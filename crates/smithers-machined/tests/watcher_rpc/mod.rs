use super::*;
use smithers_machined::broker::sessions::{Admission, Controls, Kind, Sessions, User};
use smithers_machined::{
    conn::{self, Frame},
    hooks::{self, Actor, Base, Core, EventSink, Hooks, Sessions as SessionHook},
    lock::{Executor, LockCx},
    rpc,
    watch::InotifyWatcher,
};
use std::{
    io::Cursor,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::{Arc, Mutex},
};
struct Control;
impl Controls for Control {
    fn close(&mut self, _: u32, _: Kind) -> io::Result<()> {
        Ok(())
    }
    fn kill(&mut self, _: u32, _: std::time::Instant) -> io::Result<()> {
        Ok(())
    }
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn oid(s: &str) -> [u8; 20] {
    hex(s).try_into().unwrap()
}
fn hex_oid(s: &[u8; 20]) -> String {
    s.iter().map(|b| format!("{b:02x}")).collect()
}
struct Sink {
    store: Mutex<smithers_machined::outbox_store::Store>,
    frames: Mutex<Vec<Frame>>,
}
impl EventSink for Sink {
    fn append(&self, event: &[u8], pin: Option<[u8; 20]>) -> hooks::Result<(u64, [u8; 16])> {
        assert!(pin.is_some());
        let mut id = [0; 16];
        let mut store = self.store.lock().unwrap();
        let seq = store
            .append(|seq| {
                id = [seq as u8; 16];
                let f = Frame {
                    kind: 2,
                    stream: 0,
                    payload: conn::tagged(
                        1,
                        &[
                            conn::field(1, seq.to_be_bytes()),
                            conn::field(2, id),
                            conn::field(3, event),
                        ],
                    ),
                };
                self.frames.lock().unwrap().push(f.clone());
                f.encode().map_err(io::Error::other)
            })
            .map_err(|_| hooks::Error::unsupported())?;
        Ok((seq, id))
    }
    fn hint(&self, hint: &[u8]) -> hooks::Result<()> {
        let f = Frame {
            kind: 2,
            stream: 0,
            payload: conn::tagged(2, &[conn::field(1, hint)]),
        };
        assert!(f.encode().is_ok());
        self.frames.lock().unwrap().push(f);
        Ok(())
    }
}
struct Shared {
    f: Mutex<Fixture>,
    sessions: Mutex<Sessions<Control>>,
    sink: Arc<Sink>,
    unavailable: Mutex<Option<&'static str>>,
    moved_error: Mutex<Option<u8>>,
}
struct Ports(Arc<Shared>);
impl Objects for Ports {
    type Blob = [u8; 20];
    type Commit = [u8; 20];
    fn blob(&mut self, b: &[u8]) -> io::Result<[u8; 20]> {
        Ok(oid(&self.0.f.lock().unwrap().blob(b)?))
    }
    fn parentless(&mut self, t: &BTreeMap<String, ([u8; 20], u32)>) -> io::Result<[u8; 20]> {
        let tree = t
            .iter()
            .map(|(p, (id, m))| (p.clone(), (hex_oid(id), *m)))
            .collect();
        Ok(oid(&self.0.f.lock().unwrap().parentless(&tree)?))
    }
}
impl Provider<Actor> for Ports {
    fn activate(&mut self) -> io::Result<()> {
        if let Some(name) = *self.0.unavailable.lock().unwrap() {
            Err(io::Error::new(io::ErrorKind::Unsupported, name))
        } else {
            Ok(())
        }
    }
    fn actor_session(&mut self, actor: &Actor) -> io::Result<Option<u32>> {
        let sessions = self.0.sessions.lock().unwrap();
        let ids = sessions
            .entries()
            .filter(|e| match actor {
                Actor::Session(id) => e.id == *id,
                Actor::Run(run) => e.run.as_ref() == Some(run),
                Actor::Principal(p) => p.as_slice() == e.user.login.as_bytes(),
                Actor::Outside => false,
            })
            .map(|e| e.id)
            .collect::<Vec<_>>();
        Ok(if ids.len() == 1 { Some(ids[0]) } else { None })
    }
    fn samples(&mut self) -> io::Result<Vec<Sample<Actor>>> {
        let f = self.0.f.lock().unwrap();
        let sessions = self.0.sessions.lock().unwrap();
        let counters = sessions
            .entries()
            .map(|e| (e.id, f.cpu[e.id as usize - 1], true))
            .collect::<Vec<_>>();
        smithers_machined::session::samples(sessions.entries(), &counters, |e| {
            if e.user.uid == 19999 {
                e.run.clone().map(Actor::Run)
            } else {
                Some(Actor::Session(e.id))
            }
        })
    }
    fn read(&mut self, path: &str) -> io::Result<Option<(Vec<u8>, u32)>> {
        self.0.f.lock().unwrap().read(path)
    }
    fn checkpoint(&mut self, _: &Checkpoint<Actor, [u8; 20]>) -> io::Result<()> {
        Ok(())
    } // missing shared core is a fixture
    fn append(&mut self, e: &Closed<Actor, [u8; 20], [u8; 20]>) -> io::Result<()> {
        for event in smithers_machined::events::wire_events(e).map_err(io::Error::other)? {
            self.0
                .sink
                .append(&event, Some(e.versions_commit))
                .map_err(|_| io::Error::other("outbox"))?;
        }
        Ok(())
    }
    fn hint(&mut self, p: &str, a: Option<&Actor>, d: Option<[u8; 32]>) -> io::Result<()> {
        let h = conn::file_written(p, a.unwrap_or(&Actor::Outside), d).map_err(io::Error::other)?;
        self.0.sink.hint(&h).map_err(|_| io::Error::other("hint"))
    }
    fn where_file(&mut self, _: u32, _: &str) -> io::Result<()> {
        panic!("watcher must use its authenticated session sink")
    }
    fn moved_off(&mut self) -> io::Result<()> {
        if let Some(code) = *self.0.moved_error.lock().unwrap() {
            let mut e = hooks::Error::unsupported();
            e.code = code;
            return Err(smithers_machined::watch::provider_error(e));
        }
        self.0.f.lock().unwrap().moved_off()
    }
    fn snapshot(&mut self) -> io::Result<()> {
        self.0.f.lock().unwrap().snapshot()
    }
}
struct CoreFixture(Arc<Shared>);
impl Core for CoreFixture {
    fn call(&self, cx: &mut LockCx, method: u8, args: &[u8]) -> hooks::Result<Vec<u8>> {
        if method != 3 {
            return Err(hooks::Error::unsupported());
        }
        let req = conn::write_args(args).unwrap();
        let fail = || {
            let mut e = hooks::Error::unsupported();
            e.code = 6;
            e
        };
        if !smithers_machined::doc::disk::valid_path(&req.path) {
            return Err(fail());
        }
        let watcher = cx.hooks.watcher.clone();
        watcher.before_write(&req.path, &req.actor)?;
        // The unavailable shared core is a fixture, with real confined IO.
        // Writers are sequential here; atomic stale-write races remain the
        // dependency-owned core gate, not watcher component evidence.
        use sha2::Digest as _;
        let old = self
            .0
            .f
            .lock()
            .unwrap()
            .read(&req.path)
            .map_err(|_| fail())?;
        let current: Option<[u8; 32]> = old.as_ref().map(|(b, _)| sha2::Sha256::digest(b).into());
        let matches = match &req.base {
            Base::Absent => old.is_none(),
            Base::Digest(d) => current.as_ref() == Some(d),
        };
        if !matches {
            let mut e = hooks::Error::unsupported();
            e.code = 4;
            e.current_digest = current;
            return Err(e);
        }
        let root = File::open(&self.0.f.lock().unwrap().root).unwrap();
        let flags = if old.is_none() {
            rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL
        } else {
            rustix::fs::OFlags::TRUNC
        };
        let fd = rustix::fs::openat2(
            &root,
            &req.path,
            rustix::fs::OFlags::WRONLY
                | flags
                | rustix::fs::OFlags::CLOEXEC
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK,
            if old.is_none() {
                rustix::fs::Mode::from_raw_mode(0o644)
            } else {
                rustix::fs::Mode::empty()
            },
            rustix::fs::ResolveFlags::BENEATH
                | rustix::fs::ResolveFlags::NO_SYMLINKS
                | rustix::fs::ResolveFlags::NO_XDEV,
        )
        .map_err(|_| fail())?;
        let mut file = File::from(fd);
        file.write_all(&req.content).unwrap();
        file.sync_all().unwrap();
        drop(file);
        watcher.after_write(&req.path, &req.actor, &req.content, 0o644)?;
        Ok(conn::structure_bytes(&[conn::field(
            1,
            <[u8; 32]>::from(sha2::Sha256::digest(&req.content)),
        )]))
    }
}
impl SessionHook for CoreFixture {
    fn ready(&self) -> hooks::Result<()> {
        Ok(())
    }
    fn where_file(&self, session: u32, path: &str) -> hooks::Result<()> {
        if !self
            .0
            .sessions
            .lock()
            .unwrap()
            .entries()
            .any(|entry| entry.id == session)
        {
            let mut error = hooks::Error::unsupported();
            error.code = 11;
            return Err(error);
        }
        self.0
            .f
            .lock()
            .unwrap()
            .where_file(session, path)
            .map_err(|_| hooks::Error::unsupported())
    }

