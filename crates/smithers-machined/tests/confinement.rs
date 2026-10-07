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
    confine::probe(&root).unwrap();
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
fn document_disk_reuses_boundary_and_preserves_typed_invalid_errors() {
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
    let mut disk = LinuxDisk::new(
        File::open(&workspace).unwrap(),
        File::open(&store).unwrap(),
        NoVersions,
    )
    .unwrap();
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
    fs::write(&path, bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    assert_eq!(
        Boot::read(File::open(&path).unwrap()).unwrap().topology,
        Topology::Relay
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
    assert!(Boot::read(File::open(&path).unwrap()).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    fs::hard_link(&path, fixture.0.join("alias")).unwrap();
    assert!(Boot::read(File::open(&path).unwrap()).is_err());
    assert!(Boot::read(File::open(&fixture.0).unwrap()).is_err());
}
