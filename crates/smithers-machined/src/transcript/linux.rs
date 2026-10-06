//! Runs only after the broker child has dropped to the registered owner.
//! The caller supplies an already held agent-root descriptor and exactly one
//! discovered relative source, never a home scan or caller-selected uid.
use super::{invalid, Framer, Record, READ_BYTES};
use rustix::fs::{self, inotify, Mode, OFlags, ResolveFlags};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
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
        self.framer = next;
        self.anchor.extend_from_slice(&bytes[..n]);
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
