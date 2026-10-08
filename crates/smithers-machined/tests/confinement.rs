#![cfg(target_os = "linux")]
use rustix::fs::{Mode, OFlags};
use smithers_machined::confine;
use std::{
    fs::{self, File},
    os::unix::{fs::symlink, net::UnixListener},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        assert_ne!(
            rustix::process::geteuid().as_raw(),
            0,
            "working-copy tests never run as root"
        );
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir().join(format!("machined-confine-{name}"));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn paths_and_special_files_are_confined_without_blocking() {
    let fixture = Fixture::new();
    let workspace = fixture.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(fixture.0.join("sentinel"), b"outside sentinel").unwrap();
    fs::write(workspace.join("regular"), b"independent fixture bytes").unwrap();
    fs::create_dir(workspace.join("directory")).unwrap();
    symlink("../sentinel", workspace.join("leaf")).unwrap();
    symlink(&fixture.0, workspace.join("escape")).unwrap();
    let _socket = UnixListener::bind(workspace.join("socket")).unwrap();
    assert!(Command::new("/usr/bin/mkfifo")
        .arg(workspace.join("fifo"))
        .status()
        .unwrap()
        .success());
    let root = File::open(&workspace).unwrap();
    if rustix::process::geteuid().as_raw() == 19998 {
        confine::probe(&root).unwrap();
    } else {
        assert_eq!(
            confine::probe(&root).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }
    for path in [
        "../sentinel",
        "/etc/passwd",
        "src/../../sentinel",
        "escape/sentinel",
        "a//b",
        "a/./b",
        "",
    ] {
        assert!(confine::parent(&root, path).is_err(), "{path}");
    }
    for path in ["leaf", "fifo", "socket", "directory"] {
        let start = Instant::now();
        let (parent, name) = confine::parent(&root, path).unwrap();
        let result = confine::open(&parent, &name, OFlags::RDONLY, Mode::empty())
            .and_then(|mut file| confine::read(&mut file, 1024));
        assert!(result.is_err(), "{path}");
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "blocked on {path}"
        );
    }
    let mut regular = confine::open(&root, "regular", OFlags::RDONLY, Mode::empty()).unwrap();
    assert_eq!(
        confine::read(&mut regular, 1024).unwrap(),
        b"independent fixture bytes"
    );
    assert_eq!(
        fs::read(fixture.0.join("sentinel")).unwrap(),
        b"outside sentinel"
    );
}
#[test]
fn directory_symlink_swaps_never_reach_outside_sentinel() {
    let fixture = Fixture::new();
    let workspace = fixture.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(workspace.join("d")).unwrap();
    fs::write(workspace.join("d/f"), b"inside").unwrap();
    let outside = fixture.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("f"), b"outside sentinel").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let race = workspace.clone();
    let writer = thread::spawn(move || {
        while !flag.load(Ordering::Relaxed) {
            fs::rename(race.join("d"), race.join("parked")).unwrap();
            symlink(&outside, race.join("d")).unwrap();
            thread::yield_now();
            fs::remove_file(race.join("d")).unwrap();
            fs::rename(race.join("parked"), race.join("d")).unwrap();
        }
    });
    let root = File::open(&workspace).unwrap();
    for _ in 0..10_000 {
        if let Ok((parent, name)) = confine::parent(&root, "d/f") {
            if let Ok(mut file) = confine::open(&parent, &name, OFlags::RDONLY, Mode::empty()) {
                assert_eq!(confine::read(&mut file, 100).unwrap(), b"inside");
            }
        }
    }
    stop.store(true, Ordering::Relaxed);
    writer.join().unwrap();
    assert_eq!(
        fs::read(fixture.0.join("outside/f")).unwrap(),
        b"outside sentinel"
    );
}

#[test]
fn document_disk_requires_daemon_identity_and_preserves_typed_invalid_errors() {
    use smithers_machined::doc::{
        disk::{Disk, LinuxDisk, Versions},
        Error,
    };
    use std::os::unix::fs::PermissionsExt;
    struct NoVersions;
    impl Versions for NoVersions {
        fn outside(
            &mut self,
            _: &str,
            _: &[u8],
            _: &str,
        ) -> smithers_machined::doc::Result<String> {
            panic!("read-only request records no version")
        }
        fn before_write(&mut self, _: &str, _: Option<&str>) -> smithers_machined::doc::Result<()> {
            panic!("read-only request prepares no write")
        }
        fn own_write(
            &mut self,
            _: &str,
            _: &[u8],
            _: u32,
            _: Option<&str>,
        ) -> smithers_machined::doc::Result<()> {
            panic!("read-only request writes nothing")
        }
    }
    let fixture = Fixture::new();
    let workspace = fixture.0.join("workspace");
    let store = fixture.0.join("state");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&store).unwrap();
    fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(workspace.join("file"), b"document bytes").unwrap();
    fs::create_dir(workspace.join("directory")).unwrap();
    let disk = LinuxDisk::new(
        File::open(&workspace).unwrap(),
        File::open(&store).unwrap(),
        NoVersions,
    );
    if rustix::process::geteuid().as_raw() != 19998 {
        assert!(matches!(disk, Err(Error::Unsupported)));
        assert_eq!(fs::read(workspace.join("file")).unwrap(), b"document bytes");
        assert_eq!(fs::read_dir(&store).unwrap().count(), 0);
        return;
    }
    let mut disk = disk.unwrap();
    assert_eq!(disk.read("file").unwrap(), Some(b"document bytes".to_vec()));
    assert_eq!(disk.read("missing").unwrap(), None);
    assert_eq!(disk.read("../file"), Err(Error::Invalid));
    assert_eq!(disk.read("directory"), Err(Error::Invalid));
}

