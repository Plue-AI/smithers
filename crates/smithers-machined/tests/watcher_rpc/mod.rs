use super::*;
use smithers_machined::broker::sessions::{Controls, Kind, Sessions, User};
use smithers_machined::{
    conn::{self, Frame},
    hooks::{self, Actor, Base, Core, EventSink, Hooks, Sessions as SessionHook, WriteRecord},
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
        let event = smithers_machined::events::wire_event(e).map_err(io::Error::other)?;
        self.0
            .sink
            .append(&event, Some(e.versions_commit))
            .map_err(|_| io::Error::other("outbox"))?;
        Ok(())
    }
    fn hint(&mut self, p: &str, a: Option<&Actor>, d: Option<[u8; 32]>) -> io::Result<()> {
        let h = conn::file_written(p, a.unwrap_or(&Actor::Outside), d).map_err(io::Error::other)?;
        self.0.sink.hint(&h).map_err(|_| io::Error::other("hint"))
    }
    fn where_file(&mut self, s: u32, p: &str) -> io::Result<()> {
        self.0.f.lock().unwrap().where_file(s, p)
    }
    fn moved_off(&mut self) -> io::Result<()> {
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
        watcher.before_write(cx, &req.path, &req.actor)?;
        // Shared core is the authorized fixture. Kernel-confined create is
        // enough for this absent-base boundary; no product write path is added.
        if req.base != Base::Absent {
            return Err(hooks::Error::unsupported());
        }
        let (root, before) = {
            let f = self.0.f.lock().unwrap();
            (File::open(&f.root).unwrap(), None)
        };
        let fd = rustix::fs::openat2(
            &root,
            &req.path,
            rustix::fs::OFlags::WRONLY
                | rustix::fs::OFlags::CREATE
                | rustix::fs::OFlags::EXCL
                | rustix::fs::OFlags::CLOEXEC
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK,
            rustix::fs::Mode::from_raw_mode(0o644),
            rustix::fs::ResolveFlags::BENEATH
                | rustix::fs::ResolveFlags::NO_SYMLINKS
                | rustix::fs::ResolveFlags::NO_XDEV,
        )
        .map_err(|_| fail())?;
        let mut file = File::from(fd);
        file.write_all(&req.content).unwrap();
        file.sync_all().unwrap();
        drop(file);
        let version = versions::record(&mut Ports(self.0.clone()), &req.content, 0o100644).unwrap();
        watcher.after_write(
            cx,
            &WriteRecord {
                path: req.path,
                actor: req.actor,
                before,
                after: version.blob,
                post_digest: version.post_digest,
            },
        )?;
        Ok(conn::structure_bytes(&[conn::field(
            1,
            version.post_digest,
        )]))
    }
}
impl SessionHook for CoreFixture {
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
        .insert(
            1,
            User {
                login: "agent".into(),
                uid: 19999,
            },
            Kind::Exec,
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
        )
        .unwrap();
    let watch = Inotify::new(
        File::open(&f.root).unwrap(),
        GitIgnore::new(f.root.clone(), "/usr/bin/git".into(), vec![]).unwrap(),
    )
    .unwrap()
    .0;
    let shared = Arc::new(Shared {
        f: Mutex::new(f),
        sessions: Mutex::new(sessions),
        sink: sink.clone(),
    });
    let mut cx = LockCx::new(Hooks {
        events: sink,
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
