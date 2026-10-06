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
    }
    /// Entry requires a completed mutual handshake. The caller fences replaced
    /// connections before entering here. No network IO occurs on the lock thread.
    pub fn serve(&self, mut connection: crate::link::Authenticated) -> Result<(), ProtocolError> {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.roster.store(false, Ordering::Release);
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
        let responder = std::thread::spawn(move || {
            loop {
                match rx.recv_timeout(std::time::Duration::from_millis(25)) {
                    Ok(receipt) => {
                        let receipt: crate::lock::Receipt<Result<Option<Frame>, ProtocolError>> =
                            receipt;
                        let frame = match receipt.wait() {
                            Ok(Ok(frame)) => frame,
                            _ => break,
                        };
                        if let Some(frame) = frame {
                            let Ok(mut socket) = output.lock() else { break };
                            if frame.write(&mut *socket).is_err() {
                                break;
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
                let reconciled = session_reconciled.clone();
                let roster = session_roster.clone();
                let frames = match lock.run_blocking(
                    "stream_tick",
                    move |cx| -> crate::hooks::Result<Vec<Frame>> {
                        let mut frames = cx.hooks.documents.clone().poll(cx)?;
                        if reconciled.load(Ordering::Acquire) && roster.load(Ordering::Acquire) {
                            cx.hooks.sessions.ready()?;
                            frames.extend(cx.hooks.sessions.poll()?);
                        }
                        Ok(frames)
                    },
                ) {
                    Ok(Ok(frames)) => frames,
                    _ => break,
                };
                let Ok(mut socket) = output.lock() else { break };
                if frames.iter().any(|f| f.write(&mut *socket).is_err()) {
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
            if matches!(frame.kind, 0 | 2 | 3 | 6) {
                return Err(ProtocolError::HandshakeOrder);
            }
            let state = self.reconciled.clone();
            let roster = self.roster.clone();
            let receipt = self
                .executor
                .lock
                .enqueue("host_rpc", move |cx| {
                    if frame.kind != 1 {
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
                    if crate::wiring::ready(&cx.hooks).is_err() {
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
                        state.store(false, Ordering::Release);
                        let fields = conn::fields("response", &result.payload[1..])?;
                        let value = fields[1].1;
                        if value[0] == 5 {
                            let fields = conn::fields("result5", &value[1..])?;
                            // Conflict is a real wake outcome, not permission to admit sessions.
                            if matches!(fields[0].1[0], 1 | 2) {
                                state.store(true, Ordering::Release);
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
                    cx.hooks.sessions.disconnected()
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
    mut source: impl crate::link::LinkSource,
    next_seq: impl Fn() -> io::Result<u64>,
) -> io::Result<()> {
    let daemon = Arc::new(Daemon::new(hooks)?);
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
        let auth = match crate::link::authenticate(
            stream,
            &boot.identity,
            next_seq()?,
            &daemon.hooks.sessions.live(),
        ) {
            Ok(auth) => auth,
            Err(_) => {
                std::thread::sleep(backoff.delay());
                continue;
            }
        };
        crate::wiring::ready(&daemon.hooks).map_err(io::Error::other)?;
        live.replace(&auth)?;
        backoff.reset();
        let daemon = daemon.clone();
        let connection = std::thread::spawn(move || {
            let _ = daemon.serve(auth);
        });
        if matches!(boot.topology, crate::boot::Topology::Bridge(_)) {
            // A bridge must not repeatedly replace its own healthy connection.
            // The connection owner wakes the next dial only after EOF.
            let _ = connection.join();
            std::thread::sleep(backoff.delay());
        }
    }
}
