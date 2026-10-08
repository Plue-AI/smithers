//! Runs only after the broker child has dropped to the registered owner.
//! The caller supplies an already held agent-root descriptor and exactly one
//! discovered relative source, never a home scan or caller-selected uid.
use super::{invalid, Framer, Record, READ_BYTES};
use rustix::fs::{self, inotify, Mode, OFlags, ResolveFlags};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::fs::MetadataExt,
    },
    time::{Duration, Instant},
};

pub struct Tail {
    root: File,
    path: String,
    owner: u32,
    inode: Option<(u64, u64)>,
    framer: Framer,
    anchor: Vec<u8>,
    watch: Option<OwnedFd>,
    checked: Option<Instant>,
    stopped: bool,
    source: Option<super::wire::Source>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u8,
    root: (u64, u64),
    path: String,
    owner: u32,
    inode: Option<(u64, u64)>,
    framer: SavedFramer,
    anchor: Vec<u8>,
    stopped: bool,
    source: Option<super::wire::Source>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedFramer {
    generation: u64,
    offset: u64,
    pending: Vec<u8>,
    failed: bool,
}

// The daemon validates opaque child state without opening an owner home.
// Identity and framing checks are shared with recovery, so IPC cannot persist
// a checkpoint which the next reader would reject or bind to another source.
fn decode_checkpoint(bytes: &[u8]) -> io::Result<Checkpoint> {
    if bytes.len() > super::MAX_RECORD_BYTES * 4 + 32768 {
        return Err(invalid("oversized transcript checkpoint"));
    }
    let state: Checkpoint =
        serde_json::from_slice(bytes).map_err(|_| invalid("invalid transcript checkpoint"))?;
    if state.version != 1
        || state.owner == 0
        || state.framer.generation == 0
        || state.framer.pending.len() > super::MAX_RECORD_BYTES
        || state.framer.pending.len() as u64 > state.framer.offset
        || state.framer.pending.contains(&b'\n')
        || state.anchor.len() > 64
        || state.anchor.len() as u64 > state.framer.offset
        || (state.inode.is_none() && state.framer.offset != 0)
        || (state.framer.failed && !state.stopped)
    {
        return Err(invalid("transcript checkpoint binding mismatch"));
    }
    Ok(state)
}

/// Whether a saved checkpoint records that its reader stopped the source for
/// good: a record it could not frame, or a file that stopped being the
/// owner's regular file. A stopped source fails every later read.
pub(super) fn checkpoint_stopped(bytes: &[u8]) -> bool {
    decode_checkpoint(bytes).is_ok_and(|state| state.stopped)
}

pub(super) fn validate_reader_checkpoint(
    bytes: &[u8],
    startup: &super::reader::Startup,
) -> io::Result<()> {
    let state = decode_checkpoint(bytes)?;
    if state.owner != startup.uid
        || state.path != startup.path
        || state.source.as_ref() != Some(&startup.source)
    {
        return Err(invalid("transcript checkpoint source mismatch"));
    }
    if let Some(previous) = startup.checkpoint.as_ref() {
        let previous = decode_checkpoint(previous.as_bytes())?;
        if state.root != previous.root {
            return Err(invalid("transcript checkpoint root changed"));
        }
    }
    Ok(())
}

/// One checkpoint per broker-bound source lifetime in the existing daemon
/// state directory. All operations use a held descriptor, never a home path.
pub struct CheckpointStore {
    directory: File,
    name: String,
    owner: u32,
}

impl CheckpointStore {
    pub fn new(directory: File, lifetime: [u8; 16]) -> io::Result<Self> {
        let owner = rustix::process::geteuid().as_raw();
        let meta = directory.metadata()?;
        if owner == 0
            || !meta.is_dir()
            || meta.uid() != owner
            || meta.mode() & 0o7777 != 0o700
            || lifetime == [0; 16]
        {
            return Err(invalid("invalid transcript checkpoint directory"));
        }
        let name = lifetime
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            + ".tail";
        Ok(Self {
            directory,
            name,
            owner,
        })
    }

