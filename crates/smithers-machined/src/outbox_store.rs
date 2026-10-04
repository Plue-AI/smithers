//! File-per-entry storage from machined design §5. Payloads are opaque ADR 0004
//! Durable bytes supplied by the sole codec; this module defines no wire format.
//! The head reporter has no durable acknowledgement or restart storage to reuse.
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
#[cfg(target_os = "linux")]
const NOFOLLOW: i32 = 0o400000 | 0o4000; // O_NOFOLLOW | O_NONBLOCK
#[cfg(target_os = "macos")]
const NOFOLLOW: i32 = 0x100 | 0x4; // O_NOFOLLOW | O_NONBLOCK

fn corrupt(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Owned by the FIFO mutation executor, never shared with a second writer.
/// Caller pins objects and syncfs(workspace) BEFORE append, updates acked/head
/// BEFORE remove for applied/duplicate, and deletes pending refs AFTER remove.
/// Missing-objects never removes; stale-base removes without updating the head.
pub struct Store {
    directory: PathBuf,
    entries: BTreeSet<u64>,
    highest: u64,
    poisoned: bool,
}

fn private_dir(path: &Path, owner: u32) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.uid() != owner || metadata.mode() & 0o7777 != 0o700 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "outbox directory must be owner-only",
        ));
    }
    Ok(())
}

fn read_regular(path: &Path, bound: usize, owner: u32) -> io::Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != owner
        || metadata.mode() & 0o7777 != 0o600
        || metadata.len() > bound as u64
    {
        return Err(corrupt("invalid outbox file"));
    }
    let mut bytes = Vec::new();
    file.take(bound as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > bound {
        return Err(corrupt("outbox file grew beyond limit"));
    }
    Ok(bytes)
}

fn event_name(seq: u64) -> String {
    format!("{seq:020}.ev")
}

