//! Installed, unprivileged daemon composition. Paths and descriptors belong to
//! the shipped broker; repository data is never evaluated by the root process.
use crate::{
    attrib::Sample,
    broker::control::SocketpairBroker,
    conn,
    doc::{
        disk::{LinuxDisk, Versions},
        host::{Gates, Host},
        service::Service,
    },
    events::{Checkpoint, Closed, Provider},
    hooks::{self, Actor, EventSink, Hooks, Oid, Watcher as _},
    lock::LockCx,
    versions::Objects,
};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io,
    os::{
        fd::{FromRawFd, OwnedFd},
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};
type Events = crate::event_service::Events<crate::git::Repository, crate::git::Repository>;
type Watcher = crate::watch::InotifyWatcher<crate::ignore::GitIgnore, Ports>;
fn private(path: &Path) -> io::Result<File> {
    match fs::create_dir(path) {
        Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(0o700))?,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e),
    }
    let fd = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::DIRECTORY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )?;
    let file = File::from(fd);
    let m = file.metadata()?;
    if m.uid() != 19998 || m.mode() & 0o7777 != 0o700 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}
struct Ports {
    git: crate::git::Repository,
    native: Arc<crate::native::Repository>,
    core: Arc<crate::native_core::NativeCore>,
    events: Arc<Events>,
    broker: Arc<SocketpairBroker>,
    store: crate::watcher_store::Store,
    workspace: File,
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
        self.native.current()?;
        self.events.ready().map_err(crate::watch::provider_error)?;
        self.broker
            .registry()
            .map_err(crate::watch::provider_error)?;
        Ok(())
    }
    fn actor_session(&mut self, actor: &Actor) -> io::Result<Option<u32>> {
        let entries = self
            .broker
            .registry()
            .map_err(crate::watch::provider_error)?;
        let ids: Vec<_> = entries
            .iter()
            .filter(|e| match actor {
                Actor::Session(id) => e.id == *id,
                Actor::Run(run) => e.run.as_ref() == Some(run),
                Actor::Principal(reference) => {
                    reference.as_slice() == e.principal && e.principal != [0; 16]
                }
                _ => false,
            })
            .map(|e| e.id)
            .collect();
        Ok(if ids.len() == 1 { Some(ids[0]) } else { None })
    }
    fn samples(&mut self) -> io::Result<Vec<Sample<Actor>>> {
        let entries = self
            .broker
            .registry()
            .map_err(crate::watch::provider_error)?;
        let counters = entries
            .iter()
            .map(|e| {
                let cpu = fs::read_to_string(format!("{}/cpu.stat", e.cgroup()))?;
                let usage = cpu
                    .lines()
                    .find_map(|l| l.strip_prefix("usage_usec "))
                    .ok_or(io::ErrorKind::InvalidData)?
                    .parse::<u64>()
                    .map_err(io::Error::other)?;
                let population = fs::read_to_string(format!("{}/cgroup.events", e.cgroup()))?;
                let populated = match population
                    .lines()
                    .find_map(|l| l.strip_prefix("populated "))
                {
                    Some("0") => false,
                    Some("1") => true,
                    _ => return Err(io::ErrorKind::InvalidData.into()),
                };
                Ok((e.id, usage, populated))
            })
            .collect::<io::Result<Vec<_>>>()?;
        crate::session::samples(entries.iter(), &counters, |e| {
            (e.principal != [0; 16]).then(|| Actor::Principal(e.principal.to_vec()))
        })
    }
    fn read(&mut self, path: &str) -> io::Result<Option<(Vec<u8>, u32)>> {
        let (parent, name) = match crate::confine::parent(&self.workspace, path) {
            Ok(parent) => parent,
            Err(error) if crate::watch::replaced_entry(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut f = match crate::confine::open(
            &parent,
            &name,
            rustix::fs::OFlags::RDONLY,
            rustix::fs::Mode::empty(),
        ) {
            Ok(f) => f,
            Err(e) if crate::watch::replaced_entry(&e) => return Ok(None),
            Err(e) => return Err(e),
        };
        let m = f.metadata()?;
        if !m.is_file() {
            return Ok(None);
        }
        let bytes = crate::confine::read(&mut f, conn::MAX_FILE_BYTES)?;
        if bytes.len() > conn::MAX_FILE_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(Some((
            bytes,
            if m.mode() & 0o111 == 0 {
                0o100644
            } else {
                0o100755
            },
        )))
    }
    fn checkpoint(&mut self, s: &Checkpoint<Actor, Oid>) -> io::Result<()> {
        self.store.save(s, &mut self.git)?;
        self.store.finish_closes(&self.git)
    }
    fn append(&mut self, e: &Closed<Actor, Oid, Oid>) -> io::Result<()> {
        self.store.prepare_close(e, &self.git)?;
        crate::watcher_store::Store::publish_close(e, &self.events)
    }
    fn hint(
        &mut self,
        path: &str,
        actor: Option<&Actor>,
        digest: Option<[u8; 32]>,
    ) -> io::Result<()> {
        self.events
            .hint(
                &conn::file_written(path, actor.unwrap_or(&Actor::Outside), digest)
                    .map_err(io::Error::other)?,
            )
            .map_err(crate::watch::provider_error)
    }
    fn where_file(&mut self, session: u32, path: &str) -> io::Result<()> {
        hooks::Sessions::where_file(&*self.broker, session, path)
            .map_err(crate::watch::provider_error)
    }
    fn moved_off(&mut self) -> io::Result<()> {
        self.moved_off_attributed(None)
    }
    fn moved_off_attributed(&mut self, actor: Option<&Actor>) -> io::Result<()> {
        self.core
            .observe_moved_off(actor.unwrap_or(&Actor::Outside))
            .map_err(crate::watch::provider_error)
    }
    fn snapshot(&mut self) -> io::Result<()> {
        self.native.snapshot().map(|_| ())
    }
}
fn saved_actor(actor: Option<&str>) -> Actor {
    let Some(actor) = actor.filter(|s| s.len() == 32) else {
        return Actor::Outside;
    };
    let mut reference = Vec::with_capacity(16);
    for pair in actor.as_bytes().chunks_exact(2) {
        let nibble = |b| match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            _ => None,
        };
        let (Some(high), Some(low)) = (nibble(pair[0]), nibble(pair[1])) else {
            return Actor::Outside;
        };
        reference.push(high * 16 + low);
    }
    if reference.iter().all(|b| *b == 0) {
        Actor::Outside
    } else {
        Actor::Principal(reference)
    }
}

