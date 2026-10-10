//! T-STK-08 `TestRebaseBrokerValidatesFreezeInputs` (C-SEC-02). Rebase freeze
//! and thaw requests cross the production daemon-to-broker socketpair into the
//! production root stack: `control::serve` -> `Supervisor` -> `Processes` ->
//! `Cgroups`. Only the session parent is a fixture directory, because a lane
//! host has no protected cgroup-v2 hierarchy and no root. Kernel freezing and
//! writer resumption are qualified in a real microVM by
//! `TestRealMicroVMRebaseFreezesSessionWriters`.
use super::{Cgroups, Group};
use crate::broker::{
    control::{self, SocketpairBroker},
    spawn::{InstalledAdmission, Processes},
    supervisor::Supervisor,
};
use crate::conn;
use crate::hooks::Broker;
use rustix::net::{
    getsockname, recv, send, socketpair, AddressFamily, RecvFlags, SendFlags, SocketFlags,
    SocketType,
};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SENTINEL: &[u8] = b"outside sentinel\n";

/// A session parent beside an outside directory a hostile request or entry
/// would like root to write. Every refusal must leave both byte-for-byte.
struct Tree {
    _dir: tempfile::TempDir,
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/sentinel"), SENTINEL).unwrap();
        fs::write(root.join("outside/cgroup.freeze"), b"0").unwrap();
        // A followed link would read a settled barrier and report success.
        fs::write(root.join("outside/cgroup.events"), b"populated 1\nfrozen 1\n").unwrap();
        fs::create_dir(root.join("sessions")).unwrap();
        Self { _dir: dir, root }
    }
    fn sessions(&self) -> PathBuf {
        self.root.join("sessions")
    }
    fn session(&self, name: &str, events: &str) {
        let path = self.sessions().join(name);
        fs::create_dir(&path).unwrap();
        fs::write(path.join("cgroup.events"), events).unwrap();
    }
    /// Replace the parent's control files with regular files. Removing first
    /// never writes through a link a previous step planted.
    fn barrier(&self, events: &str) {
        for (leaf, bytes) in [("cgroup.freeze", "0"), ("cgroup.events", events)] {
            let path = self.sessions().join(leaf);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => panic!("{e}"),
            }
            fs::write(path, bytes).unwrap();
        }
    }
    fn freeze_file(&self) -> Vec<u8> {
        fs::read(self.sessions().join("cgroup.freeze")).unwrap()
    }
    fn groups(&self, ids: &[u32]) -> BTreeMap<u32, Group> {
        ids.iter()
            .map(|id| {
                let name = format!("s{id}");
                let directory = File::open(self.sessions().join(&name)).unwrap();
                (*id, Group { name, directory })
            })
            .collect()
    }
    /// Every entry's kind and bytes, links by target, without following any.
    fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(path: &Path, base: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            let kind = fs::symlink_metadata(path).unwrap().file_type();
            let relative = path.strip_prefix(base).unwrap().to_path_buf();
            if kind.is_symlink() {
                let target = fs::read_link(path).unwrap();
                out.insert(relative, [b"link:", target.as_os_str().as_encoded_bytes()].concat());
            } else if kind.is_dir() {
                out.insert(relative, b"dir".to_vec());
                for entry in fs::read_dir(path).unwrap() {
                    walk(&entry.unwrap().path(), base, out);
                }
            } else if kind.is_file() {
                out.insert(relative, fs::read(path).unwrap());
            } else {
                out.insert(relative, b"special".to_vec());
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.root, &self.root, &mut out);
        out
    }
}

