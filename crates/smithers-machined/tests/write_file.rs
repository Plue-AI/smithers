#![cfg(target_os = "linux")]
//! Component boundary: authenticated TCP -> production codec -> FIFO dispatcher
//! -> actual openat2/renameat2. This is not guest-init or install acceptance.
use sha2::{Digest as _, Sha256};
use smithers_machined::{
    conn::{self, Frame},
    files::{Contents, FileCore, Files, Versions},
    hooks::{self, Actor, Core, Digest, Hooks, Oid, Watcher, WriteRecord},
    link::{self, Identity},
    lock::{Executor, LockCx},
    rpc,
};
use std::{
    fs::{self, File},
    net::{TcpListener, TcpStream},
    os::unix::{
        fs::{symlink, PermissionsExt},
        net::UnixListener,
    },
    path::PathBuf,
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
fn structure(fields: &[(u8, Vec<u8>)]) -> Vec<u8> {
    let mut body = vec![];
    for (tag, bytes) in fields {
        body.push(*tag);
        body.extend(bytes);
    }
    let mut result = (body.len() as u32).to_be_bytes().to_vec();
    result.extend(body);
    result
}
fn tagged(tag: u8, fields: &[(u8, Vec<u8>)]) -> Vec<u8> {
    let mut b = vec![tag];
    b.extend(structure(fields));
    b
}
fn string(value: &str) -> Vec<u8> {
    let mut b = (value.len() as u16).to_be_bytes().to_vec();
    b.extend(value.as_bytes());
    b
}
fn content(bytes: &[u8]) -> Vec<u8> {
    let mut b = (bytes.len() as u32).to_be_bytes().to_vec();
    b.extend(bytes);
    b
}
fn base(bytes: Option<&[u8]>) -> Vec<u8> {
    match bytes {
        Some(b) => tagged(1, &[(1, Sha256::digest(b).to_vec())]),
        None => tagged(2, &[]),
    }
}
fn write(path: &str, old: Option<&[u8]>, bytes: &[u8]) -> Vec<u8> {
    tagged(
        3,
        &[
            (1, string(path)),
            (2, base(old)),
            (3, content(bytes)),
            (4, tagged(1, &[(1, content(b"member-fixture"))])),
        ],
    )
}
fn read(path: &str) -> Vec<u8> {
    tagged(2, &[(1, string(path))])
}
#[derive(Default)]
struct Recorder {
    writes: Mutex<Vec<(String, Actor, Digest)>>,
}
impl Watcher for Recorder {
    fn before_write(&self, _: &mut LockCx, _: &str, _: &Actor) -> hooks::Result<()> {
        Ok(())
    }
    fn after_write(&self, _: &mut LockCx, w: &WriteRecord) -> hooks::Result<()> {
        self.writes
            .lock()
            .unwrap()
            .push((w.path.clone(), w.actor.clone(), w.post_digest));
        Ok(())
    }
}
struct Ready;
impl Core for Ready {
    fn admit_files(&self) -> hooks::Result<()> {
        Ok(())
    }
}
struct Objects {
    root: PathBuf,
    race: Mutex<Option<(String, Vec<u8>)>>,
}
impl Versions for Objects {
    fn blob(&self, bytes: &[u8]) -> hooks::Result<Oid> {
        // Second blob is the proposed bytes: the outside rename occurs after
        // the RPC's digest read but before its exchange. No production pause hook.
        if bytes == b"proposal" {
            if let Some((path, bytes)) = self.race.lock().unwrap().take() {
                fs::write(self.root.join("outside-write"), bytes).unwrap();
                fs::rename(self.root.join("outside-write"), self.root.join(path)).unwrap();
            }
        }
        Ok(Sha256::digest(bytes)[..20].try_into().unwrap())
    }
    fn read_at(&self, _: &str, _: Oid) -> hooks::Result<Contents> {
        Err(hooks::Error::unsupported())
    }
}
struct Fixture {
    root: PathBuf,
    socket: TcpStream,
    worker: Option<JoinHandle<()>>,
    objects: Arc<Objects>,
    recorder: Arc<Recorder>,
}
impl Fixture {
    fn new(ready: bool, watcher: bool) -> Self {
        Self::with_git(ready, watcher, false)
    }
    fn with_git(ready: bool, watcher: bool, real_git: bool) -> Self {
        assert_eq!(
            rustix::process::geteuid().as_raw(),
            19998,
            "run as machined inside Linux"
        );
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!(
            "machined-files-{}",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ));
        fs::create_dir(&root).unwrap();
        let objects = Arc::new(Objects {
            root: root.clone(),
            race: Mutex::new(None),
        });
        let recorder = Arc::new(Recorder::default());
        let versions: Arc<dyn Versions> = if real_git {
            Arc::new(
                smithers_machined::objects::GitObjects::new(
                    std::path::Path::new("/usr/bin/git"),
                    &root,
                )
                .unwrap(),
            )
        } else {
            objects.clone()
        };
        let files = Files::new(File::open(&root).unwrap(), versions).unwrap();
        let lifecycle: Arc<dyn Core> = if ready {
            Arc::new(Ready)
        } else {
            Arc::new(hooks::Disabled)
        };
        let core = Arc::new(FileCore { files, lifecycle });
        let hooks = Hooks {
            core,
            watcher: if watcher {
                recorder.clone()
            } else {
                Arc::new(hooks::Disabled)
            },
            ..Hooks::default()
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let executor = Executor::start(hooks).unwrap();
            let identity = Identity::new([4; 16], [9; 32], b"component-fixture".to_vec()).unwrap();
            let (socket, _) = listener.accept().unwrap();
            let mut auth = link::authenticate(socket, &identity, 1, &[]).unwrap();
            while let Ok(frame) = Frame::read(auth.stream()) {
                let response = executor
                    .lock
                    .run_blocking("rpc", move |cx| rpc::dispatch(&frame, cx))
                    .unwrap()
                    .unwrap();
                response.write(auth.stream()).unwrap();
            }
            executor.shutdown().unwrap();
        });
        let mut socket = TcpStream::connect(addr).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let challenge = Frame::read(&mut socket).unwrap();
        let fields = conn::fields("challenge", &challenge.payload[1..]).unwrap();
        let mac = conn::host_mac(
            &[9; 32],
            &fields[2].1.try_into().unwrap(),
            &fields[3].1.try_into().unwrap(),
        );
        Frame {
            kind: 0,
            stream: 0,
            payload: tagged(2, &[(1, 1u16.to_be_bytes().to_vec()), (2, mac.to_vec())]),
        }
        .write(&mut socket)
        .unwrap();
        assert_eq!(Frame::read(&mut socket).unwrap().payload[0], 3);
        Frame {
            kind: 0,
            stream: 0,
            payload: tagged(4, &[]),
        }
        .write(&mut socket)
        .unwrap();
        Self {
            root,
            socket,
            worker: Some(worker),
            objects,
            recorder,
        }
    }
    fn call(&mut self, call: Vec<u8>) -> Vec<u8> {
        Frame {
            kind: 1,
            stream: 0,
            payload: tagged(1, &[(1, 17u32.to_be_bytes().to_vec()), (2, call)]),
        }
        .write(&mut self.socket)
        .unwrap();
        let reply = Frame::read(&mut self.socket).unwrap();
        let fields = conn::fields("response", &reply.payload[1..]).unwrap();
        assert_eq!(fields[0].1, 17u32.to_be_bytes());
        fields[1].1.to_vec()
    }
    fn refusal(&mut self, call: Vec<u8>, code: u8) -> Vec<u8> {
        let result = self.call(call);
        assert_eq!(result[0], 255, "{result:?}");
        let fields = conn::fields("error", &result[1..]).unwrap();
        assert_eq!(fields[0].1, [code]);
        result
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.socket.shutdown(std::net::Shutdown::Both).unwrap();
        self.worker.take().unwrap().join().unwrap();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn authenticated_writes_compare_base_preserve_mode_and_record_actor() {
    let mut f = Fixture::new(true, true);
    fs::write(f.root.join("file"), b"base").unwrap();
    fs::set_permissions(f.root.join("file"), fs::Permissions::from_mode(0o775)).unwrap();
    let result = f.call(write("file", Some(b"base"), b"next"));
    assert_eq!(result, tagged(3, &[(1, Sha256::digest(b"next").to_vec())]));
    assert_eq!(fs::read(f.root.join("file")).unwrap(), b"next");
    assert_eq!(
        fs::metadata(f.root.join("file"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o775
    );
    let result = f.call(read("file"));
    assert_eq!(
        result,
        tagged(
            2,
            &[
                (1, content(b"next")),
                (2, Sha256::digest(b"next").to_vec()),
                (3, 0o775u32.to_be_bytes().to_vec())
            ]
        )
    );
    for old in [Some(b"base".as_slice()), None] {
        let refused = f.refusal(write("file", old, b"lost"), 4);
        assert_eq!(
            refused,
            tagged(255, &[(1, vec![4]), (3, Sha256::digest(b"next").to_vec())])
        );
    }
    assert_eq!(fs::read(f.root.join("file")).unwrap(), b"next");
    f.refusal(write("missing", Some(b"base"), b"lost"), 4);
    assert!(!f.root.join("missing").exists());
    assert_eq!(f.call(write("missing", None, b"new"))[0], 3);
    let writes = f.recorder.writes.lock().unwrap();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].1, Actor::Principal(b"member-fixture".to_vec()));
}
#[test]
fn outside_rename_between_check_and_exchange_restores_outside_bytes_100_times() {
    let mut f = Fixture::new(true, true);
    for i in 0..100 {
        fs::write(f.root.join("file"), b"base").unwrap();
        let outside = format!("outside writer {i}").into_bytes();
        *f.objects.race.lock().unwrap() = Some(("file".into(), outside.clone()));
        let result = f.refusal(write("file", Some(b"base"), b"proposal"), 4);
        assert_eq!(
            result,
            tagged(255, &[(1, vec![4]), (3, Sha256::digest(&outside).to_vec())])
        );
        assert_eq!(fs::read(f.root.join("file")).unwrap(), outside);
    }
    assert!(f.recorder.writes.lock().unwrap().is_empty());
    assert_eq!(
        fs::read_dir(&f.root).unwrap().count(),
        1,
        "stale proposals must not become branch files"
    );
}
#[test]
fn paths_special_files_and_size_limits_are_typed_and_bounded() {
    let mut f = Fixture::new(true, true);
    let outside = f.root.with_extension("sentinel");
    fs::write(&outside, b"outside sentinel").unwrap();
    symlink(&outside, f.root.join("leaf")).unwrap();
    symlink("/etc", f.root.join("escape")).unwrap();
    fs::create_dir(f.root.join("directory")).unwrap();
    let _socket = UnixListener::bind(f.root.join("socket")).unwrap();
    rustix::fs::mknodat(
        rustix::fs::CWD,
        f.root.join("fifo"),
        rustix::fs::FileType::Fifo,
        rustix::fs::Mode::from_raw_mode(0o600),
        0,
    )
    .unwrap();
    for path in ["../sentinel", "/etc/passwd", "escape/passwd", "leaf"] {
        f.refusal(read(path), 6);
        f.refusal(write(path, None, b"no"), 6);
    }
    for path in ["fifo", "socket", "directory"] {
        let start = Instant::now();
        f.refusal(read(path), 7);
        f.refusal(write(path, None, b"no"), 7);
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "blocked on {path}"
        );
    }
    f.refusal(read("missing"), 5);
    fs::write(f.root.join("large"), vec![1; 1_048_577]).unwrap();
    let result = f.refusal(read("large"), 8);
    assert_eq!(
        result,
        tagged(
            255,
            &[(1, vec![8]), (5, 1_048_576u32.to_be_bytes().to_vec())]
        )
    );
    assert_eq!(fs::read(&outside).unwrap(), b"outside sentinel");
    fs::remove_file(outside).unwrap();
    assert!(f.recorder.writes.lock().unwrap().is_empty());
}
#[test]
fn missing_wake_authority_and_unavailable_watcher_refuse_before_mutation() {
    for (ready, watcher, code) in [(false, true, 3), (true, false, 2)] {
        let mut f = Fixture::new(ready, watcher);
        f.refusal(write("file", None, b"no"), code);
        assert!(!f.root.join("file").exists());
        assert!(f.recorder.writes.lock().unwrap().is_empty());
        if !ready {
            f.refusal(read("file"), 3);
        }
    }
}

