//! Installed input-validation and restart/drain acceptance drivers.
//! Run only from a reviewed, main-built test bundle in an exclusively reserved
//! guest, with --ignored --test-threads=1. No checkout binary is started as root.
#![cfg(target_os = "linux")]
use smithers_machined::{
    broker::{
        cgroups::Cgroups,
        control::{self, SocketpairBroker},
        spawn::{InstalledAdmission, Processes},
        supervisor::Supervisor,
    },
    conn::{self, Frame},
    hooks::Hooks,
    lock::LockCx,
    rpc,
};
use std::{
    fs, io,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        process::CommandExt,
    },
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

const EXE: &str = "/opt/smithers/bin/smithers-machined";
const PARENT: &str = "/sys/fs/cgroup/smithers/sessions";

fn approved() {
    assert_eq!(rustix::process::geteuid().as_raw(), 0);
    approved_path(&std::env::current_exe().unwrap());
}
fn approved_path(installed: &Path) {
    let executable = fs::canonicalize(&installed).unwrap();
    assert_eq!(
        installed,
        executable.as_path(),
        "test executable may not use symlink ancestors"
    );
    assert!(
        executable.starts_with("/opt/smithers/bundle/tests"),
        "install the reviewed main-built test bundle; never run a checkout test as root"
    );
    for ancestor in executable.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        let m = fs::symlink_metadata(ancestor).unwrap();
        assert_eq!(m.uid(), 0);
        assert_eq!(m.mode() & 0o022, 0, "unprotected test bundle ancestor");
        assert!(!m.file_type().is_symlink());
    }
}
fn private_mounts() {
    // SAFETY: this subprocess alone owns the new namespace; no shared host
    // path is modified. Bind mounts disappear when the worker exits.
    unsafe {
        assert_eq!(
            libc::unshare(libc::CLONE_NEWNS),
            0,
            "{}",
            io::Error::last_os_error()
        );
        assert_eq!(
            libc::mount(
                std::ptr::null(),
                c"/".as_ptr(),
                std::ptr::null(),
                libc::MS_REC | libc::MS_PRIVATE,
                std::ptr::null()
            ),
            0
        );
    }
}
fn bind(source: &Path, target: &str) {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes()).unwrap();
    let target = std::ffi::CString::new(target).unwrap();
    // SAFETY: both strings live across mount; this is the private worker namespace.
    assert_eq!(
        unsafe {
            libc::mount(
                source.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND,
                std::ptr::null(),
            )
        },
        0,
        "{}",
        io::Error::last_os_error()
    );
}
fn file_overlay(
    target: &str,
    bytes: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
) -> tempfile::NamedTempFile {
    let file = tempfile::NamedTempFile::new().unwrap();
    fs::write(file.path(), bytes).unwrap();
    fs::set_permissions(file.path(), fs::Permissions::from_mode(mode)).unwrap();
    rustix::fs::chown(
        file.path(),
        Some(rustix::process::Uid::from_raw(uid)),
        Some(rustix::process::Gid::from_raw(gid)),
    )
    .unwrap();
    bind(file.path(), target);
    file
}
fn rpc_call(cx: &mut LockCx, method: u8, fields: &[Vec<u8>]) -> Vec<u8> {
    let frame = Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 42u32.to_be_bytes()),
                conn::field(2, conn::tagged(method, fields)),
            ],
        ),
    };
    let mut response = vec![];
    rpc::serve_one(&mut frame.encode().unwrap().as_slice(), &mut response, cx).unwrap();
    let frame = Frame::decode(&response).unwrap();
    conn::fields("response", &frame.payload[1..]).unwrap()[1]
        .1
        .to_vec()
}
fn text(s: &str) -> Vec<u8> {
    [(s.len() as u16).to_be_bytes().as_slice(), s.as_bytes()].concat()
}
fn member() -> Vec<u8> {
    conn::structure_bytes(&[
        conn::field(1, text("ben")),
        conn::field(2, 20001u32.to_be_bytes()),
    ])
}
fn open_fields() -> Vec<Vec<u8>> {
    vec![
        conn::field(1, member()),
        conn::field(2, [2]),
        conn::field(
            3,
            [
                vec![0, 3],
                text("/bin/sh"),
                text("-c"),
                text("id -u; exec sleep 120"),
            ]
            .concat(),
        ),
        conn::field(5, [1; 16]),
    ]
}
fn groups() -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(PARENT)
        .unwrap()
        .filter_map(|e| {
            let e = e.unwrap();
            e.file_type()
                .unwrap()
                .is_dir()
                .then(|| e.file_name().into_string().unwrap())
        })
        .collect();
    names.sort();
    names
}
fn changed_record(path: &str, login: &str, old: &str, new: &str) -> String {
    changed_field(path, login, 2, old, new)
}
fn changed_field(path: &str, login: &str, index: usize, old: &str, new: &str) -> String {
    let source = fs::read_to_string(path).unwrap();
    let mut found = false;
    let lines: Vec<_> = source
        .lines()
        .map(|line| {
            let mut fields: Vec<_> = line.split(':').collect();
            if fields[0] == login {
                assert_eq!(fields[index], old);
                fields[index] = new;
                assert!(!found);
                found = true;
            }
            fields.join(":")
        })
        .collect();
    assert!(found, "installed account fixture missing");
    format!("{}\n", lines.join("\n"))
}
fn provider_case(case: &str) {
    // Preserve installed host-produced bytes in a namespace-private tmpfs
    // directory. Positive launches consume this copy, never the live binding.
    let admission = tempfile::Builder::new()
        .prefix("trm07-admission-")
        .tempdir_in("/run/smithers")
        .unwrap();
    let binding_bytes = fs::read("/run/smithers/admission/u20001")
        .expect("provision Ben through the shipped host provider");
    let restore_binding = || {
        let p = admission.path().join("u20001");
        fs::write(&p, &binding_bytes).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        rustix::fs::chown(
            &p,
            Some(rustix::process::Uid::ROOT),
            Some(rustix::process::Gid::from_raw(20001)),
        )
        .unwrap();
    };
    restore_binding();
    bind(admission.path(), "/run/smithers/admission");

    let (server, client) = rustix::net::socketpair(
        rustix::net::AddressFamily::UNIX,
        rustix::net::SocketType::SEQPACKET,
        rustix::net::SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let thread = std::thread::spawn(move || {
        control::serve(
            &server,
            &mut Supervisor::new(Processes::new(Cgroups::open().unwrap(), InstalledAdmission)),
        )
        .unwrap()
    });
    let broker = Arc::new(SocketpairBroker::new(client).unwrap());
    let mut cx = LockCx::new(Hooks {
        sessions: broker.clone(),
        broker: broker.clone(),
        ..Default::default()
    });
    assert_eq!(
        rpc_call(
            &mut cx,
            16,
            &[conn::field(1, [vec![0, 1], member()].concat())]
        )[0],
        16
    );
    let before = groups();
    assert!(
        before.is_empty(),
        "reserve an empty guest; existing sessions are not owned by this driver"
    );
    assert!(
        Path::new("/run/smithers/admission/u20001").exists(),
        "provision Ben's one-use admission with the shipped host provider first"
    );

    let control = rpc_call(&mut cx, 6, &open_fields());
    assert_eq!(
        control[0], 6,
        "positive installed provider control: {control:?}"
    );
    let id = u32::from_be_bytes(
        conn::fields("result6", &control[1..]).unwrap()[0]
            .1
            .try_into()
            .unwrap(),
    );
    let until = Instant::now() + Duration::from_secs(5);
    let mut output = vec![];
    while !output.ends_with(b"20001\n") {
        for frame in smithers_machined::hooks::Sessions::poll(&*broker).unwrap() {
            if frame.stream == id && frame.payload.starts_with(&[1, 1]) {
                output.extend_from_slice(&frame.payload[2..]);
            }
        }
        assert!(
            Instant::now() < until,
            "positive process did not execute as Ben: {output:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(output, b"20001\n");
    assert_eq!(
        rpc_call(
            &mut cx,
            9,
            &[conn::field(
                1,
                conn::tagged(3, &[conn::field(1, id.to_be_bytes())])
            )]
        )[0],
        9
    );
    assert_eq!(groups(), before, "positive control failed to drain");
    restore_binding();
    let binding = "/run/smithers/admission/u20001";
    let mut overlay = None;
    let mut directory = None;
    match case {
        "missing environment" => {
            let d = tempfile::tempdir().unwrap();
            let fifo = d.path().join("env");
            let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o640) }, 0);
            bind(&fifo, "/run/smithers/env");
            directory = Some(d);
        }
        "environment mode" => {
            overlay = Some(file_overlay("/run/smithers/env", b"", 0o666, 0, 20000))
        }
        "environment owner" => {
            overlay = Some(file_overlay("/run/smithers/env", b"", 0o640, 20001, 20000))
        }
        "environment size" => {
            overlay = Some(file_overlay(
                "/run/smithers/env",
                &vec![b'x'; 262145],
                0o640,
                0,
                20000,
            ))
        }
        "missing credentials" => {
            directory = Some(tempfile::tempdir().unwrap());
            bind(
                directory.as_ref().unwrap().path(),
                "/run/smithers/admission",
            );
        }
        "credential mode" => overlay = Some(file_overlay(binding, b"{}", 0o666, 0, 20001)),
        "credential owner" => overlay = Some(file_overlay(binding, b"{}", 0o640, 20001, 20001)),
        "account uid" => {
            let passwd = changed_record("/etc/passwd", "ben", "20001", "20003");
            overlay = Some(file_overlay("/etc/passwd", passwd.as_bytes(), 0o644, 0, 0));
        }
        "account group" => {
            let group = changed_record("/etc/group", "team", "20000", "20003");
            overlay = Some(file_overlay("/etc/group", group.as_bytes(), 0o644, 0, 0));
        }
        "missing roster" => {
            assert_eq!(rpc_call(&mut cx, 16, &[conn::field(1, [0, 0])])[0], 16);
        }
        _ => panic!("unknown provider case"),
    }
    let response = rpc_call(&mut cx, 6, &open_fields());
    assert_eq!(response[0], 255, "{case}: {response:?}");
    let code = conn::fields("error", &response[1..]).unwrap()[0].1[0];
    assert_eq!(
        code,
        if case == "missing credentials" { 5 } else { 11 },
        "{case}"
    );
    assert_eq!(groups(), before, "refused input created a session cgroup");
    // Registry inspection crosses the same real private consumer after refusal.
    assert!(broker.registry().unwrap().is_empty());
    drop(cx);
    drop(broker);
    thread.join().unwrap();
    drop(overlay);
    drop(directory);
}