/// The production root stack behind one socketpair. `raw` is a second
/// descriptor for the daemon's end: a compromised daemon writes these bytes.
struct Served {
    broker: SocketpairBroker,
    raw: OwnedFd,
    worker: std::thread::JoinHandle<io::Result<()>>,
}
fn serve(tree: &Tree, groups: &[u32]) -> Served {
    let cgroups = Cgroups {
        parent: File::open(tree.sessions()).unwrap(),
        groups: tree.groups(groups),
    };
    let (server, client) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    // The sole peer: neither end has a filesystem or abstract name, so no
    // other process can connect to the broker. It inherits only this pair.
    // unix(7): an unnamed socket's address is only its sa_family_t.
    for end in [&server, &client] {
        let name = getsockname(end).unwrap();
        assert_eq!(name.address_family(), AddressFamily::UNIX);
        assert_eq!(name.addr_len() as usize, std::mem::size_of::<libc::sa_family_t>());
    }
    let worker = std::thread::spawn(move || {
        let mut root = Supervisor::new(Processes::new(cgroups, InstalledAdmission));
        control::serve(&server, &mut root)
    });
    let raw = client.try_clone().unwrap();
    rustix::net::sockopt::set_socket_timeout(
        &raw,
        rustix::net::sockopt::Timeout::Recv,
        Some(Duration::from_secs(2)),
    )
    .unwrap();
    Served {
        broker: SocketpairBroker::new(client).unwrap(),
        raw,
        worker,
    }
}
fn packet(id: u32, variant: u8, fields: &[Vec<u8>]) -> Vec<u8> {
    [id.to_be_bytes().to_vec(), conn::tagged(variant, fields)].concat()
}
fn exchange(raw: &OwnedFd, bytes: &[u8]) -> Vec<u8> {
    assert_eq!(send(raw, bytes, SendFlags::NOSIGNAL).unwrap(), bytes.len());
    let mut response = vec![0; 65561];
    let (length, _) = recv(raw, &mut response, RecvFlags::empty()).unwrap();
    response.truncate(length);
    response
}
/// The literal refusal envelope: the request id, variant 255, error code.
fn refusal(id: u32, code: u8) -> Vec<u8> {
    packet(id, 255, &[conn::field(1, [code])])
}
fn timeout(ms: u32) -> Vec<u8> {
    conn::field(1, ms.to_be_bytes())
}