#[test]
fn captured_reads_and_write_versions_use_the_real_git_store() {
    use std::process::Command;
    let mut f = Fixture::with_git(true, true, true);
    let git = |args: &[&str]| {
        let output = Command::new("/usr/bin/git")
            .current_dir(&f.root)
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    };
    git(&["init", "-q"]);
    fs::write(f.root.join("literal*name"), b"snapshot bytes").unwrap();
    fs::write(f.root.join("literal-other-name"), b"different bytes").unwrap();
    symlink("/etc/passwd", f.root.join("symbolic")).unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "fixture"]);
    let head = String::from_utf8(git(&["rev-parse", "HEAD"])).unwrap();
    let head: Vec<_> = (0..40)
        .step_by(2)
        .map(|i| u8::from_str_radix(&head[i..i + 2], 16).unwrap())
        .collect();
    let snapshot = |path: &str| tagged(2, &[(1, string(path)), (2, head.clone())]);
    fs::write(f.root.join("literal*name"), b"working copy bytes").unwrap();
    assert_eq!(
        f.call(snapshot("literal*name")),
        tagged(
            2,
            &[
                (1, content(b"snapshot bytes")),
                (2, Sha256::digest(b"snapshot bytes").to_vec()),
                (3, 0o644u32.to_be_bytes().to_vec())
            ]
        )
    );
    f.refusal(snapshot("literal*"), 5);
    f.refusal(snapshot("symbolic"), 7);
    f.refusal(
        tagged(2, &[(1, string("literal*name")), (2, vec![0x77; 20])]),
        5,
    );
    assert_eq!(f.call(write("written", None, b"durable blob bytes"))[0], 3);
    let hash = Command::new("/usr/bin/git")
        .current_dir(&f.root)
        .args(["hash-object", "written"])
        .output()
        .unwrap();
    assert!(hash.status.success());
    let oid = String::from_utf8(hash.stdout).unwrap();
    let blob = Command::new("/usr/bin/git")
        .current_dir(&f.root)
        .args(["cat-file", "blob", oid.trim()])
        .output()
        .unwrap();
    assert!(blob.status.success());
    assert_eq!(blob.stdout, b"durable blob bytes");
}

