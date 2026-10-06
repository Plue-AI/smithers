//! Git objects belong to the unprivileged daemon's existing jj backing store.
//! No repository commands run in the root broker or on the install host.
use crate::{conn::Durable, hooks::Oid, objects::Bundles, outbox::Refs};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid repository object state",
    )
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn id<const N: usize>(bytes: &[u8]) -> io::Result<[u8; N]> {
    if bytes.len() != N * 2 || !bytes.iter().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let mut result = [0; N];
    for (i, value) in result.iter_mut().enumerate() {
        *value = u8::from_str_radix(
            std::str::from_utf8(&bytes[2 * i..2 * i + 2]).map_err(|_| invalid())?,
            16,
        )
        .map_err(|_| invalid())?;
    }
    Ok(result)
}

#[derive(Clone)]
pub struct Repository {
    git: PathBuf,
    directory: PathBuf,
    spool: PathBuf,
}
impl Repository {
    /// Fixed installed executable and trusted state directory are supplied by
    /// composition, never by an RPC or repository configuration.
    pub fn open(directory: &Path, spool: &Path) -> io::Result<Self> {
        if !cfg!(target_os = "linux") || rustix::process::geteuid().as_raw() != 19998 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Self::checked(Path::new("/usr/bin/git"), directory, spool)
    }
    fn checked(git: &Path, directory: &Path, spool: &Path) -> io::Result<Self> {
        let metadata = fs::symlink_metadata(spool)?;
        if !metadata.is_dir()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o700
            || !directory.is_dir()
            || !git.is_absolute()
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let repository = Self {
            git: git.into(),
            directory: directory.into(),
            spool: spool.into(),
        };
        repository.command(&["rev-parse", "--git-dir"])?;
        Ok(repository)
    }
    fn command(&self, arguments: &[&str]) -> io::Result<Vec<u8>> {
        let output = self.temporary()?;
        let mut child = Command::new(&self.git)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .arg("--no-pager")
            .args(["-c", "core.hooksPath=/dev/null", "-c", "core.fsync=all"])
            .arg("-C")
            .arg(&self.directory)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(output.file.try_clone()?)
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                if let Some(group) = rustix::process::Pid::from_raw(child.id() as i32) {
                    let _ =
                        rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
                }
                let _ = child.wait();
                return Err(io::ErrorKind::TimedOut.into());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if !status.success() {
            return Err(invalid());
        }
        let mut bytes = vec![];
        File::open(&output.path)?
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(invalid());
        }
        Ok(bytes)
    }
    fn sync(&self) -> io::Result<()> {
        // Git fsyncs new objects/refs; syncfs additionally orders the complete
        // backing store before the outbox's separately fsync'd append.
        #[cfg(target_os = "linux")]
        rustix::fs::syncfs(File::open(&self.directory)?).map_err(io::Error::from)?;
        #[cfg(not(target_os = "linux"))]
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
    pub fn acknowledged(&self) -> io::Result<Option<Oid>> {
        let bytes = self.command(&[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/smithers/acked/head",
        ])?;
        if bytes.is_empty() {
            return Ok(None);
        }
        Ok(Some(id(bytes.strip_suffix(b"\n").ok_or_else(invalid)?)?))
    }
    pub fn contains(&self, oid: Oid) -> io::Result<bool> {
        // Object ids are generated hex, so they cannot be options or revsets.
        Ok(self
            .command(&["cat-file", "-e", &format!("{}^{{commit}}", hex(&oid))])
            .is_ok())
    }
    fn temporary(&self) -> io::Result<Spool> {
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(|e| io::Error::other(e.to_string()))?;
        let path = self.spool.join(hex(&random));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        Ok(Spool { file, path })
    }
    /// Verify before importing and never fetch bundle-advertised refs. The
    /// caller must retain the expected head before wake/session admission.
    pub fn import(&self, bundle: &Spool, expected: Oid) -> io::Result<()> {
        let path = bundle.path.to_str().ok_or_else(invalid)?;
        self.command(&["bundle", "verify", path])?;
        self.command(&["bundle", "unbundle", path])?;
        if !self.contains(expected)? {
            return Err(invalid());
        }
        self.command(&["update-ref", "refs/smithers/incoming/head", &hex(&expected)])?;
        self.sync()
    }
    /// The caller grants at most one credit window at a time. This disk spool
    /// bounds the complete incoming bundle; no bundle is held in memory.
    pub fn receive(&self, mut source: impl Read, limit: u64) -> io::Result<Spool> {
        if limit == 0 || limit == u64::MAX {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let disk = rustix::fs::statvfs(&self.spool)?;
        let available = (disk.f_bavail as u64)
            .checked_mul(disk.f_frsize as u64)
            .ok_or_else(invalid)?;
        let limit = limit.min(available.saturating_sub(1024 * 1024 * 1024));
        if limit == 0 {
            return Err(io::ErrorKind::StorageFull.into());
        }
        let mut spool = self.temporary()?;
        let written = io::copy(&mut source.by_ref().take(limit + 1), &mut spool.file)?;
        if written == 0 || written > limit {
            return Err(io::ErrorKind::InvalidData.into());
        }
        spool.file.flush()?;
        spool.file.sync_all()?;
        Ok(spool)
    }
}
impl Refs for Repository {
    fn pin_and_sync(&mut self, event: [u8; 16], oid: Oid) -> io::Result<()> {
        if !self.contains(oid)? {
            return Err(invalid());
        }
        self.command(&[
            "update-ref",
            &format!("refs/smithers/pending/{}", hex(&event)),
            &hex(&oid),
        ])?;
        self.sync()
    }
    fn acknowledge_and_sync(&mut self, head: Oid) -> io::Result<()> {
        if !self.contains(head)? {
            return Err(invalid());
        }
        self.command(&["update-ref", "refs/smithers/acked/head", &hex(&head)])?;
        self.sync()
    }
    fn unpin(&mut self, event: [u8; 16]) -> io::Result<()> {
        self.command(&[
            "update-ref",
            "-d",
            &format!("refs/smithers/pending/{}", hex(&event)),
        ])?;
        self.sync()
    }
    fn pending(&mut self) -> io::Result<Vec<[u8; 16]>> {
        let bytes = self.command(&[
            "for-each-ref",
            "--format=%(refname)",
            "refs/smithers/pending/",
        ])?;
        bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| {
                id(line
                    .strip_prefix(b"refs/smithers/pending/")
                    .ok_or_else(invalid)?)
            })
            .collect()
    }
}
impl Bundles for Repository {
    type Source = Spool;
    fn export(&mut self, event: &Durable, haves: &[Oid]) -> io::Result<Spool> {
        // Only the event's durable pin is exported; queued events cannot ask
        // this provider to export arbitrary refs from another event.
        let reference = format!("refs/smithers/pending/{}", hex(&event.id));
        let mut spool = self.temporary()?;
        let path = spool.path.to_str().ok_or_else(invalid)?;
        let mut arguments = vec!["bundle".to_owned(), "create".into(), path.into(), reference];
        for have in haves {
            if self.contains(*have)? {
                arguments.push(format!("^{}", hex(have)));
            }
        }
        // A have equal to the pinned head yields an empty bundle. Re-export
        // complete objects rather than certify an objectless transfer.
        if let Err(error) = self.command(&arguments.iter().map(String::as_str).collect::<Vec<_>>())
        {
            if arguments.len() == 4 {
                return Err(error);
            }
            self.command(
                &arguments[..4]
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )?;
        }
        // Git replaces the destination atomically; the original descriptor
        // still names the empty file created to reserve the random pathname.
        spool.file = File::open(&spool.path)?;
        Ok(spool)
    }
}
pub struct Spool {
    file: File,
    path: PathBuf,
}
impl Read for Spool {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.file.read(bytes)
    }
}
impl Drop for Spool {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        conn::{self, Frame},
        outbox::{self, Outbox},
        outbox_store::Store,
    };
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        root: PathBuf,
        repository: Repository,
    }
    impl Fixture {
        fn new() -> Self {
            let mut random = [0; 16];
            getrandom::fill(&mut random).unwrap();
            let root = std::env::temp_dir().join(format!("w2-git-{}", hex(&random)));
            fs::create_dir(&root).unwrap();
            for name in ["repo", "spool", "state", "state/outbox"] {
                fs::create_dir(root.join(name)).unwrap();
                fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
            }
            let git = std::env::var_os("PATH")
                .and_then(|paths| {
                    std::env::split_paths(&paths)
                        .map(|p| p.join("git"))
                        .find(|p| p.is_file())
                })
                .unwrap();
            assert!(Command::new(&git)
                .args(["init", "--bare", "--quiet"])
                .arg(root.join("repo"))
                .status()
                .unwrap()
                .success());
            let repository =
                Repository::checked(&git, &root.join("repo"), &root.join("spool")).unwrap();
            Self { root, repository }
        }
        fn commit(&self) -> Oid {
            // Independently supplied literal commit/tree, not a production
            // snapshot or event encoder's idea of the expected repository.
            let mut content = vec![0; 400_001];
            getrandom::fill(&mut content).unwrap();
            let blob = self.root.join("blob");
            fs::write(&blob, &content).unwrap();
            let output = self
                .repository
                .command(&["hash-object", "-w", blob.to_str().unwrap()])
                .unwrap();
            let blob_id: Oid = id(output.strip_suffix(b"\n").unwrap()).unwrap();
            let mut tree = b"100644 file\0".to_vec();
            tree.extend(blob_id);
            let tree_path = self.root.join("tree");
            fs::write(&tree_path, tree).unwrap();
            let output = self
                .repository
                .command(&[
                    "hash-object",
                    "-w",
                    "-t",
                    "tree",
                    tree_path.to_str().unwrap(),
                ])
                .unwrap();
            let tree = std::str::from_utf8(&output).unwrap().trim();
            let bytes = format!("tree {tree}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nfixture\n");
            let path = self.root.join("commit");
            fs::write(&path, bytes).unwrap();
            let output = self
                .repository
                .command(&["hash-object", "-w", "-t", "commit", path.to_str().unwrap()])
                .unwrap();
            id(output.strip_suffix(b"\n").unwrap()).unwrap()
        }
        fn outbox(&self) -> Outbox<Repository> {
            let owner = fs::metadata(&self.root).unwrap().uid();
            Outbox::open(
                Store::open(&self.root.join("state/outbox"), owner).unwrap(),
                owner,
                self.repository.clone(),
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn bundle_verified_import_does_not_publish_advertised_pending_ref() {
        let source = Fixture::new();
        let destination = Fixture::new();
        let head = source.commit();
        let mut outbox = source.outbox();
        let (seq, event_id) = outbox
            .append(&outbox::captured(head, [2; 20], [3; 20]), Some(head))
            .unwrap();
        let event = outbox.front().unwrap().unwrap();
        assert_eq!((event.seq, event.id), (seq, event_id));
        let mut repo = source.repository.clone();
        for haves in [vec![], vec![head], vec![[99; 20]]] {
            let bundle = repo.export(&event, &haves).unwrap();
            assert!(bundle.file.metadata().unwrap().len() > 256 * 1024);
            let incoming = destination
                .repository
                .receive(bundle, 4 * 1024 * 1024)
                .unwrap();
            destination.repository.import(&incoming, head).unwrap();
            assert!(destination.repository.contains(head).unwrap());
            assert!(destination.repository.clone().pending().unwrap().is_empty());
            assert_eq!(destination.repository.acknowledged().unwrap(), None);
        }
        assert_eq!(fs::read_dir(source.root.join("spool")).unwrap().count(), 0);
        assert_eq!(
            fs::read_dir(destination.root.join("spool"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn restart_retains_pin_and_stale_receipt_preserves_acknowledged_head() {
        let fixture = Fixture::new();
        let head = fixture.commit();
        let mut repo = fixture.repository.clone();
        repo.acknowledge_and_sync(head).unwrap();
        for outcome in [1u8, 2, 5] {
            let mut outbox = fixture.outbox();
            let (seq, event_id) = outbox
                .append(&outbox::captured(head, [2; 20], [3; 20]), Some(head))
                .unwrap();
            drop(outbox);
            let mut outbox = fixture.outbox();
            assert_eq!(repo.pending().unwrap(), [event_id]);
            outbox.after_bundle(seq).unwrap();
            outbox
                .acknowledge(&Frame {
                    kind: 2,
                    stream: 0,
                    payload: conn::tagged(
                        3,
                        &[conn::field(1, seq.to_be_bytes()), conn::field(2, [outcome])],
                    ),
                })
                .unwrap();
            assert!(outbox.front().unwrap().is_none());
            assert!(repo.pending().unwrap().is_empty());
            assert_eq!(repo.acknowledged().unwrap(), Some(head));
        }
        let mut orphan = fixture.repository.clone();
        orphan.pin_and_sync([22; 16], head).unwrap();
        drop(fixture.outbox());
        assert!(orphan.pending().unwrap().is_empty());
    }

    #[test]
    fn invalid_or_oversized_incoming_never_advances_a_ref_and_removes_spool() {
        let fixture = Fixture::new();
        assert!(fixture.repository.receive(&b"12345"[..], 4).is_err());
        assert!(fixture.repository.receive(&b""[..], 4).is_err());
        assert!(fixture.repository.receive(&b"x"[..], 0).is_err());
        let spool = fixture
            .repository
            .receive(&b"invalid bundle"[..], 40)
            .unwrap();
        assert!(fixture.repository.import(&spool, [1; 20]).is_err());
        drop(spool);
        assert_eq!(fs::read_dir(fixture.root.join("spool")).unwrap().count(), 0);
        assert_eq!(fixture.repository.acknowledged().unwrap(), None);
        assert!(fixture
            .repository
            .command(&["show-ref", "--verify", "refs/smithers/incoming/head"])
            .is_err());
        assert!(Repository::open(&fixture.root.join("repo"), &fixture.root.join("spool")).is_err());
    }

    #[cfg(all(feature = "killpoints", debug_assertions))]
    #[test]
    fn k3_crash_child() {
        let Some(root) = std::env::var_os("W2_K3_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let git = std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|p| p.join("git"))
                    .find(|p| p.is_file())
            })
            .unwrap();
        let repository =
            Repository::checked(&git, &root.join("repo"), &root.join("spool")).unwrap();
        let head = id::<20>(std::env::var("W2_K3_HEAD").unwrap().as_bytes()).unwrap();
        let fixture = Fixture { root, repository };
        fixture
            .outbox()
            .append(&outbox::captured(head, [2; 20], [3; 20]), Some(head))
            .unwrap();
        panic!("K3 must terminate after durable append");
    }

    #[cfg(all(feature = "killpoints", debug_assertions))]
    #[test]
    fn k3_durable_event_and_real_git_pin_survive_process_crash_ten_times() {
        for _ in 0..10 {
            let fixture = Fixture::new();
            let head = fixture.commit();
            let status = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "git::tests::k3_crash_child", "--nocapture"])
                .env("W2_K3_ROOT", &fixture.root)
                .env("W2_K3_HEAD", hex(&head))
                .env("SMITHERS_MACHINED_KILL_AT", "K3")
                .stdout(Stdio::null())
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(73));
            let outbox = fixture.outbox();
            let event = outbox.front().unwrap().unwrap();
            assert_eq!(event.seq, 1);
            assert_eq!(event.captured_head(), Some(head));
            assert_eq!(fixture.repository.clone().pending().unwrap(), [event.id]);
            let mut repository = fixture.repository.clone();
            let mut bundle = repository.export(&event, &[]).unwrap();
            let mut signature = [0; 16];
            bundle.read_exact(&mut signature).unwrap();
            assert_eq!(&signature, b"# v2 git bundle\n");
            assert_eq!(repository.acknowledged().unwrap(), None);
        }
    }
}