    fn call(&self, method: u8, args: &[u8]) -> hooks::Result<Vec<u8>> {
        if method != 10 {
            return Err(hooks::Error::unsupported());
        }
        let (run, session) = conn::register_run_args(args).unwrap();
        self.0
            .sessions
            .lock()
            .unwrap()
            .register_run(session, &run)
            .map_err(|_| {
                let mut e = hooks::Error::unsupported();
                e.code = 11;
                e
            })?;
        Ok(conn::structure_bytes(&[]))
    }
}
fn setup() -> (Arc<Shared>, Executor) {
    assert!(!rustix::process::geteuid().is_root());
    let f = Fixture::new();
    fs::set_permissions(&f.state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(f.state.join("outbox")).unwrap();
    fs::set_permissions(f.state.join("outbox"), fs::Permissions::from_mode(0o700)).unwrap();
    let store = smithers_machined::outbox_store::Store::open(
        &f.state.join("outbox"),
        fs::metadata(&f.state).unwrap().uid(),
    )
    .unwrap();
    let sink = Arc::new(Sink {
        store: Mutex::new(store),
        frames: Mutex::new(vec![]),
    });
    let mut sessions = Sessions::new(Control);
    sessions
        .set_roster(
            &[
                User {
                    login: "ben".into(),
                    uid: 20000,
                },
                User {
                    login: "maya".into(),
                    uid: 20001,
                },
            ],
            std::time::Instant::now(),
        )
        .unwrap();
    sessions
        .insert(
            1,
            User {
                login: "agent".into(),
                uid: 19999,
            },
            Kind::Pty,
            Admission {
                principal: [1; 16],
                run: Some("run-1".into()),
            },
        )
        .unwrap();
    sessions
        .insert(
            2,
            User {
                login: "ben".into(),
                uid: 20000,
            },
            Kind::Pty,
            Admission {
                principal: [2; 16],
                run: None,
            },
        )
        .unwrap();
    sessions
        .insert(
            3,
            User {
                login: "maya".into(),
                uid: 20001,
            },
            Kind::Pty,
            Admission {
                principal: [3; 16],
                run: None,
            },
        )
        .unwrap();
    let watch = Inotify::new(
        File::open(&f.root).unwrap(),
        GitIgnore::new(f.root.clone(), "/usr/bin/git".into(), vec!["target".into()]).unwrap(),
    )
    .unwrap()
    .0;
    let shared = Arc::new(Shared {
        f: Mutex::new(f),
        sessions: Mutex::new(sessions),
        sink: sink.clone(),
        unavailable: Mutex::new(None),
        moved_error: Mutex::new(None),
    });
    let mut cx = LockCx::new(Hooks {
        events: sink,
        sessions: Arc::new(CoreFixture(shared.clone())),
        ..Hooks::default()
    });
    let watcher = Arc::new(
        InotifyWatcher::fixture(watch, Ports(shared.clone()), Checkpoint::default(), &mut cx)
            .unwrap(),
    );
    let hooks = Hooks {
        watcher,
        core: Arc::new(CoreFixture(shared.clone())),
        sessions: Arc::new(CoreFixture(shared.clone())),
        ..cx.hooks
    };
    (shared, Executor::start(hooks).unwrap())
}
fn request(executor: &Executor, bytes: Vec<u8>) -> Vec<u8> {
    executor
        .lock
        .run_blocking("rpc", move |cx| {
            let mut out = vec![];
            rpc::serve_one(&mut Cursor::new(bytes), &mut out, cx).unwrap();
            out
        })
        .unwrap()
}
#[test]
fn encoded_write_dispatches_to_real_watcher_and_durable_outbox() {
    let (shared, executor) = setup();
    shared.f.lock().unwrap().cpu = [100, 100, 100];
    // Independent literal request: a, absent, abc, principal. Expected response
    // contains the standard literal SHA-256 of abc, never a runtime encoder.
    let response=request(&executor,hex("0000003601000000000100000031010000002a02030000002601000161020200000000030000000361626304010000000e01000000097072696e636970616c"));
    assert_eq!(response,hex("000000310100000000020000002c010000002a02030000002101ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    assert_eq!(
        fs::read(shared.f.lock().unwrap().root.join("a")).unwrap(),
        b"abc"
    );
    executor
        .lock
        .run_blocking("close", |cx| {
            let w = cx.hooks.watcher.clone();
            w.close_bursts(cx)
        })
        .unwrap()
        .unwrap();
    let frames = shared.sink.frames.lock().unwrap();
    assert_eq!(frames.len(), 2);
    for f in frames.iter() {
        assert_eq!(Frame::decode(&f.encode().unwrap()).unwrap(), *f);
    }
    // The exact principal stays present even with three active sessions.
    assert!(frames[0].payload.windows(9).any(|b| b == b"principal"));
    assert!(frames[1].payload.windows(9).any(|b| b == b"principal"));
    assert_eq!(
        shared
            .sink
            .store
            .lock()
            .unwrap()
            .sequences()
            .collect::<Vec<_>>(),
        [1]
    );
    drop(frames);
    executor.shutdown().unwrap();
}
#[test]
fn register_run_crosses_dispatch_and_unknown_session_cannot_claim_actor() {
    let (shared, executor) = setup();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/backend/internal/compose/testdata/cocontracts/req_register_run.bin");
    let response = request(&executor, fs::read(path).unwrap());
    assert!(Frame::decode(&response).is_ok());
    assert_eq!(
        shared.sessions.lock().unwrap().local_run(19999, 1).unwrap(),
        "run-1"
    );
    // Same independently committed frame, session 99 instead of registered 1.
    let mut request_bytes =
        hex("0000001d01000000000100000018010000002a020a0000000d01000572756e2d310200000063");
    let response = request(&executor, std::mem::take(&mut request_bytes));
    assert_eq!(
        response,
        hex("000000120100000000020000000d010000002a02ff00000002010b")
    );
    assert!(shared.sink.frames.lock().unwrap().is_empty());
    executor.shutdown().unwrap();
}
#[test]
fn principal_hint_matches_independent_shared_golden_frame() {
    let hint = conn::file_written(
        "a",
        &Actor::Principal(b"principal".to_vec()),
        Some([0x33; 32]),
    )
    .unwrap();
    let f = Frame {
        kind: 2,
        stream: 0,
        payload: conn::tagged(2, &[conn::field(1, hint)]),
    };
    let literal = fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../../packages/backend/internal/compose/testdata/cocontracts/hint_file_written.bin",
    ))
    .unwrap();
    assert_eq!(f.encode().unwrap(), literal);
}

#[test]
fn rpc_refuses_escape_symlink_nonregular_and_forged_run_without_writes() {
    use std::os::unix::fs::symlink;
    let (shared, executor) = setup();
    let outside = shared.f.lock().unwrap().state.join("outside");
    fs::write(&outside, b"unchanged outside").unwrap();
    let root = shared.f.lock().unwrap().root.clone();
    symlink(&outside, root.join("link")).unwrap();
    symlink(shared.f.lock().unwrap().state.clone(), root.join("swapped")).unwrap();
    fs::create_dir(root.join("directory")).unwrap();
    rustix::fs::mknodat(
        rustix::fs::CWD,
        root.join("fifo"),
        rustix::fs::FileType::Fifo,
        rustix::fs::Mode::from_raw_mode(0o600),
        0,
    )
    .unwrap();
    let text = |s: &str| {
        let mut b = (s.len() as u16).to_be_bytes().to_vec();
        b.extend(s.as_bytes());
        b
    };
    for path in ["../outside", "link", "swapped/outside", "directory", "fifo"] {
        let req = Frame {
            kind: 1,
            stream: 0,
            payload: conn::tagged(
                1,
                &[
                    conn::field(1, 42u32.to_be_bytes()),
                    conn::field(
                        2,
                        conn::tagged(
                            3,
                            &[
                                conn::field(1, text(path)),
                                conn::field(2, conn::tagged(2, &[])),
                                conn::field(3, [0, 0, 0, 3, b'a', b'b', b'c']),
                                conn::field(
                                    4,
                                    conn::actor_bytes(&Actor::Principal(b"principal".to_vec())),
                                ),
                            ],
                        ),
                    ),
                ],
            ),
        };
        let response = request(&executor, req.encode().unwrap());
        assert_eq!(
            response,
            hex("000000120100000000020000000d010000002a02ff000000020106"),
            "{path}"
        );
    }
    // A host write cannot claim a run; host_actor accepts only authenticated
    // principal envelopes. Local run attribution belongs to the shared core.
    let forged = Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 42u32.to_be_bytes()),
                conn::field(
                    2,
                    conn::tagged(
                        3,
                        &[
                            conn::field(1, text("forged")),
                            conn::field(2, conn::tagged(2, &[])),
                            conn::field(3, [0, 0, 0, 3, b'a', b'b', b'c']),
                            conn::field(4, conn::actor_bytes(&Actor::Run("run-1".into()))),
                        ],
                    ),
                ),
            ],
        ),
    };
    // Encode the envelope literally; the production encoder correctly refuses
    // this payload, while serve_one must return a correlated malformed error.
    let mut bytes = (forged.payload.len() as u32).to_be_bytes().to_vec();
    bytes.extend([1, 0, 0, 0, 0]);
    bytes.extend(forged.payload);
    let response = request(&executor, bytes);
    assert_eq!(
        response,
        hex("000000140100000000020000000f010000002a02ff000000040101060c")
    );
    assert_eq!(fs::read(outside).unwrap(), b"unchanged outside");
    assert!(!root.join("forged").exists());
    assert!(shared.sink.frames.lock().unwrap().is_empty());
    executor.shutdown().unwrap();
}