#[test]
fn rebase_broker_validates_freeze_inputs() {
    let tree = Tree::new();
    // Session groups the broker already holds: 3 is a member writer that has
    // not reached the barrier, 4 is empty and 5 is frozen.
    tree.session("s3", "populated 1\nfrozen 0\n");
    tree.session("s4", "populated 0\nfrozen 0\n");
    tree.session("s5", "populated 1\nfrozen 1\n");
    let served = serve(&tree, &[3, 4, 5]);

    // 1. Before root filesystem access. The parent has no control files yet,
    // so a request that reaches the provider's filesystem fails NotFound (5).
    // Positive control: a valid freeze does reach it.
    let baseline = tree.snapshot();
    assert_eq!(
        exchange(&served.raw, &packet(0x5100_0001, 1, &[timeout(1000)])),
        refusal(0x5100_0001, 5)
    );
    assert_eq!(tree.snapshot(), baseline);
    let outside = tree.root.join("outside");
    let mut malformed_trailing = packet(0x5100_0002, 1, &[timeout(1000)]);
    malformed_trailing.push(0);
    let mut malformed_short = packet(0x5100_0003, 1, &[timeout(1000)]);
    malformed_short.pop();
    let mut hostile: Vec<(Vec<u8>, u8)> = vec![
        // Bounded parsing: one u32 timeout of 1 to 1000 ms, nothing else.
        (packet(0x5200_0001, 1, &[]), 1),
        (packet(0x5200_0002, 1, &[timeout(0)]), 1),
        (packet(0x5200_0003, 1, &[timeout(1001)]), 1),
        (packet(0x5200_0004, 1, &[timeout(u32::MAX)]), 1),
        (packet(0x5200_0005, 1, &[conn::field(1, 1000u16.to_be_bytes())]), 1),
        (packet(0x5200_0006, 1, &[timeout(1000), timeout(1)]), 1),
        (malformed_trailing, 1),
        (malformed_short, 1),
        // No request names a cgroup path, uid, environment, argv, working-copy
        // path or onto revision.
        (packet(0x5300_0001, 1, &[timeout(1000), conn::field(2, b"/sys/fs/cgroup/smithers/sessions/../../..")]), 1),
        (packet(0x5300_0002, 1, &[timeout(1000), conn::field(2, outside.as_os_str().as_encoded_bytes())]), 1),
        (packet(0x5300_0003, 1, &[timeout(1000), conn::field(2, b"../outside/cgroup.freeze")]), 1),
        (packet(0x5300_0004, 1, &[timeout(1000), conn::field(2, 0u32.to_be_bytes())]), 1),
        (packet(0x5300_0005, 1, &[timeout(1000), conn::field(3, 20000u32.to_be_bytes())]), 1),
        (packet(0x5300_0006, 1, &[timeout(1000), conn::field(2, b"LD_PRELOAD=/workspace/evil.so")]), 1),
        (packet(0x5300_0007, 1, &[timeout(1000), conn::field(2, b"/bin/sh")]), 1),
        (packet(0x5300_0008, 1, &[timeout(1000), conn::field(2, b"/workspace/.jj/repo/config.toml")]), 1),
        (packet(0x5300_0009, 1, &[timeout(1000), conn::field(2, [0x11; 20])]), 1),
        (packet(0x5300_000a, 1, &[timeout(1000), conn::field(2, b"1111111111111111111111111111111111111111")]), 1),
        // Thaw, kill and the barrier query take no arguments.
        (packet(0x5400_0001, 2, &[conn::field(1, outside.as_os_str().as_encoded_bytes())]), 1),
        (packet(0x5400_0002, 3, &[conn::field(1, b"s3")]), 1),
        (packet(0x5400_0003, 31, &[conn::field(1, b"../outside")]), 1),
    ];
    // Unknown operations, including a forged reply variant.
    for (n, op) in [0u8, 4, 5, 11, 12, 13, 14, 33, 64, 128, 254, 255].into_iter().enumerate() {
        hostile.push((packet(0x5500_0000 + n as u32, op, &[timeout(1000)]), 2));
    }
    for (bytes, code) in &hostile {
        let id = u32::from_be_bytes(bytes[..4].try_into().unwrap());
        assert_eq!(exchange(&served.raw, bytes), refusal(id, *code), "{bytes:?}");
        assert_eq!(tree.snapshot(), baseline, "{bytes:?}");
    }
    // The daemon-side client refuses an unbounded timeout before sending.
    for bad in [Duration::ZERO, Duration::from_millis(1001)] {
        assert_eq!(served.broker.freeze(bad).unwrap_err().code, 1);
    }
    assert_eq!(tree.snapshot(), baseline);

    // 2. A valid freeze and thaw succeed through the production client.
    tree.barrier("populated 1\nfrozen 1\n");
    assert_eq!(served.broker.freeze(Duration::from_secs(1)).unwrap(), None);
    assert_eq!(tree.freeze_file(), b"1");
    assert_eq!(served.broker.frozen(), Some(true));
    served.broker.thaw().unwrap();
    assert_eq!(tree.freeze_file(), b"0");
    assert_eq!(served.broker.frozen(), Some(false));

    // 3. A writer that misses the barrier is named and every writer resumes:
    // only populated, unfrozen session 3 is blamed, and the parent thaws.
    tree.barrier("populated 1\nfrozen 0\n");
    assert_eq!(served.broker.freeze(Duration::from_millis(5)).unwrap(), Some(3));
    assert_eq!(tree.freeze_file(), b"0");
    // A member replaces the retained group's name with a link outside. The
    // broker reads only the directory it holds, never the new name.
    fs::rename(tree.sessions().join("s3"), tree.sessions().join("retained")).unwrap();
    std::os::unix::fs::symlink("../outside", tree.sessions().join("s3")).unwrap();
    assert_eq!(served.broker.freeze(Duration::from_millis(5)).unwrap(), Some(3));
    assert_eq!(tree.freeze_file(), b"0");
    // With no identifiable writer the timeout is a typed refusal, still thawed.
    fs::write(tree.sessions().join("retained/cgroup.events"), "populated 1\nfrozen 1\n").unwrap();
    assert_eq!(served.broker.freeze(Duration::from_millis(5)).unwrap_err().code, 9);
    assert_eq!(tree.freeze_file(), b"0");

    // 4. Replaced control files are never followed, for freeze or thaw.
    let before = tree.snapshot();
    for leaf in ["cgroup.freeze", "cgroup.events"] {
        fs::remove_file(tree.sessions().join(leaf)).unwrap();
        std::os::unix::fs::symlink(format!("../outside/{leaf}"), tree.sessions().join(leaf)).unwrap();
    }
    assert_eq!(served.broker.freeze(Duration::from_secs(1)).unwrap_err().code, 12);
    assert_eq!(served.broker.thaw().unwrap_err().code, 12);
    fs::remove_file(tree.sessions().join("cgroup.freeze")).unwrap();
    fs::write(tree.sessions().join("cgroup.freeze"), b"0").unwrap();
    // Freeze wrote the barrier, could not read events through the link, and
    // thawed: the writers resume after the error.
    assert_eq!(served.broker.freeze(Duration::from_secs(1)).unwrap_err().code, 12);
    assert_eq!(tree.freeze_file(), b"0");
    assert_eq!(fs::read(tree.root.join("outside/cgroup.freeze")).unwrap(), b"0");
    assert_eq!(fs::read(tree.root.join("outside/sentinel")).unwrap(), SENTINEL);
    // Restored control files: the same channel freezes and thaws again.
    tree.barrier("populated 1\nfrozen 1\n");
    assert_eq!(served.broker.freeze(Duration::from_secs(1)).unwrap(), None);
    served.broker.thaw().unwrap();
    assert_eq!(tree.freeze_file(), b"0");
    let mut after = tree.snapshot();
    let mut expected = before;
    for map in [&mut after, &mut expected] {
        map.retain(|path, _| !path.starts_with("sessions/cgroup.events"));
    }
    assert_eq!(after, expected);
    drop(served.broker);
    drop(served.raw);
    served.worker.join().unwrap().unwrap();
}

