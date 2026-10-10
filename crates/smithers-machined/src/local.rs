//! Agent-only socket admission. The kernel peer and registered cgroup determine
//! the run; request bytes cannot select one or register a new run.
use crate::{
    conn::{self, Frame},
    daemon,
    files::Files,
    hooks::{Error, Sessions},
    lock::Lock,
};
use std::{
    io::{self, Read},
    os::unix::net::UnixStream,
    sync::Arc,
    time::Duration,
};
fn unauthorized() -> Error {
    Error {
        code: 11,
        ..Error::unsupported()
    }
}
pub(crate) fn write_response(
    cx: &mut crate::lock::LockCx,
    files: &Files,
    id: u32,
    args: conn::WriteArgs,
    admitted_epoch: u64,
) -> Frame {
    // Rebase preserves the item: compare queued writes on the rewritten tree.
    // Return changes authority, including requests admitted during its hold.
    if admitted_epoch < cx.return_epoch {
        return daemon::refused(
            id,
            Error {
                code: 10,
                ..Error::unsupported()
            },
        );
    }
    match files.write(cx, args) {
        Ok(body) => daemon::response(id, 3, body),
        Err(error) => daemon::refused(id, error),
    }
}
pub(crate) fn batch_response(
    cx: &mut crate::lock::LockCx,
    files: &Files,
    id: u32,
    changes: Vec<crate::hooks::FileWrite>,
    actor: crate::hooks::Actor,
    admitted_epoch: u64,
) -> Frame {
    // Rebase preserves the item: compare queued writes on the rewritten tree.
    // Return changes authority, including requests admitted during its hold.
    if admitted_epoch < cx.return_epoch {
        return daemon::refused(
            id,
            Error {
                code: 10,
                ..Error::unsupported()
            },
        );
    }
    match files.write_batch(cx, changes, actor) {
        Ok(body) => daemon::response(id, 17, body),
        Err(error) => daemon::refused(id, error),
    }
}
pub fn admission_for_peer(
    uid: u32,
    cgroups: &str,
    sessions: &dyn Sessions,
) -> Result<crate::broker::sessions::Admission, Error> {
    if uid != 19999 || cgroups.len() > 4096 {
        return Err(unauthorized());
    }
    let mut unified = cgroups.lines().filter_map(|line| line.strip_prefix("0::"));
    let path = unified.next().ok_or_else(unauthorized)?;
    if unified.next().is_some() || !path.starts_with("/smithers/sessions/") || path.contains("..") {
        return Err(unauthorized());
    }
    sessions.admission_of_cgroup(path).ok_or_else(unauthorized)
}
/// The local wire keeps ADR 0004 args6, but the peer cannot select an identity
/// or kind. Only an agent PTY can enter the dedicated broker-local operation.
pub fn validate_open(args: &[u8]) -> Result<(), Error> {
    use crate::broker::{request::Request, sessions::Kind};
    match Request::decode(6, args) {
        Ok(Request::Open {
            user,
            kind: Kind::Pty,
            admission: None,
            ..
        }) if user.uid == 19999 && user.login == "agent" => Ok(()),
        _ => Err(unauthorized()),
    }
}
fn unified_cgroup(groups: &str) -> Option<&str> {
    let mut paths = groups.lines().filter_map(|line| line.strip_prefix("0::"));
    let path = paths.next()?;
    if paths.next().is_some() {
        return None;
    }
    Some(path)
}
/// `ready` runs inside this request's mutation job, so it must never wait on
/// the mutation queue. The job applies the rewrite barrier per method.
pub fn serve(
    socket: UnixStream,
    ready: Arc<dyn Fn() -> bool + Send + Sync>,
    sessions: &dyn Sessions,
    lock: &Lock,
    files: Arc<Files>,
) -> io::Result<()> {
    if !ready() {
        return Ok(());
    }
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let peer = rustix::net::sockopt::socket_peercred(&socket)?;
    if peer.uid.as_raw() != 19999 {
        return Ok(());
    }
    let mut groups = String::new();
    std::fs::File::open(format!("/proc/{}/cgroup", peer.pid.as_raw_nonzero()))?
        .take(4097)
        .read_to_string(&mut groups)?;
    serve_peer(
        socket,
        peer.uid.as_raw(),
        groups,
        ready,
        sessions,
        lock,
        files,
    )
}
/// Everything after the kernel credential read: `uid` and `groups` are the
/// peer's `SO_PEERCRED` uid and `/proc/<pid>/cgroup` text.
pub(crate) fn serve_peer(
    mut socket: UnixStream,
    uid: u32,
    groups: String,
    ready: Arc<dyn Fn() -> bool + Send + Sync>,
    sessions: &dyn Sessions,
    lock: &Lock,
    files: Arc<Files>,
) -> io::Result<()> {
    let run =
        admission_for_peer(uid, &groups, sessions).map_err(|_| io::ErrorKind::PermissionDenied)?;
    let admitted_epoch = lock.epoch();
    let frame = Frame::read_envelope(&mut socket).map_err(io::Error::other)?;
    if let Err(e) = frame.validate(true) {
        return crate::rpc::malformed_response(&frame, e)
            .map_err(io::Error::other)?
            .write(&mut socket);
    }
    let (id, method, args) = frame.request().map_err(io::Error::other)?;
    if method == 6 && validate_open(args).is_err() {
        return daemon::refused(id, unauthorized()).write(&mut socket);
    }
    let open = (method == 6).then(|| args.to_vec());
    let write = if method == 3 {
        Some(conn::local_write_args(args, run.principal).map_err(io::Error::other)?)
    } else {
        None
    };
    let batch = if method == 17 {
        Some(conn::local_batch_write_args(args, run.principal).map_err(io::Error::other)?)
    } else {
        None
    };
    let stream_ready = ready.clone();
    let stream_groups = groups.clone();
    let stream_run = run.clone();
    let response = lock
        .enqueue("local_rpc", move |cx| {
            // Recheck after queueing: revocation can happen while this request waits
            // behind a capture or rewrite. The original cgroup grants no lease.
            if !ready()
                || admission_for_peer(uid, &groups, &*cx.hooks.sessions)
                    .ok()
                    .as_ref()
                    != Some(&run)
            {
                return Ok(daemon::refused(id, unauthorized()));
            }
            if cx.rewrite_pending && matches!(method, 3 | 17) {
                return Ok(daemon::refused(
                    id,
                    if cx.last_rewrite_was_return {
                        Error {
                            code: 10,
                            ..Error::unsupported()
                        }
                    } else {
                        crate::freeze::pending_error()
                    },
                ));
            }
            match method {
                3 => Ok(write_response(
                    cx,
                    &files,
                    id,
                    write.unwrap(),
                    admitted_epoch,
                )),
                17 => {
                    let (changes, actor) = batch.unwrap();
                    Ok(batch_response(
                        cx,
                        &files,
                        id,
                        changes,
                        actor,
                        admitted_epoch,
                    ))
                }
                6 => {
                    if cx.rewrite_pending {
                        return Ok(daemon::refused(id, crate::freeze::pending_error()));
                    }
                    let path =
                        unified_cgroup(&groups).ok_or(crate::conn::ProtocolError::BadValue)?;
                    Ok(match cx.hooks.sessions.open_local(path, &open.unwrap()) {
                        Ok(body) => daemon::response(id, 6, body),
                        Err(e) => daemon::refused(id, e),
                    })
                }
                2 => crate::rpc::dispatch(&frame, cx),
                _ => Ok(daemon::refused(id, Error::unsupported())),
            }
        })
        .map_err(|_| io::Error::other("mutation executor stopped"))?;
    // The reference-guest supervisor holds Return at freeze-start, then waits
    // for this marker before releasing it. Admission and FIFO enqueue are real;
    // the transport thread pauses, never the mutation executor. Release builds
    // contain no hook and accept no branch-controlled synchronization input.
    #[cfg(all(feature = "killpoints", debug_assertions))]
    if matches!(method, 3 | 17) {
        crate::events::killpoint("coding-queued");
    }
    let response = response
        .wait()
        .map_err(|_| io::Error::other("mutation executor stopped"))?
        .map_err(io::Error::other)?;
    response.write(&mut socket)?;
    if method != 6 {
        return Ok(());
    }
    let fields = conn::fields("response", &response.payload[1..]).map_err(io::Error::other)?;
    let value = fields[1].1;
    if value.first() != Some(&6) {
        return Ok(());
    }
    let fields = conn::fields("result6", &value[1..]).map_err(io::Error::other)?;
    let session = u32::from_be_bytes(
        fields[0]
            .1
            .try_into()
            .map_err(|_| io::ErrorKind::InvalidData)?,
    );
    crate::local_stream::serve(
        socket,
        session,
        lock.clone(),
        Arc::new(move |cx| {
            stream_ready()
                && admission_for_peer(19999, &stream_groups, &*cx.hooks.sessions)
                    .ok()
                    .as_ref()
                    == Some(&stream_run)
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{broker::sessions::Admission, hooks::Hooks, lock::Executor};
    use std::{
        io::Write,
        sync::atomic::{AtomicUsize, Ordering},
    };
    /// Counts every session-provider action the local socket could take.
    struct Runs(AtomicUsize);
    impl Sessions for Runs {
        fn admission_of_cgroup(&self, path: &str) -> Option<Admission> {
            (path == "/smithers/sessions/7").then(|| Admission {
                principal: [7; 16],
                run: Some("run-7".into()),
            })
        }
        fn open_local(&self, _: &str, _: &[u8]) -> crate::hooks::Result<Vec<u8>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(Error::unsupported())
        }
        fn call(&self, _: u8, _: &[u8]) -> crate::hooks::Result<Vec<u8>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(Error::unsupported())
        }
    }
    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../packages/backend/internal/compose/testdata/cocontracts/{name}.bin"
            )),
        )
        .unwrap()
    }
    /// Production local dispatch after the kernel credential read: returns the
    /// reply bytes, the provider actions and the mutation jobs it ran.
    fn exchange(request: &[u8]) -> (Vec<u8>, usize, u64) {
        let runs = Arc::new(Runs(AtomicUsize::new(0)));
        let executor = Executor::start(Hooks {
            sessions: runs.clone(),
            ..Hooks::default()
        })
        .unwrap();
        let workspace = std::fs::File::open(env!("CARGO_MANIFEST_DIR")).unwrap();
        let files = Arc::new(Files::fixture(workspace, Arc::new(crate::hooks::Disabled)));
        let (mut caller, server) = UnixStream::pair().unwrap();
        caller
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let lock = executor.lock.clone();
        let sessions = runs.clone();
        let worker = std::thread::spawn(move || {
            serve_peer(
                server,
                19999,
                "0::/smithers/sessions/7\n".into(),
                Arc::new(|| true),
                &*sessions,
                &lock,
                files,
            )
        });
        caller.write_all(request).unwrap();
        let mut reply = vec![];
        caller.read_to_end(&mut reply).unwrap();
        let _ = worker.join().unwrap();
        let jobs = executor
            .lock
            .run_blocking("probe", |cx| cx.completed)
            .unwrap();
        executor.shutdown().unwrap();
        (reply, runs.0.load(Ordering::SeqCst), jobs)
    }
    /// T-TRM-05: `client pty` through the production local admission, the
    /// mutation job and the socket-scoped stream; only kernel effects are fake.
    #[test]
    fn client_pty_runs_through_kernel_admission_and_the_scoped_stream() {
        use std::{collections::VecDeque, sync::Mutex};
        struct Pty {
            opened: Mutex<Vec<Vec<u8>>>,
            credit: AtomicUsize,
            closed: AtomicUsize,
            output: Mutex<VecDeque<Frame>>,
        }
        impl Sessions for Pty {
            fn admission_of_cgroup(&self, path: &str) -> Option<Admission> {
                (path == "/smithers/sessions/7").then(|| Admission {
                    principal: [7; 16],
                    run: Some("run-7".into()),
                })
            }
            fn open_local(&self, cgroup: &str, args: &[u8]) -> crate::hooks::Result<Vec<u8>> {
                assert_eq!(cgroup, "/smithers/sessions/7");
                self.opened.lock().unwrap().push(args.to_vec());
                Ok(conn::structure_bytes(&[conn::field(
                    1,
                    17u32.to_be_bytes(),
                )]))
            }
            fn poll_local(&self, session: u32) -> crate::hooks::Result<Vec<Frame>> {
                assert_eq!(session, 17);
                Ok(self
                    .output
                    .lock()
                    .unwrap()
                    .pop_front()
                    .into_iter()
                    .collect())
            }
            fn frame_local(&self, frame: &Frame) -> crate::hooks::Result<Option<Frame>> {
                assert_eq!((frame.kind, frame.stream, frame.payload[0]), (5, 17, 6));
                let n = u32::from_be_bytes(frame.payload[1..5].try_into().unwrap());
                self.credit.fetch_add(n as usize, Ordering::SeqCst);
                Ok(None)
            }
            fn call(&self, method: u8, args: &[u8]) -> crate::hooks::Result<Vec<u8>> {
                assert_eq!((method, args), (8, &[0, 0, 0, 5, 1, 0, 0, 0, 17][..]));
                self.closed.fetch_add(1, Ordering::SeqCst);
                Ok(vec![0, 0])
            }
        }
        let data = |b: &[u8]| Frame {
            kind: 5,
            stream: 17,
            payload: [&[1u8, 1], b].concat(),
        };
        let pty = Arc::new(Pty {
            opened: Mutex::new(vec![]),
            credit: AtomicUsize::new(0),
            closed: AtomicUsize::new(0),
            output: Mutex::new(VecDeque::from([
                data(b"$ printf AGENT_TERMINAL_SECOND\r\n"),
                data(b"AGENT_TERMINAL_SECOND"),
                Frame {
                    kind: 5,
                    stream: 17,
                    payload: vec![5, 0, 0, 0, 0, 0],
                },
            ])),
        });
        let executor = Executor::start(Hooks {
            sessions: pty.clone(),
            ..Hooks::default()
        })
        .unwrap();
        let workspace = std::fs::File::open(env!("CARGO_MANIFEST_DIR")).unwrap();
        let files = Arc::new(Files::fixture(workspace, Arc::new(crate::hooks::Disabled)));
        let (mut caller, server) = UnixStream::pair().unwrap();
        caller
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let lock = executor.lock.clone();
        let sessions = pty.clone();
        let worker = std::thread::spawn(move || {
            serve_peer(
                server,
                19999,
                "0::/smithers/sessions/7\n".into(),
                Arc::new(|| true),
                &*sessions,
                &lock,
                files,
            )
        });
        let (request, echo) = crate::client::pty_request(
            &mut &br#"{"argv":["/bin/sh","-c","printf AGENT_TERMINAL_SECOND"],"display":"printf AGENT_TERMINAL_SECOND"}"#[..],
        )
        .unwrap();
        assert_eq!(
            crate::client::pty_open(&mut caller, &request).unwrap(),
            Ok(17)
        );
        let writer = std::sync::Mutex::new(caller.try_clone().unwrap());
        let mut output = vec![];
        let end = crate::client::pty_stream(&mut caller, &writer, 17, &echo, &mut output).unwrap();
        assert_eq!(end, crate::client::PtyEnd::Exit(0));
        assert_eq!(output, b"AGENT_TERMINAL_SECOND");
        worker.join().unwrap().unwrap();
        assert_eq!(pty.credit.load(Ordering::SeqCst), 32 + 21);
        assert_eq!(pty.closed.load(Ordering::SeqCst), 1);
        let opened = pty.opened.lock().unwrap();
        assert_eq!(opened.len(), 1);
        validate_open(&opened[0]).unwrap();
        executor.shutdown().unwrap();
    }
    /// ADR 0004 §durable session admission (8a, 2026-10-07): a local request
    /// carrying admission fields decodes, and the daemon answers it with
    /// exactly `Error{unauthorized}` (control error 11) without acting.
    #[test]
    fn local_open_with_admission_fields_answers_unauthorized_without_acting() {
        let (reply, actions, jobs) = exchange(&corpus("local_open_session_admitted"));
        // Both carry req_id 42: the reply is the corpus error frame byte for byte.
        assert_eq!(reply, corpus("err_unauthorized"));
        // Response{42, Error{1 code: 11}} and no other Error field.
        assert!(reply.ends_with(&[255, 0, 0, 0, 2, 1, 11]));
        assert_eq!((actions, jobs), (0, 0));
        // Control: the same dispatch without tags 5/6 does reach the provider.
        let (_, actions, jobs) = exchange(&corpus("local_open_session"));
        assert_eq!((actions, jobs), (1, 1));
    }
}