    pub fn load(&self) -> io::Result<Option<Vec<u8>>> {
        let file = match open(&self.directory, &self.name) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let meta = file.metadata()?;
        let bound = super::MAX_RECORD_BYTES * 4 + 32768;
        if !meta.is_file()
            || meta.uid() != self.owner
            || meta.nlink() != 1
            || meta.mode() & 0o7777 != 0o600
            || meta.len() > bound as u64
        {
            return Err(invalid("invalid transcript checkpoint file"));
        }
        let mut bytes = Vec::new();
        file.take(bound as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > bound {
            return Err(invalid("checkpoint grew beyond limit"));
        }
        Ok(Some(bytes))
    }

    /// Forget this source. A checkpoint that is not there is already forgotten.
    pub fn remove(&self) -> io::Result<()> {
        match fs::unlinkat(&self.directory, self.name.as_str(), fs::AtFlags::empty()) {
            Ok(()) => self.directory.sync_all(),
            Err(rustix::io::Errno::NOENT) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Remove every checkpoint in `directory` but those of `keep`, and every
    /// half-written one. Source lifetimes are the broker's and end with it, so
    /// what an earlier boot or a finished agent left is never read again.
    pub fn sweep(directory: &File, keep: &std::collections::BTreeSet<[u8; 16]>) -> io::Result<()> {
        let kept: std::collections::BTreeSet<String> = keep
            .iter()
            .map(|lifetime| {
                lifetime
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
                    + ".tail"
            })
            .collect();
        let mut removed = false;
        for entry in fs::Dir::read_from(directory)? {
            let entry = entry?;
            let Ok(name) = entry.file_name().to_str() else {
                continue;
            };
            if (name.ends_with(".tail") || name.ends_with(".tail.tmp")) && !kept.contains(name) {
                fs::unlinkat(directory, name, fs::AtFlags::empty())?;
                removed = true;
            }
        }
        if removed {
            directory.sync_all()?;
        }
        Ok(())
    }

    pub fn save(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > super::MAX_RECORD_BYTES * 4 + 32768 {
            return Err(invalid("oversized transcript checkpoint"));
        }
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|e| io::Error::other(e.to_string()))?;
        let temporary = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>() + ".tail.tmp";
        let fd = fs::openat2(
            &self.directory,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )?;
        let mut file = File::from(fd);
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::renameat(
                &self.directory,
                temporary.as_str(),
                &self.directory,
                self.name.as_str(),
            )?;
            self.directory.sync_all()
        })();
        if result.is_err() {
            let _ = fs::unlinkat(&self.directory, temporary.as_str(), fs::AtFlags::empty());
        }
        result
    }
}

fn open(root: &File, path: &str) -> io::Result<File> {
    Ok(fs::openat2(
        root,
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    )?
    .into())
}

impl Tail {
    /// Opaque reader state. The daemon fsyncs this only AFTER outbox append.
    /// A crash before checkpoint persistence replays the same source ranges.
    pub fn checkpoint(&self) -> io::Result<Vec<u8>> {
        let meta = self.root.metadata()?;
        serde_json::to_vec(&Checkpoint {
            version: 1,
            root: (meta.dev(), meta.ino()),
            path: self.path.clone(),
            owner: self.owner,
            inode: self.inode,
            framer: SavedFramer {
                generation: self.framer.generation,
                offset: self.framer.offset,
                pending: self.framer.pending.clone(),
                failed: self.framer.failed,
            },
            anchor: self.anchor.clone(),
            stopped: self.stopped,
            source: self.source.clone(),
        })
        .map_err(|_| invalid("cannot encode transcript checkpoint"))
    }

