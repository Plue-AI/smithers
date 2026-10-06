//! Linux cgroup-v2 controls. Root opens only a fixed protected hierarchy; all
//! later operations use held directory descriptors and constant filenames.
use super::sessions::{Controls, Kind};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::ChildStdin;
use std::time::{Duration, Instant};

const NOFOLLOW: i32 = 0o400000;
const NONBLOCK: i32 = 0o4000;
const DIRECTORY: i32 = 0o200000;
const ROOT: &str = "/sys/fs/cgroup/smithers/sessions";
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn held(directory: &File, leaf: &str) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}/{}", directory.as_raw_fd(), leaf))
}
fn directory(path: &Path) -> io::Result<File> {
    let fd = OpenOptions::new()
        .read(true)
        .custom_flags(NOFOLLOW | DIRECTORY)
        .open(path)?;
    let stat = fd.metadata()?;
    if !stat.is_dir() || stat.uid() != 0 || stat.mode() & 0o022 != 0 {
        return Err(invalid("unprotected cgroup ancestor"));
    }
    Ok(fd)
}
fn leaf(directory: &File, name: &str, write: bool) -> io::Result<File> {
    OpenOptions::new()
        .read(!write)
        .write(write)
        .custom_flags(NOFOLLOW | NONBLOCK)
        .open(held(directory, name))
}
fn read_events(directory: &File) -> io::Result<bool> {
    let mut body = String::new();
    leaf(directory, "cgroup.events", false)?
        .take(4097)
        .read_to_string(&mut body)?;
    if body.len() > 4096 {
        return Err(invalid("oversized cgroup events"));
    }
    let mut populated = None;
    for line in body.lines() {
        if let Some(value) = line.strip_prefix("populated ") {
            if populated.is_some() {
                return Err(invalid("duplicate populated state"));
            }
            populated = Some(match value {
                "0" => false,
                "1" => true,
                _ => return Err(invalid("invalid populated state")),
            });
        }
    }
    populated.ok_or_else(|| invalid("missing populated state"))
}
struct Group {
    directory: File,
    // PTY closure drops the master, delivering kernel HUP to its foreground
    // group. Exec/SFTP closure drops stdin. Remaining children stay registered.
    pty: Option<File>,
    stdin: Option<ChildStdin>,
}
pub struct Cgroups {
    parent: File,
    groups: BTreeMap<u32, Group>,
}
impl Cgroups {
    pub fn open() -> io::Result<Self> {
        let mut fd = directory(Path::new("/"))?;
        for component in ROOT.trim_start_matches('/').split('/') {
            fd = directory(&held(&fd, component))?;
        }
        if rustix::fs::fstatfs(&fd)?.f_type as u64 != 0x6367_7270 {
            return Err(invalid("session parent is not cgroup v2"));
        }
        // cgroup.events exists only on the unified hierarchy, not cgroup v1.
        read_events(&fd)?;
        Ok(Self {
            parent: fd,
            groups: BTreeMap::new(),
        })
    }
    /// Before forking, create the child cgroup and retain cgroup.procs. The
    /// trusted spawn path writes its own pid to this fd before dropping uid.
    pub fn create(&mut self, id: u32) -> io::Result<File> {
        if id == 0 || id > 0x7fffffff || self.groups.contains_key(&id) {
            return Err(invalid("invalid session id"));
        }
        let path = held(&self.parent, &id.to_string());
        fs::create_dir(&path)?; // EEXIST refuses retained/forged entries.
        let result = (|| {
            let fd = directory(&path)?;
            let procs = leaf(&fd, "cgroup.procs", true)?;
            read_events(&fd)?;
            self.groups.insert(
                id,
                Group {
                    directory: fd,
                    pty: None,
                    stdin: None,
                },
            );
            Ok(procs)
        })();
        if result.is_err() {
            let _ = fs::remove_dir(path);
        }
        result
    }
    /// Descriptors are produced by the broker's spawn, never decoded from RPC.
    pub fn set_io(
        &mut self,
        id: u32,
        pty: Option<File>,
        stdin: Option<ChildStdin>,
    ) -> io::Result<()> {
        let group = self
            .groups
            .get_mut(&id)
            .ok_or_else(|| invalid("unknown session"))?;
        if group.pty.is_some() || group.stdin.is_some() || pty.is_some() && stdin.is_some() {
            return Err(invalid("session io already assigned or ambiguous"));
        }
        group.pty = pty;
        group.stdin = stdin;
        Ok(())
    }
    /// Clean up retained groups after startup. No daemon may start until this
    /// succeeds. Names outside the daemon allocator's decimal range fail closed.
    pub fn recover(&mut self, deadline: Instant) -> io::Result<()> {
        for entry in fs::read_dir(held(&self.parent, "."))? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_file() {
                continue;
            } // kernel cgroup control files
            if !kind.is_dir() {
                return Err(invalid("special retained cgroup entry"));
            }
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| invalid("invalid retained cgroup name"))?;
            let id: u32 = name
                .parse()
                .map_err(|_| invalid("invalid retained cgroup id"))?;
            if id == 0 || id > 0x7fffffff || name != id.to_string() {
                return Err(invalid("invalid retained cgroup id"));
            }
            if !self.groups.contains_key(&id) {
                let fd = directory(&held(&self.parent, name))?;
                self.groups.insert(
                    id,
                    Group {
                        directory: fd,
                        pty: None,
                        stdin: None,
                    },
                );
            }
        }
        let ids: Vec<_> = self.groups.keys().copied().collect();
        for id in ids {
            self.kill(id, deadline)?;
        }
        Ok(())
    }
}
impl Controls for Cgroups {
    fn close(&mut self, id: u32, kind: Kind) -> io::Result<()> {
        let group = self
            .groups
            .get_mut(&id)
            .ok_or_else(|| invalid("unknown session"))?;
        if kind == Kind::Pty {
            group.pty.take();
        } else {
            group.stdin.take();
        }
        Ok(())
    }
    fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()> {
        let group = self
            .groups
            .get(&id)
            .ok_or_else(|| invalid("unknown session"))?;
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "session kill deadline",
            ));
        }
        leaf(&group.directory, "cgroup.kill", true)?.write_all(b"1")?;
        while read_events(&group.directory)? {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "cgroup remains populated",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // Do not forget the held group on failed removal; retry remains possible.
        fs::remove_dir(held(&self.parent, &id.to_string()))?;
        self.groups.remove(&id);
        Ok(())
    }
}
