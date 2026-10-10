//! Real recursive inotify with held directory descriptors. The lock-thread
//! adapter drains this before RPC writes; this module never mutates files.
use crate::events::Provider as _;
use crate::ignore::{relative, Ignore};
use rustix::fs::{self, inotify, Mode, OFlags, ResolveFlags};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read},
    mem::MaybeUninit,
    os::fd::{AsRawFd, OwnedFd},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    File {
        path: String,
        cookie: u32,
        from: bool,
        to: bool,
    },
    Metadata,
    Overflow,
}
struct Directory {
    path: PathBuf,
    _held: File,
    metadata: bool,
    recursive: bool,
}
pub struct Inotify<I> {
    root: File,
    fd: OwnedFd,
    dirs: BTreeMap<i32, Directory>,
    ignore: I,
}
const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_XDEV);
// A queued directory/file event can name an inode that has since become a
// symlink or moved outside the held workspace. Such an entry is excluded from
// the public regular-file watcher; kernel confinement is never retried loosely.
pub(crate) fn replaced_entry(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP | libc::EXDEV)
    )
}
fn open(root: &File, path: &Path, directory: bool) -> io::Result<File> {
    Ok(fs::openat2(
        root,
        path,
        OFlags::RDONLY
            | OFlags::CLOEXEC
            | OFlags::NONBLOCK
            | OFlags::NOFOLLOW
            | if directory {
                OFlags::DIRECTORY
            } else {
                OFlags::empty()
            },
        Mode::empty(),
        RESOLVE,
    )?
    .into())
}
impl<I: Ignore> Inotify<I> {
    /// root comes from startup's trusted workspace descriptor. No privileged
    /// setup or root-owned watch-limit adjustment is performed here.
    pub fn new(root: File, ignore: I) -> io::Result<(Self, Vec<String>)> {
        if rustix::process::geteuid().is_root() || !root.metadata()?.is_dir() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let mut this = Self {
            root,
            fd: inotify::init(inotify::CreateFlags::CLOEXEC | inotify::CreateFlags::NONBLOCK)?,
            dirs: BTreeMap::new(),
            ignore,
        };
        let files = this.rearm()?;
        Ok((this, files))
    }
    fn scan(
        &mut self,
        path: &Path,
        metadata: bool,
        recursive: bool,
        files: &mut Vec<String>,
    ) -> io::Result<()> {
        // Daemon-owned pins do not move HEAD or the jj working copy. Watching
        // our own checkpoint refs would block the next save as a branch move.
        if metadata && path.starts_with(".git/refs/smithers") {
            return Ok(());
        }
        if !metadata && path != Path::new(".") && self.ignore.ignored(path, true)? {
            return Ok(());
        }
        let held = match open(&self.root, path, true) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) if !metadata && path != Path::new(".") && replaced_entry(&e) => return Ok(()),
            Err(e) => return Err(e),
        };
        let wd = inotify::add_watch(
            &self.fd,
            format!("/proc/self/fd/{}", held.as_raw_fd()),
            inotify::WatchFlags::CLOSE_WRITE
                | inotify::WatchFlags::MOVED_FROM
                | inotify::WatchFlags::MOVED_TO
                | inotify::WatchFlags::CREATE
                | inotify::WatchFlags::DELETE
                | inotify::WatchFlags::DELETE_SELF
                | inotify::WatchFlags::MOVE_SELF
                | inotify::WatchFlags::ONLYDIR,
        )?;
        let mut dir = fs::Dir::read_from(&held)?;
        self.dirs.insert(
            wd,
            Directory {
                path: path.into(),
                _held: held,
                metadata,
                recursive,
            },
        );
        if !recursive {
            return Ok(());
        }
        let mut entries = vec![];
        while let Some(entry) = dir.read() {
            let entry = entry?;
            let Ok(name) = entry.file_name().to_str() else {
                continue;
            };
            if name == "." || name == ".." {
                continue;
            }
            let child = if path == Path::new(".") {
                PathBuf::from(name)
            } else {
                path.join(name)
            };
            entries.push((child, entry.file_type()));
        }
        let ignored = if metadata {
            vec![false; entries.len()]
        } else {
            self.ignore.batch(
                &entries
                    .iter()
                    .map(|(p, t)| (p.clone(), *t == fs::FileType::Directory))
                    .collect::<Vec<_>>(),
            )?
        };
        for ((child, kind), ignored) in entries.into_iter().zip(ignored) {
            if ignored {
                continue;
            }
            match kind {
                fs::FileType::Directory => self.scan(&child, metadata, true, files)?,
                fs::FileType::RegularFile if !metadata => {
                    files.push(child.to_str().unwrap().into())
                }
                _ => (),
            }
        }
        Ok(())
    }
    /// Overflow replaces the fd too: queued stale watch IDs cannot be mistaken
    /// for re-used IDs. The caller snapshots and compares this complete scan.
    pub fn rearm(&mut self) -> io::Result<Vec<String>> {
        self.fd = inotify::init(inotify::CreateFlags::CLOEXEC | inotify::CreateFlags::NONBLOCK)?;
        self.dirs.clear();
        let mut files = vec![];
        self.scan(Path::new("."), false, true, &mut files)?;
        self.rearm_metadata()?;
        Ok(files)
    }
    // Watch the fixed metadata ancestors as well: jj may be initialized after
    // startup, and tools replace refs/op-head directories with atomic renames.
    // These shallow watches observe only the next metadata component.
    fn rearm_metadata(&mut self) -> io::Result<()> {
        let old: Vec<_> = self
            .dirs
            .iter()
            .filter_map(|(wd, d)| d.metadata.then_some(*wd))
            .collect();
        for wd in old {
            match inotify::remove_watch(&self.fd, wd) {
                Ok(()) | Err(rustix::io::Errno::INVAL) => (),
                Err(e) => return Err(e.into()),
            }
            self.dirs.remove(&wd);
        }
        for (p, recursive) in [
            (".git", false),
            (".jj", false),
            (".jj/repo", false),
            (".jj/repo/op_heads", false),
            (".git/refs", true),
            (".jj/repo/op_heads/heads", true),
        ] {
            self.scan(Path::new(p), true, recursive, &mut vec![])?;
        }
        Ok(())
    }
    pub fn tracked(&mut self, path: &str) -> io::Result<bool> {
        Ok(!self.ignore.ignored(Path::new(path), false)?)
    }
    pub fn tracked_paths(&mut self, paths: Vec<String>) -> io::Result<Vec<String>> {
        let ignored = self.ignore.batch(
            &paths
                .iter()
                .map(|p| (PathBuf::from(p), false))
                .collect::<Vec<_>>(),
        )?;
        Ok(paths
            .into_iter()
            .zip(ignored)
            .filter_map(|(p, i)| if i { None } else { Some(p) })
            .collect())
    }
    pub fn read(&self, path: &str) -> io::Result<Option<Vec<u8>>> {
        if !relative(Path::new(path)) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let file = match open(&self.root, Path::new(path), false) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if !file.metadata()?.is_file() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mut bytes = vec![];
        file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(Some(bytes))
    }
    pub fn drain(&mut self) -> io::Result<Vec<Event>> {
        let mut raw = vec![];
        let mut buf = [MaybeUninit::uninit(); 65536];
        let mut reader = inotify::Reader::new(&self.fd, &mut buf);
        loop {
            match reader.next() {
                Ok(e) => raw.push((
                    e.wd(),
                    e.events(),
                    e.cookie(),
                    e.file_name().map(|n| n.to_bytes().to_vec()),
                )),
                Err(rustix::io::Errno::AGAIN) => break,
                Err(rustix::io::Errno::INTR) => continue,
                Err(e) => return Err(e.into()),
            }
        }
        let mut candidates = Vec::new();
        for (wd, flags, _, name) in &raw {
            if let Some(d) = self.dirs.get(wd).filter(|d| !d.metadata) {
                if let Some(name) = name.as_ref().and_then(|n| std::str::from_utf8(n).ok()) {
                    let path = if d.path == Path::new(".") {
                        PathBuf::from(name)
                    } else {
                        d.path.join(name)
                    };
                    candidates.push((path, flags.contains(inotify::ReadFlags::ISDIR)));
                }
            }
        }
        let ignored = self.ignore.batch(&candidates)?;
        let filtered: BTreeMap<_, _> = candidates.into_iter().zip(ignored).collect();
        let mut out = vec![];
        let mut metadata_rearm = false;
        for (wd, flags, cookie, name) in raw {
            if flags.contains(inotify::ReadFlags::QUEUE_OVERFLOW) {
                return Ok(vec![Event::Overflow]);
            }
            if flags.contains(inotify::ReadFlags::IGNORED) {
                self.dirs.remove(&wd);
                continue;
            }
            let Some(d) = self.dirs.get(&wd) else {
                continue;
            };
            let metadata = d.metadata;
            let recursive = d.recursive;
            if flags.intersects(inotify::ReadFlags::DELETE_SELF | inotify::ReadFlags::MOVE_SELF) {
                if metadata {
                    metadata_rearm = true;
                    out.push(Event::Metadata);
                    continue;
                }
                return Ok(vec![Event::Overflow]);
            }
            let Some(name) = name.and_then(|n| String::from_utf8(n).ok()) else {
                continue;
            };
            let path = if d.path == Path::new(".") {
                PathBuf::from(&name)
            } else {
                d.path.join(&name)
            };
            if metadata {
                if path.starts_with(".git/refs/smithers") {
                    continue;
                }
                let relevant = recursive
                    || match d.path.to_str() {
                        Some(".git") => matches!(name.as_str(), "HEAD" | "packed-refs" | "refs"),
                        Some(".jj") => name == "repo",
                        Some(".jj/repo") => name == "op_heads",
                        Some(".jj/repo/op_heads") => name == "heads",
                        _ => false,
                    };
                if relevant {
                    out.push(Event::Metadata);
                    metadata_rearm |= flags.contains(inotify::ReadFlags::ISDIR);
                }
                continue;
            }
            if path == Path::new(".git") || path == Path::new(".jj") {
                if flags.contains(inotify::ReadFlags::ISDIR) {
                    metadata_rearm = true;
                    out.push(Event::Metadata);
                }
                continue;
            }
            if name == ".gitignore" {
                return Ok(vec![Event::Overflow]);
            }
            if filtered
                .get(&(path.clone(), flags.contains(inotify::ReadFlags::ISDIR)))
                .copied()
                .unwrap_or(false)
            {
                continue;
            }
            if flags.contains(inotify::ReadFlags::ISDIR) {
                if flags.intersects(inotify::ReadFlags::CREATE | inotify::ReadFlags::MOVED_TO) {
                    let mut files = vec![];
                    self.scan(&path, false, true, &mut files)?;
                    out.extend(files.into_iter().map(|path| Event::File {
                        path,
                        cookie: 0,
                        from: false,
                        to: false,
                    }));
                }
                if flags.intersects(inotify::ReadFlags::MOVED_FROM | inotify::ReadFlags::DELETE) {
                    // A moved directory's descriptor no longer has its old path.
                    // Force a full comparison, including all descendant deletes.
                    return Ok(vec![Event::Overflow]);
                }
                continue;
            }
            if flags.intersects(
                inotify::ReadFlags::CLOSE_WRITE
                    | inotify::ReadFlags::MOVED_FROM
                    | inotify::ReadFlags::MOVED_TO
                    | inotify::ReadFlags::DELETE,
            ) {
                out.push(Event::File {
                    path: path.to_str().unwrap().into(),
                    cookie,
                    from: flags.contains(inotify::ReadFlags::MOVED_FROM),
                    to: flags.contains(inotify::ReadFlags::MOVED_TO),
                });
            }
        }
        if metadata_rearm {
            self.rearm_metadata()?;
        }
        Ok(out)
    }
}