    /// Bind recovered state to the same held owner root and linked source.
    /// Never accept a checkpoint as permission to choose another owner/path.
    pub fn resume(root: File, path: &str, owner: u32, bytes: &[u8]) -> io::Result<Self> {
        let state = decode_checkpoint(bytes)?;
        let mut tail = Self::new(root, path, owner)?;
        let meta = tail.root.metadata()?;
        if state.root != (meta.dev(), meta.ino()) || state.path != path || state.owner != owner {
            return Err(invalid("transcript checkpoint binding mismatch"));
        }
        tail.inode = state.inode;
        tail.framer = Framer::restored(
            state.framer.generation,
            state.framer.offset,
            state.framer.pending,
            state.framer.failed,
        );
        tail.anchor = state.anchor;
        tail.stopped = state.stopped;
        tail.source = state.source;
        Ok(tail)
    }

    /// The owner reader waits for `persist` to fsync each event in the daemon's
    /// existing outbox (through the broker IPC, never by opening daemon state
    /// under the owner's UID). `save` then atomically replaces and fsyncs the
    /// checkpoint. Failure restores the cursor for transactional host replay.
    pub fn poll_durable(
        &mut self,
        now: Instant,
        source: &super::wire::Source,
        mut persist: impl FnMut(&[u8]) -> io::Result<()>,
        mut save: impl FnMut(&[u8]) -> io::Result<()>,
    ) -> io::Result<usize> {
        if self.source.as_ref().is_some_and(|bound| bound != source) {
            return Err(invalid("transcript source binding changed"));
        }
        // Validate identity even at EOF, before opening the linked source.
        source
            .event(&Record {
                generation: 1,
                start: 0,
                end: 2,
                text: "x".into(),
            })
            .map_err(|_| invalid("invalid transcript source"))?;
        self.source = Some(source.clone());
        let previous = self.checkpoint()?;
        let result = self.poll(now, |record| {
            let event = source
                .event(record)
                .map_err(|_| invalid("invalid transcript source"))?;
            persist(&event)
        });
        // Preserve terminal refusal as well as successful/partial progress.
        let checkpoint = self.checkpoint()?;
        if let Err(error) = save(&checkpoint) {
            *self = Self::resume(self.root.try_clone()?, &self.path, self.owner, &previous)?;
            return Err(error);
        }
        result
    }
    /// No root fallback: this module never reads a home under daemon/root uid.
    /// Broker must separately bind groups, process lifetime and revocation.
    pub fn new(root: File, path: &str, owner: u32) -> io::Result<Self> {
        if owner == 0
            || rustix::process::getuid().as_raw() != owner
            || rustix::process::geteuid().as_raw() != owner
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "reader is not session owner",
            ));
        }
        let meta = root.metadata()?;
        if !meta.is_dir()
            || meta.uid() != owner
            || path.is_empty()
            || path.len() > 4096
            || path.starts_with('/')
            || path.contains('\0')
            || path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return Err(invalid("invalid transcript root or relative source"));
        }
        Ok(Self {
            root,
            path: path.into(),
            owner,
            inode: None,
            framer: Framer::new(1)?,
            anchor: Vec::new(),
            watch: None,
            checked: None,
            stopped: false,
            source: None,
        })
    }
    /// Remove watches and prevent all subsequent reads, including reconciliation.
    pub fn revoke(&mut self) {
        self.stopped = true;
        self.watch = None;
    }

    fn watch_file(&mut self, file: &File) -> io::Result<()> {
        let fd = inotify::init(inotify::CreateFlags::CLOEXEC | inotify::CreateFlags::NONBLOCK)?;
        // The proc path refers to our held, verified inode, never a path hint.
        inotify::add_watch(
            &fd,
            format!("/proc/self/fd/{}", file.as_raw_fd()),
            inotify::WatchFlags::MODIFY
                | inotify::WatchFlags::ATTRIB
                | inotify::WatchFlags::MOVE_SELF
                | inotify::WatchFlags::DELETE_SELF,
        )?;
        self.watch = Some(fd);
        Ok(())
    }
    fn changed(&self) -> io::Result<bool> {
        let Some(fd) = &self.watch else {
            return Ok(true);
        };
        let mut buffer = [MaybeUninit::uninit(); 4096];
        let mut reader = inotify::Reader::new(fd, &mut buffer);
        let mut changed = false;
        loop {
            match reader.next() {
                Ok(_) => changed = true, // includes overflow and ignored
                Err(rustix::io::Errno::WOULDBLOCK) => break,
                Err(rustix::io::Errno::INTR) => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Ok(changed)
    }
    /// Scheduler calls at least once per second and on inotify readiness.
    /// `persist` must fsync the existing outbox before returning success. On
    /// failure offsets stay unchanged; already appended records replay with
    /// the same identity, allowing the host receipt to deduplicate them.
    /// A fresh source generation on replacement/truncation discards partials.
    pub fn poll(
        &mut self,
        now: Instant,
        mut persist: impl FnMut(&Record) -> io::Result<()>,
    ) -> io::Result<usize> {
        if self.stopped {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "transcript source stopped",
            ));
        }
        if !self.changed()?
            && self
                .checked
                .is_some_and(|last| now.saturating_duration_since(last) < Duration::from_secs(1))
        {
            return Ok(0);
        }
        let mut file = match open(&self.root, &self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.checked = Some(now);
                return Ok(0);
            }
            Err(e) => {
                self.revoke();
                return Err(e);
            }
        };
        let meta = file.metadata()?;
        // Hard links can otherwise give a beneath-root name to unrelated data.
        if !meta.is_file() || meta.uid() != self.owner || meta.nlink() != 1 {
            self.revoke();
            return Err(invalid("transcript is not an owner regular file"));
        }
        let inode = (meta.dev(), meta.ino());
        // Detect truncate-and-regrow between polls when length has already
        // passed the old offset. Kernel MODIFY events alone do not distinguish
        // this from an append. No home scan or whole-file reread is needed.
        let mut rewritten = false;
        if self.inode == Some(inode)
            && meta.len() >= self.framer.offset()
            && !self.anchor.is_empty()
        {
            file.seek(SeekFrom::Start(
                self.framer.offset() - self.anchor.len() as u64,
            ))?;
            let mut previous = vec![0; self.anchor.len()];
            rewritten = file.read_exact(&mut previous).is_err() || previous != self.anchor;
        }
        if rewritten
            || self.inode.is_some_and(|old| old != inode)
            || meta.len() < self.framer.offset()
        {
            self.framer = Framer::new(
                self.framer
                    .generation
                    .checked_add(1)
                    .ok_or_else(|| invalid("source generation exhausted"))?,
            )?;
            self.anchor.clear();
        }
        if self.inode != Some(inode) || self.watch.is_none() {
            self.watch_file(&file)?;
        }
        self.inode = Some(inode);
        file.seek(SeekFrom::Start(self.framer.offset()))?;
        let mut bytes = [0; READ_BYTES];
        let n = file.read(&mut bytes)?;
        let mut next = self.framer.clone();
        let mut records = Vec::new();
        let mut malformed = None;
        // Preserve complete valid records preceding a bad record in this read.
        for part in bytes[..n].split_inclusive(|b| *b == b'\n') {
            match next.push(part) {
                Ok(mut framed) => records.append(&mut framed),
                Err(e) => {
                    malformed = Some(e);
                    break;
                }
            }
        }
        for record in &records {
            if let Err(e) = persist(record) {
                self.checked = None;
                return Err(e);
            }
        }
        let consumed = (next.offset() - self.framer.offset()) as usize;
        self.framer = next;
        self.anchor.extend_from_slice(&bytes[..consumed]);
        if self.anchor.len() > 64 {
            self.anchor.drain(..self.anchor.len() - 64);
        }
        if let Some(error) = malformed {
            self.revoke();
            return Err(error);
        }
        // Backlog continues immediately; EOF waits for events or reconciliation.
        self.checked = if n == READ_BYTES { None } else { Some(now) };
        Ok(records.len())
    }
}