#[test]
fn failed_overflow_moved_off_check_keeps_dispatcher_writes_refused() {
    let (shared, executor) = setup();
    shared.f.lock().unwrap().moved_ok = false;
    assert!(executor
        .lock
        .run_blocking("overflow", |cx| {
            let w = cx.hooks.watcher.clone();
            w.resync(cx)
        })
        .unwrap()
        .is_err());
    let response=request(&executor,hex("0000003601000000000100000031010000002a02030000002601000161020200000000030000000361626304010000000e01000000097072696e636970616c"));
    assert_eq!(Frame::decode(&response).unwrap().payload[17], 3);
    assert!(!shared.f.lock().unwrap().root.join("a").exists());
    assert!(shared.sink.frames.lock().unwrap().is_empty());
    executor.shutdown().unwrap();
}
#[test]
fn large_bursts_split_before_frame_or_file_count_bounds() {
    let v = Version {
        blob: [0x22; 20],
        post_digest: [0x33; 32],
        mode: 0o100644,
    };
    let files = (0..66_000)
        .map(|i| {
            (
                format!("p/{i:05}"),
                BurstFile {
                    before: None,
                    after: Some(v.clone()),
                },
            )
        })
        .collect();
    let event = Closed {
        burst_id: [0x11; 16],
        actor: Some(Actor::Outside),
        session: None,
        files,
        versions_commit: [0x44; 20],
        renamed_to: BTreeMap::new(),
        last_path: "p/65999".into(),
    };
    let parts = smithers_machined::events::wire_events(&event).unwrap();
    assert!(parts.len() > 1);
    let mut total = 0;
    for (i, event) in parts.iter().enumerate() {
        // Literal field offsets: union+len (5), burst id (17), outside actor
        // (6), files tag (1), list count (2). Stable ADR 0004 values.
        total += u16::from_be_bytes(event[29..31].try_into().unwrap()) as usize;
        assert_eq!(
            &event[event.len() - 6..],
            &[5, 0, (i + 1) as u8, 6, 0, parts.len() as u8]
        );
        let frame = Frame {
            kind: 2,
            stream: 0,
            payload: conn::tagged(
                1,
                &[
                    conn::field(1, 1u64.to_be_bytes()),
                    conn::field(2, [0; 16]),
                    conn::field(3, event),
                ],
            ),
        };
        let bytes = frame.encode().unwrap();
        assert!(bytes.len() <= 4 * 1024 * 1024 + 9);
        Frame::decode(&bytes).unwrap();
    }
    assert_eq!(total, 66_000);
}