#[test]
fn boot_descriptor_requires_private_single_link_regular_authority() {
    use smithers_machined::boot::{Boot, Topology};
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let path = fixture.0.join("boot");
    let bytes = format!(
        "boot_id={}\nrelay_secret={}\ncredential=fixture-token\ntopology=relay\n",
        "04".repeat(16),
        "09".repeat(32)
    );
    fs::write(&path, &bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    assert_eq!(
        Boot::parse(bytes.as_bytes()).unwrap().topology,
        Topology::Relay
    );
    if rustix::process::geteuid().as_raw() == 19998 {
        assert_eq!(
            Boot::read(File::open(&path).unwrap()).unwrap().topology,
            Topology::Relay
        );
    } else {
        assert!(Boot::read(File::open(&path).unwrap()).is_err());
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
    assert!(Boot::read(File::open(&path).unwrap()).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    fs::hard_link(&path, fixture.0.join("alias")).unwrap();
    assert!(Boot::read(File::open(&path).unwrap()).is_err());
    assert!(Boot::read(File::open(&fixture.0).unwrap()).is_err());
}

#[test]
fn production_broker_and_daemon_refuse_branch_supplied_bootstrap_before_io() {
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::{net::UnixStream, process::CommandExt};
    let fixture = Fixture::new();
    // The installed identities are essential, not environment-selected flags.
    assert_ne!(rustix::process::geteuid().as_raw(), 19998);
    let marker = fixture.0.join("executed");
    let executable = fixture.0.join("git");
    fs::write(
        &executable,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        fixture.0.join("boot.json"),
        b"{\"uid\":19998,\"ready\":true}",
    )
    .unwrap();
    fs::write(fixture.0.join("sentinel"), b"unchanged").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    for (entry, inherited) in [
        ("broker", false),
        ("daemon", false),
        ("broker", true),
        ("daemon", true),
    ] {
        // A caller can supply descriptors as well as environment variables.
        // Neither substitutes for the installed kernel identity. Queue literal
        // hostile bytes and observe that the executable never answers them.
        let (socket, mut peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let source: OwnedFd = rustix::io::fcntl_dupfd_cloexec(&socket, 10).unwrap();
        drop(socket);
        peer.write_all(b"branch-controlled broker request").unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_smithers-machined"));
        command
            .arg(entry)
            .current_dir(&fixture.0)
            .env("PATH", &fixture.0)
            .env("SMITHERS_MACHINED_BOOT", fixture.0.join("boot.json"))
            .env("SMITHERS_MACHINED_EXECUTABLE", &executable)
            .env(
                "SMITHERS_MACHINED_HOST",
                listener.local_addr().unwrap().to_string(),
            )
            .env("SMITHERS_MACHINED_UID", "19998");
        if inherited {
            let fd = source.as_raw_fd();
            // SAFETY: the child only duplicates a held descriptor before exec.
            // The parent keeps it alive until spawn and wait have completed.
            unsafe {
                command.pre_exec(move || {
                    for destination in [3, 4, 5] {
                        if libc::dup2(fd, destination) < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                    }
                    Ok(())
                });
            }
        }
        let output = command.output().unwrap();
        drop(command);
        drop(source);
        let mut response = [0; 1];
        // Linux reports unread queued input as reset on close; either reset or
        // EOF is valid, but a response byte would expose premature dispatch.
        match peer.read(&mut response) {
            Ok(0) => (),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
            result => panic!("unexpected pre-identity socket response: {result:?}"),
        }
        assert_eq!(output.status.code(), Some(1), "{entry}");
        assert_eq!(
            output.stderr, b"{\"error\":{\"code\":\"unavailable\"}}\n",
            "{entry}"
        );
        assert!(output.stdout.is_empty());
        assert!(listener.accept().is_err());
        assert!(!marker.exists());
        assert_eq!(fs::read(fixture.0.join("sentinel")).unwrap(), b"unchanged");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 3);
    }
}

#[test]
fn creating_parents_refuses_symlinks_and_invalid_paths_and_preserves_existing_modes() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("real")).unwrap();
    fs::set_permissions(fixture.0.join("real"), fs::Permissions::from_mode(0o750)).unwrap();
    symlink("real", fixture.0.join("link")).unwrap();
    symlink("missing", fixture.0.join("dangling")).unwrap();
    let root = File::open(&fixture.0).unwrap();
    for path in [
        "link/new/file",
        "dangling/new/file",
        "../new/file",
        "new/../../file",
        "/new/file",
        "new//file",
        "new/./file",
        "",
    ] {
        assert!(confine::create_parent(&root, path).is_err(), "{path}");
    }
    assert!(!fixture.0.join("new").exists());
    assert!(!fixture.0.join("real/new").exists());
    assert!(!fixture.0.join("missing").exists());
    let (parent, name) = confine::create_parent(&root, "real/deep/file").unwrap();
    assert_eq!(name, "file");
    assert_eq!(
        parent.metadata().unwrap().ino(),
        fs::metadata(fixture.0.join("real/deep")).unwrap().ino()
    );
    assert_eq!(
        fs::metadata(fixture.0.join("real")).unwrap().mode() & 0o7777,
        0o750
    );
    assert_eq!(
        confine::create_parent(&root, "flat")
            .unwrap()
            .0
            .metadata()
            .unwrap()
            .ino(),
        root.metadata().unwrap().ino()
    );
}
