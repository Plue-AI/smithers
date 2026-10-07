//! Installed, unprivileged daemon composition. Paths and descriptors belong to
//! the shipped broker; repository data is never evaluated by the root process.
use crate::{
    attrib::Sample,
    broker::control::SocketpairBroker,
    conn::{self, field, structure_bytes, tagged},
    doc::{
        disk::{LinuxDisk, Versions},
        host::{Gates, Host},
        service::Service,
    },
    events::{Checkpoint, Closed, Provider},
    hooks::{self, Actor, EventSink, Hooks, Oid},
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
    sync::{Arc, Mutex},
};
type Events = crate::event_service::Events<crate::git::Repository, crate::git::Repository>;
fn bytes(value: &str) -> Vec<u8> {
    let mut b = (value.len() as u16).to_be_bytes().to_vec();
    b.extend(value.as_bytes());
    b
}
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
    events: Arc<Events>,
    broker: Arc<SocketpairBroker>,
    store: crate::watcher_store::Store,
    workspace: File,
    saved: Arc<Mutex<Vec<(String, Actor, [u8; 32])>>>,
    paths: BTreeMap<u32, String>,
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
                // Principal identifiers are host-owned; never infer one from login.
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
        crate::session::samples(entries.iter(), &counters, |e| Some(Actor::Session(e.id)))
    }
    fn read(&mut self, path: &str) -> io::Result<Option<(Vec<u8>, u32)>> {
        let (parent, name) = crate::confine::parent(&self.workspace, path)?;
        let mut f = match crate::confine::open(
            &parent,
            &name,
            rustix::fs::OFlags::RDONLY,
            rustix::fs::Mode::empty(),
        ) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let m = f.metadata()?;
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
        self.store.save(s, &mut self.git)
    }
    fn append(&mut self, e: &Closed<Actor, Oid, Oid>) -> io::Result<()> {
        for event in crate::events::wire_events(e).map_err(io::Error::other)? {
            self.events
                .append(&event, Some(e.versions_commit))
                .map_err(crate::watch::provider_error)?;
        }
        Ok(())
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
        let entries = self
            .broker
            .registry()
            .map_err(crate::watch::provider_error)?;
        if !entries.iter().any(|e| e.id == session) || !crate::doc::disk::valid_path(path) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        self.paths
            .retain(|id, _| entries.iter().any(|e| e.id == *id));
        self.paths.insert(session, path.into());
        let mut list = (entries.len() as u16).to_be_bytes().to_vec();
        for entry in entries {
            let mut fields = vec![field(1, entry.id.to_be_bytes())];
            if let Some(path) = self.paths.get(&entry.id) {
                fields.push(field(2, bytes(path)));
            }
            list.extend(structure_bytes(&fields));
        }
        self.events
            .presence(&tagged(1, &[field(1, list)]))
            .map_err(crate::watch::provider_error)
    }
    fn saved_writes(&mut self) -> Vec<(String, Actor, [u8; 32])> {
        std::mem::take(&mut *self.saved.lock().unwrap_or_else(|e| e.into_inner()))
    }
    fn moved_off(&mut self) -> io::Result<()> {
        self.native.current().map(|_| ())
    }
    fn snapshot(&mut self) -> io::Result<()> {
        self.native.snapshot().map(|_| ())
    }
}
struct DocumentVersions {
    git: crate::git::Repository,
    events: Arc<Events>,
    saved: Arc<Mutex<Vec<(String, Actor, [u8; 32])>>>,
}
impl Versions for DocumentVersions {
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
        Ok(commit.iter().map(|b| format!("{b:02x}")).collect())
    }
    fn own_write(&mut self, path: &str, digest: [u8; 32]) {
        // Timer saves can combine multiple authors; Outside preserves that
        // uncertainty rather than attributing them to an arbitrary subscriber.
        self.saved.lock().unwrap_or_else(|e| e.into_inner()).push((
            path.into(),
            Actor::Outside,
            digest,
        ));
    }
}
/// Validates the inherited process boundary before reading authority or repo data.
pub fn run() -> io::Result<()> {
    if rustix::process::getuid().as_raw() != 19998 || rustix::process::geteuid().as_raw() != 19998 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let boot = crate::boot::Boot::open()?;
    // SAFETY: the shipped broker explicitly installs these three descriptors;
    // each is taken exactly once after verifying the fixed daemon identity.
    let broker = Arc::new(SocketpairBroker::new(unsafe { OwnedFd::from_raw_fd(3) })?);
    let native = Arc::new(crate::native::Repository::installed()?);
    let state = Path::new("/var/lib/smithers-machined");
    let spool = state.join("bundles");
    private(&spool)?;
    let git = crate::git::Repository::open(Path::new("/workspace"), &spool)?;
    let outbox_dir = state.join("outbox");
    private(&outbox_dir)?;
    let outbox = crate::outbox::Outbox::open(
        crate::outbox_store::Store::open(&outbox_dir, 19998)?,
        19998,
        git.clone(),
    )?;
    let allocator = broker.clone();
    let events = Arc::new(Events::new(outbox, git.clone(), move || {
        allocator.allocate_stream()
    })?);
    let core = Arc::new(crate::native_core::NativeCore {
        native: native.clone(),
        git: git.clone(),
        events: events.clone(),
        sessions: broker.clone(),
    });
    let workspace = File::open("/workspace")?;
    crate::confine::probe(&workspace)?;
    let documents_dir = private(&state.join("documents"))?;
    let saved = Arc::new(Mutex::new(Vec::new()));
    let disk = LinuxDisk::new(
        workspace.try_clone()?,
        documents_dir,
        DocumentVersions {
            git: git.clone(),
            events: events.clone(),
            saved: saved.clone(),
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
    let files = Arc::new(crate::files::Files::new(workspace.try_clone()?, core)?);
    let mut hooks = Hooks {
        core: files.clone(),
        documents,
        events: events.clone(),
        broker: broker.clone(),
        sessions: broker.clone(),
        ..Default::default()
    };
    let store = crate::watcher_store::Store::open(state)?;
    let checkpoint = store.load()?;
    let ignore = crate::ignore::GitIgnore::new("/workspace".into(), "/usr/bin/git".into(), vec![])?;
    let (watch, _) = crate::watch::Inotify::new(workspace.try_clone()?, ignore)?;
    let mut cx = LockCx::recovering(hooks.clone(), crate::rewrite_journal::Journal::open(state)?)?;
    if cx.rewrite_pending {
        crate::freeze::restore(&mut cx, &Actor::Outside).map_err(crate::watch::provider_error)?;
    }
    hooks.watcher = Arc::new(
        crate::watch::InotifyWatcher::activate(
            watch,
            Ports {
                git,
                native,
                events: events.clone(),
                broker,
                store,
                workspace,
                saved,
                paths: BTreeMap::new(),
            },
            checkpoint,
            &mut cx,
        )
        .map_err(crate::watch::provider_error)?,
    );
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