#[test]
fn activation_checks_every_required_provider_even_on_empty_workspace() {
    let (shared, executor) = setup();
    shared.f.lock().unwrap().order.clear();
    for missing in [
        "codec",
        "lock",
        "checkpoint",
        "durable outbox",
        "versions refs",
        "authenticated host",
        "session registry",
        "daemon identity",
        "moved-off",
    ] {
        *shared.unavailable.lock().unwrap() = Some(missing);
        assert_eq!(
            executor
                .lock
                .run_blocking("ready", |cx| cx.hooks.watcher.ready())
                .unwrap()
                .unwrap_err()
                .code,
            2,
            "{missing}"
        );
        let root = shared.f.lock().unwrap().root.clone();
        let watch = Inotify::new(
            File::open(&root).unwrap(),
            GitIgnore::new(root, "/usr/bin/git".into(), vec![]).unwrap(),
        )
        .unwrap()
        .0;
        let s = shared.clone();
        let result = executor
            .lock
            .run_blocking("activate", move |cx| {
                InotifyWatcher::fixture(watch, Ports(s), Checkpoint::default(), cx).map(|_| ())
            })
            .unwrap();
        assert_eq!(result.unwrap_err().code, 2, "{missing}");
        assert!(shared.sink.frames.lock().unwrap().is_empty());
        assert!(shared.f.lock().unwrap().order.is_empty());
    }
    executor.shutdown().unwrap();
}

