#![cfg(target_os = "linux")]
use smithers_machined::{
    attrib::Sample,
    burst::{Burst, Bursts, File as BurstFile, Key},
    events::{Changes, Checkpoint, Closed, Provider},
    ignore::GitIgnore,
    resync::WatchLoop,
    versions::{self, Objects, Version},
    watch::Inotify,
};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
type State = Checkpoint<String, String>;
type Event = Closed<String, String, String>;
struct Fixture {
    root: PathBuf,
    state: PathBuf,
    cpu: [u64; 3],
    checkpoint: Option<State>,
    events: Vec<Event>,
    hints: Vec<(String, Option<String>, Option<[u8; 32]>)>,
    where_file: Vec<(u32, String)>,
    order: Vec<&'static str>,
    moved_ok: bool,
    append_ok: bool,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "machined-versions-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let state = root.with_extension("state");
        fs::create_dir(&state).unwrap();
        assert!(Command::new("/usr/bin/git")
            .args(["init", "-q"])
            .arg(&root)
            .status()
            .unwrap()
            .success());
        let f = Self {
            root,
            state,
            cpu: [0; 3],
            checkpoint: None,
            events: vec![],
            hints: vec![],
            where_file: vec![],
            order: vec![],
            moved_ok: true,
            append_ok: true,
        };
        f.git(&["config", "user.name", "Fixture"], None).unwrap();
        f.git(&["config", "user.email", "fixture@example.invalid"], None)
            .unwrap();
        f
    }
    fn git(&self, args: &[&str], input: Option<&[u8]>) -> io::Result<String> {
        let mut c = Command::new("/usr/bin/git");
        c.current_dir(&self.root)
            .args(args)
            .env("GIT_INDEX_FILE", self.state.join("index"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn()?;
        if let Some(input) = input {
            child.stdin.take().unwrap().write_all(input)?;
        } else {
            drop(child.stdin.take());
        }
        let output = child.wait_with_output()?;
        if !output.status.success() {
            return Err(io::Error::other(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }
        Ok(String::from_utf8(output.stdout).unwrap().trim().into())
    }
    fn write(&self, path: &str, bytes: &[u8]) {
        let mut f = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(self.root.join(path))
            .unwrap();
        f.write_all(bytes).unwrap();
        f.sync_all().unwrap();
    }
    fn watcher(&mut self) -> WatchLoop<GitIgnore, String, String> {
        let ignore = GitIgnore::new(self.root.clone(), "/usr/bin/git".into(), vec![]).unwrap();
        let watch = Inotify::new(File::open(&self.root).unwrap(), ignore)
            .unwrap()
            .0;
        let changes = Changes::new(self.checkpoint.clone().unwrap_or_default());
        let mut w = WatchLoop::new(watch, changes);
        w.resync(self, 0).unwrap();
        self.events.clear();
        self.hints.clear();
        self.order.clear();
        w
    }
    fn seed(&mut self, path: &str, bytes: &[u8]) {
        self.write(path, bytes);
        let v = versions::record(self, bytes, 0o100644).unwrap();
        self.checkpoint
            .get_or_insert_with(State::default)
            .recorded
            .insert(path.into(), v);
    }
    fn bytes(&self, blob: &str) -> Vec<u8> {
        self.git(&["cat-file", "blob", blob], None)
            .unwrap()
            .into_bytes()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(&self.state);
    }
}
impl Objects for Fixture {
    type Blob = String;
    type Commit = String;
    fn blob(&mut self, bytes: &[u8]) -> io::Result<String> {
        self.git(&["hash-object", "-w", "--stdin"], Some(bytes))
    }
    fn parentless(&mut self, tree: &BTreeMap<String, (String, u32)>) -> io::Result<String> {
        self.git(&["read-tree", "--empty"], None)?;
        let input: Vec<u8> = tree
            .iter()
            .flat_map(|(p, (id, mode))| format!("{mode:o} {id}\t{p}\0").into_bytes())
            .collect();
        self.git(&["update-index", "-z", "--index-info"], Some(&input))?;
        let tree = self.git(&["write-tree"], None)?;
        let commit = self.git(&["commit-tree", &tree], Some(b"fixture versions\n"))?;
        // Fixture durability provider retains objects before a K2 process exit.
        self.git(
            &["update-ref", "refs/smithers/fixture/versions", &commit],
            None,
        )?;
        Ok(commit)
    }
}
impl Provider<String> for Fixture {
    fn activate(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn actor_session(&mut self, _: &String) -> io::Result<Option<u32>> {
        Ok(None)
    }
    fn samples(&mut self) -> io::Result<Vec<Sample<String>>> {
        Ok(self
            .cpu
            .iter()
            .enumerate()
            .map(|(i, cpu)| Sample {
                session: i as u32 + 1,
                actor: Some(["maya", "ben", "coding:run-1"][i].into()),
                participant: Some(if i == 2 {
                    smithers_machined::attrib::Participant::Run("run-1".into())
                } else {
                    smithers_machined::attrib::Participant::Person(20000 + i as u32)
                }),
                usage_usec: *cpu,
                populated: true,
            })
            .collect())
    }
    fn read(&mut self, path: &str) -> io::Result<Option<(Vec<u8>, u32)>> {
        use std::io::Read;
        use std::os::unix::fs::PermissionsExt;
        if !smithers_machined::doc::disk::valid_path(path) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let root = File::open(&self.root)?;
        let fd = match rustix::fs::openat2(
            &root,
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::CLOEXEC
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::empty(),
            rustix::fs::ResolveFlags::BENEATH
                | rustix::fs::ResolveFlags::NO_SYMLINKS
                | rustix::fs::ResolveFlags::NO_XDEV,
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let mut f = File::from(fd);
        let meta = f.metadata()?;
        if !meta.is_file() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mode = if meta.permissions().mode() & 0o111 != 0 {
            0o100755
        } else {
            0o100644
        };
        let mut bytes = vec![];
        f.read_to_end(&mut bytes)?;
        Ok(Some((bytes, mode)))
    }
    fn checkpoint(&mut self, s: &State) -> io::Result<()> {
        self.checkpoint = Some(s.clone());
        save_checkpoint(&self.state, s)
    }
    fn append(&mut self, e: &Event) -> io::Result<()> {
        self.order.push("append");
        if !self.append_ok {
            return Err(io::Error::other("outbox unavailable"));
        }
        if !self.events.iter().any(|v| v.burst_id == e.burst_id) {
            self.events.push(e.clone());
        }
        Ok(())
    }
    fn hint(
        &mut self,
        path: &str,
        actor: Option<&String>,
        digest: Option<[u8; 32]>,
    ) -> io::Result<()> {
        self.hints.push((path.into(), actor.cloned(), digest));
        Ok(())
    }
    fn where_file(&mut self, s: u32, p: &str) -> io::Result<()> {
        self.where_file.push((s, p.into()));
        Ok(())
    }
    fn moved_off(&mut self) -> io::Result<()> {
        self.order.push("moved");
        if self.moved_ok {
            Ok(())
        } else {
            Err(io::Error::other("moved-off unavailable"))
        }
    }
    fn snapshot(&mut self) -> io::Result<()> {
        self.order.push("snapshot");
        Ok(())
    }
}
// Only the missing core checkpoint provider is a fixture. This is not daemon
// wire encoding; expectations below use literal bytes and real git objects.
fn v_json(v: &Option<Version<String>>) -> serde_json::Value {
    match v {
        Some(v) => serde_json::json!({"blob":v.blob,"digest":v.post_digest.to_vec(),"mode":v.mode}),
        None => serde_json::Value::Null,
    }
}
fn decode_v(v: &serde_json::Value) -> Option<Version<String>> {
    if v.is_null() {
        None
    } else {
        Some(Version {
            blob: v["blob"].as_str().unwrap().into(),
            post_digest: v["digest"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_u64().unwrap() as u8)
                .collect::<Vec<_>>()
                .try_into()
                .unwrap(),
            mode: v["mode"].as_u64().unwrap() as u32,
        })
    }
}
fn key_json(k: &Key<String>) -> serde_json::Value {
    match k {
        Key::Outside => serde_json::Value::Null,
        Key::Smithers(a) => serde_json::json!(a),
    }
}
fn decode_key(v: &serde_json::Value) -> Key<String> {
    match v.as_str() {
        Some(a) => Key::Smithers(a.into()),
        None => Key::Outside,
    }
}
fn save_checkpoint(dir: &std::path::Path, s: &State) -> io::Result<()> {
    let recorded: Vec<_> = s
        .recorded
        .iter()
        .map(|(p, v)| serde_json::json!([p, v_json(&Some(v.clone()))]))
        .collect();
    let ids = s.identities();
    let bursts:Vec<_>=s.bursts.pending().iter().map(|b|{
        let files:Vec<_>=b.files.iter().map(|(p,f)|serde_json::json!([p,v_json(&f.before),v_json(&f.after)])).collect();
        let id=ids.iter().find(|(k,_)|k==&b.key).unwrap().1;
        serde_json::json!({"key":key_json(&b.key),"opened":b.opened_ms,"last":b.last_ms,"path":b.last_path,"files":files,"id":id.to_vec()})
    }).collect();
    let bytes = serde_json::to_vec(
        &serde_json::json!({"recorded":recorded,"bursts":bursts,"renames":s.renames()}),
    )
    .unwrap();
    let mut f = File::create(dir.join("checkpoint.tmp"))?;
    f.write_all(&bytes)?;
    f.sync_all()?;
    fs::rename(dir.join("checkpoint.tmp"), dir.join("checkpoint"))?;
    File::open(dir)?.sync_all()
}
fn load_checkpoint(dir: &std::path::Path) -> State {
    let json: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("checkpoint")).unwrap()).unwrap();
    let recorded = json["recorded"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v[0].as_str().unwrap().into(), decode_v(&v[1]).unwrap()))
        .collect();
    let mut ids = vec![];
    let mut now = 0;
    let bursts = json["bursts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            let key = decode_key(&v["key"]);
            let id = v["id"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect::<Vec<_>>()
                .try_into()
                .unwrap();
            ids.push((key.clone(), id));
            let last_ms = v["last"].as_u64().unwrap();
            now = now.max(last_ms);
            let files = v["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| {
                    (
                        f[0].as_str().unwrap().into(),
                        BurstFile {
                            before: decode_v(&f[1]),
                            after: decode_v(&f[2]),
                        },
                    )
                })
                .collect();
            Burst {
                key,
                opened_ms: v["opened"].as_u64().unwrap(),
                last_ms,
                files,
                last_path: v["path"].as_str().unwrap().into(),
            }
        })
        .collect();
    State::restore(
        recorded,
        Bursts::restore(bursts, now).unwrap(),
        ids,
        serde_json::from_value(json["renames"].clone()).unwrap(),
    )
    .unwrap()
}
fn poll_until(
    f: &mut Fixture,
    w: &mut WatchLoop<GitIgnore, String, String>,
    now: u64,
    ready: impl Fn(&Fixture, &WatchLoop<GitIgnore, String, String>) -> bool,
) {
    let start = std::time::Instant::now();
    loop {
        w.drain(f, now).unwrap();
        if ready(f, w) {
            break;
        }
        assert!(
            start.elapsed().as_millis() < 180,
            "inotify delivery exceeded hint budget"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    assert!(start.elapsed().as_millis() < 200, "hint exceeded 200 ms");
}
#[test]
fn formatter_one_session_or_ambiguous_and_immediate_hints() {
    for busy_ben in [false, true] {
        let mut f = Fixture::new();
        let mut w = f.watcher();
        for i in 0..12 {
            f.write(&format!("f{i}.txt"), b"formatted");
        }
        f.cpu = [100, if busy_ben { 50 } else { 0 }, 0];
        poll_until(&mut f, &mut w, 100, |f, _| f.hints.len() == 12);
        assert_eq!(f.hints.len(), 12);
        assert!(f.hints.iter().all(|(_, _, d)| d.is_some()));
        w.drain(&mut f, 1600).unwrap();
        assert_eq!(f.events.len(), 1);
        let event = &f.events[0];
        assert_eq!(
            event.actor.as_deref(),
            if busy_ben { None } else { Some("maya") }
        );
        assert_eq!(event.files.len(), 12);
        if busy_ben {
            assert!(f.where_file.is_empty());
        } else {
            assert_eq!(f.where_file.len(), 1);
        }
        assert!(
            f.git(
                &["rev-list", "--parents", "-n", "1", &event.versions_commit],
                None
            )
            .unwrap()
            .split_whitespace()
            .count()
                == 1
        );
        for file in event.files.values() {
            assert!(file.before.is_none());
            assert_eq!(f.bytes(&file.after.as_ref().unwrap().blob), b"formatted");
        }
    }
}
#[test]
fn outside_drain_actor_switch_and_overlapping_files_keep_literal_versions() {
    let mut f = Fixture::new();
    f.seed("a", b"original");
    f.seed("b", b"other");
    let mut w = f.watcher();
    f.write("a", b"outside first");
    f.cpu[0] = 10;
    poll_until(&mut f, &mut w, 100, |_, w| w.changes.state.bursts.is_open());
    let ben = "ben".to_string();
    w.changes.before_write(&mut f, 101, "a", &ben).unwrap();
    assert_eq!(f.events.len(), 1);
    assert_eq!(f.events[0].actor.as_deref(), Some("maya"));
    let file = &f.events[0].files["a"];
    assert_eq!(f.bytes(&file.before.as_ref().unwrap().blob), b"original");
    assert_eq!(
        f.bytes(&file.after.as_ref().unwrap().blob),
        b"outside first"
    );
    f.write("a", b"ben's version");
    let v = versions::record(&mut f, b"ben's version", 0o100644).unwrap();
    w.changes.own_write(&mut f, 101, "a", &ben, v).unwrap();
    f.cpu = [20, 20, 20];
    // Pending own inotify events, even when repeated, never become outside.
    w.drain(&mut f, 102).unwrap();
    w.changes.outside(&mut f, 102, "a").unwrap();
    w.changes.tick(&mut f, 302).unwrap();
    let maya = "maya".to_string();
    w.changes.before_write(&mut f, 303, "b", &maya).unwrap();
    f.write("b", b"maya's version");
    let v = versions::record(&mut f, b"maya's version", 0o100644).unwrap();
    w.changes.own_write(&mut f, 303, "b", &maya, v).unwrap();
    w.drain(&mut f, 1804).unwrap();
    assert_eq!(f.events.len(), 3);
    assert_eq!(f.events[1].actor.as_deref(), Some("ben"));
    assert_eq!(f.events[2].actor.as_deref(), Some("maya"));
    assert_eq!(
        f.bytes(&f.events[1].files["a"].before.as_ref().unwrap().blob),
        b"outside first"
    );
    assert_eq!(
        f.bytes(&f.events[1].files["a"].after.as_ref().unwrap().blob),
        b"ben's version"
    );
    assert_eq!(
        f.bytes(&f.events[2].files["b"].before.as_ref().unwrap().blob),
        b"other"
    );
    assert_eq!(
        f.bytes(&f.events[2].files["b"].after.as_ref().unwrap().blob),
        b"maya's version"
    );
}
#[test]
fn overflow_scan_delete_snapshot_and_moved_off_before_writes() {
    let mut f = Fixture::new();
    f.seed("deleted", b"old");
    let mut w = f.watcher();
    fs::remove_file(f.root.join("deleted")).unwrap();
    fs::create_dir(f.root.join("new")).unwrap();
    f.write("new/x", b"after overflow");
    f.cpu = [100, 0, 0];
    w.resync(&mut f, 100).unwrap();
    assert_eq!(f.order, ["snapshot", "append", "moved"]);
    assert!(!w.changes.writes_blocked());
    assert_eq!(f.events.len(), 1);
    assert!(f.events[0].actor.is_none());
    assert!(f.events[0].files["deleted"].after.is_none());
    assert_eq!(
        f.bytes(&f.events[0].files["new/x"].after.as_ref().unwrap().blob),
        b"after overflow"
    );
    let actor = "ben".to_string();
    w.changes
        .before_write(&mut f, 101, "new/x", &actor)
        .unwrap();
    f.moved_ok = false;
    w.changes.metadata(200);
    assert!(w
        .changes
        .before_write(&mut f, 201, "new/x", &actor)
        .is_err());
    assert!(w.changes.tick(&mut f, 400).is_err());
    assert!(w.changes.writes_blocked());
    f.moved_ok = true;
    w.changes.tick(&mut f, 401).unwrap();
    assert!(!w.changes.writes_blocked());
}
#[test]
fn durable_append_failure_keeps_checkpoint_retryable_after_restart() {
    let mut f = Fixture::new();
    f.seed("a", b"before");
    let mut w = f.watcher();
    f.write("a", b"after");
    f.cpu[0] = 20;
    poll_until(&mut f, &mut w, 100, |_, w| w.changes.state.bursts.is_open());
    f.append_ok = false;
    assert!(w.changes.close_all(&mut f).is_err());
    assert!(w.changes.writes_blocked());
    assert!(f.events.is_empty());
    let saved = load_checkpoint(&f.state);
    assert!(saved.bursts.is_open());
    f.append_ok = true;
    w.changes = Changes::new(saved);
    w.resync(&mut f, 101).unwrap();
    assert_eq!(f.events.len(), 1);
    assert_eq!(
        f.bytes(&f.events[0].files["a"].after.as_ref().unwrap().blob),
        b"after"
    );
    assert!(f.events[0].actor.is_none());
}

#[cfg(feature = "killpoints")]
#[test]
fn fault_child() {
    let Ok(root) = std::env::var("MACHINED_WATCH_FAULT_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let state = root.with_extension("state");
    let mut f = Fixture {
        root,
        state,
        cpu: [0; 3],
        checkpoint: None,
        events: vec![],
        hints: vec![],
        where_file: vec![],
        order: vec![],
        moved_ok: true,
        append_ok: true,
    };
    f.checkpoint = Some(load_checkpoint(&f.state));
    let ignore = GitIgnore::new(f.root.clone(), "/usr/bin/git".into(), vec![]).unwrap();
    let watch = Inotify::new(File::open(&f.root).unwrap(), ignore)
        .unwrap()
        .0;
    let mut w = WatchLoop::new(watch, Changes::new(f.checkpoint.clone().unwrap()));
    // Initialize providers before arming the fault; write, fsync, close precede
    // both hooks, so this is an acknowledged external disk write.
    w.resync(&mut f, 0).unwrap();
    w.changes.sample(&mut f).unwrap();
    use sha2::Digest as _;
    let hash = sha2::Sha256::digest(b"acknowledged after restart");
    let digest = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut log = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(f.state.join("writer.log"))
        .unwrap();
    for i in 0..20 {
        let path = if i == 0 { "a".into() } else { format!("f{i}") };
        f.write(&path, b"acknowledged after restart");
        writeln!(log, "{} {} {}", i + 1, path, digest).unwrap();
        log.sync_all().unwrap();
    }
    drop(log);
    File::open(&f.state).unwrap().sync_all().unwrap();
    f.cpu[0] = 100;
    let point = std::env::var("MACHINED_WATCH_FAULT_POINT").unwrap();
    std::env::set_var("SMITHERS_MACHINED_KILL_AT", &point);
    poll_until(&mut f, &mut w, 100, |_, w| w.changes.state.bursts.is_open());
    w.changes.close_all(&mut f).unwrap();
    panic!("fault did not fire");
}
#[cfg(feature = "killpoints")]
#[test]
fn k1_k2_process_exit_recovery_ten_runs_each() {
    for point in ["K1", "K2"] {
        for run in 1..=10 {
            let mut f = Fixture::new();
            let paths = (0..20)
                .map(|i| if i == 0 { "a".into() } else { format!("f{i}") })
                .collect::<Vec<String>>();
            for path in &paths {
                f.seed(path, b"literal before");
            }
            save_checkpoint(&f.state, f.checkpoint.as_ref().unwrap()).unwrap();
            let status = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "fault_child", "--nocapture"])
                .env("MACHINED_WATCH_FAULT_ROOT", &f.root)
                .env("MACHINED_WATCH_FAULT_POINT", point)
                .stdout(Stdio::null())
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(73), "{point}");
            assert_eq!(
                fs::read(f.root.join("a")).unwrap(),
                b"acknowledged after restart"
            );
            let interrupted = fs::read(f.state.join("checkpoint")).unwrap();
            let state = load_checkpoint(&f.state);
            assert!(state.bursts.is_open());
            f.checkpoint = Some(state);
            let ignore = GitIgnore::new(f.root.clone(), "/usr/bin/git".into(), vec![]).unwrap();
            let watch = Inotify::new(File::open(&f.root).unwrap(), ignore)
                .unwrap()
                .0;
            let mut w = WatchLoop::new(watch, Changes::new(f.checkpoint.clone().unwrap()));
            w.resync(&mut f, 101).unwrap();
            assert_eq!(f.events.len(), 1);
            assert_eq!(f.events[0].files.len(), 20);
            for path in &paths {
                assert_eq!(
                    fs::read(f.root.join(path)).unwrap(),
                    b"acknowledged after restart"
                );
            }
            let file = &f.events[0].files["a"];
            for recorded in f.events[0].files.values() {
                assert_eq!(recorded, file);
            }

            assert_eq!(
                f.bytes(&file.before.as_ref().unwrap().blob),
                b"literal before"
            );
            assert_eq!(
                f.bytes(&file.after.as_ref().unwrap().blob),
                b"acknowledged after restart"
            );
            let commit = &f.events[0].versions_commit;
            let tree = f
                .git(&["ls-tree", "-r", "--name-only", commit], None)
                .unwrap();
            let expected: std::collections::BTreeSet<_> = paths
                .iter()
                .flat_map(|p| [format!("a/{p}"), format!("b/{p}")])
                .collect();
            assert_eq!(
                tree.lines()
                    .map(String::from)
                    .collect::<std::collections::BTreeSet<_>>(),
                expected
            );

            assert_eq!(
                f.git(&["show", &format!("{commit}:a/a")], None).unwrap(),
                "literal before"
            );
            assert_eq!(
                f.git(&["show", &format!("{commit}:b/a")], None).unwrap(),
                "acknowledged after restart"
            );
            assert!(!load_checkpoint(&f.state).bursts.is_open());
            #[cfg(feature = "testing")]
            wire_boundary::fault_delivery(&f.events[0], &f.state);
            if let Some(evidence) = std::env::var_os("MACHINED_WATCH_EVIDENCE") {
                let dir = PathBuf::from(evidence)
                    .join(point)
                    .join(format!("run-{run:02}"));
                fs::create_dir_all(&dir).unwrap();
                fs::copy(f.state.join("writer.log"), dir.join("writer.log")).unwrap();
                fs::write(dir.join("checkpoint-at-kill.json"), &interrupted).unwrap();
                fs::copy(
                    f.state.join("checkpoint"),
                    dir.join("checkpoint-after-recovery.json"),
                )
                .unwrap();
                fs::copy(f.root.join("a"), dir.join("working-copy-a")).unwrap();
                let hashes: BTreeMap<_, _> = paths
                    .iter()
                    .map(|p| {
                        (
                            p.clone(),
                            f.events[0].files[p]
                                .after
                                .as_ref()
                                .unwrap()
                                .post_digest
                                .to_vec(),
                        )
                    })
                    .collect();
                fs::write(
                    dir.join("working-copy-hashes.json"),
                    serde_json::to_vec_pretty(&hashes).unwrap(),
                )
                .unwrap();
                for name in [
                    "outbox-durable.bin",
                    "host-ack.bin",
                    "outbox-after-ack.json",
                ] {
                    if f.state.join(name).exists() {
                        fs::copy(f.state.join(name), dir.join(name)).unwrap();
                    }
                }
                let event = &f.events[0];
                let files:Vec<_>=event.files.iter().map(|(p,v)|serde_json::json!({"path":p,"before":v_json(&v.before),"after":v_json(&v.after)})).collect();
                fs::write(dir.join("event.json"),serde_json::to_vec_pretty(&serde_json::json!({"burst_id":event.burst_id.to_vec(),"actor":event.actor,"files":files,"versions_commit":commit,"component_fixture":true})).unwrap()).unwrap();
                f.git(
                    &[
                        "bundle",
                        "create",
                        dir.join("versions.bundle").to_str().unwrap(),
                        "refs/smithers/fixture/versions",
                    ],
                    None,
                )
                .unwrap();
                f.git(
                    &[
                        "bundle",
                        "verify",
                        dir.join("versions.bundle").to_str().unwrap(),
                    ],
                    None,
                )
                .unwrap();
            }
        }
    }
}

#[test]
fn rename_and_temp_save_keep_one_logical_file_entry() {
    let mut f = Fixture::new();
    f.seed("a", b"move me");
    f.seed("edited", b"original");
    let mut w = f.watcher();
    fs::rename(f.root.join("a"), f.root.join("b")).unwrap();
    f.write("editor-temp", b"replacement");
    fs::rename(f.root.join("editor-temp"), f.root.join("edited")).unwrap();
    f.cpu[0] = 10;
    w.drain(&mut f, 100).unwrap();
    w.changes.close_all(&mut f).unwrap();
    assert_eq!(f.events.len(), 1);
    let e = &f.events[0];
    assert_eq!(e.renamed_to.get("a").map(String::as_str), Some("b"));
    assert_eq!(e.files.len(), 2);
    assert!(!e.files.contains_key("editor-temp"));
    assert!(!e.files.contains_key("b"));
    assert_eq!(
        f.bytes(&e.files["a"].before.as_ref().unwrap().blob),
        b"move me"
    );
    assert_eq!(
        f.bytes(&e.files["a"].after.as_ref().unwrap().blob),
        b"move me"
    );
    assert_eq!(
        f.bytes(&e.files["edited"].after.as_ref().unwrap().blob),
        b"replacement"
    );
    assert!(w.changes.state.recorded.contains_key("b"));
    assert!(!w.changes.state.recorded.contains_key("a"));
}
#[test]
fn metadata_debounce_never_emits_file_activity() {
    let mut f = Fixture::new();
    let mut w = f.watcher();
    f.write(".git/HEAD", b"ref: refs/heads/fixture\n");
    poll_until(&mut f, &mut w, 100, |_, w| w.changes.writes_blocked());
    assert!(f.events.is_empty());
    assert!(f.hints.is_empty());
    assert!(w.changes.writes_blocked());
    assert!(f.order.is_empty());
    w.changes.tick(&mut f, 299).unwrap();
    assert!(f.order.is_empty());
    w.changes.tick(&mut f, 300).unwrap();
    assert_eq!(f.order, ["moved"]);
    assert!(!w.changes.writes_blocked());
}
#[test]
fn all_hints_carry_literal_sha256_post_digest() {
    let mut f = Fixture::new();
    let mut w = f.watcher();
    f.write("a", b"abc");
    f.cpu[0] = 1;
    poll_until(&mut f, &mut w, 100, |f, _| !f.hints.is_empty());
    assert_eq!(
        f.hints,
        vec![(
            "a".into(),
            Some("maya".into()),
            Some([
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad
            ])
        )]
    );
}

#[cfg(feature = "testing")]
#[path = "watcher_rpc/mod.rs"]
mod wire_boundary;

#[test]
fn changed_ignore_rules_also_filter_overflow_recorded_paths() {
    let mut f = Fixture::new();
    f.seed("now-ignored", b"original");
    let mut w = f.watcher();
    f.write(".gitignore", b"now-ignored\n");
    f.write("now-ignored", b"must not appear");
    w.resync(&mut f, 100).unwrap();
    assert!(!w.changes.state.recorded.contains_key("now-ignored"));
    assert!(!f.events.iter().any(|e| e.files.contains_key("now-ignored")));
    assert!(!f.hints.iter().any(|(p, _, _)| p == "now-ignored"));
}

#[test]
fn recovery_resets_monotonic_clock_before_admitting_new_bursts() {
    let mut f = Fixture::new();
    f.seed("a", b"before restart");
    let mut w = f.watcher();
    f.write("a", b"at restart");
    f.cpu[0] = 100;
    poll_until(&mut f, &mut w, 10_000_000, |_, w| {
        w.changes.state.bursts.is_open()
    });
    w.changes = Changes::new(load_checkpoint(&f.state));
    w.resync(&mut f, 0).unwrap();
    assert_eq!(f.events.len(), 1);
    f.write("a", b"new process clock");
    f.cpu[0] = 150;
    poll_until(&mut f, &mut w, 10, |_, w| w.changes.state.bursts.is_open());
    w.drain(&mut f, 1510).unwrap();
    assert_eq!(f.events.len(), 2);
    assert_eq!(
        f.bytes(&f.events[1].files["a"].before.as_ref().unwrap().blob),
        b"at restart"
    );
    assert_eq!(
        f.bytes(&f.events[1].files["a"].after.as_ref().unwrap().blob),
        b"new process clock"
    );
}