/// The watcher owns the session-presence sink. Event/object providers cannot
/// substitute an unauthenticated location callback for the admitted broker.
struct SessionPresence<P> {
    provider: P,
    sessions: std::sync::Arc<dyn crate::hooks::Sessions>,
    completed: Vec<(String, crate::hooks::Actor)>,
}
impl<P: crate::versions::Objects> crate::versions::Objects for SessionPresence<P> {
    type Blob = P::Blob;
    type Commit = P::Commit;
    fn blob(&mut self, bytes: &[u8]) -> io::Result<Self::Blob> {
        self.provider.blob(bytes)
    }
    fn parentless(
        &mut self,
        tree: &std::collections::BTreeMap<String, (Self::Blob, u32)>,
    ) -> io::Result<Self::Commit> {
        self.provider.parentless(tree)
    }
}
impl<P: crate::events::Provider<crate::hooks::Actor>> crate::events::Provider<crate::hooks::Actor>
    for SessionPresence<P>
{
    fn activate(&mut self) -> io::Result<()> {
        self.sessions.ready().map_err(provider_error)?;
        self.provider.activate()
    }
    fn actor_session(&mut self, actor: &crate::hooks::Actor) -> io::Result<Option<u32>> {
        self.provider.actor_session(actor)
    }
    fn samples(&mut self) -> io::Result<Vec<crate::attrib::Sample<crate::hooks::Actor>>> {
        self.provider.samples()
    }
    fn read(&mut self, path: &str) -> io::Result<Option<(Vec<u8>, u32)>> {
        self.provider.read(path)
    }
    fn checkpoint(
        &mut self,
        state: &crate::events::Checkpoint<crate::hooks::Actor, Self::Blob>,
    ) -> io::Result<()> {
        self.provider.checkpoint(state)
    }
    fn append(
        &mut self,
        event: &crate::events::Closed<crate::hooks::Actor, Self::Blob, Self::Commit>,
    ) -> io::Result<()> {
        self.provider.append(event)
    }
    fn hint(
        &mut self,
        path: &str,
        actor: Option<&crate::hooks::Actor>,
        digest: Option<[u8; 32]>,
    ) -> io::Result<()> {
        self.provider.hint(path, actor, digest)?;
        self.completed.push((
            path.into(),
            actor.cloned().unwrap_or(crate::hooks::Actor::Outside),
        ));
        Ok(())
    }
    fn where_file(&mut self, session: u32, path: &str) -> io::Result<()> {
        self.sessions
            .where_file(session, path)
            .map_err(provider_error)
    }
    fn moved_off(&mut self) -> io::Result<()> {
        self.provider.moved_off()
    }
    fn moved_off_attributed(&mut self, actor: Option<&crate::hooks::Actor>) -> io::Result<()> {
        self.provider.moved_off_attributed(actor)
    }
    fn snapshot(&mut self) -> io::Result<()> {
        self.provider.snapshot()
    }
}