#[test]
fn encoded_own_write_to_ignored_path_produces_no_hint_or_burst() {
    let (shared, executor) = setup();
    fs::create_dir(shared.f.lock().unwrap().root.join("target")).unwrap();
    let path = b"target/a";
    let mut text = (path.len() as u16).to_be_bytes().to_vec();
    text.extend(path);
    let req = Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 42u32.to_be_bytes()),
                conn::field(
                    2,
                    conn::tagged(
                        3,
                        &[
                            conn::field(1, text),
                            conn::field(2, conn::tagged(2, &[])),
                            conn::field(3, [0, 0, 0, 3, b'a', b'b', b'c']),
                            conn::field(
                                4,
                                conn::actor_bytes(&Actor::Principal(b"principal".to_vec())),
                            ),
                        ],
                    ),
                ),
            ],
        ),
    };
    let response = request(&executor, req.encode().unwrap());
    assert_eq!(response,hex("000000310100000000020000002c010000002a02030000002101ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    executor
        .lock
        .run_blocking("close", |cx| {
            let w = cx.hooks.watcher.clone();
            w.close_bursts(cx)
        })
        .unwrap()
        .unwrap();
    assert!(shared.sink.frames.lock().unwrap().is_empty());
    assert!(shared
        .sink
        .store
        .lock()
        .unwrap()
        .sequences()
        .next()
        .is_none());
    assert_eq!(
        fs::read(shared.f.lock().unwrap().root.join("target/a")).unwrap(),
        b"abc"
    );
    executor.shutdown().unwrap();
}

pub(super) fn fault_delivery(event: &super::Event, state: &std::path::Path) {
    fs::set_permissions(state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(state.join("outbox")).unwrap();
    fs::set_permissions(state.join("outbox"), fs::Permissions::from_mode(0o700)).unwrap();
    let owner = fs::metadata(state).unwrap().uid();
    let store = smithers_machined::outbox_store::Store::open(&state.join("outbox"), owner).unwrap();
    let sink = Sink {
        store: Mutex::new(store),
        frames: Mutex::new(vec![]),
    };
    let version = |v: &Option<Version<String>>| {
        v.as_ref().map(|v| Version {
            blob: oid(&v.blob),
            post_digest: v.post_digest,
            mode: v.mode,
        })
    };
    let files = event
        .files
        .iter()
        .map(|(p, v)| {
            (
                p.clone(),
                BurstFile {
                    before: version(&v.before),
                    after: version(&v.after),
                },
            )
        })
        .collect();
    let record = Closed {
        burst_id: event.burst_id,
        actor: None,
        session: None,
        files,
        versions_commit: oid(&event.versions_commit),
        renamed_to: event.renamed_to.clone(),
        last_path: event.last_path.clone(),
    };
    let events = smithers_machined::events::wire_events(&record).unwrap();
    assert_eq!(events.len(), 1);
    sink.append(&events[0], Some(record.versions_commit))
        .unwrap();
    let durable = sink.store.lock().unwrap().read(1, owner).unwrap();
    Frame::decode(&durable).unwrap();
    fs::write(state.join("outbox-durable.bin"), durable).unwrap();
    // Fixture host ACK uses independent ADR literal bytes. Production core owns
    // transport and receipt matching; Store supplies the durable FIFO removal.
    let bytes = hex("000000100200000000030000000b0100000000000000010201");
    let ack = Frame::decode(&bytes).unwrap();
    assert_eq!(ack.payload[15], 1);
    let seq = u64::from_be_bytes(ack.payload[6..14].try_into().unwrap());
    sink.store.lock().unwrap().remove(seq, false).unwrap();
    assert!(sink.store.lock().unwrap().sequences().next().is_none());
    fs::write(state.join("host-ack.bin"), bytes).unwrap();
    fs::write(state.join("outbox-after-ack.json"), b"[]\n").unwrap();
}

#[test]
fn known_moved_off_keeps_shared_typed_error_at_rpc_boundary() {
    let (shared, executor) = setup();
    *shared.moved_error.lock().unwrap() = Some(10);
    assert_eq!(
        executor
            .lock
            .run_blocking("overflow", |cx| {
                let w = cx.hooks.watcher.clone();
                w.resync(cx)
            })
            .unwrap()
            .unwrap_err()
            .code,
        10
    );
    let response=request(&executor,hex("0000003601000000000100000031010000002a02030000002601000161020200000000030000000361626304010000000e01000000097072696e636970616c"));
    assert_eq!(
        response,
        hex("000000120100000000020000000d010000002a02ff00000002010a")
    );
    assert!(!shared.f.lock().unwrap().root.join("a").exists());
    executor.shutdown().unwrap();
}

fn write_request(path: &str, base: Option<[u8; 32]>, content: &[u8], principal: &[u8]) -> Vec<u8> {
    let mut text = (path.len() as u16).to_be_bytes().to_vec();
    text.extend(path.as_bytes());
    let mut bytes = (content.len() as u32).to_be_bytes().to_vec();
    bytes.extend(content);
    let base = match base {
        Some(d) => conn::tagged(1, &[conn::field(1, d)]),
        None => conn::tagged(2, &[]),
    };
    Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 42u32.to_be_bytes()),
                conn::field(
                    2,
                    conn::tagged(
                        3,
                        &[
                            conn::field(1, text),
                            conn::field(2, base),
                            conn::field(3, bytes),
                            conn::field(4, conn::actor_bytes(&Actor::Principal(principal.into()))),
                        ],
                    ),
                ),
            ],
        ),
    }
    .encode()
    .unwrap()
}
fn close(executor: &Executor) {
    executor
        .lock
        .run_blocking("close", |cx| {
            let w = cx.hooks.watcher.clone();
            w.close_bursts(cx)
        })
        .unwrap()
        .unwrap();
}
fn burst_commits(shared: &Shared) -> Vec<(String, Vec<u8>)> {
    shared
        .sink
        .frames
        .lock()
        .unwrap()
        .iter()
        .filter(|f| f.payload[0] == 1)
        .map(|f| {
            (
                hex_oid(&f.payload[f.payload.len() - 20..].try_into().unwrap()),
                f.payload.clone(),
            )
        })
        .collect()
}
#[test]
fn encoded_actor_switch_and_overlapping_files_keep_exact_before_after_bytes() {
    for same_file in [true, false] {
        let (shared, executor) = setup();
        shared.f.lock().unwrap().cpu = [100, 100, 100];
        let abc: [u8; 32] = hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
            .try_into()
            .unwrap();
        let first = request(&executor, write_request("a", None, b"abc", b"maya"));
        assert_eq!(Frame::decode(&first).unwrap().payload[11], 3);
        let path = if same_file { "a" } else { "b" };
        let second = request(
            &executor,
            write_request(
                path,
                if same_file { Some(abc) } else { None },
                b"def",
                b"ben",
            ),
        );
        assert_eq!(
            Frame::decode(&second).unwrap().payload[17..49],
            hex("cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34")
        );
        close(&executor);
        let commits = burst_commits(&shared);
        assert_eq!(commits.len(), 2);
        assert!(commits[0].1.windows(4).any(|b| b == b"maya"));
        assert!(commits[1].1.windows(3).any(|b| b == b"ben"));
        let f = shared.f.lock().unwrap();
        assert_eq!(f.where_file, vec![(3, "a".into()), (2, path.into())]);
        assert_eq!(
            f.git(&["show", &format!("{}:b/a", commits[0].0)], None)
                .unwrap(),
            "abc"
        );
        assert_eq!(
            f.git(&["show", &format!("{}:b/{path}", commits[1].0)], None)
                .unwrap(),
            "def"
        );
        if same_file {
            assert_eq!(
                f.git(&["show", &format!("{}:a/a", commits[1].0)], None)
                    .unwrap(),
                "abc"
            );
        }
        drop(f);
        executor.shutdown().unwrap();
    }
}
#[test]
fn pending_external_close_is_durable_before_encoded_rpc_write() {
    let (shared, executor) = setup();
    let state = shared.clone();
    executor
        .lock
        .run_blocking("external write", move |cx| {
            state.f.lock().unwrap().write("a", b"abc");
            let watcher = cx.hooks.watcher.clone();
            watcher.drain(cx)?;
            state.f.lock().unwrap().cpu[1] = 100;
            watcher.drain(cx)
        })
        .unwrap()
        .unwrap();
    let abc = hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        .try_into()
        .unwrap();
    let response = request(&executor, write_request("a", Some(abc), b"def", b"maya"));
    assert_eq!(Frame::decode(&response).unwrap().payload[11], 3);
    close(&executor);
    let commits = burst_commits(&shared);
    assert_eq!(commits.len(), 2);
    let f = shared.f.lock().unwrap();
    assert_eq!(
        f.git(&["show", &format!("{}:b/a", commits[0].0)], None)
            .unwrap(),
        "abc"
    );
    assert_eq!(
        f.git(&["show", &format!("{}:a/a", commits[1].0)], None)
            .unwrap(),
        "abc"
    );
    assert_eq!(
        f.git(&["show", &format!("{}:b/a", commits[1].0)], None)
            .unwrap(),
        "def"
    );
    drop(f);
    executor.shutdown().unwrap();
}
#[test]
fn registered_run_external_write_uses_run_actor_and_presence_hook() {
    let (shared, executor) = setup();
    request(
        &executor,
        fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../../packages/backend/internal/compose/testdata/cocontracts/req_register_run.bin",
        ))
        .unwrap(),
    );
    let state = shared.clone();
    executor
        .lock
        .run_blocking("attributed write", move |cx| {
            state.f.lock().unwrap().write("a", b"run bytes");
            let watcher = cx.hooks.watcher.clone();
            watcher.drain(cx)?;
            state.f.lock().unwrap().cpu[0] = 100;
            watcher.close_bursts(cx)
        })
        .unwrap()
        .unwrap();
    let commits = burst_commits(&shared);
    assert_eq!(commits.len(), 1);
    assert!(commits[0].1.windows(5).any(|b| b == b"run-1"));
    assert_eq!(shared.f.lock().unwrap().where_file, vec![(1, "a".into())]);
    executor.shutdown().unwrap();
}

