//! Real document RPC, LinuxDisk, inotify, object store and watcher checkpoint.
//! Session samples and event publication are controlled ports, not full install proof.
use super::*;
use smithers_machined::{
    attrib::Sample,
    events::{Checkpoint, Closed, Provider},
    hooks::{Actor, Oid, Watcher as _},
    ignore::GitIgnore,
    versions::{Objects, Version},
    watch::{Inotify, InotifyWatcher},
    watcher_store::Store,
};
use std::{collections::BTreeMap, io, path::Path, sync::atomic::AtomicBool};

#[derive(Default)]
struct Observed {
    events: Mutex<Vec<Closed<Actor, Oid, Oid>>>,
    checkpoint_fail: AtomicBool,
    sample_fail: AtomicBool,
    replace_at_receipt: AtomicBool,
}
struct Ports {
    root: PathBuf,
    state: PathBuf,
    git: smithers_machined::git::Repository,
    observed: Arc<Observed>,
}
impl Objects for Ports {
    type Blob = Oid;
    type Commit = Oid;
    fn blob(&mut self, bytes: &[u8]) -> io::Result<Oid> {
        self.git.blob(bytes)
    }
    fn parentless(&mut self, tree: &BTreeMap<String, (Oid, u32)>) -> io::Result<Oid> {
        self.git.parentless(tree)
    }
}
impl Provider<Actor> for Ports {
    fn activate(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn actor_session(&mut self, _: &Actor) -> io::Result<Option<u32>> {
        Ok(None)
    }
    fn samples(&mut self) -> io::Result<Vec<Sample<Actor>>> {
        if self.observed.sample_fail.load(Ordering::Relaxed) {
            Err(io::Error::other("fixture session provider unavailable"))
        } else {
            Ok(vec![])
        }
    }
    fn read(&mut self, path: &str) -> io::Result<Option<(Vec<u8>, u32)>> {
        let p = self.root.join(path);
        match fs::read(&p) {
            Ok(bytes) => Ok(Some((
                bytes,
                if p.metadata()?.mode() & 0o111 == 0 {
                    0o100644
                } else {
                    0o100755
                },
            ))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn checkpoint(&mut self, s: &Checkpoint<Actor, Oid>) -> io::Result<()> {
        if self.observed.checkpoint_fail.load(Ordering::Relaxed) {
            return Err(io::Error::other("fixture checkpoint unavailable"));
        }
        Store::open(&self.state)?.save(s, &mut self.git)
    }
    fn append(&mut self, event: &Closed<Actor, Oid, Oid>) -> io::Result<()> {
        self.observed.events.lock().unwrap().push(event.clone());
        Ok(())
    }
    fn hint(&mut self, _: &str, _: Option<&Actor>, _: Option<[u8; 32]>) -> io::Result<()> {
        Ok(())
    }
    fn where_file(&mut self, _: u32, _: &str) -> io::Result<()> {
        panic!("no session fixture")
    }
    fn moved_off(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn snapshot(&mut self) -> io::Result<()> {
        Ok(())
    }
}
type Watcher = InotifyWatcher<GitIgnore, Ports>;
struct SaveVersions {
    watcher: Arc<Watcher>,
    observed: Arc<Observed>,
    root: PathBuf,
}
fn actor(key: Option<&str>) -> Actor {
    match key {
        Some("01010101010101010101010101010101") => Actor::Principal(vec![1; 16]),
        Some("02020202020202020202020202020202") => Actor::Principal(vec![2; 16]),
        _ => Actor::Outside,
    }
}
impl Versions for SaveVersions {
    fn outside(&mut self, _: &str, _: &[u8], _: &str) -> smithers_machined::doc::Result<String> {
        panic!("these fixtures do not inject displaced-inode races")
    }
    fn before_write(
        &mut self,
        path: &str,
        key: Option<&str>,
    ) -> smithers_machined::doc::Result<()> {
        self.watcher
            .before_write(path, &actor(key))
            .map_err(smithers_machined::doc::Error::Provider)
    }
    fn own_write(
        &mut self,
        path: &str,
        bytes: &[u8],
        mode: u32,
        key: Option<&str>,
    ) -> smithers_machined::doc::Result<()> {
        if self
            .observed
            .replace_at_receipt
            .swap(false, Ordering::Relaxed)
        {
            fs::write(self.root.join(path), b"later outside").unwrap();
            fs::set_permissions(self.root.join(path), fs::Permissions::from_mode(0o755)).unwrap();
        }
        self.watcher
            .after_write(path, &actor(key), bytes, mode)
            .map_err(smithers_machined::doc::Error::Provider)
    }
}
struct NoSessions;
impl hooks::Sessions for NoSessions {
    fn ready(&self) -> hooks::Result<()> {
        Ok(())
    }
}
struct Setup {
    f: Fixture,
    service: Arc<Service<LinuxDisk<SaveVersions>>>,
    cx: LockCx,
    watcher: Arc<Watcher>,
    observed: Arc<Observed>,
}
impl Setup {
    fn new() -> Self {
        let f = Fixture::new();
        gix::init(f.root.join("workspace")).unwrap();
        let state = f.root.join("watcher");
        let spool = f.root.join("spool");
        for path in [&state, &spool] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let git =
            smithers_machined::git::Repository::open(&f.root.join("workspace"), &spool).unwrap();
        let observed = Arc::new(Observed::default());
        let (watch, _) = Inotify::new(
            File::open(f.root.join("workspace")).unwrap(),
            GitIgnore::new(f.root.join("workspace"), "/usr/bin/git".into(), vec![]).unwrap(),
        )
        .unwrap();
        let mut initial = LockCx::new(hooks::Hooks {
            clock: f.clock.clone(),
            sessions: Arc::new(NoSessions),
            ..Default::default()
        });
        let watcher = Arc::new(
            InotifyWatcher::activate(
                watch,
                Ports {
                    root: f.root.join("workspace"),
                    state,
                    git,
                    observed: observed.clone(),
                },
                Default::default(),
                &mut initial,
            )
            .unwrap(),
        );
        observed.events.lock().unwrap().clear();
        let (service, mut cx) = f.with_versions(SaveVersions {
            watcher: watcher.clone(),
            observed: observed.clone(),
            root: f.root.join("workspace"),
        });
        cx.hooks.watcher = watcher.clone();
        Self {
            f,
            service,
            cx,
            watcher,
            observed,
        }
    }
    fn write(&mut self, base: &[u8], bytes: &[u8], who: u8) -> Vec<u8> {
        let mut content = (bytes.len() as u32).to_be_bytes().to_vec();
        content.extend(bytes);
        result(
            &rpc::dispatch(
                &request(
                    3,
                    &[
                        conn::field(1, string("a.rs")),
                        conn::field(2, conn::tagged(1, &[conn::field(1, digest(base))])),
                        conn::field(3, content),
                        conn::field(4, conn::actor_bytes(&Actor::Principal(vec![who; 16]))),
                    ],
                ),
                &mut self.cx,
            )
            .unwrap(),
        )
    }
    fn checkpoint(&self) -> Checkpoint<Actor, Oid> {
        Store::open(&self.f.root.join("watcher"))
            .unwrap()
            .load()
            .unwrap()
    }
    fn bytes(&self, v: &Version<Oid>) -> Vec<u8> {
        let repo = gix::open(self.f.root.join("workspace")).unwrap();
        let object = repo
            .find_object(gix::ObjectId::from_bytes_or_panic(&v.blob))
            .unwrap();
        object.data.to_vec()
    }
}
#[test]
#[ignore = "requires Linux uid19998, installed Git and real filesystem"]
fn pending_outside_bytes_close_before_authenticated_file_save() {
    let mut s = Setup::new();
    fs::write(s.f.root.join("workspace/a.rs"), b"outside first").unwrap();
    assert_eq!(s.write(b"outside first", b"member save", 1)[0], 3);
    s.watcher.close_bursts(&mut s.cx).unwrap();
    let events = s.observed.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].actor, None);
    assert_eq!(
        s.bytes(events[0].files["a.rs"].before.as_ref().unwrap()),
        b"abc"
    );
    assert_eq!(
        s.bytes(events[0].files["a.rs"].after.as_ref().unwrap()),
        b"outside first"
    );
    assert_eq!(events[1].actor, Some(Actor::Principal(vec![1; 16])));
    assert_eq!(
        s.bytes(events[1].files["a.rs"].before.as_ref().unwrap()),
        b"outside first"
    );
    assert_eq!(
        s.bytes(events[1].files["a.rs"].after.as_ref().unwrap()),
        b"member save"
    );
}
#[test]
#[ignore = "requires Linux uid19998, installed Git and real filesystem"]
fn successive_authors_keep_distinct_durable_versions_before_next_write() {
    let mut s = Setup::new();
    assert_eq!(s.write(b"abc", b"first member", 1)[0], 3);
    let checkpoint = s.checkpoint();
    assert_eq!(checkpoint.bursts.pending().len(), 1);
    assert_eq!(s.bytes(&checkpoint.recorded["a.rs"]), b"first member");
    assert_eq!(s.write(b"first member", b"second member", 2)[0], 3);
    s.watcher.close_bursts(&mut s.cx).unwrap();
    let events = s.observed.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    for (e, who, before, after) in [
        (&events[0], 1, b"abc".as_slice(), b"first member".as_slice()),
        (
            &events[1],
            2,
            b"first member".as_slice(),
            b"second member".as_slice(),
        ),
    ] {
        assert_eq!(e.actor, Some(Actor::Principal(vec![who; 16])));
        assert_eq!(s.bytes(e.files["a.rs"].before.as_ref().unwrap()), before);
        assert_eq!(s.bytes(e.files["a.rs"].after.as_ref().unwrap()), after);
    }
}
#[test]
#[ignore = "requires Linux uid19998, installed Git and real filesystem"]
fn outside_replacement_cannot_change_saved_bytes_or_mode_in_the_receipt() {
    let mut s = Setup::new();
    s.observed.replace_at_receipt.store(true, Ordering::Relaxed);
    assert_eq!(s.write(b"abc", b"member save", 1)[0], 3);
    let saved = s.checkpoint().recorded["a.rs"].clone();
    assert_eq!(s.bytes(&saved), b"member save");
    assert_eq!(saved.mode, 0o100644);
    assert_eq!(
        fs::read(s.f.root.join("workspace/a.rs")).unwrap(),
        b"later outside"
    );
    s.watcher.close_bursts(&mut s.cx).unwrap();
    let events = s.observed.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        s.bytes(events[0].files["a.rs"].after.as_ref().unwrap()),
        b"member save"
    );
    assert_eq!(
        s.bytes(events[1].files["a.rs"].after.as_ref().unwrap()),
        b"later outside"
    );
    assert_eq!(
        events[1].files["a.rs"].after.as_ref().unwrap().mode,
        0o100755
    );
}
#[test]
#[ignore = "requires Linux uid19998, installed Git and real filesystem"]
fn unavailable_watcher_refuses_before_changing_file_bytes() {
    let mut s = Setup::new();
    s.observed.sample_fail.store(true, Ordering::Relaxed);
    let refused = s.write(b"abc", b"refused", 1);
    assert_eq!(refused[0], 255);
    assert_eq!(conn::fields("error", &refused[1..]).unwrap()[0].1, &[3]);
    assert_eq!(fs::read(s.f.root.join("workspace/a.rs")).unwrap(), b"abc");
    assert_eq!(s.bytes(&s.checkpoint().recorded["a.rs"]), b"abc");
    assert!(s.observed.events.lock().unwrap().is_empty());
}
#[test]
#[ignore = "requires Linux uid19998, installed Git and real filesystem"]
fn failed_version_checkpoint_withholds_success_and_fences_the_next_save() {
    let mut s = Setup::new();
    s.observed.checkpoint_fail.store(true, Ordering::Relaxed);
    assert_eq!(s.write(b"abc", b"applied without receipt", 1)[0], 255);
    assert_eq!(
        fs::read(s.f.root.join("workspace/a.rs")).unwrap(),
        b"applied without receipt"
    );
    assert!(!s.service.all_flushed());
    assert_eq!(s.bytes(&s.checkpoint().recorded["a.rs"]), b"abc");
    s.observed.checkpoint_fail.store(false, Ordering::Relaxed);
    assert_eq!(
        s.write(b"applied without receipt", b"must not replace", 2)[0],
        255
    );
    assert_eq!(
        fs::read(s.f.root.join("workspace/a.rs")).unwrap(),
        b"applied without receipt"
    );
}

#[test]
#[ignore = "requires Linux uid19998, installed Git and real filesystem"]
fn watcher_checkpoint_recovery_keeps_saved_version_after_an_outside_overwrite() {
    let mut s = Setup::new();
    assert_eq!(s.write(b"abc", b"acknowledged member save", 1)[0], 3);
    fs::write(s.f.root.join("workspace/a.rs"), b"outside after receipt").unwrap();
    // Reconstruct from the actual persisted checkpoint, with a fresh provider.
    // No in-memory save queue, pending burst, or old file bytes are supplied.
    let mut recovered = smithers_machined::events::Changes::new(s.checkpoint());
    let mut ports = Ports {
        root: s.f.root.join("workspace"),
        state: s.f.root.join("watcher"),
        git: smithers_machined::git::Repository::open(
            &s.f.root.join("workspace"),
            &s.f.root.join("spool"),
        )
        .unwrap(),
        observed: s.observed.clone(),
    };
    recovered
        .resync(&mut ports, 0, vec!["a.rs".into()])
        .unwrap();
    let events = s.observed.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].actor, Some(Actor::Principal(vec![1; 16])));
    assert_eq!(
        s.bytes(events[0].files["a.rs"].before.as_ref().unwrap()),
        b"abc"
    );
    assert_eq!(
        s.bytes(events[0].files["a.rs"].after.as_ref().unwrap()),
        b"acknowledged member save"
    );
    assert_eq!(events[1].actor, None);
    assert_eq!(
        s.bytes(events[1].files["a.rs"].before.as_ref().unwrap()),
        b"acknowledged member save"
    );
    assert_eq!(
        s.bytes(events[1].files["a.rs"].after.as_ref().unwrap()),
        b"outside after receipt"
    );
}