/// Dispatcher adapter. This mutex protects hook interior state while the
/// existing FIFO LockCx owns working-copy mutation ordering; no executor or
/// second mutation queue is created by the watcher.
pub struct InotifyWatcher<I, P> {
    state: std::sync::Mutex<(
        crate::resync::WatchLoop<I, crate::hooks::Actor, crate::hooks::Oid>,
        SessionPresence<P>,
    )>,
    origin: std::time::Instant,
    clock: std::sync::Arc<dyn crate::hooks::Clock>,
}
/// Preserve the shared core's typed refusal (notably moved_off) across the
/// provider's IO boundary without inventing a second error envelope.
#[derive(Debug)]
struct HookFailure(crate::hooks::Error);
impl std::fmt::Display for HookFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "daemon error {}", self.0.code)
    }
}
impl std::error::Error for HookFailure {}
pub fn provider_error(error: crate::hooks::Error) -> io::Error {
    io::Error::other(HookFailure(error))
}
fn hook_error(error: io::Error) -> crate::hooks::Error {
    if let Some(failure) = error
        .get_ref()
        .and_then(|e| e.downcast_ref::<HookFailure>())
    {
        return failure.0.clone();
    }

    let mut result = crate::hooks::Error::unsupported();
    result.code = match error.kind() {
        io::ErrorKind::Unsupported => 2,
        io::ErrorKind::PermissionDenied => 11,
        io::ErrorKind::InvalidInput => 6,
        _ => 3,
    };
    result.detail = Some(error.to_string());
    result
}
impl<I: Ignore, P: crate::events::Provider<crate::hooks::Actor, Blob = crate::hooks::Oid>>
    InotifyWatcher<I, P>
{
    pub fn activate(
        watch: Inotify<I>,
        provider: P,
        checkpoint: crate::events::Checkpoint<crate::hooks::Actor, crate::hooks::Oid>,
        cx: &mut crate::lock::LockCx,
    ) -> crate::hooks::Result<Self> {
        if rustix::process::getuid().as_raw() != 19998
            || rustix::process::geteuid().as_raw() != 19998
        {
            return Err(hook_error(io::ErrorKind::PermissionDenied.into()));
        }
        Self::mount(watch, provider, checkpoint, cx)
    }
    #[cfg(feature = "testing")]
    pub fn fixture(
        watch: Inotify<I>,
        provider: P,
        checkpoint: crate::events::Checkpoint<crate::hooks::Actor, crate::hooks::Oid>,
        cx: &mut crate::lock::LockCx,
    ) -> crate::hooks::Result<Self> {
        if rustix::process::geteuid().is_root() {
            return Err(hook_error(io::ErrorKind::PermissionDenied.into()));
        }
        Self::mount(watch, provider, checkpoint, cx)
    }
    fn mount(
        watch: Inotify<I>,
        provider: P,
        checkpoint: crate::events::Checkpoint<crate::hooks::Actor, crate::hooks::Oid>,
        cx: &mut crate::lock::LockCx,
    ) -> crate::hooks::Result<Self> {
        let mut provider = SessionPresence {
            provider,
            sessions: cx.hooks.sessions.clone(),
            completed: vec![],
        };
        crate::events::Provider::activate(&mut provider).map_err(hook_error)?;
        let mut watcher =
            crate::resync::WatchLoop::new(watch, crate::events::Changes::new(checkpoint));
        watcher.resync(&mut provider, 0).map_err(hook_error)?;
        Ok(Self {
            state: std::sync::Mutex::new((watcher, provider)),
            origin: cx.hooks.clock.mono(),
            clock: cx.hooks.clock.clone(),
        })
    }
    fn job<T>(
        &self,
        cx: &mut crate::lock::LockCx,
        f: impl FnOnce(
            &mut crate::resync::WatchLoop<I, crate::hooks::Actor, crate::hooks::Oid>,
            &mut SessionPresence<P>,
            u64,
        ) -> io::Result<T>,
    ) -> crate::hooks::Result<T> {
        self.job_at(cx.hooks.clock.mono(), f)
    }
    fn job_at<T>(
        &self,
        at: std::time::Instant,
        f: impl FnOnce(
            &mut crate::resync::WatchLoop<I, crate::hooks::Actor, crate::hooks::Oid>,
            &mut SessionPresence<P>,
            u64,
        ) -> io::Result<T>,
    ) -> crate::hooks::Result<T> {
        let now = at
            .saturating_duration_since(self.origin)
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        let mut state = self
            .state
            .lock()
            .map_err(|_| hook_error(io::Error::other("watcher state poisoned")))?;
        let (watcher, provider) = &mut *state;
        f(watcher, provider, now).map_err(hook_error)
    }
}
impl<
        I: Ignore + Send,
        P: crate::events::Provider<crate::hooks::Actor, Blob = crate::hooks::Oid> + Send,
    > crate::hooks::Watcher for InotifyWatcher<I, P>
{
    fn ready(&self) -> crate::hooks::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| hook_error(io::Error::other("watcher state poisoned")))?;
        state.1.activate().map_err(hook_error)
    }
    fn idle(&self, cx: &mut crate::lock::LockCx) -> crate::hooks::Result<bool> {
        self.job(cx, |w, p, now| {
            w.drain(p, now)?;
            Ok(!w.changes.writes_blocked() && w.changes.state.bursts.pending().is_empty())
        })
    }
    fn drain(&self, cx: &mut crate::lock::LockCx) -> crate::hooks::Result<()> {
        let completed = self.job(cx, |w, p, now| {
            w.drain(p, now)?;
            Ok(std::mem::take(&mut p.completed))
        })?;
        if completed.is_empty() {
            return Ok(());
        }
        // Release the watcher mutex before documents reconcile: a save calls
        // this watcher again to pin its own version on the same mutation lock.
        let documents = cx.hooks.documents.clone();
        match documents.ready() {
            Ok(()) => {
                for (index, (path, actor)) in completed.iter().enumerate() {
                    if let Err(error) = documents.completed_write(cx, path, actor) {
                        self.job(cx, |_, p, _| {
                            p.completed.splice(0..0, completed[index..].iter().cloned());
                            Ok(())
                        })?;
                        return Err(error);
                    }
                }
                Ok(())
            }
            Err(error) if error.code == 2 => Ok(()), // S2 has no document host.
            Err(error) => {
                self.job(cx, |_, p, _| {
                    p.completed.splice(0..0, completed);
                    Ok(())
                })?;
                Err(error)
            }
        }
    }
    fn settle_rewrite(&self, cx: &mut crate::lock::LockCx) -> crate::hooks::Result<()> {
        self.job(cx, |w, p, now| {
            w.drain(p, now)?;
            w.changes.settle_metadata(p)
        })
    }
    fn prepare_write(&self, cx: &mut crate::lock::LockCx) -> crate::hooks::Result<()> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            let pending = self.job(cx, |w, p, now| {
                w.drain(p, now)?;
                Ok(w.changes.metadata_pending())
            })?;
            if !pending {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(hook_error(io::Error::other("moved-off check required")));
            }
            // Tick the real watcher on the same FIFO job. Outside jj moves
            // still restart the 200 ms debounce; poisoned/resync guards and
            // the normal before_write comparator remain authoritative.
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    /// Called by the document disk adapter on the existing FIFO mutation lock.
    /// Settle outside bytes before a document changes the working-copy path.
    fn before_write(&self, path: &str, actor: &crate::hooks::Actor) -> crate::hooks::Result<()> {
        self.job_at(self.clock.mono(), |w, p, now| {
            w.drain(p, now)?;
            w.changes.before_write(p, now, path, actor)
        })
    }
    /// Uses the saved bytes and mode, never a later read of the working copy.
    /// own_write pins/checkpoints the version before this returns successfully.
    fn after_write(
        &self,
        path: &str,
        actor: &crate::hooks::Actor,
        bytes: &[u8],
        mode: u32,
    ) -> crate::hooks::Result<()> {
        self.job_at(self.clock.mono(), |w, p, now| {
            if !w.watch.tracked(path)? {
                return Ok(());
            }
            let mode = if mode & 0o111 == 0 {
                0o100644
            } else {
                0o100755
            };
            let version = crate::versions::record(p, bytes, mode)?;
            w.changes.own_write(p, now, path, actor, version)
        })
    }
    fn after_delete(&self, path: &str, actor: &crate::hooks::Actor) -> crate::hooks::Result<()> {
        self.job_at(self.clock.mono(), |w, p, now| {
            if !w.watch.tracked(path)? {
                return Ok(());
            }
            w.changes.own_delete(p, now, path, actor)
        })
    }
    fn close_bursts(&self, cx: &mut crate::lock::LockCx) -> crate::hooks::Result<()> {
        self.job(cx, |w, p, now| {
            w.drain(p, now)?;
            w.changes.close_all(p)
        })
    }
    fn resync(&self, cx: &mut crate::lock::LockCx) -> crate::hooks::Result<()> {
        self.job(cx, |w, p, now| w.resync(p, now))
    }
    fn burst_open(&self) -> bool {
        self.state
            .lock()
            .map(|s| s.0.changes.state.bursts.is_open())
            .unwrap_or(true)
    }
}
