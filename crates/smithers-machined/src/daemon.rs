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
        self.admitting()
            && self
                .executor
                .lock
                .run_blocking("readiness", |cx| !cx.rewrite_pending)
                .unwrap_or(false)
    }
    fn admitting(&self) -> bool {
        self.reconciled.load(Ordering::Acquire)
            && self.roster.load(Ordering::Acquire)
            && crate::wiring::ready(&self.hooks).is_ok()
    }
    /// The admission check local clients and session streams run inside their
    /// own mutation jobs (`local.rs`). It never waits on the queue those jobs
    /// hold; each job applies the rewrite barrier itself, per method.
    pub fn local_admission(self: &Arc<Self>) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let daemon = self.clone();
        Arc::new(move || daemon.admitting())
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
        // Freeze is observed while the mutation executor is busy rewriting.
        // Network IO stays on this transport thread, outside the shared lock.
        let progress_stop = Arc::new(AtomicBool::new(false));
        let progress_done = progress_stop.clone();
        let progress_writer = writer.clone();
        let progress_broker = self.hooks.broker.clone();
        let progress_generation = self.generation.clone();
        let progress = std::thread::spawn(move || {
            let mut last = None;
            while !progress_done.load(Ordering::Acquire)
                && progress_generation.load(Ordering::Acquire) == generation
            {
                let frozen = progress_broker.frozen();
                if frozen != last {
                    if let Some(frozen) = frozen {
                        let frame = Frame {
                            kind: 3,
                            stream: 0,
                            payload: conn::tagged(2, &[conn::field(1, [u8::from(frozen)])]),
                        };
                        let Ok(mut socket) = progress_writer.lock() else {
                            break;
                        };
                        if frame.write(&mut *socket).is_err() {
                            let _ = socket.shutdown(std::net::Shutdown::Both);
                            break;
                        }
                    }
                    last = frozen;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
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
            // Take the admission time on the authenticated reader, before the
            // mutation queue waits for a rewrite. Application alone cannot
            // prove the edit was received while writes were held.
            let held_document = if frame.kind == 4 {
                self.hooks.events.held_document()
            } else {
                None
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
                        let before = held_document
                            .as_ref()
                            .and_then(|_| cx.hooks.documents.text(frame.stream).ok());
                        let response = rpc::dispatch_input(&frame, cx)?;
                        if let (Some(hold), Some(before), Some(reply)) =
                            (held_document, before, response.as_ref())
                        {
                            if reply.payload.first() != Some(&255) {
                                if let (Ok(input), Ok(after)) = (
                                    crate::document_payload::Document::decode_v2(&frame.payload),
                                    cx.hooks.documents.text(frame.stream),
                                ) {
                                    if input.msg == 1 {
                                        cx.hooks.events.applied_held_document(
                                            hold,
                                            frame.stream,
                                            &input.actor,
                                            &before,
                                            &after,
                                        );
                                    }
                                }
                            }
                        }
                        return Ok(response);
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
                    if !matches!(method, 5 | 16 | 18)
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
                    if method == 5 || (method == 18 && !state.load(Ordering::Acquire)) {
                        cx.maintenance_ready = false;
                        state.store(false, Ordering::Release);
                        let fields = conn::fields("response", &result.payload[1..])?;
                        let value = fields[1].1;
                        if value[0] == 18 {
                            // The authenticated host uses the same retained-pair
                            // inspection for recovery; native boot authority and
                            // target validation precede any restored admission.
                            state.store(true, Ordering::Release);
                            cx.maintenance_ready = true;
                        }
                        if value[0] == 5 {
                            let fields = conn::fields("result5", &value[1..])?;
                            // Ordinary wake conflicts remain closed.
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
        progress_stop.store(true, Ordering::Release);
        drop(tx);
        let _ = connection.stream().shutdown(std::net::Shutdown::Both);
        let _ = responder.join();
        let _ = progress.join();
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
                    let _ = crate::local::serve(
                        socket,
                        daemon.local_admission(),
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
    let mut refused: Option<String> = None;
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
        // An unready provider refuses this link, never the process. Exiting
        // here took the daemon down on a redial; its restarts then failed the
        // same check and the machine kept its slot with no daemon (#3385).
        if let Err(error) = ready() {
            let reason = error.to_string();
            if refused.as_ref() != Some(&reason) {
                eprintln!(
                    "{}",
                    serde_json::json!({"event": "link_refused", "error": reason})
                );
                refused = Some(reason);
            }
            drop(auth);
            std::thread::sleep(backoff.delay());
            continue;
        }
        refused = None;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    struct Ready;
    macro_rules! ready {
        ($name:ident) => {
            impl crate::hooks::$name for Ready {
                fn ready(&self) -> crate::hooks::Result<()> {
                    Ok(())
                }
            }
        };
    }
    ready!(Watcher);
    ready!(Documents);
    ready!(Sessions);
    ready!(Broker);
    ready!(EventSink);
    ready!(Core);
    fn admitted_in_a_job(daemon: &Arc<Daemon>) -> (Result<bool, crate::lock::LockError>, Duration) {
        let admission = daemon.local_admission();
        let started = Instant::now();
        let result = daemon
            .executor
            .lock
            .run_blocking("local_rpc", move |_| admission());
        (result, started.elapsed())
    }
    fn host_handshake(stream: &mut std::net::TcpStream) -> bool {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let challenge = Frame::read(stream).unwrap();
        let fields = conn::fields("challenge", &challenge.payload[1..]).unwrap();
        let boot = fields[2].1.try_into().unwrap();
        let nonce = fields[3].1.try_into().unwrap();
        let reply = conn::tagged(
            2,
            &[
                conn::field(1, conn::PROTOCOL.to_be_bytes()),
                conn::field(2, conn::host_mac(&[9; 32], conn::PROTOCOL, &boot, &nonce)),
            ],
        );
        Frame {
            kind: 0,
            stream: 0,
            payload: reply,
        }
        .write(stream)
        .unwrap();
        assert_eq!(Frame::read(stream).unwrap().payload[0], 3);
        Frame {
            kind: 0,
            stream: 0,
            payload: conn::tagged(4, &[]),
        }
        .write(stream)
        .unwrap();
        // A refused link closes right after the handshake.
        let mut byte = [0u8; 1];
        !matches!(std::io::Read::read(stream, &mut byte), Ok(0))
    }
    /// #3385: a provider that is not ready when a host redials must refuse that
    /// link, not end the daemon. The run 9 daemon exited here; its restarts
    /// could not start, and the machine kept its slot without a daemon.
    #[test]
    fn an_unready_provider_refuses_the_link_and_the_daemon_keeps_accepting() {
        use std::sync::atomic::AtomicUsize;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let boot = crate::boot::Boot {
            identity: crate::link::Identity::new(
                [4; 16],
                [9; 32],
                b"fixture-machine-token".to_vec(),
            )
            .unwrap(),
            topology: crate::boot::Topology::Relay,
            item: None,
            moved_off: None,
        };
        let unready = Arc::new(AtomicUsize::new(2));
        let served = Arc::new(AtomicUsize::new(0));
        let (check, count) = (unready.clone(), served.clone());
        std::thread::spawn(move || {
            run_connections(
                boot,
                crate::link::RelayListener(listener),
                || Ok(1),
                Vec::new,
                move || match check.load(Ordering::SeqCst) {
                    0 => Ok(()),
                    _ => {
                        check.fetch_sub(1, Ordering::SeqCst);
                        Err(io::Error::other("sessions not ready"))
                    }
                },
                move |auth| {
                    count.fetch_add(1, Ordering::SeqCst);
                    // Hold the link open until the host has read past the handshake.
                    std::thread::sleep(Duration::from_millis(200));
                    drop(auth);
                },
            )
        });
        let mut open = vec![];
        for _ in 0..3 {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(100)))
                .ok();
            open.push(host_handshake(&mut stream));
        }
        assert_eq!(open, [false, false, true]);
        let deadline = Instant::now() + Duration::from_secs(5);
        while served.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            (
                served.load(Ordering::SeqCst),
                unready.load(Ordering::SeqCst)
            ),
            (1, 0)
        );
    }
    /// #3385: an agent write's job checked `Daemon::ready`, which waited on
    /// the queue that same job held. Every later host frame, roster push and
    /// local client then waited behind it.
    #[test]
    fn local_admission_answers_inside_a_job_and_leaves_the_rewrite_barrier_to_it() {
        let ready = Arc::new(Ready);
        let daemon = Arc::new(
            Daemon::new(Hooks {
                watcher: ready.clone(),
                documents: ready.clone(),
                sessions: ready.clone(),
                broker: ready.clone(),
                events: ready.clone(),
                core: ready,
                ..Default::default()
            })
            .unwrap(),
        );
        assert_eq!(admitted_in_a_job(&daemon).0, Ok(false));
        daemon.reconciled.store(true, Ordering::Release);
        daemon.roster.store(true, Ordering::Release);
        assert!(daemon.ready());
        let (admitted, took) = admitted_in_a_job(&daemon);
        assert_eq!(admitted, Ok(true));
        assert!(took < Duration::from_secs(1), "{took:?}");
        // A pending rewrite closes readiness. Local admission still answers,
        // so a queued agent write gets the job's moved_off or pending reply.
        daemon
            .executor
            .lock
            .run_blocking("rewrite", |cx| cx.rewrite_pending = true)
            .unwrap();
        assert!(!daemon.ready());
        assert_eq!(admitted_in_a_job(&daemon).0, Ok(true));
        daemon.roster.store(false, Ordering::Release);
        assert_eq!(admitted_in_a_job(&daemon).0, Ok(false));
    }
    #[test]
    fn freeze_facts_cross_authenticated_transport_while_executor_is_busy() {
        use std::sync::atomic::AtomicU8;
        struct Observed(AtomicU8);
        impl crate::hooks::Broker for Observed {
            fn ready(&self) -> crate::hooks::Result<()> {
                Ok(())
            }
            fn frozen(&self) -> Option<bool> {
                match self.0.load(Ordering::Acquire) {
                    1 => Some(false),
                    2 => Some(true),
                    _ => None,
                }
            }
        }
        let ready = Arc::new(Ready);
        let broker = Arc::new(Observed(AtomicU8::new(0)));
        let daemon = Arc::new(
            Daemon::new(Hooks {
                watcher: ready.clone(),
                documents: ready.clone(),
                sessions: ready.clone(),
                broker: broker.clone(),
                events: ready.clone(),
                core: ready,
                ..Default::default()
            })
            .unwrap(),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = daemon.clone();
        let serving = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let identity =
                crate::link::Identity::new([4; 16], [9; 32], b"fixture-machine-token".to_vec())
                    .unwrap();
            let connection = crate::link::authenticate(socket, &identity, 1, &[]).unwrap();
            server.serve(connection)
        });
        let mut host = std::net::TcpStream::connect(address).unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let challenge = Frame::read(&mut host).unwrap();
        let fields = conn::fields("challenge", &challenge.payload[1..]).unwrap();
        let boot = fields[2].1.try_into().unwrap();
        let nonce = fields[3].1.try_into().unwrap();
        Frame {
            kind: 0,
            stream: 0,
            payload: conn::tagged(
                2,
                &[
                    conn::field(1, conn::PROTOCOL.to_be_bytes()),
                    conn::field(2, conn::host_mac(&[9; 32], conn::PROTOCOL, &boot, &nonce)),
                ],
            ),
        }
        .write(&mut host)
        .unwrap();
        assert_eq!(Frame::read(&mut host).unwrap().payload[0], 3);
        Frame {
            kind: 0,
            stream: 0,
            payload: conn::tagged(4, &[]),
        }
        .write(&mut host)
        .unwrap();
        // Force reconnect setup to finish before holding the executor.
        let deadline = Instant::now() + Duration::from_secs(3);
        while daemon.generation.load(Ordering::Acquire) == 0 {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        // The initial fact confirms that the independent pump has started.
        broker.0.store(1, Ordering::Release);
        assert_eq!(
            Frame::read(&mut host).unwrap().payload,
            conn::tagged(2, &[conn::field(1, [0])])
        );
        let (held, holding) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let receipt = daemon
            .executor
            .lock
            .enqueue("held_rewrite", move |_| {
                held.send(()).unwrap();
                released.recv().unwrap();
            })
            .unwrap();
        holding.recv_timeout(Duration::from_secs(3)).unwrap();
        broker.0.store(2, Ordering::Release);
        let frame = Frame::read(&mut host).unwrap();
        assert_eq!(frame.kind, 3);
        assert_eq!(frame.payload, conn::tagged(2, &[conn::field(1, [1])]));
        broker.0.store(1, Ordering::Release);
        assert_eq!(
            Frame::read(&mut host).unwrap().payload,
            conn::tagged(2, &[conn::field(1, [0])])
        );
        release.send(()).unwrap();
        receipt.wait().unwrap();
        host.shutdown(std::net::Shutdown::Both).unwrap();
        assert!(serving.join().unwrap().is_err());
    }
}
