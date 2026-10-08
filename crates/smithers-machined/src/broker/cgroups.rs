//! Linux cgroup-v2 controls. Root opens only a fixed protected hierarchy; all
//! later operations use held directory descriptors and constant filenames.
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// The platform's values. Octal literals here were x86-64's: on arm64, where
// machines run, they are O_LARGEFILE and O_DIRECT, and no directory opens.
const NOFOLLOW: i32 = libc::O_NOFOLLOW;
const NONBLOCK: i32 = libc::O_NONBLOCK;
const DIRECTORY: i32 = libc::O_DIRECTORY;
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
// Kernel state is bounded and has exactly one frozen field. Use the same
// parser for the parent barrier and its session children.
fn read_frozen(directory: &File) -> io::Result<bool> {
    let mut events = String::new();
    leaf(directory, "cgroup.events", false)?
        .take(4097)
        .read_to_string(&mut events)?;
    if events.len() > 4096 {
        return Err(invalid("oversized cgroup events"));
    }
    let values: Vec<_> = events
        .lines()
        .filter_map(|line| line.strip_prefix("frozen "))
        .collect();
    match values.as_slice() {
        ["1"] => Ok(true),
        ["0"] => Ok(false),
        _ => Err(invalid("invalid frozen state")),
    }
}
struct Group {
    name: String,
    directory: File,
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
    /// Read retained session groups, including closed sessions with surviving
    /// children. No pathname or PID comes from an RPC request.
    pub fn activity(&self) -> io::Result<Vec<(u32, u64, bool)>> {
        self.groups
            .iter()
            .map(|(id, group)| {
                let mut bytes = Vec::new();
                leaf(&group.directory, "cpu.stat", false)?
                    .take(4097)
                    .read_to_end(&mut bytes)?;
                Ok((
                    *id,
                    crate::attrib::usage(&bytes)?,
                    read_events(&group.directory)?,
                ))
            })
            .collect()
    }