/// Retained entries are member-influenced data at broker recovery. Links,
/// special files and invented names refuse before any kill or removal, and
/// nothing outside the parent is followed or changed.
/// Plants one hostile entry in the session parent.
type Plant = fn(&Path);

#[test]
fn rebase_broker_recovery_refuses_hostile_retained_entries() {
    let hostile: [(&str, Plant); 4] = [
        ("link", |parent| std::os::unix::fs::symlink("../outside", parent.join("s7")).unwrap()),
        ("fifo", |parent| {
            let path = std::ffi::CString::new(parent.join("s8").as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        }),
        ("socket", |parent| drop(std::os::unix::net::UnixListener::bind(parent.join("s9")).unwrap())),
        ("name", |parent| fs::create_dir(parent.join("..s10")).unwrap()),
    ];
    for (case, plant) in hostile {
        let tree = Tree::new();
        tree.barrier("populated 0\nfrozen 0\n");
        // Positive control: an empty parent recovers and reports no sessions.
        let served = serve(&tree, &[]);
        assert_eq!(served.broker.kill_sessions(None).unwrap(), 0, "{case}");
        plant(&tree.sessions());
        let baseline = tree.snapshot();
        assert_eq!(served.broker.kill_sessions(None).unwrap_err().code, 1, "{case}");
        assert_eq!(tree.snapshot(), baseline, "{case}");
        // The refusal kept the barrier released and the channel usable.
        assert_eq!(tree.freeze_file(), b"0", "{case}");
        tree.barrier("populated 0\nfrozen 1\n");
        assert_eq!(served.broker.freeze(Duration::from_secs(1)).unwrap(), None, "{case}");
        served.broker.thaw().unwrap();
        assert_eq!(tree.freeze_file(), b"0", "{case}");
        drop(served.broker);
        drop(served.raw);
        served.worker.join().unwrap().unwrap();
    }
}

/// Short and oversized frames end the private channel before any provider
/// call, even when an oversized frame starts with a valid freeze. No
/// replacement peer can reattach: the broker has no address to connect to.
#[test]
fn rebase_broker_closes_on_unbounded_frames_before_freezing() {
    for length in [1usize, 4, 8, 65537, 65561, 70000] {
        let tree = Tree::new();
        tree.barrier("populated 1\nfrozen 1\n");
        let baseline = tree.snapshot();
        let served = serve(&tree, &[]);
        let mut bytes = packet(0x5600_0001, 1, &[timeout(1000)]);
        bytes.resize(length, 0);
        assert_eq!(send(&served.raw, &bytes, SendFlags::NOSIGNAL).unwrap(), length);
        let error = served.worker.join().unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{length}");
        assert_eq!(tree.snapshot(), baseline, "{length}");
        assert_eq!(served.broker.freeze(Duration::from_secs(1)).unwrap_err().code, 12, "{length}");
        assert_eq!(tree.freeze_file(), b"0", "{length}");
    }
}