struct DocumentVersions {
    #[cfg(all(feature = "testing", debug_assertions))]
    broker: Arc<SocketpairBroker>,
    git: crate::git::Repository,
    events: Arc<Events>,
    watcher: Arc<OnceLock<Arc<Watcher>>>,
}
impl Versions for DocumentVersions {
    fn own_delete(&mut self, path: &str, actor: Option<&str>) -> crate::doc::Result<()> {
        self.watcher
            .get()
            .ok_or(crate::doc::Error::Unsupported)?
            .after_delete(path, &saved_actor(actor))
            .map_err(crate::doc::Error::Provider)
    }

    fn outside(&mut self, path: &str, text: &[u8], _: &str) -> crate::doc::Result<String> {
        let blob = self.git.blob(text)?;
        let mut files = BTreeMap::new();
        files.insert(
            path.to_owned(),
            crate::burst::File {
                before: None,
                after: Some(crate::versions::Version {
                    blob,
                    post_digest: crate::doc::state::digest(text),
                    mode: 0o100644,
                }),
            },
        );
        let commit = crate::versions::commit(&mut self.git, &files)?;
        let mut id = [0; 16];
        getrandom::fill(&mut id).map_err(|e| crate::doc::Error::Io(e.to_string()))?;
        let closed = Closed {
            burst_id: id,
            actor: None,
            session: None,
            files,
            versions_commit: commit,
            renamed_to: BTreeMap::new(),
            last_path: path.into(),
        };
        for event in
            crate::events::wire_events(&closed).map_err(|e| crate::doc::Error::Io(e.to_string()))?
        {
            self.events
                .append(&event, Some(commit))
                .map_err(|_| crate::doc::Error::Io("outside version append failed".into()))?;
        }
        let version: String = commit.iter().map(|b| format!("{b:02x}")).collect();
        #[cfg(all(feature = "testing", debug_assertions))]
        {
            let sessions = self
                .broker
                .registry()
                .map_err(crate::doc::Error::Provider)?;
            let sessions: Vec<_> = sessions.iter().filter(|s| !s.closed && !s.exited).map(|s| serde_json::json!({"id":s.id,"principal":s.principal,"kind":s.kind,"run":s.run})).collect();
            eprintln!(
                "{}",
                serde_json::json!({"event":"doc-outside-version","path":path,"version":version,"session_set":sessions})
            );
        }
        Ok(version)
    }
    fn before_write(&mut self, path: &str, actor: Option<&str>) -> crate::doc::Result<()> {
        self.watcher
            .get()
            .ok_or(crate::doc::Error::Unsupported)?
            .before_write(path, &saved_actor(actor))
            .map_err(crate::doc::Error::Provider)
    }
    fn own_write(
        &mut self,
        path: &str,
        bytes: &[u8],
        mode: u32,
        actor: Option<&str>,
    ) -> crate::doc::Result<()> {
        self.watcher
            .get()
            .ok_or(crate::doc::Error::Unsupported)?
            .after_write(path, &saved_actor(actor), bytes, mode)
            .map_err(crate::doc::Error::Provider)
    }
}
/// Validates the inherited process boundary before reading authority or repo data.
pub fn run() -> io::Result<()> {
    // Set before composing providers or starting threads. Setgid workspace
    // directories supply team ownership; jj tempfiles also need their grant.
    rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o002));
    if rustix::process::getuid().as_raw() != 19998 || rustix::process::geteuid().as_raw() != 19998 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let boot = crate::boot::Boot::open()?;
    // SAFETY: the shipped broker explicitly installs these three descriptors;
    // each is taken exactly once after verifying the fixed daemon identity.
    let broker = SocketpairBroker::new(unsafe { OwnedFd::from_raw_fd(3) })?;
    #[cfg(all(feature = "testing", debug_assertions))]
    let broker = broker.with_installed_input_validation();
    let broker = Arc::new(broker);
    let state = Path::new("/var/lib/smithers-machined");
    let outbox_dir = state.join("outbox");
    private(&outbox_dir)?;
    let store = match crate::outbox_store::Store::open(&outbox_dir, 19998) {
        Ok(store) => store,
        Err(error) if crate::outbox_store::format_unsupported(&error) => {
            return match boot.topology {
                crate::boot::Topology::Relay => crate::daemon::run_outbox_refused(
                    boot,
                    crate::link::RelayListener(unsafe { std::net::TcpListener::from_raw_fd(4) }),
                ),
                crate::boot::Topology::Bridge(port) => {
                    crate::daemon::run_outbox_refused(boot, crate::link::BridgeDialer(port))
                }
            };
        }
        Err(error) => return Err(error),
    };
    let native = Arc::new(crate::native::Repository::installed()?);
    let spool = state.join("bundles");
    private(&spool)?;
    let git = crate::git::Repository::open(Path::new("/workspace"), &spool)?;
    let outbox = crate::outbox::Outbox::open(store, 19998, git.clone())?;
    let allocator = broker.clone();
    let events = Arc::new(
        Events::new(outbox, git.clone(), move || allocator.allocate_stream())?
            .with_incoming(Arc::new(git.clone())),
    );
    // Fixed daemon-owned state; no branch path or root step is introduced.
    use std::os::unix::fs::OpenOptionsExt;
    let log = std::fs::OpenOptions::new().create(true).append(true).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(state.join("rebase.jsonl"))?;
    let metadata = log.metadata()?;
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_file() || metadata.uid() != 19998 || metadata.mode() & 0o777 != 0o600 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    events.observe_rebases(boot.identity.boot, log)?;
    let core =
        Arc::new(crate::native_core::NativeCore {
            item: boot.item.clone(),
            moved: Mutex::new(boot.moved_off.as_ref().map(|pre_move_commit| {
                crate::moved_off::Fact {
                    by: String::new(),
                    item: format!("T{}", boot.item.as_ref().unwrap().number),
                    pre_move_commit: pre_move_commit.clone(),
                }
            })),
            native: native.clone(),
            git: git.clone(),
            events: events.clone(),
            sessions: broker.clone(),
        });
    // Members' own agent sessions (spec §9.6.6). The pump reads only while
    // this daemon serves a ready link, and ends if the broker has no import.
    let transcripts = crate::transcript::pump::Pump::new(
        broker.clone(),
        events.clone(),
        private(&state.join("transcripts"))?,
    )?;
    let serving = broker.clone();
    std::thread::Builder::new()
        .name("transcripts".into())
        .spawn(move || {
            crate::transcript::pump::run(transcripts, move || {
                serving.serving(std::time::Instant::now())
            })
        })?;
    let workspace = File::open("/workspace")?;
    crate::confine::probe(&workspace)?;
    let documents_dir = private(&state.join("documents"))?;
    let document_watcher = Arc::new(OnceLock::new());
    let disk = LinuxDisk::new(
        workspace.try_clone()?,
        documents_dir,
        DocumentVersions {
            #[cfg(all(feature = "testing", debug_assertions))]
            broker: broker.clone(),
            git: git.clone(),
            events: events.clone(),
            watcher: document_watcher.clone(),
        },
    )
    .map_err(|e| io::Error::other(format!("{e:?}")))?;
    let allocator = broker.clone();
    let documents = Arc::new(Service::new(
        Host::new(
            disk,
            Gates {
                codec: true,
                dispatcher: true,
                envelopes: true,
                saved_epoch: true,
                authenticated_machine: true,
                mutation_lock: true,
                capture_rewrite: true,
                attribution: true,
                versions: true,
                topology: true,
                kernel: true,
                non_root_machine: true,
            },
            move || {
                allocator
                    .allocate_stream()
                    .map_err(|_| crate::doc::Error::Unsupported)
            },
        ),
        Arc::new(hooks::SystemClock),
    ));
    let files = Arc::new(crate::files::Files::new(
        workspace.try_clone()?,
        core.clone(),
    )?);
    let mut hooks = Hooks {
        core: files.clone(),
        documents,
        events: events.clone(),
        broker: broker.clone(),
        sessions: broker.clone(),
        ..Default::default()
    };
    let store = crate::watcher_store::Store::open(state)?;
    let mut checkpoint = store.load()?;
    let mut recovery_git = git.clone();
    store.recover_closes(&mut checkpoint, &mut recovery_git, &events)?;
    let ignore = crate::ignore::GitIgnore::new("/workspace".into(), "/usr/bin/git".into(), vec![])?;
    let (watch, _) = crate::watch::Inotify::new(workspace.try_clone()?, ignore)?;
    let mut cx = LockCx::recovering(hooks.clone(), crate::rewrite_journal::Journal::open(state)?)?;
    if cx.rewrite_pending {
        crate::freeze::restore(&mut cx, &Actor::Outside).map_err(crate::watch::provider_error)?;
    }
    let watcher = Arc::new(
        crate::watch::InotifyWatcher::activate(
            watch,
            Ports {
                git,
                native,
                core,
                events: events.clone(),
                broker,
                store,
                workspace,
            },
            checkpoint,
            &mut cx,
        )
        .map_err(crate::watch::provider_error)?,
    );
    document_watcher
        .set(watcher.clone())
        .map_err(|_| io::Error::other("document watcher already bound"))?;
    hooks.watcher = watcher;
    let local = unsafe { std::os::unix::net::UnixListener::from_raw_fd(5) };
    match boot.topology {
        crate::boot::Topology::Relay => crate::daemon::run_with_local(
            boot,
            hooks,
            crate::link::RelayListener(unsafe { std::net::TcpListener::from_raw_fd(4) }),
            move || events.next_sequence(),
            Some((local, files)),
        ),
        crate::boot::Topology::Bridge(port) => crate::daemon::run_with_local(
            boot,
            hooks,
            crate::link::BridgeDialer(port),
            move || events.next_sequence(),
            Some((local, files)),
        ),
    }
}

#[cfg(test)]
mod document_save_actor_tests {
    use super::*;

    #[test]
    fn save_actor_is_an_opaque_reference_not_a_display_name() {
        assert_eq!(
            saved_actor(Some("00ff800102030405060708090a0b0c0d")),
            Actor::Principal(vec![0, 255, 128, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
        );
        for label in [
            None,
            Some(""),
            Some("outside"),
            Some("session:1"),
            Some("run:abc"),
            Some("alice"),
            Some("00000000000000000000000000000000"),
            Some("00FF800102030405060708090A0B0C0D"),
            Some("zzff800102030405060708090a0b0c0d"),
            Some("éééééééééééééééé"),
            Some("00ff800102030405060708090a0b0c"),
        ] {
            assert_eq!(saved_actor(label), Actor::Outside, "{label:?}");
        }
    }
}