#[test]
fn late_jj_metadata_blocks_rpc_until_debounced_moved_off_check() {
    let (shared, executor) = setup();
    let root = shared.f.lock().unwrap().root.clone();
    fs::create_dir_all(root.join(".jj/repo/op_heads/heads")).unwrap();
    fs::write(root.join(".jj/repo/op_heads/heads/op1"), b"operation").unwrap();
    let response = request(&executor, write_request("a", None, b"abc", b"maya"));
    assert_eq!(Frame::decode(&response).unwrap().payload[11], 255);
    assert!(!root.join("a").exists());
    assert!(shared.sink.frames.lock().unwrap().is_empty());
    std::thread::sleep(std::time::Duration::from_millis(210));
    let response = request(&executor, write_request("a", None, b"abc", b"maya"));
    assert_eq!(Frame::decode(&response).unwrap().payload[11], 3);
    close(&executor);
    assert_eq!(burst_commits(&shared).len(), 1);
    // Subsequent op-head writes must remain visible through the new watch.
    fs::write(root.join(".jj/repo/op_heads/heads/op2"), b"next").unwrap();
    let response = request(&executor, write_request("b", None, b"def", b"ben"));
    assert_eq!(Frame::decode(&response).unwrap().payload[11], 255);
    assert!(!root.join("b").exists());
    executor.shutdown().unwrap();
}

