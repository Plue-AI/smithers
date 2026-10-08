//! Private watcher recovery data. Restoring goes through the existing burst and
//! checkpoint validators; malformed files never select an empty checkpoint.
use crate::{
    burst::{Burst, Bursts, Key},
    events::Checkpoint,
    hooks::{Actor, Oid},
    versions::{Objects, Version},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
const LIMIT: u64 = 64 * 1024 * 1024;
type Closed = crate::events::Closed<Actor, Oid, Oid>;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Closing {
    version: u8,
    closes: Vec<Closed>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u8,
    pin: Oid,
    recorded: BTreeMap<String, Version<Oid>>,
    bursts: Vec<Burst<Actor, Version<Oid>>>,
    identities: Vec<(Key<Actor>, [u8; 16])>,
    renames: BTreeMap<String, String>,
}
fn invalid(e: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}
pub struct Store {
    directory: PathBuf,
    owner: u32,
}
impl Store {
    pub fn open(directory: &Path) -> io::Result<Self> {
        let owner = rustix::process::geteuid().as_raw();
        let metadata = fs::symlink_metadata(directory)?;
        if !metadata.is_dir() || metadata.uid() != owner || metadata.mode() & 0o7777 != 0o700 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(Self {
            directory: directory.into(),
            owner,
        })
    }
    fn read_private(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(
                rustix::fs::OFlags::NOFOLLOW.bits() as i32
                    | rustix::fs::OFlags::NONBLOCK.bits() as i32,
            )
            .open(self.directory.join(name))
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let m = file.metadata()?;
        if !m.is_file()
            || m.nlink() != 1
            || m.uid() != self.owner
            || m.mode() & 0o7777 != 0o600
            || m.len() > LIMIT
        {
            return Err(invalid("unsafe watcher checkpoint"));
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > LIMIT {
            return Err(invalid("watcher checkpoint too large"));
        }
        Ok(Some(bytes))
    }
    fn stored(&self) -> io::Result<Option<Stored>> {
        let Some(bytes) = self.read_private("watcher.json")? else {
            return Ok(None);
        };
        let stored: Stored = serde_json::from_slice(&bytes).map_err(invalid)?;
        if stored.version != 1 {
            return Err(invalid("unsupported watcher checkpoint"));
        }
        Ok(Some(stored))
    }
    fn closing(&self) -> io::Result<Vec<Closed>> {
        let Some(bytes) = self.read_private("watcher-closing.json")? else {
            return Ok(vec![]);
        };
        let journal: Closing = serde_json::from_slice(&bytes).map_err(invalid)?;
        if journal.version != 1 {
            return Err(invalid("unsupported watcher close journal"));
        }
        Self::validate_closes(&journal.closes)?;
        Ok(journal.closes)
    }
    fn validate_closes(closes: &[Closed]) -> io::Result<()> {
        let valid_path =
            |path: &str| !path.contains('\0') && crate::ignore::relative(Path::new(path));
        for (index, close) in closes.iter().enumerate() {
            if close.burst_id == [0; 16]
                || close.files.is_empty()
                || !valid_path(&close.last_path)
                || matches!(&close.actor, Some(Actor::Principal(reference)) if reference.len() != 16)
                || closes[..index]
                    .iter()
                    .any(|old| old.burst_id == close.burst_id)
                || close.files.iter().any(|(path, file)| {
                    !valid_path(path)
                        || file
                            .before
                            .iter()
                            .chain(file.after.iter())
                            .any(|version| ![0o100644, 0o100755].contains(&version.mode))
                })
                || close.renamed_to.iter().any(|(from, to)| {
                    !valid_path(from)
                        || !valid_path(to)
                        || from == to
                        || !close
                            .files
                            .get(from)
                            .is_some_and(|file| file.before.is_some() && file.after.is_some())
                })
            {
                return Err(invalid("invalid watcher close journal"));
            }
            for event in crate::events::wire_events(close).map_err(invalid)? {
                crate::conn::Durable {
                    seq: 1,
                    id: close.burst_id,
                    event,
                }
                .frame()
                .encode()
                .map_err(invalid)?;
            }
        }
        Ok(())
    }
    pub(crate) fn prepare_close(
        &self,
        close: &Closed,
        repository: &crate::git::Repository,
    ) -> io::Result<()> {
        let mut closes = self.closing()?;
        if closes.iter().any(|old| old.burst_id == close.burst_id) {
            return Err(invalid("duplicate watcher close intent"));
        }
        closes.push(close.clone());
        Self::validate_closes(&closes)?;
        let bytes = serde_json::to_vec(&Closing { version: 1, closes }).map_err(invalid)?;
        if bytes.len() as u64 > LIMIT {
            return Err(invalid("watcher close journal too large"));
        }
        // Retain immutable versions before the private intent becomes durable.
        repository.retain_watcher_close(close.burst_id, close.versions_commit)?;
        self.replace_private("watcher-closing.json", &bytes)
    }
    pub(crate) fn publish_close(
        close: &Closed,
        events: &crate::event_service::Events<crate::git::Repository, crate::git::Repository>,
    ) -> io::Result<()> {
        use sha2::{Digest as _, Sha256};
        for (part, payload) in crate::events::wire_events(close)
            .map_err(invalid)?
            .iter()
            .enumerate()
        {
            let mut hash = Sha256::new();
            hash.update(b"smithers-watcher-close-v1");
            hash.update(close.burst_id);
            hash.update((part as u32).to_be_bytes());
            let id = hash.finalize()[..16].try_into().unwrap();
            events.append_keyed(id, payload, close.versions_commit)?;
        }
        Ok(())
    }
    pub(crate) fn recover_closes(
        &self,
        state: &mut Checkpoint<Actor, Oid>,
        repository: &mut crate::git::Repository,
        events: &crate::event_service::Events<crate::git::Repository, crate::git::Repository>,
    ) -> io::Result<()> {
        let closes = self.closing()?;
        for close in &closes {
            Self::publish_close(close, events)?;
            state.settle_closed(close)?;
        }
        if !closes.is_empty() {
            self.save(state, repository)?;
        } else {
            // A crash before intent rename may leave an unreferenced close pin.
            repository.clear_watcher_closes()?;
        }
        self.finish_closes(repository)
    }
    pub(crate) fn finish_closes(&self, repository: &crate::git::Repository) -> io::Result<()> {
        match fs::symlink_metadata(self.directory.join("watcher-closing.json")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
            Ok(_) => {
                self.closing()?;
            }
        }
        // The committed checkpoint and complete outbox pins now retain history.
        repository.clear_watcher_closes()?;
        match fs::remove_file(self.directory.join("watcher-closing.json")) {
            Ok(()) => File::open(&self.directory)?.sync_all(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
    fn restore(stored: Stored) -> io::Result<Checkpoint<Actor, Oid>> {
        let versions = stored
            .recorded
            .values()
            .chain(stored.bursts.iter().flat_map(|b| {
                b.files
                    .values()
                    .flat_map(|f| f.before.iter().chain(f.after.iter()))
            }));
        if versions
            .into_iter()
            .any(|v| ![0o100644, 0o100755].contains(&v.mode))
        {
            return Err(invalid("invalid version mode"));
        }
        let now = stored.bursts.iter().map(|b| b.last_ms).max().unwrap_or(0);
        let bursts = Bursts::restore(stored.bursts, now).map_err(invalid)?;
        Checkpoint::restore(stored.recorded, bursts, stored.identities, stored.renames)
    }
    pub fn load(&self) -> io::Result<Checkpoint<Actor, Oid>> {
        self.stored()?
            .map(Self::restore)
            .transpose()
            .map(|checkpoint| checkpoint.unwrap_or_default())
    }
    pub fn save(
        &self,
        state: &Checkpoint<Actor, Oid>,
        repository: &mut crate::git::Repository,
    ) -> io::Result<()> {
        let previous = self.stored()?;
        // Validate the current disk checkpoint before replacing any refs.
        if let Some(previous) = &previous {
            Self::restore(Stored {
                version: previous.version,
                pin: previous.pin,
                recorded: previous.recorded.clone(),
                bursts: previous.bursts.clone(),
                identities: previous.identities.clone(),
                renames: previous.renames.clone(),
            })?;
        }
        // Refuse invalid new state before the first repository or disk write.
        Self::restore(Stored {
            version: 1,
            pin: [0; 20],
            recorded: state.recorded.clone(),
            bursts: state.bursts.pending().to_vec(),
            identities: state.identities(),
            renames: state.renames().clone(),
        })?;
        let mut tree = BTreeMap::new();
        for v in state
            .recorded
            .values()
            .chain(state.bursts.pending().iter().flat_map(|b| {
                b.files
                    .values()
                    .flat_map(|f| f.before.iter().chain(f.after.iter()))
            }))
        {
            let name: String = v.blob.iter().map(|b| format!("{b:02x}")).collect();
            tree.insert(name, (v.blob, 0o100644));
        }
        let pin = repository.parentless(&tree)?;
        repository.retain_checkpoint(pin, previous.as_ref().map(|s| s.pin))?;
        let stored = Stored {
            version: 1,
            pin,
            recorded: state.recorded.clone(),
            bursts: state.bursts.pending().to_vec(),
            identities: state.identities(),
            renames: state.renames().clone(),
        };
        Self::restore(Stored {
            version: 1,
            pin,
            recorded: stored.recorded.clone(),
            bursts: stored.bursts.clone(),
            identities: stored.identities.clone(),
            renames: stored.renames.clone(),
        })?;
        let bytes = serde_json::to_vec(&stored).map_err(invalid)?;
        self.replace_private("watcher.json", &bytes)
    }
    fn replace_private(&self, destination: &str, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() as u64 > LIMIT {
            return Err(invalid("watcher checkpoint too large"));
        }
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(invalid)?;
        let name: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let path = self.directory.join(format!(".watcher-{name}"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&path, self.directory.join(destination))?;
            File::open(&self.directory)?.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(&path);
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (tempfile::TempDir, Store) {
        let d = tempfile::tempdir().unwrap();
        fs::set_permissions(d.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let s = Store::open(d.path()).unwrap();
        (d, s)
    }
    fn write(s: &Store, data: &[u8]) {
        let path = s.directory.join("watcher.json");
        fs::write(&path, data).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn closed() -> Closed {
        Closed {
            burst_id: [1; 16],
            actor: None,
            session: None,
            files: BTreeMap::from([(
                "a".into(),
                crate::burst::File {
                    before: None,
                    after: Some(Version {
                        blob: [2; 20],
                        post_digest: [3; 32],
                        mode: 0o100644,
                    }),
                },
            )]),
            versions_commit: [4; 20],
            renamed_to: BTreeMap::new(),
            last_path: "a".into(),
        }
    }
    #[test]
    fn recovered_close_settles_rename_delete_and_keeps_other_actors_and_later_versions() {
        let before = Version {
            blob: [2; 20],
            post_digest: [3; 32],
            mode: 0o100644,
        };
        let after = Version {
            blob: [4; 20],
            post_digest: [5; 32],
            mode: 0o100755,
        };
        let agent = Key::Smithers(Actor::Principal(vec![6; 16]));
        let pending = vec![
            Burst {
                key: Key::Outside,
                opened_ms: 0,
                last_ms: 1,
                last_path: "to".into(),
                files: BTreeMap::from([
                    (
                        "from".into(),
                        crate::burst::File {
                            before: Some(before.clone()),
                            after: None,
                        },
                    ),
                    (
                        "to".into(),
                        crate::burst::File {
                            before: None,
                            after: None,
                        },
                    ),
                ]),
            },
            Burst {
                key: agent.clone(),
                opened_ms: 0,
                last_ms: 2,
                last_path: "other".into(),
                files: BTreeMap::from([(
                    "other".into(),
                    crate::burst::File {
                        before: Some(before.clone()),
                        after: Some(after.clone()),
                    },
                )]),
            },
        ];
        let mut checkpoint = Checkpoint::restore(
            BTreeMap::from([
                ("from".into(), before.clone()),
                ("other".into(), after.clone()),
            ]),
            Bursts::restore(pending, 2).unwrap(),
            vec![(Key::Outside, [1; 16]), (agent.clone(), [2; 16])],
            BTreeMap::from([("from".into(), "to".into())]),
        )
        .unwrap();
        let mut close = closed();
        close.files = BTreeMap::from([(
            "from".into(),
            crate::burst::File {
                before: Some(before),
                after: Some(after.clone()),
            },
        )]);
        close.renamed_to = BTreeMap::from([("from".into(), "to".into())]);
        close.last_path = "to".into();
        checkpoint.settle_closed(&close).unwrap();
        assert!(!checkpoint.recorded.contains_key("from"));
        assert_eq!(checkpoint.recorded["to"], after);
        assert_eq!(checkpoint.bursts.pending().len(), 1);
        assert_eq!(checkpoint.identities(), vec![(agent, [2; 16])]);
        assert!(checkpoint.renames().is_empty());
        let later = Version {
            blob: [7; 20],
            post_digest: [8; 32],
            mode: 0o100644,
        };
        checkpoint.recorded.insert("to".into(), later.clone());
        checkpoint.settle_closed(&close).unwrap();
        assert_eq!(
            checkpoint.recorded["to"], later,
            "a committed close cannot undo a later checkpoint"
        );
        close.burst_id = [2; 16];
        close.renamed_to.clear();
        close.last_path = "other".into();
        close.files = BTreeMap::from([(
            "other".into(),
            crate::burst::File {
                before: Some(after),
                after: None,
            },
        )]);
        checkpoint.settle_closed(&close).unwrap();
        assert!(!checkpoint.recorded.contains_key("other"));
        assert_eq!(checkpoint.recorded["to"], later);
        assert!(checkpoint.bursts.pending().is_empty());
    }
    #[test]
    fn close_journal_rejects_corruption_foreign_versions_and_unsafe_intents() {
        let (_dir, store) = fixture();
        assert!(store.closing().unwrap().is_empty());
        store
            .replace_private("watcher-closing.json", b"broken")
            .unwrap();
        assert!(store.closing().is_err());
        store
            .replace_private("watcher-closing.json", br#"{"version":2,"closes":[]}"#)
            .unwrap();
        assert!(store.closing().is_err());
        let good = closed();
        let bytes = serde_json::to_vec(&Closing {
            version: 1,
            closes: vec![good.clone()],
        })
        .unwrap();
        store
            .replace_private("watcher-closing.json", &bytes)
            .unwrap();
        assert_eq!(store.closing().unwrap()[0].burst_id, [1; 16]);
        let mut invalid = vec![good.clone(), good.clone()];
        assert!(Store::validate_closes(&invalid).is_err());
        invalid.truncate(1);
        invalid[0].burst_id = [0; 16];
        assert!(Store::validate_closes(&invalid).is_err());
        invalid[0] = good.clone();
        invalid[0].last_path = "../escape".into();
        assert!(Store::validate_closes(&invalid).is_err());
        invalid[0] = good.clone();
        invalid[0]
            .files
            .get_mut("a")
            .unwrap()
            .after
            .as_mut()
            .unwrap()
            .mode = 0o120000;
        assert!(Store::validate_closes(&invalid).is_err());
        invalid[0] = good.clone();
        invalid[0].actor = Some(Actor::Principal(vec![0; 15]));
        assert!(Store::validate_closes(&invalid).is_err());
        invalid[0] = good.clone();
        invalid[0].renamed_to.insert("a".into(), "../escape".into());
        assert!(Store::validate_closes(&invalid).is_err());
        let target = store.directory.join("foreign");
        fs::write(&target, &bytes).unwrap();
        fs::remove_file(store.directory.join("watcher-closing.json")).unwrap();
        std::os::unix::fs::symlink(&target, store.directory.join("watcher-closing.json")).unwrap();
        assert!(store.closing().is_err());
        assert_eq!(fs::read(target).unwrap(), bytes);
    }
    fn journal_recovery(count: usize) {
        use sha2::{Digest as _, Sha256};
        use std::process::Command;
        let (dir, store) = fixture();
        let root = dir.path().join("repo");
        assert!(Command::new("/usr/bin/git")
            .args(["init", "--bare", "-q"])
            .arg(&root)
            .status()
            .unwrap()
            .success());
        let spool = dir.path().join("spool");
        fs::create_dir(&spool).unwrap();
        fs::set_permissions(&spool, fs::Permissions::from_mode(0o700)).unwrap();
        let mut git =
            crate::git::Repository::checked(Path::new("/usr/bin/git"), &root, &spool).unwrap();
        let blob = git.blob(b"immutable closed bytes\n").unwrap();
        let mut close = closed();
        close.files.clear();
        let mut tree = BTreeMap::new();
        let mut pending = BTreeMap::new();
        for n in 0..count {
            let path = format!(
                "{}file-{n:05}",
                "nested/".repeat(if count == 1 { 0 } else { 90 })
            );
            let mode = if n % 2 == 0 { 0o100644 } else { 0o100755 };
            tree.insert(format!("b/{path}"), (blob, mode));
            close.files.insert(
                path.clone(),
                crate::burst::File {
                    before: None,
                    after: Some(Version {
                        blob,
                        post_digest: Sha256::digest(b"immutable closed bytes\n").into(),
                        mode,
                    }),
                },
            );
            pending.insert(
                path.clone(),
                crate::burst::File {
                    before: None,
                    after: None,
                },
            );
            close.last_path = path;
        }
        close.versions_commit = git.parentless(&tree).unwrap();
        let bursts = Bursts::restore(
            vec![Burst {
                key: Key::Outside,
                opened_ms: 0,
                last_ms: 0,
                files: pending,
                last_path: close.last_path.clone(),
            }],
            0,
        )
        .unwrap();
        let mut checkpoint = Checkpoint::restore(
            BTreeMap::new(),
            bursts,
            vec![(Key::Outside, [1; 16])],
            BTreeMap::new(),
        )
        .unwrap();
        store.save(&checkpoint, &mut git).unwrap();
        store.prepare_close(&close, &git).unwrap();
        assert!(Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args(["gc", "--prune=now"])
            .status()
            .unwrap()
            .success());
        assert!(
            git.contains(close.versions_commit).unwrap(),
            "intent pins versions before outbox append"
        );
        let outbox_dir = dir.path().join("outbox");
        fs::create_dir(&outbox_dir).unwrap();
        fs::set_permissions(&outbox_dir, fs::Permissions::from_mode(0o700)).unwrap();
        let owner = rustix::process::geteuid().as_raw();
        let outbox = crate::outbox::Outbox::open(
            crate::outbox_store::Store::open(&outbox_dir, owner).unwrap(),
            owner,
            git.clone(),
        )
        .unwrap();
        let events =
            crate::event_service::Events::new(outbox, git.clone(), || Ok(0x80000001)).unwrap();
        let payloads = crate::events::wire_events(&close).unwrap();
        if count > 1 {
            assert!(payloads.len() > 1, "exercise interrupted multipart append");
        }
        // Independently frozen SHA-256(domain, burst id, part=0), not read from the implementation.
        events
            .append_keyed(
                [
                    130, 122, 19, 91, 120, 253, 120, 224, 15, 146, 129, 89, 88, 231, 203, 104,
                ],
                &payloads[0],
                close.versions_commit,
            )
            .unwrap();
        store
            .recover_closes(&mut checkpoint, &mut git, &events)
            .unwrap();
        assert_eq!(
            events.depth().unwrap(),
            payloads.len() as u32,
            "first part reuses its queued envelope"
        );
        assert!(checkpoint.bursts.pending().is_empty());
        assert!(checkpoint.identities().is_empty());
        let restored = store.load().unwrap();
        assert_eq!(restored.recorded.len(), count);
        for (path, file) in &close.files {
            assert_eq!(restored.recorded.get(path), file.after.as_ref());
        }
        assert!(store.closing().unwrap().is_empty());
        store
            .recover_closes(&mut checkpoint, &mut git, &events)
            .unwrap();
        assert_eq!(events.depth().unwrap(), payloads.len() as u32);
        assert!(git.contains(close.versions_commit).unwrap());
    }
    #[test]
    fn close_journal_recovers_exact_versions_without_reopening_published_burst() {
        journal_recovery(1);
    }
    #[test]
    fn close_journal_completes_interrupted_multipart_append_without_duplicate_parts() {
        journal_recovery(6000);
    }
    #[test]
    fn missing_checkpoint_is_empty_but_corruption_and_foreign_versions_refuse() {
        let (_d, s) = fixture();
        assert!(s.load().unwrap().recorded.is_empty());
        write(&s, b"broken");
        assert!(s.load().is_err());
        let mut state = Stored {
            version: 1,
            pin: [0; 20],
            recorded: BTreeMap::new(),
            bursts: vec![],
            identities: vec![],
            renames: BTreeMap::new(),
        };
        state.recorded.insert(
            "../escape".into(),
            Version {
                blob: [1; 20],
                post_digest: [2; 32],
                mode: 0o100644,
            },
        );
        write(&s, &serde_json::to_vec(&state).unwrap());
        assert!(s.load().is_err());
        state.recorded.clear();
        state.recorded.insert(
            "file".into(),
            Version {
                blob: [1; 20],
                post_digest: [2; 32],
                mode: 0o100644,
            },
        );
        write(&s, &serde_json::to_vec(&state).unwrap());
        assert_eq!(s.load().unwrap().recorded["file"].blob, [1; 20]);
        state.recorded.get_mut("file").unwrap().mode = 0o1004755;
        write(&s, &serde_json::to_vec(&state).unwrap());
        assert!(s.load().is_err());
    }
    #[test]
    fn symlinks_hardlinks_and_shared_modes_never_reset_history() {
        for kind in ["symlink", "hardlink", "mode"] {
            let (_d, s) = fixture();
            let target = s.directory.join("target");
            fs::write(&target, b"keep").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
            let path = s.directory.join("watcher.json");
            match kind {
                "symlink" => std::os::unix::fs::symlink(&target, &path).unwrap(),
                "hardlink" => fs::hard_link(&target, &path).unwrap(),
                _ => {
                    fs::write(&path, b"{}").unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
                }
            }
            assert!(s.load().is_err());
            assert_eq!(fs::read(&target).unwrap(), b"keep");
        }
    }
}