// Stop only the broker and daemon this driver started. Hold their kernel
// lifetime identities so a reused PID can never select an unrelated process.
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct OwnedBroker {
    child: Child,
    daemon: Option<(u32, u64)>,
}
impl OwnedBroker {
    fn start() -> Self {
        let child = Command::new(EXE)
            .arg("broker")
            .env("PATH", "/workspace")
            .env("HOME", "/workspace")
            .env("PYTHONPATH", "/workspace")
            .env("BASH_ENV", "/workspace/startup-canary")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            child,
            daemon: None,
        }
    }
    fn daemon(&mut self) -> u32 {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "installed broker refused positive startup control"
            );
            let children = fs::read_to_string(format!(
                "/proc/{}/task/{}/children",
                self.child.id(),
                self.child.id()
            ))
            .unwrap();
            for pid in children
                .split_whitespace()
                .map(|p| p.parse::<u32>().unwrap())
            {
                let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
                if status
                    .lines()
                    .any(|l| l == "Uid:\t19998\t19998\t19998\t19998")
                    && fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default()
                        == [EXE.as_bytes(), b"\0daemon\0"].concat()
                {
                    self.daemon = Some((
                        pid,
                        smithers_machined::broker::process_identity::start_ticks(pid).unwrap(),
                    ));
                    return pid;
                }
            }
            assert!(Instant::now() < until, "daemon did not drop uid");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for OwnedBroker {
    fn drop(&mut self) {
        let mut children = vec![];
        if let Ok(pids) = fs::read_to_string(format!(
            "/proc/{}/task/{}/children",
            self.child.id(),
            self.child.id()
        )) {
            for pid in pids
                .split_whitespace()
                .filter_map(|p| p.parse::<u32>().ok())
            {
                if let Ok(ticks) = smithers_machined::broker::process_identity::start_ticks(pid) {
                    children.push((pid, ticks));
                }
            }
        }
        if let Some(daemon) = self.daemon {
            children.push(daemon);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        for (pid, ticks) in children {
            if smithers_machined::broker::process_identity::start_ticks(pid).ok() == Some(ticks) {
                // SAFETY: this was our broker's own child at the held lifetime.
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        }
    }
}
fn observe_daemon(pid: u32) {
    let environment = fs::read(format!("/proc/{pid}/environ")).unwrap();
    let mut env: Vec<_> = environment
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .collect();
    env.sort();
    assert_eq!(
        env,
        vec![
            b"HOME=/var/lib/smithers-machined".as_slice(),
            b"PATH=/usr/bin:/bin".as_slice()
        ]
    );
    assert_eq!(
        fs::read_link(format!("/proc/{pid}/exe")).unwrap(),
        Path::new(EXE)
    );
    assert_eq!(
        fs::read_link(format!("/proc/{pid}/cwd")).unwrap(),
        Path::new("/")
    );
    let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    assert!(status
        .lines()
        .any(|l| l == "Gid:\t19998\t19998\t19998\t19998"));
    assert!(status.lines().any(|l| l.trim_end() == "Groups:\t20000"));
}

fn startup_mutation(case: &str) -> (Option<tempfile::NamedTempFile>, Option<tempfile::TempDir>) {
    let mut overlay = None;
    let mut directory = None;
    match case {
        "ancestor mode" => {
            let d = tempfile::tempdir().unwrap();
            fs::set_permissions(d.path(), fs::Permissions::from_mode(0o777)).unwrap();
            bind(d.path(), "/opt/smithers/bin");
            directory = Some(d);
        }
        "ancestor symlink" => {
            let d = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink("/workspace", d.path().join("bin")).unwrap();
            bind(d.path(), "/opt/smithers");
            directory = Some(d);
        }
        "daemon account uid" => {
            overlay = Some(file_overlay(
                "/etc/passwd",
                changed_record("/etc/passwd", "machined", "19998", "20003").as_bytes(),
                0o644,
                0,
                0,
            ));
        }
        "daemon account gid" | "daemon account home" | "daemon account shell" => {
            let (index, old, new) = match case {
                "daemon account gid" => (3, "20000", "0"),
                "daemon account home" => (5, "/nonexistent", "/workspace"),
                "daemon account shell" => (6, "/usr/sbin/nologin", "/workspace/sh"),
                _ => unreachable!(),
            };
            overlay = Some(file_overlay(
                "/etc/passwd",
                changed_field("/etc/passwd", "machined", index, old, new).as_bytes(),
                0o644,
                0,
                0,
            ));
        }
        "daemon team group" => {
            overlay = Some(file_overlay(
                "/etc/group",
                changed_record("/etc/group", "team", "20000", "20003").as_bytes(),
                0o644,
                0,
                0,
            ));
        }
        "executable bytes" => {
            overlay = Some(file_overlay(
                EXE,
                b"not the installed executable\n",
                0o755,
                0,
                0,
            ));
        }
        "executable mode" => {
            overlay = Some(file_overlay(EXE, &fs::read(EXE).unwrap(), 0o777, 0, 0))
        }
        "executable setuid" => {
            overlay = Some(file_overlay(EXE, &fs::read(EXE).unwrap(), 0o4755, 0, 0))
        }
        "executable owner" => {
            overlay = Some(file_overlay(
                EXE,
                &fs::read(EXE).unwrap(),
                0o755,
                20001,
                20001,
            ))
        }
        "executable symlink" => {
            let d = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(
                "/workspace/startup-canary",
                d.path().join("smithers-machined"),
            )
            .unwrap();
            bind(d.path(), "/opt/smithers/bin");
            directory = Some(d);
        }
        "boot mode" => {
            overlay = Some(file_overlay(
                "/run/smithers/machined/boot",
                &fs::read("/run/smithers/machined/boot").unwrap(),
                0o644,
                19998,
                19998,
            ))
        }
        "boot owner" => {
            overlay = Some(file_overlay(
                "/run/smithers/machined/boot",
                &fs::read("/run/smithers/machined/boot").unwrap(),
                0o400,
                20001,
                20001,
            ))
        }
        "boot malformed" => {
            overlay = Some(file_overlay(
                "/run/smithers/machined/boot",
                b"PATH=/workspace\n",
                0o400,
                19998,
                19998,
            ))
        }
        "cgroup parent" => {
            let d = tempfile::tempdir().unwrap();
            bind(d.path(), PARENT);
            directory = Some(d);
        }
        "environment and restart" => (),
        _ => panic!("unknown startup case"),
    }
    (overlay, directory)
}

fn startup_case(case: &str) {
    let pinned = fs::File::open(EXE).unwrap();
    let (mut overlay, mut directory) = if case.starts_with("restart ") {
        (None, None)
    } else {
        startup_mutation(case)
    };
    use std::os::fd::AsRawFd;
    let held = rustix::io::fcntl_dupfd_cloexec(&pinned, 10).unwrap();
    let mut command = Command::new(format!("/proc/self/fd/{}", held.as_raw_fd()));
    command
        .arg("broker")
        .env("PATH", "/workspace")
        .env("HOME", "/workspace")
        .env("PYTHONPATH", "/workspace")
        .env("BASH_ENV", "/workspace/startup-canary")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Keep the reviewed installed inode available for exec; no replacement
    // bytes are loaded as root, even when a test substitutes the startup path.
    unsafe {
        command.pre_exec(move || {
            let flags = libc::fcntl(held.as_raw_fd(), libc::F_GETFD);
            if flags < 0
                || libc::fcntl(held.as_raw_fd(), libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut broker = OwnedBroker {
        child: command.spawn().unwrap(),
        daemon: None,
    };
    drop(command);
    if case != "environment and restart" && !case.starts_with("restart ") {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = broker.child.try_wait().unwrap() {
                assert!(!status.success(), "{case}");
                break;
            }
            assert!(
                Instant::now() < until,
                "{case}: refused startup kept running"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    } else {
        let pid = broker.daemon();
        observe_daemon(pid);
        // Retained descendants must be drained by the real restart barrier.
        // Provision the child through OS primitives, never branch root code.
        let retained = format!("{PARENT}/s2147483646");
        fs::create_dir(&retained).unwrap();
        let mut child = Command::new("/bin/sleep");
        child.arg("120");
        unsafe {
            child.pre_exec(move || {
                fs::write(
                    format!("{PARENT}/s2147483646/cgroup.procs"),
                    std::process::id().to_string(),
                )?;
                rustix::thread::set_thread_groups(&[rustix::process::Gid::from_raw(20000)])?;
                rustix::thread::set_thread_res_gid(
                    rustix::process::Gid::from_raw(20001),
                    rustix::process::Gid::from_raw(20001),
                    rustix::process::Gid::from_raw(20001),
                )?;
                rustix::thread::set_thread_res_uid(
                    rustix::process::Uid::from_raw(20001),
                    rustix::process::Uid::from_raw(20001),
                    rustix::process::Uid::from_raw(20001),
                )?;
                Ok(())
            });
        }
        let mut child = OwnedChild(child.spawn().unwrap());
        assert!(fs::read_to_string(format!("{retained}/cgroup.events"))
            .unwrap()
            .lines()
            .any(|l| l == "populated 1"));
        if let Some(mutation) = case.strip_prefix("restart ") {
            (overlay, directory) = startup_mutation(mutation);
        }
        unsafe {
            assert_eq!(libc::kill(pid as i32, libc::SIGKILL), 0);
        }
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if child.0.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                Instant::now() < until,
                "restart did not drain retained child"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!Path::new(&format!("/proc/{}", child.0.id())).exists());
        assert!(!Path::new(&retained).exists());
        broker.daemon = None;
        if case.starts_with("restart ") {
            loop {
                if let Some(status) = broker.child.try_wait().unwrap() {
                    assert!(!status.success());
                    break;
                }
                assert!(
                    Instant::now() < until,
                    "untrusted retained startup was admitted"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        } else {
            let replacement = loop {
                let next = broker.daemon();
                if next != pid {
                    break next;
                }
                assert!(Instant::now() < until, "daemon was not replaced");
                std::thread::sleep(Duration::from_millis(10));
            };
            assert_ne!(pid, replacement);
            observe_daemon(replacement);
            assert!(groups().is_empty(), "replacement admitted before drainage");
        }
    }
    drop(broker);
    drop(overlay);
    drop(directory);
}

// The outside-run receipt uses the production Go session client against the
// installed daemon, plus a real SO_PEERCRED caller created by the reviewed Go
// test bundle. Reuse that harness rather than another host protocol client.
fn outside_run_case() {
    let admission = tempfile::Builder::new()
        .prefix("trm07-outside-")
        .tempdir_in("/run/smithers")
        .unwrap();
    for uid in [19999, 20001, 20002] {
        let source = format!("/run/smithers/admission/u{uid}");
        let target = admission.path().join(format!("u{uid}"));
        fs::copy(&source, &target)
            .expect("provision native accounts through the shipped host provider");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        rustix::fs::chown(
            &target,
            Some(rustix::process::Uid::ROOT),
            Some(rustix::process::Gid::from_raw(uid)),
        )
        .unwrap();
    }
    bind(admission.path(), "/run/smithers/admission");
    let executable = Path::new("/opt/smithers/bundle/tests/machined.test");
    approved_path(executable);
    let mut broker = OwnedBroker::start();
    broker.daemon();
    assert!(
        Command::new(executable)
            .args([
                "-test.run",
                "^TestSessionProductionOutsideRun$",
                "-test.v",
                "-test.timeout",
                "2m"
            ])
            .env("SMITHERS_REQUIRE_SESSION_ACCEPTANCE", "1")
            .status()
            .unwrap()
            .success(),
        "installed Go outside-run acceptance"
    );
}

#[test]
#[ignore = "reviewed installed test bundle, isolated guest with real accounts and cgroup v2"]
#[allow(non_snake_case)]
fn TestSessionInstalledRootInputMatrices() {
    approved();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/run/smithers/machined/broker.lock")
        .expect("installed broker lock required");
    rustix::fs::flock(&lock, rustix::fs::FlockOperation::NonBlockingLockExclusive)
        .expect("reserve an inactive guest; another broker owns this install");
    assert!(
        groups().is_empty(),
        "reserve an empty guest; existing sessions are not owned by this driver"
    );
    drop(lock);
    // Reuse the existing production private-envelope matrix from the reviewed
    // installed lib-test bundle rather than introducing another wire harness.
    let raw = Path::new("/opt/smithers/bundle/tests/smithers_machined");
    approved_path(raw);
    assert!(
        Command::new(raw)
            .args([
                "--exact",
                "broker::ssh_acceptance::TestSSHRawPrivilegedBrokerEnvelopes",
                "--ignored",
                "--nocapture",
                "--test-threads=1"
            ])
            .status()
            .unwrap()
            .success(),
        "installed private broker-envelope matrix"
    );
    // Each worker gets a private mount namespace and its own broker. An active
    // install's broker lock prevents a second startup; reserve the guest first.
    for case in [
        "missing environment",
        "environment mode",
        "environment owner",
        "environment size",
        "missing credentials",
        "credential mode",
        "credential owner",
        "account uid",
        "account group",
        "missing roster",
        "ancestor mode",
        "ancestor symlink",
        "daemon account uid",
        "daemon account gid",
        "daemon account home",
        "daemon account shell",
        "daemon team group",
        "executable bytes",
        "executable mode",
        "executable setuid",
        "executable owner",
        "executable symlink",
        "boot mode",
        "boot owner",
        "boot malformed",
        "cgroup parent",
        "environment and restart",
        "outside registered run",
        "restart ancestor mode",
        "restart ancestor symlink",
        "restart daemon account uid",
        "restart daemon account gid",
        "restart daemon account home",
        "restart daemon account shell",
        "restart daemon team group",
        "restart executable bytes",
        "restart executable mode",
        "restart executable setuid",
        "restart executable symlink",
        "restart executable owner",
        "restart boot mode",
        "restart boot owner",
        "restart boot malformed",
        "restart cgroup parent",
    ] {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "installed_input_worker",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("SMITHERS_INSTALLED_INPUT_CASE", case)
            .status()
            .unwrap();
        assert!(status.success(), "installed input case: {case}");
    }
}
#[test]
#[ignore = "subprocess of the installed matrix driver"]
fn installed_input_worker() {
    approved();
    private_mounts();
    let case =
        std::env::var("SMITHERS_INSTALLED_INPUT_CASE").expect("use the installed matrix driver");
    if case == "outside registered run" {
        outside_run_case();
    } else if case.starts_with("ancestor ")
        || case.starts_with("daemon ")
        || case.starts_with("executable")
        || case.starts_with("boot")
        || case == "cgroup parent"
        || case == "environment and restart"
        || case.starts_with("restart ")
    {
        startup_case(&case);
    } else {
        provider_case(&case);
    }
}
