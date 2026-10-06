//! Real recursive inotify with held directory descriptors. The lock-thread
//! adapter drains this before RPC writes; this module never mutates files.
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
        if !metadata && path != Path::new(".") && self.ignore.ignored(path, true)? {
            return Ok(());
        }
        let held = match open(&self.root, path, true) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
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
        while let Some(entry) = dir.read() {
            let entry = entry?;
            let name = entry.file_name();
            let Ok(name) = name.to_str() else {
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
            match entry.file_type() {
                fs::FileType::Directory => self.scan(&child, metadata, true, files)?,
                fs::FileType::RegularFile
                    if !metadata && !self.ignore.ignored(&child, false)? =>
                {
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
        for (p, recursive) in [
            (".git", false),
            (".git/refs", true),
            (".jj/repo/op_heads/heads", true),
        ] {
            self.scan(Path::new(p), true, recursive, &mut files)?;
        }
        Ok(files)
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
        drop(reader);
        let mut out = vec![];
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
                return Ok(vec![if metadata {
                    Event::Metadata
                } else {
                    Event::Overflow
                }]);
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
                if recursive || name == "HEAD" || name == "packed-refs" || name == "refs" {
                    out.push(Event::Metadata);
                    if flags.contains(inotify::ReadFlags::ISDIR)
                        && flags
                            .intersects(inotify::ReadFlags::CREATE | inotify::ReadFlags::MOVED_TO)
                    {
                        self.scan(&path, true, true, &mut vec![])?;
                    }
                }
                continue;
            }
            if name == ".gitignore" {
                return Ok(vec![Event::Overflow]);
            }
            if self
                .ignore
                .ignored(&path, flags.contains(inotify::ReadFlags::ISDIR))?
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
        Ok(out)
    }
}