    /// Before forking, create the child cgroup and retain cgroup.procs. The
    /// trusted spawn path writes its own pid to this fd before dropping uid.
    pub fn create(&mut self, id: u32) -> io::Result<File> {
        if id == 0 || id > 0x7fffffff || self.groups.contains_key(&id) {
            return Err(invalid("invalid session id"));
        }
        let name = format!("s{id}");
        let path = held(&self.parent, &name);
        fs::create_dir(&path)?; // EEXIST refuses retained/forged entries.
        let result = (|| {
            let fd = directory(&path)?;
            let procs = leaf(&fd, "cgroup.procs", true)?;
            read_events(&fd)?;
            self.groups.insert(
                id,
                Group {
                    name,
                    directory: fd,
                },
            );
            Ok(procs)
        })();
        if result.is_err() {
            let _ = fs::remove_dir(path);
        }
        result
    }
    /// Clean up retained groups after startup. No daemon may start until this
    /// succeeds. Legacy decimal and current s<id> names are cleaned; aliases fail closed.
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
            let id = super::sessions::cgroup_id(name)?;
            if self.groups.get(&id).is_some_and(|group| group.name != name) {
                return Err(invalid("duplicate retained cgroup aliases"));
            }
            if !self.groups.contains_key(&id) {
                let fd = directory(&held(&self.parent, name))?;
                self.groups.insert(
                    id,
                    Group {
                        name: name.to_owned(),
                        directory: fd,
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
impl Cgroups {
    pub(super) fn contains(&self, id: u32) -> bool {
        self.groups.contains_key(&id)
    }
    /// The process list of one retained session group, through its held
    /// directory. No pathname or id comes from a request.
    pub(super) fn procs(&self, id: u32) -> Option<PathBuf> {
        Some(held(&self.groups.get(&id)?.directory, "cgroup.procs"))
    }
    pub fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()> {
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
        fs::remove_dir(held(&self.parent, &group.name))?;
        self.groups.remove(&id);
        Ok(())
    }
}

impl super::control::Controls for Cgroups {
    fn freeze(&mut self, timeout: Duration) -> io::Result<Option<u32>> {
        if timeout.is_zero() || timeout > Duration::from_secs(1) {
            return Err(invalid("invalid freeze timeout"));
        }
        let deadline = Instant::now() + timeout;
        let result = (|| {
            leaf(&self.parent, "cgroup.freeze", true)?.write_all(b"1")?;
            loop {
                if read_frozen(&self.parent)? {
                    return Ok(None);
                }
                if Instant::now() >= deadline {
                    // Never guess from the first registered session: only a
                    // populated child whose kernel barrier is still pending
                    // can be named as the blocking writer.
                    for (id, group) in &self.groups {
                        if read_events(&group.directory)? && !read_frozen(&group.directory)? {
                            return Ok(Some(*id));
                        }
                    }
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "freeze timeout"));
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        })();
        if !matches!(result, Ok(None)) {
            // Cleanup failure takes precedence; never report a safe timeout if
            // the kernel did not accept thaw.
            super::control::Controls::thaw(self)?;
        }
        result
    }
    fn thaw(&mut self) -> io::Result<()> {
        leaf(&self.parent, "cgroup.freeze", true)?.write_all(b"0")
    }
    fn kill(&mut self) -> io::Result<u16> {
        let count = u16::try_from(self.groups.len()).map_err(|_| invalid("too many sessions"))?;
        self.recover(Instant::now() + Duration::from_secs(5))?;
        Ok(count)
    }
}

#[cfg(test)]
mod freeze_tests {
    use super::*;
    use crate::broker::control::Controls;
    fn group(root: &Path, name: &str, events: &str) -> File {
        let path = root.join(name);
        fs::create_dir(&path).unwrap();
        fs::write(path.join("cgroup.events"), events).unwrap();
        fs::write(path.join("cgroup.freeze"), b"0").unwrap();
        File::open(path).unwrap()
    }
    #[test]
    fn activity_reads_core_cpu_accounting_without_controller_files() {
        let root = tempfile::tempdir().unwrap();
        let parent = group(root.path(), "parent", "populated 1\nfrozen 0\n");
        let session = group(root.path(), "s1", "populated 1\nfrozen 0\n");
        // Model a guest with no delegated controllers. Only core accounting
        // fields exist; no cpu.max, cpu.weight, pids.max or throttling counters.
        fs::write(root.path().join("cgroup.controllers"), b"").unwrap();
        fs::write(root.path().join("cgroup.subtree_control"), b"").unwrap();
        let stat = root.path().join("s1/cpu.stat");
        fs::write(&stat, "usage_usec 41\nuser_usec 30\nsystem_usec 11\n").unwrap();
        let controls = Cgroups {
            parent,
            groups: BTreeMap::from([(
                1,
                Group {
                    name: "s1".into(),
                    directory: session,
                },
            )]),
        };
        assert_eq!(controls.activity().unwrap(), vec![(1, 41, true)]);
        // Keep reading the held directory even if its original path changes.
        fs::rename(root.path().join("s1"), root.path().join("retained")).unwrap();
        let stat = root.path().join("retained/cpu.stat");
        fs::write(&stat, "usage_usec 73\nuser_usec 60\nsystem_usec 13\n").unwrap();
        assert_eq!(controls.activity().unwrap(), vec![(1, 73, true)]);
        fs::write(&stat, "user_usec 60\nsystem_usec 13\n").unwrap();
        assert_eq!(
            controls.activity().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        fs::remove_file(&stat).unwrap();
        assert_eq!(
            controls.activity().unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }
    #[test]
    fn timeout_names_only_populated_unfrozen_session_and_thaws() {
        let root = tempfile::tempdir().unwrap();
        let parent = group(root.path(), "parent", "populated 1\nfrozen 0\n");
        let mut groups = BTreeMap::new();
        for (id, events) in [
            (1, "populated 0\nfrozen 0\n"),
            (2, "populated 1\nfrozen 1\n"),
            (3, "populated 1\nfrozen 0\n"),
        ] {
            let name = id.to_string();
            groups.insert(
                id,
                Group {
                    directory: group(root.path(), &name, events),
                    name,
                },
            );
        }
        let mut controls = Cgroups { parent, groups };
        assert_eq!(controls.freeze(Duration::from_millis(2)).unwrap(), Some(3));
        assert_eq!(
            fs::read(root.path().join("parent/cgroup.freeze")).unwrap(),
            b"0"
        );
        fs::write(
            root.path().join("parent/cgroup.events"),
            "populated 1\nfrozen 1\n",
        )
        .unwrap();
        assert_eq!(controls.freeze(Duration::from_millis(2)).unwrap(), None);
        controls.thaw().unwrap();
        assert_eq!(
            fs::read(root.path().join("parent/cgroup.freeze")).unwrap(),
            b"0"
        );
    }
    #[test]
    fn malformed_or_unidentified_barrier_refuses_and_thaws() {
        for events in [
            "populated 1\nfrozen 0\n",
            "populated 1\n",
            "frozen 2\n",
            "frozen 0\nfrozen 1\n",
        ] {
            let root = tempfile::tempdir().unwrap();
            let parent = group(root.path(), "parent", events);
            let mut controls = Cgroups {
                parent,
                groups: BTreeMap::new(),
            };
            assert!(controls.freeze(Duration::from_millis(2)).is_err());
            assert_eq!(
                fs::read(root.path().join("parent/cgroup.freeze")).unwrap(),
                b"0"
            );
        }
    }
}