#[test]
fn watcher_presence_requires_session_sink_before_activation() {
    let (shared, executor) = setup();
    let root = shared.f.lock().unwrap().root.clone();
    let watch = Inotify::new(
        File::open(&root).unwrap(),
        GitIgnore::new(root, "/usr/bin/git".into(), vec![]).unwrap(),
    )
    .unwrap()
    .0;
    shared.f.lock().unwrap().order.clear();
    let state = shared.clone();
    let result = executor
        .lock
        .run_blocking("activate", move |cx| {
            let previous = cx.hooks.sessions.clone();
            cx.hooks.sessions = Arc::new(hooks::Disabled);
            let result =
                InotifyWatcher::fixture(watch, Ports(state), Checkpoint::default(), cx).map(|_| ());
            cx.hooks.sessions = previous;
            result
        })
        .unwrap();
    assert_eq!(result.unwrap_err().code, 2);
    assert!(shared.f.lock().unwrap().order.is_empty());
    assert!(shared.sink.frames.lock().unwrap().is_empty());
    executor.shutdown().unwrap();
}

#[test]
fn idle_observation_drains_real_inotify_and_blocks_open_bursts() {
    let (shared, executor) = setup();
    let idle = || {
        executor
            .lock
            .run_blocking("idle", |cx| {
                let watcher = cx.hooks.watcher.clone();
                watcher.idle(cx)
            })
            .unwrap()
    };
    assert!(idle().unwrap());
    fs::write(
        shared.f.lock().unwrap().root.join("idle.txt"),
        b"unsaved member bytes",
    )
    .unwrap();
    assert!(!idle().unwrap());
    close(&executor);
    assert!(idle().unwrap());
    executor.shutdown().unwrap();
}