#[test]
fn absent_base_cannot_replace_an_outside_creation() {
    let mut f = Fixture::new(true, true);
    *f.objects.race.lock().unwrap() = Some(("file".into(), b"outside creation".to_vec()));
    let result = f.refusal(write("file", None, b"proposal"), 4);
    assert_eq!(
        result,
        tagged(
            255,
            &[
                (1, vec![4]),
                (3, Sha256::digest(b"outside creation").to_vec())
            ]
        )
    );
    assert_eq!(fs::read(f.root.join("file")).unwrap(), b"outside creation");
    assert!(f.recorder.writes.lock().unwrap().is_empty());
}
#[test]
fn dispatched_writes_stay_confined_across_10000_directory_symlink_swaps() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let mut f = Fixture::new(true, true);
    let outside = f.root.with_extension("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("file"), b"outside sentinel").unwrap();
    fs::create_dir(f.root.join("d")).unwrap();
    fs::write(f.root.join("d/file"), b"inside").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let root = f.root.clone();
    let target = outside.clone();
    let writer = thread::spawn(move || {
        while !flag.load(Ordering::Relaxed) {
            fs::rename(root.join("d"), root.join("parked")).unwrap();
            symlink(&target, root.join("d")).unwrap();
            thread::yield_now();
            fs::remove_file(root.join("d")).unwrap();
            fs::rename(root.join("parked"), root.join("d")).unwrap();
        }
    });
    // Always stop our own writer even if an assertion fails.
    struct Stop(Arc<AtomicBool>, Option<JoinHandle<()>>);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
            self.1.take().unwrap().join().unwrap();
        }
    }
    let guard = Stop(stop, Some(writer));
    for _ in 0..10000 {
        let result = f.call(write("d/file", Some(b"inside"), b"inside"));
        if result[0] == 255 {
            let fields = conn::fields("error", &result[1..]).unwrap();
            assert!([5, 6].contains(&fields[0].1[0]), "{result:?}");
        } else {
            assert_eq!(result[0], 3);
        }
    }
    drop(guard);
    assert_eq!(fs::read(outside.join("file")).unwrap(), b"outside sentinel");
    assert_eq!(fs::read(f.root.join("d/file")).unwrap(), b"inside");
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn writes_share_document_permission_policy() {
    let mut f = Fixture::new(true, true);
    for mode in [0o1755, 0o2755, 0o4755] {
        fs::write(f.root.join("file"), b"base").unwrap();
        fs::set_permissions(f.root.join("file"), fs::Permissions::from_mode(mode)).unwrap();
        if mode == 0o1755 {
            assert_eq!(f.call(write("file", Some(b"base"), b"next"))[0], 3);
            assert_eq!(fs::read(f.root.join("file")).unwrap(), b"next");
        } else {
            f.refusal(write("file", Some(b"base"), b"next"), 2);
            assert_eq!(fs::read(f.root.join("file")).unwrap(), b"base");
        }
        assert_eq!(
            fs::metadata(f.root.join("file"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            mode
        );
    }
}
