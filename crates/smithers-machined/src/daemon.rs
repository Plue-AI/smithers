//! Process-local readiness and authenticated RPC service. Only a successful
//! native reconciliation can make a new process ready; reconnects retain it.
use crate::{
    conn::{self, Frame, ProtocolError},
    hooks::{Error, Hooks},
    lock::Executor,
    rpc,
};
use std::{
    io,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    sync::{Arc, Mutex},
};

pub struct Daemon {
    executor: Executor,
    hooks: Hooks,
    reconciled: Arc<AtomicBool>,
    roster: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}
impl Daemon {
    pub fn new(hooks: Hooks) -> io::Result<Self> {
        Ok(Self {
            executor: crate::wiring::start(hooks.clone()).map_err(io::Error::other)?,
            hooks,
            reconciled: Arc::new(AtomicBool::new(false)),
            roster: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
        })
    }
    pub fn ready(&self) -> bool {
        self.reconciled.load(Ordering::Acquire)
            && self.roster.load(Ordering::Acquire)
            && crate::wiring::ready(&self.hooks).is_ok()
            && self
                .executor
                .lock
                .run_blocking("readiness", |cx| !cx.rewrite_pending)
                .unwrap_or(false)
    }
    /// Entry requires a completed mutual handshake. The caller fences replaced
    /// connections before entering here. No network IO occurs on the lock thread.
    pub fn serve(&self, mut connection: crate::link::Authenticated) -> Result<(), ProtocolError> {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.roster.store(false, Ordering::Release);
        self.executor
            .lock
            .run_blocking("event_reconnect", |cx| {
                cx.hooks.documents.disconnected()?;
                cx.hooks.events.reconnect()
            })
            .map_err(|_| ProtocolError::Truncated)?
            .map_err(|_| ProtocolError::Truncated)?;
        self.executor
            .lock
            .run_blocking("presence_reconnect", |cx| {
                cx.hooks.sessions.reset_presence()
            })
            .map_err(|_| ProtocolError::Truncated)?
            .map_err(|_| ProtocolError::Truncated)?;
        let writer = Arc::new(Mutex::new(
            connection
                .stream()
                .try_clone()
                .map_err(|_| ProtocolError::Truncated)?,
        ));
        // Bound outstanding requests while allowing the reader to continue.
        let (tx, rx) = std::sync::mpsc::sync_channel(64);
        let output = writer.clone();
        let lock = self.executor.lock.clone();
        let session_reconciled = self.reconciled.clone();
        let session_roster = self.roster.clone();
        let responder_generation = self.generation.clone();
        #[cfg(all(feature = "killpoints", debug_assertions))]
        let fault_events = self.hooks.events.clone();
        let responder = std::thread::spawn(move || {
            // A capture's local phase runs on the mutation executor, but its
            // reply waits here while the same pump transfers bytes and accepts
            // host receipts. Never wait for delivery on the lock or stop the
            // responder: either would deadlock the ACK needed for completion.
            let mut captures = Vec::with_capacity(64);
            loop {
                if responder_generation.load(Ordering::Acquire) != generation {
                    break;
                }
                match rx.recv_timeout(std::time::Duration::from_millis(25)) {
                    Ok(receipt) => {
                        let receipt: crate::lock::Receipt<Result<Option<Frame>, ProtocolError>> =
                            receipt;
                        let frame = match receipt.wait() {
                            Ok(Ok(frame)) => frame,
                            _ => break,
                        };
                        if responder_generation.load(Ordering::Acquire) != generation {
                            break;
                        }
                        if let Some(frame) = frame {
                            let capture = frame.kind == 1
                                && frame.payload.first() == Some(&2)
                                && conn::fields("response", &frame.payload[1..])
                                    .is_ok_and(|f| f[1].1.first() == Some(&4));
                            if capture {
                                // Bound retained request results independently
                                // of the inbound channel. Closing lets the host
                                // retry against the retained durable outbox.
                                if captures.len() == 64 {
                                    break;
                                }
                                captures.push(frame);
                            } else {
                                let Ok(mut socket) = output.lock() else { break };
                                if frame.write(&mut *socket).is_err() {
                                    break;
                                }
                                #[cfg(all(feature = "killpoints", debug_assertions))]
                                fault_events.sent(&frame);
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
                let reconciled = session_reconciled.clone();
                let roster = session_roster.clone();
                let current = responder_generation.clone();
                let waiting = !captures.is_empty();
                let (mut frames, drained) = match lock.run_blocking(
                    "stream_tick",
                    move |cx| -> crate::hooks::Result<(Vec<Frame>, bool)> {
                        if current.load(Ordering::Acquire) != generation {
                            return Ok((vec![], false));
                        }
                        let mut frames = cx.hooks.documents.clone().poll(cx)?;
                        // Authentication authorizes recovery delivery; readiness
                        // authorizes sessions. A conflict or pending rewrite must
                        // still deliver its durable event and accept the receipt.
                        frames.extend(cx.hooks.events.poll()?);
                        if reconciled.load(Ordering::Acquire) && roster.load(Ordering::Acquire) {
                            cx.hooks.sessions.ready()?;
                            frames.extend(cx.hooks.sessions.poll()?);
                        }
                        let drained = waiting && cx.hooks.events.drained()?;
                        Ok((frames, drained))
                    },
                ) {
                    Ok(Ok(frames)) => frames,
                    _ => break,
                };
                if responder_generation.load(Ordering::Acquire) != generation {
                    break;
                }
                if drained {
                    frames.append(&mut captures);
                }
                let Ok(mut socket) = output.lock() else { break };
                if frames.iter().any(|f| {
                    if f.write(&mut *socket).is_err() {
                        return true;
                    }
                    #[cfg(all(feature = "killpoints", debug_assertions))]
                    fault_events.sent(f);
                    false
                }) {
                    break;
                }
            }
            // A failed receipt or frame write must also interrupt the reader.
            // Otherwise it can wait forever for another host request after the
            // only responder has exited.
            if let Ok(socket) = output.lock() {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
        });
        let result = (|| loop {
            let frame = Frame::read_envelope(connection.stream())?;
            if let Err(error) = frame.validate(false) {
                let response = rpc::malformed_response(&frame, error)?;
                response
                    .write(&mut *writer.lock().map_err(|_| ProtocolError::Truncated)?)
                    .map_err(|_| ProtocolError::Truncated)?;
                continue;
            }
            if matches!(frame.kind, 0 | 3) {
                return Err(ProtocolError::HandshakeOrder);
            }
            let state = self.reconciled.clone();
            let roster = self.roster.clone();
            let current = self.generation.clone();
            let job = if frame.kind == 1 {
                match frame.request().map(|(_, method, _)| method) {
                    Ok(11) => "rebase",
                    Ok(12) => "return_to_item",
                    _ => "host_rpc",
                }
            } else {
                "host_rpc"
            };
            let receipt = self
                .executor
                .lock
                .enqueue(job, move |cx| {
                    if current.load(Ordering::Acquire) != generation {
                        return Err(ProtocolError::HandshakeOrder);
                    }
                    if frame.kind != 1 {
                        // The delivery state validates the active stream and
                        // sequence. Do not gate its ACK/credit behind the state
                        // whose recovery depends on draining that same outbox.
                        if matches!(frame.kind, 2 | 6) {
                            return cx
                                .hooks
                                .events
                                .frame(&frame)
                                .map_err(|_| ProtocolError::BadValue);
                        }
                        if !(state.load(Ordering::Acquire) && roster.load(Ordering::Acquire)) {
                            return Ok(Some(Frame {
                                kind: frame.kind,
                                stream: frame.stream,
                                payload: conn::tagged(255, &not_ready().fields()),
                            }));
                        }
                        return rpc::dispatch_input(&frame, cx);
                    }
                    let (id, method, args) = frame.request()?;
                    if cx.rewrite_pending || crate::wiring::ready(&cx.hooks).is_err() {
                        cx.maintenance_ready = false;
                        state.store(false, Ordering::Release);
                        roster.store(false, Ordering::Release);
                    }
                    if method == 1 {
                        // Depth, acked head and queue length belong to the live
                        // core. Never claim an empty outbox from transport defaults.
                        let core = cx.hooks.core.clone();
                        let body = match core.call(cx, 1, args) {
                            Ok(body) => body,
                            Err(error) => return Ok(Some(refused(id, error))),
                        };
                        let fields = conn::fields("result1", &body)?;
                        let ready = state.load(Ordering::Acquire)
                            && roster.load(Ordering::Acquire)
                            && !cx.rewrite_pending;
                        let fields: Vec<_> = fields
                            .into_iter()
                            .map(|(tag, value)| {
                                if tag == 1 {
                                    conn::field(1, [if ready { 3 } else { 2 }])
                                } else {
                                    conn::field(tag, value)
                                }
                            })
                            .collect();
                        return Ok(Some(response(id, 1, conn::structure_bytes(&fields))));
                    }
                    if !matches!(method, 5 | 16)
                        && !(state.load(Ordering::Acquire) && roster.load(Ordering::Acquire))
                    {
                        return Ok(Some(refused(id, not_ready())));
                    }
                    if method == 16 {
                        // A valid roster update can fail while killing revoked
                        // descendants. That must close admission until a retry
                        // confirms cleanup, even on an already-ready link.
                        roster.store(false, Ordering::Release);
                    }
                    let result = rpc::dispatch(&frame, cx)?;
                    if method == 16 && result.payload.get(11) == Some(&16) {
                        roster.store(true, Ordering::Release);
                    }
                    if method == 5 {
                        cx.maintenance_ready = false;
                        state.store(false, Ordering::Release);
                        let fields = conn::fields("response", &result.payload[1..])?;
                        let value = fields[1].1;
                        if value[0] == 5 {
                            let fields = conn::fields("result5", &value[1..])?;
                            // Conflict is a real wake outcome, not permission to admit sessions.
                            if matches!(fields[0].1[0], 1 | 2) {
                                state.store(true, Ordering::Release);
                                cx.maintenance_ready = true;
                            }
                        }
                    }
                    Ok(Some(result))
                })
                .map_err(|_| ProtocolError::Truncated)?;
            tx.send(receipt).map_err(|_| ProtocolError::Truncated)?;
        })();
        drop(tx);
        let _ = connection.stream().shutdown(std::net::Shutdown::Both);
        let _ = responder.join();
        let current = self.generation.clone();
        let _ = self
            .executor
            .lock
            .run_blocking("session_disconnect", move |cx| {
                // A replaced socket must not detach sessions already attached on
                // its successor. Recheck under the same lock as attach_session.
                if current.load(Ordering::Acquire) == generation {
                    cx.hooks.documents.disconnected()?;
                    let sessions = cx.hooks.sessions.disconnected();
                    cx.hooks.events.disconnected()?;
                    sessions
                } else {
                    Ok(())
                }
            });
        result
    }
}
fn not_ready() -> Error {
    Error {
        code: 3,
        ..Error::unsupported()
    }
}
pub fn response(id: u32, method: u8, body: Vec<u8>) -> Frame {
    let mut value = vec![method];
    value.extend(body);
    Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            2,
            &[conn::field(1, id.to_be_bytes()), conn::field(2, value)],
        ),
    }
}
pub fn refused(id: u32, error: Error) -> Frame {
    response(id, 255, conn::structure_bytes(&error.fields()))
}

/// Shared relay/bridge accept loop. Only authenticated candidates replace a
/// live connection. A failed bridge attempt backs off without claiming ready.
pub fn run(
    boot: crate::boot::Boot,
    hooks: Hooks,
    source: impl crate::link::LinkSource,
    next_seq: impl Fn() -> io::Result<u64>,
) -> io::Result<()> {
    run_with_local(boot, hooks, source, next_seq, None)
}

#[cfg(target_os = "linux")]
type LocalDoor = (std::os::unix::net::UnixListener, Arc<crate::files::Files>);
#[cfg(not(target_os = "linux"))]
type LocalDoor = ();

pub fn run_with_local(
    boot: crate::boot::Boot,
    hooks: Hooks,
    source: impl crate::link::LinkSource,
    next_seq: impl Fn() -> io::Result<u64>,
    local: Option<LocalDoor>,
) -> io::Result<()> {
    let daemon = Arc::new(Daemon::new(hooks)?);
    #[cfg(target_os = "linux")]
    if let Some((listener, files)) = local {
        let daemon = daemon.clone();
        std::thread::spawn(move || {
            let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            for socket in listener.incoming() {
                let Ok(socket) = socket else { break };
                if active.fetch_add(1, Ordering::AcqRel) >= 64 {
                    active.fetch_sub(1, Ordering::AcqRel);
                    continue;
                }
                let active = active.clone();
                let daemon = daemon.clone();
                let files = files.clone();
                std::thread::spawn(move || {
                    let check = daemon.clone();
                    let _ = crate::local::serve(
                        socket,
                        Arc::new(move || check.ready()),
                        &*daemon.hooks.sessions,
                        &daemon.executor.lock,
                        files,
                    );
                    active.fetch_sub(1, Ordering::AcqRel);
                });
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = local;
    let serving = daemon.clone();
    let admission = daemon.clone();
    run_connections(
        boot,
        source,
        next_seq,
        move || daemon.hooks.sessions.live(),
        move || crate::wiring::ready(&admission.hooks).map_err(io::Error::other),
        move |auth| {
            let _ = serving.serve(auth);
        },
    )
}

/// Keep authenticated status reachable without opening the repository, starting
/// providers, or interpreting any bytes from an unsupported outbox.
pub fn run_outbox_refused(
    boot: crate::boot::Boot,
    source: impl crate::link::LinkSource,
) -> io::Result<()> {
    run_connections(
        boot,
        source,
        || Ok(1),
        Vec::new,
        || Ok(()),
        |auth| {
            let _ = serve_outbox_refused(auth);
        },
    )
}

pub fn serve_outbox_refused(
    mut connection: crate::link::Authenticated,
) -> Result<(), ProtocolError> {
    loop {
        let frame = Frame::read_envelope(connection.stream())?;
        let response = if let Err(error) = frame.validate(false) {
            rpc::malformed_response(&frame, error)?
        } else if frame.kind == 1 {
            let (id, _, _) = frame.request()?;
            refused(
                id,
                Error {
                    detail: Some(crate::outbox_store::FORMAT_UNSUPPORTED.into()),
                    ..Error::unsupported()
                },
            )
        } else {
            return Err(ProtocolError::HandshakeOrder);
        };
        response
            .write(connection.stream())
            .map_err(|_| ProtocolError::Truncated)?;
    }
}

fn run_connections(
    boot: crate::boot::Boot,
    mut source: impl crate::link::LinkSource,
    next_seq: impl Fn() -> io::Result<u64>,
    sessions: impl Fn() -> Vec<u32>,
    ready: impl Fn() -> io::Result<()>,
    serve: impl Fn(crate::link::Authenticated) + Send + Sync + 'static,
) -> io::Result<()> {
    let serve = Arc::new(serve);
    let live = crate::link::Live::default();
    let mut backoff = crate::link::Backoff::default();
    loop {
        // Authentication has bounded reads and writes. A silent candidate cannot
        // prevent the existing connection from processing controls.
        let stream = match source.next() {
            Ok(stream) => stream,
            Err(_) => {
                std::thread::sleep(backoff.delay());
                continue;
            }
        };
        let auth = match crate::link::authenticate(stream, &boot.identity, next_seq()?, &sessions())
        {
            Ok(auth) => auth,
            Err(_) => {
                std::thread::sleep(backoff.delay());
                continue;
            }
        };
        ready()?;
        live.replace(&auth)?;
        backoff.reset();
        let serve = serve.clone();
        let connection = std::thread::spawn(move || serve(auth));
        if matches!(boot.topology, crate::boot::Topology::Bridge(_)) {
            // A bridge must not repeatedly replace its own healthy connection.
            // The connection owner wakes the next dial only after EOF.
            let _ = connection.join();
            std::thread::sleep(backoff.delay());
        }
    }
}