impl Store {
    /// Parent must already be a trusted machined-owned state directory (0700).
    /// Activation authority and event decoding are the daemon's responsibility.
    pub fn open(directory: &Path, owner: u32) -> io::Result<Self> {
        private_dir(
            directory
                .parent()
                .ok_or_else(|| corrupt("missing state directory"))?,
            owner,
        )?;
        private_dir(directory, owner)?;
        let mut entries = BTreeSet::new();
        let mut highest = match read_regular(&directory.join("SEQ"), 20, owner) {
            Ok(bytes) => std::str::from_utf8(&bytes)
                .map_err(|_| corrupt("invalid SEQ"))?
                .parse::<u64>()
                .map_err(|_| corrupt("invalid SEQ"))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error),
        };
        for item in fs::read_dir(directory)? {
            let item = item?;
            let name = item.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| corrupt("invalid outbox filename"))?;
            if name == "SEQ" || name == "dead" {
                continue;
            }
            if name == "SEQ.tmp" || name.ends_with(".ev.tmp") {
                // Only interrupted writes use .tmp; never replay an incomplete event.
                let metadata = fs::symlink_metadata(item.path())?;
                if !metadata.is_file() || metadata.uid() != owner {
                    return Err(corrupt("invalid temporary entry"));
                }
                fs::remove_file(item.path())?;
                continue;
            }
            let seq = name
                .strip_suffix(".ev")
                .ok_or_else(|| corrupt("invalid outbox filename"))?
                .parse::<u64>()
                .map_err(|_| corrupt("invalid event sequence"))?;
            if seq == 0 || name != event_name(seq) {
                return Err(corrupt("noncanonical event sequence"));
            }
            if read_regular(&item.path(), MAX_EVENT_BYTES, owner)?.is_empty() {
                return Err(corrupt("empty event"));
            }
            highest = highest.max(seq);
            entries.insert(seq);
        }
        let dead = directory.join("dead");
        match fs::symlink_metadata(&dead) {
            Ok(_) => private_dir(&dead, owner)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&dead)?;
                fs::set_permissions(&dead, fs::Permissions::from_mode(0o700))?;
            }
            Err(error) => return Err(error),
        }
        File::open(directory)?.sync_all()?;
        Ok(Self {
            directory: directory.into(),
            entries,
            highest,
            poisoned: false,
        })
    }

    pub fn sequences(&self) -> impl Iterator<Item = u64> + '_ {
        self.entries.iter().copied()
    }
    pub fn next_sequence(&self) -> io::Result<u64> {
        if self.poisoned {
            return Err(corrupt("reopen outbox after IO failure"));
        }
        self.highest
            .checked_add(1)
            .ok_or_else(|| corrupt("sequence exhausted"))
    }

    fn atomic_write(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let temp = self.directory.join(format!("{name}.tmp"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(temp, self.directory.join(name))?;
        File::open(&self.directory)?.sync_all()
    }

    /// Closure uses ADR 0004's encoder to bind the allocated seq into the payload.
    pub fn append(&mut self, encode: impl FnOnce(u64) -> io::Result<Vec<u8>>) -> io::Result<u64> {
        let seq = self.next_sequence()?;
        let bytes = encode(seq)?;
        if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
            return Err(corrupt("invalid event length"));
        }
        if let Err(error) = self.atomic_write(&event_name(seq), &bytes) {
            self.poisoned = true;
            return Err(error);
        }
        self.highest = seq;
        self.entries.insert(seq);
        Ok(seq)
    }

    pub fn read(&self, seq: u64, owner: u32) -> io::Result<Vec<u8>> {
        if !self.entries.contains(&seq) {
            return Err(io::ErrorKind::NotFound.into());
        }
        read_regular(
            &self.directory.join(event_name(seq)),
            MAX_EVENT_BYTES,
            owner,
        )
    }

    /// Removes only the oldest entry. Rejection retains the exact bytes in dead/.
    /// Persisting SEQ before every deletion prevents reuse even on stale-base.
    pub fn remove(&mut self, seq: u64, rejected: bool) -> io::Result<()> {
        if self.poisoned {
            return Err(corrupt("reopen outbox after IO failure"));
        }
        if self.entries.first().copied() != Some(seq) {
            return Err(corrupt("acknowledgement out of order"));
        }
        let result = (|| {
            self.atomic_write("SEQ", self.highest.to_string().as_bytes())?;
            let path = self.directory.join(event_name(seq));
            if rejected {
                fs::rename(path, self.directory.join("dead").join(event_name(seq)))?;
                File::open(self.directory.join("dead"))?.sync_all()?;
            } else {
                fs::remove_file(path)?;
            }
            File::open(&self.directory)?.sync_all()
        })();
        if let Err(error) = result {
            self.poisoned = true;
            return Err(error);
        }
        self.entries.remove(&seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Fixture {
        state: PathBuf,
        owner: u32,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let state = std::env::temp_dir().join(format!(
                "machined-outbox-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&state).unwrap();
            fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
            let owner = fs::metadata(&state).unwrap().uid();
            fs::create_dir(state.join("outbox")).unwrap();
            fs::set_permissions(state.join("outbox"), fs::Permissions::from_mode(0o700)).unwrap();
            Self { state, owner }
        }
        fn open(&self) -> io::Result<Store> {
            Store::open(&self.state.join("outbox"), self.owner)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.state).unwrap();
        }
    }

    #[test]
    fn replay_order_ack_and_empty_restart_never_reuse_seq() {
        let fixture = Fixture::new();
        let mut store = fixture.open().unwrap();
        for seq in 1..=3 {
            assert_eq!(
                store
                    .append(|allocated| {
                        assert_eq!(allocated, seq);
                        Ok(vec![seq as u8])
                    })
                    .unwrap(),
                seq
            );
        }
        drop(store);
        let mut store = fixture.open().unwrap();
        assert_eq!(store.sequences().collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(store.read(2, fixture.owner).unwrap(), [2]);
        assert!(store.remove(2, false).is_err());
        assert_eq!(store.sequences().collect::<Vec<_>>(), [1, 2, 3]);
        store.remove(1, false).unwrap();
        store.remove(2, true).unwrap();
        assert_eq!(
            fs::read(fixture.state.join("outbox/dead/00000000000000000002.ev")).unwrap(),
            [2]
        );
        store.remove(3, false).unwrap();
        drop(store);
        let mut store = fixture.open().unwrap();
        assert!(store.sequences().next().is_none());
        assert_eq!(store.next_sequence().unwrap(), 4);
        assert_eq!(store.append(|_| Ok(vec![4])).unwrap(), 4);
        assert!(store.read(1, fixture.owner).is_err());
    }

    #[test]
    fn interrupted_tmp_and_high_water_recover_without_replay() {
        let fixture = Fixture::new();
        let mut store = fixture.open().unwrap();
        store.append(|_| Ok(vec![1, 2, 3])).unwrap();
        drop(store);
        fs::write(
            fixture.state.join("outbox/00000000000000000002.ev.tmp"),
            [8],
        )
        .unwrap();
        let store = fixture.open().unwrap();
        assert_eq!(store.sequences().collect::<Vec<_>>(), [1]);
        assert_eq!(store.next_sequence().unwrap(), 2);
        assert!(
            !fixture
                .state
                .join("outbox/00000000000000000002.ev.tmp")
                .exists()
        );
    }

    #[test]
    fn refuse_unsafe_state_and_entries() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fs::set_permissions(&fixture.state, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(fixture.open().is_err());
        fs::set_permissions(&fixture.state, fs::Permissions::from_mode(0o700)).unwrap();
        let mut store = fixture.open().unwrap();
        assert!(store.append(|_| Ok(vec![])).is_err());
        assert!(store.append(|_| Ok(vec![1; 4_194_305])).is_err());
        assert_eq!(store.next_sequence().unwrap(), 1);
        drop(store);
        let entry = fixture.state.join("outbox/00000000000000000001.ev");
        symlink("/etc/passwd", &entry).unwrap();
        assert!(fixture.open().is_err());
        fs::remove_file(&entry).unwrap();
        fs::write(&entry, []).unwrap();
        fs::set_permissions(&entry, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(fixture.open().is_err());
        fs::remove_file(&entry).unwrap();
        fs::write(fixture.state.join("outbox/garbage"), [1]).unwrap();
        assert!(fixture.open().is_err());
    }

    #[test]
    fn failed_append_poison_requires_restart() {
        let fixture = Fixture::new();
        let mut store = fixture.open().unwrap();
        fs::write(
            fixture.state.join("outbox/00000000000000000001.ev.tmp"),
            [99],
        )
        .unwrap();
        assert!(store.append(|_| Ok(vec![1])).is_err());
        assert!(store.next_sequence().is_err());
        assert!(store.append(|_| Ok(vec![2])).is_err());
        drop(store);
        let mut store = fixture.open().unwrap();
        assert_eq!(store.append(|_| Ok(vec![3])).unwrap(), 1);
    }

    #[test]
    fn sequence_exhaustion_does_not_prevent_acknowledgement() {
        let fixture = Fixture::new();
        let mut store = fixture.open().unwrap();
        store.append(|_| Ok(vec![8])).unwrap();
        store.atomic_write("SEQ", b"18446744073709551615").unwrap();
        drop(store);
        let mut store = fixture.open().unwrap();
        assert!(store.next_sequence().is_err());
        store.remove(1, false).unwrap();
        drop(store);
        let store = fixture.open().unwrap();
        assert!(store.sequences().next().is_none());
        assert!(store.next_sequence().is_err());
    }

    // Child exits without running destructors; the parent reopens the real files.
    #[test]
    fn crash_child() {
        let Ok(state) = std::env::var("MACHINED_STORE_CRASH_FIXTURE") else {
            return;
        };
        let state = PathBuf::from(state);
        let owner = fs::metadata(&state).unwrap().uid();
        let mut store = Store::open(&state.join("outbox"), owner).unwrap();
        if std::env::var_os("MACHINED_STORE_CRASH_ACK").is_some() {
            store.remove(1, false).unwrap();
        } else {
            store
                .append(|seq| {
                    assert_eq!(seq, 1);
                    Ok(vec![19, 71])
                })
                .unwrap();
        }
        std::process::exit(73);
    }

    #[test]
    fn durable_append_and_ack_survive_process_exit_ten_times() {
        for _ in 0..10 {
            let fixture = Fixture::new();
            for ack in [false, true] {
                let mut child = std::process::Command::new(std::env::current_exe().unwrap());
                child
                    .args(["--exact", "tests::crash_child"])
                    .env("MACHINED_STORE_CRASH_FIXTURE", &fixture.state)
                    .env_remove("MACHINED_STORE_CRASH_ACK")
                    .stdout(std::process::Stdio::null());
                if ack {
                    child.env("MACHINED_STORE_CRASH_ACK", "1");
                }
                assert_eq!(child.status().unwrap().code(), Some(73));
                let store = fixture.open().unwrap();
                assert_eq!(store.next_sequence().unwrap(), 2);
                if ack {
                    assert!(store.sequences().next().is_none());
                } else {
                    assert_eq!(store.sequences().collect::<Vec<_>>(), [1]);
                    assert_eq!(store.read(1, fixture.owner).unwrap(), [19, 71]);
                }
            }
        }
    }
}
