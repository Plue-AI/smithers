//! Unprivileged namespace evidence for the shipped executable. The only fake
//! provider is the empty session census, shared with journey rehearsals.
//! Busy shared runners can set TMPDIR=/dev/shm to isolate syncfs from unrelated
//! builds. These are daemon-restart assertions; persistent disk and VM faults
//! still require the reference guest.
#![cfg(target_os = "linux")]
use smithers_machined::conn::{self, Frame};
use std::{
    fs,
    io::{BufRead, BufReader},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    process::{Child, Command, Stdio},
    time::Duration,
};
struct Guest {
    child: Child,
    root: tempfile::TempDir,
    head: [u8; 20],
}
impl Drop for Guest {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Host {
    stream: TcpStream,
    store: tempfile::TempDir,
    bundle: Vec<u8>,
    captured: Option<[u8; 20]>,
    acknowledge: bool,
    verify_versions: bool,
    seen: Vec<(u64, [u8; 16])>,
    events: Vec<conn::Durable>,
    response_id: u32,
}
fn guest() -> (Guest, Host) {
    guest_with_fault(None)
}
fn guest_with_fault(fault: Option<&str>) -> (Guest, Host) {
    guest_with_history(fault, 0)
}
fn guest_with_history(fault: Option<&str>, operations: usize) -> (Guest, Host) {
    let init = std::env::var("SMITHERS_NAMESPACE_INIT")
        .expect("build rehearsal_daemon and set SMITHERS_NAMESPACE_INIT");
    let root = tempfile::tempdir().unwrap();
    for dir in ["workspace", "outside", "state", "run", "run/machined"] {
        fs::create_dir(root.path().join(dir)).unwrap();
    }
    fs::set_permissions(root.path().join("state"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(root.path().join("outside/f"), b"outside protected sentinel").unwrap();
    fs::write(root.path().join("workspace/.gitignore"), b"d\nswap\n").unwrap();
    let jj = std::env::var("SMITHERS_TEST_JJ").unwrap_or("jj".into());
    let mut initialize = Command::new(&jj);
    if operations > 0 {
        initialize.args([
            "--config",
            "debug.operation-timestamp=\"2000-01-01T00:00:00Z\"",
        ]);
    }
    let out = initialize
        .args(["git", "init"])
        .arg(root.path().join("workspace"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    for index in 0..operations {
        let output = Command::new(&jj)
            .args([
                "--config",
                "debug.operation-timestamp=\"2000-01-01T00:00:00Z\"",
                "describe",
                "-m",
                &format!("history {index}"),
            ])
            .current_dir(root.path().join("workspace"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fs::write(root.path().join("workspace/file"), b"outside sentinel").unwrap();
    let output = Command::new(&jj)
        .args(["log", "-r", "@", "--no-graph", "-T", "commit_id"])
        .current_dir(root.path().join("workspace"))
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = std::str::from_utf8(&output.stdout).unwrap();
    let head: [u8; 20] = (0..20)
        .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap())
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    fs::write(root.path().join("run/machined/boot"), format!("boot_id={}\nrelay_secret={}\ncredential=namespace-machine\ntopology=relay\nitem_number=0\n", "04".repeat(16), "09".repeat(32))).unwrap();
    fs::set_permissions(
        root.path().join("run/machined/boot"),
        fs::Permissions::from_mode(0o400),
    )
    .unwrap();
    let store = tempfile::tempdir().unwrap();
    assert!(Command::new("/usr/bin/git")
        .args(["init", "--bare"])
        .arg(store.path())
        .output()
        .unwrap()
        .status
        .success());
    // The host already owns the head it sent at boot, just as the
    // composed machine registry does. A no-op capture need not resend it.
    let hex: String = head.iter().map(|b| format!("{b:02x}")).collect();
    let workspace = root.path().join("workspace");
    let bundle = store.path().join("seed.bundle");
    for (directory, args) in [
        (
            &workspace,
            vec!["update-ref", "refs/smithers/test-seed", hex.as_str()],
        ),
        (
            &workspace,
            vec![
                "bundle",
                "create",
                bundle.to_str().unwrap(),
                "refs/smithers/test-seed",
            ],
        ),
        (
            &store.path().to_path_buf(),
            vec!["bundle", "unbundle", bundle.to_str().unwrap()],
        ),
    ] {
        let output = Command::new("/usr/bin/git")
            .arg("-C")
            .arg(directory)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let binary = env!("CARGO_BIN_EXE_smithers-machined");
    let mut command = Command::new("bwrap");
    command
        .args([
            "--tmpfs",
            "/",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind",
            "/lib64",
            "/lib64",
            "--symlink",
            "usr/bin",
            "/bin",
            "--ro-bind",
            "/etc",
            "/etc",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--unshare-user",
            "--uid",
            "19998",
            "--gid",
            "19998",
            "--die-with-parent",
            "--dir",
            "/opt/smithers/bin",
            "--ro-bind",
            binary,
            "/opt/smithers/bin/smithers-machined",
            "--ro-bind",
            &init,
            "/init",
            "--bind",
        ])
        .arg(root.path().join("workspace"))
        .arg("/workspace")
        .arg("--bind")
        .arg(root.path().join("outside"))
        .arg("/outside")
        .arg("--dir")
        .arg("/var/lib")
        .arg("--bind")
        .arg(root.path().join("state"))
        .arg("/var/lib/smithers-machined")
        .arg("--dir")
        .arg("/run")
        .arg("--bind")
        .arg(root.path().join("run"))
        .arg("/run/smithers")
        .args(["--chdir", "/workspace", "--", "/init", "--installed"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .stdout(Stdio::piped());
    if let Some(fault) = fault {
        command.arg(fault);
    }
    let mut child = command.spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port: u16 = line.trim().parse().expect("namespace init relay port");
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    authenticate(&mut stream);
    (
        Guest { child, root, head },
        Host {
            stream,
            store,
            bundle: Vec::new(),
            captured: None,
            acknowledge: true,
            verify_versions: false,
            seen: Vec::new(),
            events: Vec::new(),
            response_id: 0,
        },
    )
}
fn authenticate(stream: &mut TcpStream) {
    stream.set_nodelay(true).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let challenge = Frame::read(stream).unwrap();
    let fields = conn::fields("challenge", &challenge.payload[1..]).unwrap();
    let boot = fields[2].1.try_into().unwrap();
    let nonce = fields[3].1.try_into().unwrap();
    Frame {
        kind: 0,
        stream: 0,
        payload: conn::tagged(
            2,
            &[
                conn::field(1, conn::PROTOCOL.to_be_bytes()),
                conn::field(2, conn::host_mac(&[9; 32], conn::PROTOCOL, &boot, &nonce)),
            ],
        ),
    }
    .write(stream)
    .unwrap();
    assert_eq!(Frame::read(stream).unwrap().payload[0], 3);
    Frame {
        kind: 0,
        stream: 0,
        payload: conn::tagged(4, &[]),
    }
    .write(stream)
    .unwrap();
}
fn call(host: &mut Host, method: u8, fields: &[Vec<u8>]) -> Vec<u8> {
    exchange(host, method, fields, false)
}
fn exchange(host: &mut Host, method: u8, fields: &[Vec<u8>], stop_at_event: bool) -> Vec<u8> {
    exchange_result(host, method, fields, stop_at_event).unwrap()
}
fn exchange_result(
    host: &mut Host,
    method: u8,
    fields: &[Vec<u8>],
    stop_at_event: bool,
) -> std::io::Result<Vec<u8>> {
    Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 41u32.to_be_bytes()),
                conn::field(2, conn::tagged(method, fields)),
            ],
        ),
    }
    .write(&mut host.stream)?;
    receive_reply(host, stop_at_event)
}
fn receive_reply(host: &mut Host, stop_at_event: bool) -> std::io::Result<Vec<u8>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "request never completed"
        );
        let f = Frame::read(&mut host.stream).map_err(std::io::Error::other)?;
        if f.kind == 6 {
            let payload = match f.payload[0] {
                1 => {
                    host.bundle.extend_from_slice(&f.payload[2..]);
                    [
                        vec![6],
                        ((f.payload.len() - 2) as u32).to_be_bytes().to_vec(),
                    ]
                    .concat()
                }
                2 => {
                    let path = host.store.path().join("incoming.bundle");
                    fs::write(&path, &host.bundle).unwrap();
                    let output = Command::new("/usr/bin/git")
                        .arg("-C")
                        .arg(host.store.path())
                        .args(["bundle", "unbundle"])
                        .arg(&path)
                        .output()
                        .unwrap();
                    assert!(
                        output.status.success(),
                        "{}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                    host.bundle.clear();
                    vec![7]
                }
                _ => panic!("unexpected object frame"),
            };
            Frame {
                kind: 6,
                stream: f.stream,
                payload,
            }
            .write(&mut host.stream)?;
        }
        if f.kind == 2 && f.payload[0] == 1 {
            let event = conn::Durable::decode(&f.payload).unwrap();
            if host.verify_versions && event.event[0] == 1 {
                let fields = conn::fields("burst", &event.event[1..]).unwrap();
                let commit = fields.iter().find(|(tag, _)| *tag == 4).unwrap().1;
                let hex: String = commit.iter().map(|b| format!("{b:02x}")).collect();
                let verified = Command::new("/usr/bin/git")
                    .arg("-C")
                    .arg(host.store.path())
                    .args(["cat-file", "-e", &format!("{hex}^{{commit}}")])
                    .output()
                    .unwrap();
                assert!(
                    verified.status.success(),
                    "burst event preceded its versions objects"
                );
            }
            host.seen.push((event.seq, event.id));
            if let Some(head) = event.captured_head() {
                let hex: String = head.iter().map(|b| format!("{b:02x}")).collect();
                let output = Command::new("/usr/bin/git")
                    .arg("-C")
                    .arg(host.store.path())
                    .args(["cat-file", "-e", &format!("{hex}^{{commit}}")])
                    .output()
                    .unwrap();
                assert!(output.status.success(), "event preceded its objects");
                host.captured = Some(head);
            }
            if host.acknowledge || event.captured_head().is_none() {
                Frame {
                    kind: 2,
                    stream: 0,
                    payload: conn::tagged(
                        3,
                        &[conn::field(1, event.seq.to_be_bytes()), conn::field(2, [1])],
                    ),
                }
                .write(&mut host.stream)?;
            }
            let captured = event.captured_head().is_some();
            host.events.push(event);
            if stop_at_event && captured {
                return Ok(f.payload);
            }
        }
        if f.kind == 1 {
            host.response_id = u32::from_be_bytes(
                conn::fields("response", &f.payload[1..]).unwrap()[0]
                    .1
                    .try_into()
                    .unwrap(),
            );
            return Ok(conn::fields("response", &f.payload[1..]).unwrap()[1]
                .1
                .to_vec());
        }
    }
}
#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; no sudo, real executable in bwrap"]
fn production_binary_dark_activation_and_confined_read() {
    let (guest, mut host) = guest();
    // Before wake and roster receipts, status must not announce awake.
    let status = call(&mut host, 1, &[]);
    assert_eq!(status[0], 1);
    assert_eq!(conn::fields("result1", &status[1..]).unwrap()[0].1, &[2]);
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    let result = call(
        &mut host,
        2,
        &[conn::field(1, [0, 4, b'f', b'i', b'l', b'e'])],
    );
    assert_eq!(result[0], 2);
    assert!(result.windows(16).any(|w| w == b"outside sentinel"));
    for path in ["../etc/passwd", "/etc/passwd"] {
        let mut value = (path.len() as u16).to_be_bytes().to_vec();
        value.extend(path.as_bytes());
        assert_eq!(call(&mut host, 2, &[conn::field(1, value)])[0], 255);
    }

    // A rejected newcomer cannot retire the authenticated live connection.
    let address = host.stream.peer_addr().unwrap();
    let mut bad = TcpStream::connect(address).unwrap();
    bad.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    assert_eq!(Frame::read(&mut bad).unwrap().payload[0], 1);
    Frame {
        kind: 0,
        stream: 0,
        payload: conn::tagged(
            2,
            &[conn::field(1, 9u16.to_be_bytes()), conn::field(2, [0; 32])],
        ),
    }
    .write(&mut bad)
    .unwrap();
    assert_eq!(
        Frame::read(&mut bad).unwrap().payload,
        vec![5, 0, 0, 0, 2, 1, 14]
    );
    assert_eq!(call(&mut host, 1, &[])[0], 1);
    let mut replacement = TcpStream::connect(address).unwrap();
    authenticate(&mut replacement);
    host.bundle.clear();
    host.stream = replacement;
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    assert_eq!(
        call(
            &mut host,
            2,
            &[conn::field(1, [0, 4, b'f', b'i', b'l', b'e'])]
        )[0],
        2
    );
    let workspace = guest.root.path().join("workspace");
    std::os::unix::fs::symlink("/etc/passwd", workspace.join("symlink")).unwrap();
    fs::create_dir(workspace.join("directory")).unwrap();
    let fifo =
        std::ffi::CString::new(workspace.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let _socket = std::os::unix::net::UnixListener::bind(workspace.join("socket")).unwrap();
    for path in ["symlink", "directory", "fifo", "socket"] {
        let mut value = (path.len() as u16).to_be_bytes().to_vec();
        value.extend(path.as_bytes());
        let start = std::time::Instant::now();
        let refused = call(&mut host, 2, &[conn::field(1, value)]);
        assert_eq!(refused[0], 255);
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "special file blocked"
        );
    }
    assert_eq!(
        fs::read(guest.root.path().join("workspace/file")).unwrap(),
        b"outside sentinel"
    );
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; production executable and real jj"]
fn production_capture_and_dispatched_stale_write_preserve_logged_outside_renames() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let (guest, mut host) = guest();
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    let running = Arc::new(AtomicBool::new(true));
    let run = running.clone();
    let workspace = guest.root.path().join("workspace");
    let writer = std::thread::spawn(move || {
        let mut log = Vec::new();
        for n in 0..10000 {
            if !run.load(Ordering::Acquire) {
                break;
            }
            let bytes = format!("outside rename {n}\n").into_bytes();
            fs::write(workspace.join("replacement"), &bytes).unwrap();
            fs::rename(workspace.join("replacement"), workspace.join("file")).unwrap();
            log.push(bytes);
            std::thread::sleep(Duration::from_millis(2));
        }
        log
    });
    // The independent writer's log is the oracle; no expected bytes come from
    // a control handler or generated production response.
    for _ in 0..20 {
        let result = call(
            &mut host,
            3,
            &[
                conn::field(1, [0, 4, b'f', b'i', b'l', b'e']),
                conn::field(2, conn::tagged(1, &[conn::field(1, [0; 32])])),
                conn::field(3, [0, 0, 0, 4, b'l', b'o', b's', b't']),
                conn::field(4, conn::tagged(1, &[conn::field(1, [0, 0, 0, 1, b'a'])])),
            ],
        );
        assert_eq!(result[0], 255);
        assert_eq!(conn::fields("error", &result[1..]).unwrap()[0].1, &[4]);
    }
    assert_eq!(call(&mut host, 4, &[])[0], 4);
    running.store(false, Ordering::Release);
    let log = writer.join().unwrap();
    assert!(!log.is_empty());
    let final_bytes = fs::read(guest.root.path().join("workspace/file")).unwrap();
    assert_eq!(log.last().unwrap(), &final_bytes);
    assert_eq!(call(&mut host, 4, &[])[0], 4);
    let head = host.captured.expect("verified captured event");
    let hex: String = head.iter().map(|b| format!("{b:02x}")).collect();
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(host.store.path())
        .args(["show", &format!("{hex}:file")])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, final_bytes);
    let status = call(&mut host, 1, &[]);
    let fields = conn::fields("result1", &status[1..]).unwrap();
    assert_eq!(
        fields.iter().find(|(tag, _)| *tag == 4).unwrap().1,
        &[0, 0, 0, 0]
    );
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; namespace init restart barrier"]
fn killed_production_daemon_restarts_and_authenticates_with_retained_boot() {
    let (guest, mut host) = guest();
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    let path = guest.root.path().join("run/namespace-daemon.pid");
    let address = host.stream.peer_addr().unwrap();
    let old: i32 = fs::read_to_string(&path).unwrap().parse().unwrap();
    assert_eq!(unsafe { libc::kill(old, libc::SIGKILL) }, 0);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let new: i32 = fs::read_to_string(&path).unwrap().parse().unwrap();
        if new != old {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "init did not restart daemon"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    host.bundle.clear();
    host.stream = TcpStream::connect(address).unwrap();
    authenticate(&mut host.stream);
    let status = call(&mut host, 1, &[]);
    assert_eq!(conn::fields("result1", &status[1..]).unwrap()[0].1, &[2]);
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    let read = call(
        &mut host,
        2,
        &[conn::field(1, [0, 4, b'f', b'i', b'l', b'e'])],
    );
    assert!(read.windows(16).any(|w| w == b"outside sentinel"));
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; authenticated lost-ack replay"]
fn production_capture_replays_verified_event_after_lost_acknowledgement() {
    for _ in 0..10 {
        lost_ack_case();
    }
}
fn lost_ack_case() {
    let (guest, mut host) = guest();
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    // First drain ordinary setup so the fault applies to this capture alone.
    assert_eq!(call(&mut host, 4, &[])[0], 4);
    fs::write(
        guest.root.path().join("workspace/file"),
        b"lost ack sentinel",
    )
    .unwrap();
    host.acknowledge = false;
    let payload = exchange(&mut host, 4, &[], true);
    let original = conn::Durable::decode(&payload).unwrap();
    let address = host.stream.peer_addr().unwrap();
    host.stream.shutdown(std::net::Shutdown::Both).unwrap();
    host.bundle.clear();
    host.stream = TcpStream::connect(address).unwrap();
    authenticate(&mut host.stream);
    host.acknowledge = true;
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    assert_eq!(call(&mut host, 4, &[])[0], 4);
    assert!(
        host.seen
            .iter()
            .filter(|entry| **entry == (original.seq, original.id))
            .count()
            >= 2,
        "replay changed durable identity"
    );
    let hex: String = host
        .captured
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(host.store.path())
        .args(["show", &format!("{hex}:file")])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"lost ack sentinel");
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; 10000 production path swaps"]
fn production_write_parent_swap_cannot_reach_outside_sentinel() {
    use std::sync::mpsc;
    let (guest, mut host) = guest();
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    let workspace = guest.root.path().join("workspace");
    fs::create_dir(workspace.join("d")).unwrap();
    std::os::unix::fs::symlink("/outside", workspace.join("swap")).unwrap();
    let (swap, requests) = mpsc::channel();
    let (finished, swapped) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        let first =
            std::ffi::CString::new(workspace.join("d").as_os_str().as_encoded_bytes()).unwrap();
        let second =
            std::ffi::CString::new(workspace.join("swap").as_os_str().as_encoded_bytes()).unwrap();
        for () in requests {
            for _ in 0..2 {
                assert_eq!(
                    unsafe {
                        libc::renameat2(
                            libc::AT_FDCWD,
                            first.as_ptr(),
                            libc::AT_FDCWD,
                            second.as_ptr(),
                            libc::RENAME_EXCHANGE,
                        )
                    },
                    0
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            finished.send(()).unwrap();
        }
    });
    let mut succeeded = 0;
    let mut refused = 0;

    for start in (0..10000u32).step_by(32) {
        swap.send(()).unwrap();
        let end = (start + 32).min(10000);
        for index in start..end {
            let fields = [
                conn::field(1, [0, 3, b'd', b'/', b'f']),
                conn::field(2, conn::tagged(2, &[])),
                conn::field(3, [0, 0, 0, 4, b'l', b'o', b's', b't']),
                conn::field(4, conn::tagged(1, &[conn::field(1, [0, 0, 0, 1, b'a'])])),
            ];
            Frame {
                kind: 1,
                stream: 0,
                payload: conn::tagged(
                    1,
                    &[
                        conn::field(1, (index + 1).to_be_bytes()),
                        conn::field(2, conn::tagged(3, &fields)),
                    ],
                ),
            }
            .write(&mut host.stream)
            .unwrap();
        }
        for index in start..end {
            let result = receive_reply(&mut host, false).unwrap();
            assert_eq!(
                host.response_id,
                index + 1,
                "write replies must retain FIFO identity"
            );
            match result[0] {
                3 => succeeded += 1,
                255 => refused += 1,
                _ => panic!("unexpected write response"),
            };
        }
        swapped.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    drop(swap);
    writer.join().unwrap();
    assert!(succeeded <= 1);
    assert!(refused >= 9999);
    assert_eq!(
        fs::read(guest.root.path().join("outside/f")).unwrap(),
        b"outside protected sentinel"
    );
}

#[cfg(feature = "killpoints")]
#[test]
#[ignore = "requires killpoints debug binary and SMITHERS_NAMESPACE_INIT"]
fn production_capture_killpoints_restart_and_converge_ten_times_each() {
    for fault in ["K3", "K3b", "K5a", "K5b", "K5c"] {
        for iteration in 0..10 {
            eprintln!("fault {fault} iteration {iteration}");
            let (guest, mut host) = guest_with_fault(Some(&format!("armed:{fault}")));
            let address = host.stream.peer_addr().unwrap();
            let path = guest.root.path().join("run/namespace-daemon.pid");
            let old = fs::read_to_string(guest.root.path().join("run/namespace-first.pid"))
                .unwrap()
                .parse::<i32>()
                .unwrap();
            assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
            assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
            assert_eq!(call(&mut host, 4, &[])[0], 4);
            let mut writer_log = vec![];
            use std::io::Write;
            for index in 0..20 {
                let name = format!("fault-{index}");
                let bytes = format!("logged {fault}/{iteration}/{index}\n").into_bytes();
                let mut file =
                    fs::File::create(guest.root.path().join("workspace").join(&name)).unwrap();
                file.write_all(&bytes).unwrap();
                file.sync_all().unwrap();
                drop(file);
                writer_log.push((name, bytes));
            }
            // The existing debug-only hook is armed by the trusted supervisor's
            // private state after every independent write has been fsynced and
            // logged. Setup captures cannot consume this run's fault.
            fs::write(guest.root.path().join("state/fault-armed"), fault).unwrap();
            assert!(
                exchange_result(&mut host, 4, &[], false).is_err(),
                "{fault} did not kill capture"
            );
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let new: i32 = fs::read_to_string(&path).unwrap().parse().unwrap();
                if new != old {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "{fault} did not restart"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(
                fs::read_to_string(guest.root.path().join("run/namespace-first.status")).unwrap(),
                "73",
                "{fault} did not hit its compiled fault hook"
            );
            host.bundle.clear(); // restart sends the complete pinned bundle
            host.stream = TcpStream::connect(address).unwrap();
            authenticate(&mut host.stream);
            assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
            assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
            let capture = call(&mut host, 4, &[]);
            assert_eq!(capture[0], 4);
            let head: [u8; 20] = conn::fields("result4", &capture[1..]).unwrap()[0]
                .1
                .try_into()
                .unwrap();
            host.captured = Some(head);
            let hex: String = host
                .captured
                .unwrap()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            for (name, expected) in writer_log {
                let output = Command::new("/usr/bin/git")
                    .arg("-C")
                    .arg(host.store.path())
                    .args(["show", &format!("{hex}:{name}")])
                    .output()
                    .unwrap();
                assert!(output.status.success());
                assert_eq!(output.stdout, expected, "{fault} lost a logged write");
                assert_eq!(
                    fs::read(guest.root.path().join("workspace").join(name)).unwrap(),
                    expected
                );
            }
        }
    }
}

// This exercises the real installed cleanup and a jj reader running as member
// uid in a second unprivileged namespace. A single-id user namespace maps both
// identities to the lane's host uid, so group permissions and distinct-user
// access remain the separate privileged oplog.rs qualification.
#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; production capture and member namespace jj"]
fn production_cleanup_keeps_operation_log_readable_in_member_namespace() {
    let (guest, mut host) = guest_with_history(None, 108);
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    assert_eq!(call(&mut host, 4, &[])[0], 4);
    let cleanup = guest.root.path().join("state/oplog.gc");
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    while !cleanup.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "installed maintenance never ran"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(fs::metadata(cleanup).unwrap().len(), 8);
    let jj = std::env::var("SMITHERS_TEST_JJ").unwrap_or_else(|_| {
        let output = Command::new("sh")
            .args(["-c", "command -v jj"])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    });
    let output = Command::new("bwrap")
        .args(["--tmpfs", "/", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib",
            "--ro-bind", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
            "--ro-bind", "/etc", "/etc", "--proc", "/proc", "--dev", "/dev",
            "--unshare-user", "--uid", "20000", "--gid", "20000", "--die-with-parent",
            "--ro-bind"])
        .arg(jj).arg("/jj")
        .arg("--bind").arg(guest.root.path().join("workspace")).arg("/workspace")
        .args(["--chdir", "/workspace", "--", "/bin/sh", "-c",
            "test $(id -u) = 20000 && test $(id -g) = 20000 && exec /jj --ignore-working-copy op log --no-graph -T 'id ++ \"\\n\"'"])
        .env_clear().env("PATH", std::env::var("PATH").unwrap()).env("HOME", "/nonexistent")
        .output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let log = std::str::from_utf8(&output.stdout).unwrap();
    // The all-zero root operation is not part of the retention count.
    assert_eq!(
        log.lines()
            .filter(|id| id.bytes().any(|b| b != b'0'))
            .count(),
        100
    );
    assert!(log
        .lines()
        .all(|id| id.len() == 128 && id.bytes().all(|b| b.is_ascii_hexdigit())));
    assert_eq!(
        fs::read(guest.root.path().join("workspace/file")).unwrap(),
        b"outside sentinel"
    );
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; dispatched special-file write refusals"]
fn production_write_refuses_special_files_without_side_effects() {
    let (guest, mut host) = guest();
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    let workspace = guest.root.path().join("workspace");
    fs::create_dir(workspace.join("directory")).unwrap();
    std::os::unix::fs::symlink("/outside/f", workspace.join("symlink")).unwrap();
    let fifo =
        std::ffi::CString::new(workspace.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let _socket = std::os::unix::net::UnixListener::bind(workspace.join("socket")).unwrap();
    for path in [
        "directory",
        "symlink",
        "fifo",
        "socket",
        "../outside/f",
        "/outside/f",
    ] {
        for base in [
            conn::tagged(2, &[]),
            conn::tagged(1, &[conn::field(1, [0; 32])]),
        ] {
            let mut name = (path.len() as u16).to_be_bytes().to_vec();
            name.extend(path.as_bytes());
            let start = std::time::Instant::now();
            let result = call(
                &mut host,
                3,
                &[
                    conn::field(1, name),
                    conn::field(2, base),
                    conn::field(3, [0, 0, 0, 4, b'l', b'o', b's', b't']),
                    conn::field(4, conn::tagged(1, &[conn::field(1, [0, 0, 0, 1, b'a'])])),
                ],
            );
            assert_eq!(result[0], 255, "accepted {path}");
            assert!(
                start.elapsed() < Duration::from_millis(100),
                "blocked on {path}"
            );
        }
    }
    assert!(fs::symlink_metadata(workspace.join("directory"))
        .unwrap()
        .is_dir());
    assert!(fs::symlink_metadata(workspace.join("symlink"))
        .unwrap()
        .file_type()
        .is_symlink());
    use std::os::unix::fs::FileTypeExt;
    assert!(fs::symlink_metadata(workspace.join("fifo"))
        .unwrap()
        .file_type()
        .is_fifo());
    assert!(fs::symlink_metadata(workspace.join("socket"))
        .unwrap()
        .file_type()
        .is_socket());
    assert_eq!(
        fs::read(guest.root.path().join("outside/f")).unwrap(),
        b"outside protected sentinel"
    );
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; ten 30-second K4b disconnects"]
fn production_fifty_bursts_close_offline_and_replay_without_restart() {
    for iteration in 0..10 {
        eprintln!("K4b iteration {iteration}");
        let (guest, mut host) = guest();
        assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
        assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
        assert_eq!(call(&mut host, 4, &[])[0], 4);
        host.events.clear();
        host.verify_versions = true;
        let pid_path = guest.root.path().join("run/namespace-daemon.pid");
        let pid = fs::read_to_string(&pid_path).unwrap();
        let mut writer_log = vec![];
        // Different authenticated actors keep independent bursts open. Queue
        // the real writes together, then cut the connection before idle closes
        // them. The bytes/paths below are the independent writer oracle.
        for index in 0..50u32 {
            let path = format!("offline-{index}");
            let bytes = format!("logged write {iteration}/{index}\n").into_bytes();
            let mut name = (path.len() as u16).to_be_bytes().to_vec();
            name.extend(path.as_bytes());
            let mut content = (bytes.len() as u32).to_be_bytes().to_vec();
            content.extend(&bytes);
            let mut reference = vec![0, 0, 0, 16];
            reference.extend([index as u8 + 1; 16]);
            Frame {
                kind: 1,
                stream: 0,
                payload: conn::tagged(
                    1,
                    &[
                        conn::field(1, (index + 100).to_be_bytes()),
                        conn::field(
                            2,
                            conn::tagged(
                                3,
                                &[
                                    conn::field(1, name),
                                    conn::field(2, conn::tagged(2, &[])),
                                    conn::field(3, content),
                                    conn::field(4, conn::tagged(1, &[conn::field(1, reference)])),
                                ],
                            ),
                        ),
                    ],
                ),
            }
            .write(&mut host.stream)
            .unwrap();
            writer_log.push((path, bytes));
        }
        for index in 0..50u32 {
            assert_eq!(receive_reply(&mut host, false).unwrap()[0], 3);
            assert_eq!(host.response_id, index + 100);
        }
        assert!(
            host.events.iter().all(|event| event.event[0] != 1),
            "burst closed before disconnect; this run cannot qualify K4b"
        );
        let address = host.stream.peer_addr().unwrap();
        host.stream.shutdown(std::net::Shutdown::Both).unwrap();
        let cut = std::time::Instant::now();
        // Observe the real durable files while offline, without opening the
        // store as another writer or calling a handler directly.
        let outbox = guest.root.path().join("state/outbox");
        while cut.elapsed() < Duration::from_secs(30) {
            assert_eq!(
                fs::read_to_string(&pid_path).unwrap(),
                pid,
                "K4b restarted daemon"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(
            fs::read_dir(&outbox)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".ev"))
                .count()
                >= 50,
            "50 bursts did not become durable while offline"
        );
        eprintln!("K4b reconnect {iteration}");
        host.bundle.clear();
        host.stream = TcpStream::connect(address).unwrap();
        authenticate(&mut host.stream);
        assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
        let capture = call(&mut host, 4, &[]);
        assert_eq!(capture[0], 4);
        let head = conn::fields("result4", &capture[1..]).unwrap()[0]
            .1
            .to_vec();
        let hex: String = head.iter().map(|b| format!("{b:02x}")).collect();
        let bursts: Vec<_> = host
            .events
            .iter()
            .filter(|event| event.event[0] == 1)
            .collect();
        assert_eq!(bursts.len(), 50);
        let mut identities = std::collections::BTreeSet::new();
        let mut versions = std::collections::BTreeSet::new();
        let mut recorded_paths = std::collections::BTreeSet::new();
        for event in &bursts {
            assert!(
                identities.insert((event.seq, event.id)),
                "duplicate durable event"
            );
            let fields = conn::fields("burst", &event.event[1..]).unwrap();
            assert!(
                versions.insert(fields[0].1.to_vec()),
                "duplicate burst identity"
            );
            let files = fields.iter().find(|(tag, _)| *tag == 3).unwrap().1;
            assert_eq!(
                &files[..2],
                &[0, 1],
                "one acknowledged path per actor burst"
            );
            let file = conn::fields("burst_file", &files[2..]).unwrap();
            let name = file.iter().find(|(tag, _)| *tag == 1).unwrap().1;
            let path = std::str::from_utf8(&name[2..]).unwrap();
            assert!(
                recorded_paths.insert(path.to_owned()),
                "path recorded twice"
            );
            let expected = &writer_log.iter().find(|(name, _)| name == path).unwrap().1;
            use sha2::{Digest, Sha256};
            assert_eq!(
                file.iter().find(|(tag, _)| *tag == 6).unwrap().1,
                Sha256::digest(expected).as_slice()
            );
            let commit = fields.iter().find(|(tag, _)| *tag == 4).unwrap().1;
            let commit: String = commit.iter().map(|b| format!("{b:02x}")).collect();
            let verified = Command::new("/usr/bin/git")
                .arg("-C")
                .arg(host.store.path())
                .args(["cat-file", "-e", &format!("{commit}^{{commit}}")])
                .output()
                .unwrap();
            assert!(
                verified.status.success(),
                "burst preceded its versions objects"
            );
            let bytes = Command::new("/usr/bin/git")
                .arg("-C")
                .arg(host.store.path())
                .args(["show", &format!("{commit}:b/{path}")])
                .output()
                .unwrap();
            assert!(bytes.status.success());
            assert_eq!(&bytes.stdout, expected);
        }
        assert_eq!(recorded_paths.len(), 50);
        for (path, bytes) in writer_log {
            assert_eq!(
                fs::read(guest.root.path().join("workspace").join(&path)).unwrap(),
                bytes
            );
            let captured = Command::new("/usr/bin/git")
                .arg("-C")
                .arg(host.store.path())
                .args(["show", &format!("{hex}:{path}")])
                .output()
                .unwrap();
            assert!(captured.status.success());
            assert_eq!(captured.stdout, bytes);
        }
        assert!(fs::read_dir(outbox)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".ev")));
        assert_eq!(fs::read_to_string(pid_path).unwrap(), pid);
    }
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; namespace daemon lifetime"]
fn namespace_init_exit_ends_the_production_daemon() {
    let (mut guest, _host) = guest();
    let pid = fs::read_to_string(guest.root.path().join("run/namespace-daemon.pid")).unwrap();
    guest.child.kill().unwrap();
    guest.child.wait().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match fs::read_to_string(format!("/proc/{}/status", pid.trim())) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Ok(status)
                if status
                    .lines()
                    .any(|line| line.starts_with("State:") && line.contains('Z')) =>
            {
                break
            }
            Ok(_) => (),
            Err(error) => panic!("daemon process observation: {error}"),
        }
        assert!(
            std::time::Instant::now() < deadline,
            "daemon survived its namespace init"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; production compare-and-write contract"]
fn production_absent_and_digest_preconditions_preserve_captured_bytes() {
    use sha2::{Digest, Sha256};
    let (guest, mut host) = guest();
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    let write = |host: &mut Host, path: &str, base: Vec<u8>, bytes: &[u8]| {
        let mut name = (path.len() as u16).to_be_bytes().to_vec();
        name.extend_from_slice(path.as_bytes());
        let mut content = (bytes.len() as u32).to_be_bytes().to_vec();
        content.extend_from_slice(bytes);
        call(
            host,
            3,
            &[
                conn::field(1, name),
                conn::field(2, base),
                conn::field(3, content),
                conn::field(4, conn::tagged(1, &[conn::field(1, [0, 0, 0, 1, b'a'])])),
            ],
        )
    };
    // These bytes originate in the test, independently of the daemon replies.
    let initial = b"created through authenticated RPC\n";
    let updated = b"updated through authenticated RPC\n";
    assert_eq!(
        write(&mut host, "created", conn::tagged(2, &[]), initial)[0],
        3
    );
    for base in [
        conn::tagged(2, &[]),
        conn::tagged(1, &[conn::field(1, [0; 32])]),
    ] {
        let refused = write(&mut host, "created", base, b"lost");
        assert_eq!(refused[0], 255);
        let fields = conn::fields("error", &refused[1..]).unwrap();
        assert_eq!(fields[0].1, &[4]); // literal wire code: stale
        assert_eq!(
            fs::read(guest.root.path().join("workspace/created")).unwrap(),
            initial
        );
    }
    let digest: [u8; 32] = Sha256::digest(initial).into();
    assert_eq!(
        write(
            &mut host,
            "created",
            conn::tagged(1, &[conn::field(1, digest)]),
            updated
        )[0],
        3
    );
    assert_eq!(
        fs::read(guest.root.path().join("workspace/created")).unwrap(),
        updated
    );
    assert_eq!(call(&mut host, 4, &[])[0], 4);
    let head = host
        .captured
        .expect("capture objects verified before acknowledgement");
    let hex: String = head.iter().map(|b| format!("{b:02x}")).collect();
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(host.store.path())
        .args(["show", &format!("{hex}:created")])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, updated);
}

// The current §9.4.1 contract retains and versions a displaced outside save;
// it never rolls back an irreversible exchange. Exercise the narrow race with
// the shipped debug hold, not a fixture Disk or a direct control-handler call.
#[cfg(feature = "killpoints")]
#[test]
#[ignore = "requires debug killpoints and SMITHERS_NAMESPACE_INIT; real exchange race"]
fn production_rename_between_validation_and_exchange_returns_retained_race() {
    use sha2::{Digest, Sha256};
    let (guest, mut host) = guest();
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    assert_eq!(call(&mut host, 4, &[])[0], 4);
    host.events.clear();
    host.verify_versions = true;
    let initial = b"outside sentinel";
    let outside = b"independently logged replacement after validation\n";
    let accepted = b"authenticated replacement\n";
    let state = guest.root.path().join("state");
    fs::write(state.join("qualification-write_swap.arm"), []).unwrap();
    let workspace = guest.root.path().join("workspace");
    let writer = std::thread::spawn(move || {
        let marker = state.join("qualification-write_swap.hit");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !marker.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "exchange boundary not reached"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(fs::read(&marker).unwrap(), b"write_swap");
        assert_eq!(fs::read(workspace.join("file")).unwrap(), initial);
        fs::write(workspace.join("replacement"), outside).unwrap();
        fs::File::open(workspace.join("replacement"))
            .unwrap()
            .sync_all()
            .unwrap();
        fs::rename(workspace.join("replacement"), workspace.join("file")).unwrap();
        fs::File::open(&workspace).unwrap().sync_all().unwrap();
        let logged = fs::read(workspace.join("file")).unwrap();
        assert_eq!(logged, outside);
        fs::remove_file(marker).unwrap();
        logged
    });
    let mut content = (accepted.len() as u32).to_be_bytes().to_vec();
    content.extend(accepted);
    // Queue capture behind the held write on the production FIFO. Its result
    // must include the accepted bytes and the displaced writer's versions.
    for (id, request) in [
        (
            41u32,
            conn::tagged(
                3,
                &[
                    conn::field(1, [0, 4, b'f', b'i', b'l', b'e']),
                    conn::field(
                        2,
                        conn::tagged(1, &[conn::field(1, Sha256::digest(initial))]),
                    ),
                    conn::field(3, content),
                    conn::field(4, conn::tagged(1, &[conn::field(1, [0, 0, 0, 1, b'a'])])),
                ],
            ),
        ),
        (42u32, conn::tagged(4, &[])),
    ] {
        Frame {
            kind: 1,
            stream: 0,
            payload: conn::tagged(
                1,
                &[conn::field(1, id.to_be_bytes()), conn::field(2, request)],
            ),
        }
        .write(&mut host.stream)
        .unwrap();
    }
    let response = receive_reply(&mut host, false).unwrap();
    assert_eq!(host.response_id, 41);
    assert_eq!(
        response[0], 3,
        "an exchanged write cannot claim unchanged stale refusal"
    );
    let fields = conn::fields("result3", &response[1..]).unwrap();
    assert_eq!(fields[0].1, Sha256::digest(accepted).as_slice());
    let raced = conn::fields("raced", fields[1].1).unwrap();
    assert_eq!(raced[0].1, [0, 4, b'f', b'i', b'l', b'e']);
    let writer_log = writer.join().unwrap();
    assert_eq!(raced[1].1, Sha256::digest(&writer_log).as_slice());
    let capture = receive_reply(&mut host, false).unwrap();
    assert_eq!(host.response_id, 42);
    assert_eq!(capture[0], 4);
    assert_eq!(
        fs::read(guest.root.path().join("workspace/file")).unwrap(),
        accepted
    );
    let head: String = conn::fields("result4", &capture[1..]).unwrap()[0]
        .1
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let captured = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(host.store.path())
        .args(["show", &format!("{head}:file")])
        .output()
        .unwrap();
    assert!(captured.status.success());
    assert_eq!(captured.stdout, accepted);
    let mut retained = false;
    for event in host.events.iter().filter(|event| event.event[0] == 1) {
        let fields = conn::fields("burst", &event.event[1..]).unwrap();
        let commit: String = fields
            .iter()
            .find(|(tag, _)| *tag == 4)
            .unwrap()
            .1
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        for side in ["b", "a"] {
            let version = Command::new("/usr/bin/git")
                .arg("-C")
                .arg(host.store.path())
                .args(["show", &format!("{commit}:{side}/file")])
                .output()
                .unwrap();
            retained |= version.status.success() && version.stdout == writer_log;
        }
    }
    assert!(
        retained,
        "displaced outside bytes absent from acknowledged host versions"
    );
    assert!(fs::read_dir(guest.root.path().join("state/outbox"))
        .unwrap()
        .filter_map(Result::ok)
        .all(|entry| !entry.file_name().to_string_lossy().ends_with(".ev")));
}

#[test]
#[ignore = "requires SMITHERS_NAMESPACE_INIT; production local socket peer credentials"]
fn production_local_socket_rejects_non_agent_before_write_dispatch() {
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
    };
    let (guest, mut host) = guest();
    assert_eq!(call(&mut host, 5, &[conn::field(1, guest.head)])[0], 5);
    assert_eq!(call(&mut host, 16, &[conn::field(1, [0, 0])])[0], 16);
    // This host caller maps to machined, not agent, in the daemon namespace.
    // Actual agent/member separation and registered-run admission still need
    // the protected guest; no payload may substitute for SO_PEERCRED here.
    for forged_actor in [false, true] {
        let mut fields = vec![
            conn::field(1, [0, 4, b'f', b'i', b'l', b'e']),
            conn::field(2, conn::tagged(2, &[])),
            conn::field(3, [0, 0, 0, 4, b'l', b'o', b's', b't']),
        ];
        if forged_actor {
            fields.push(conn::field(
                4,
                conn::tagged(1, &[conn::field(1, [0, 0, 0, 1, b'a'])]),
            ));
        }
        let frame = Frame {
            kind: 1,
            stream: 0,
            payload: conn::tagged(
                1,
                &[
                    conn::field(1, 73u32.to_be_bytes()),
                    conn::field(2, conn::tagged(3, &fields)),
                ],
            ),
        };
        let request = if forged_actor {
            frame.encode()
        } else {
            frame.encode_local()
        }
        .unwrap();
        let mut socket = UnixStream::connect(guest.root.path().join("run/machined.sock")).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        match socket.write_all(&request) {
            Ok(()) => (),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                ) =>
            {
                ()
            }
            result => panic!("local request: {result:?}"),
        }
        let mut byte = [0];
        match socket.read(&mut byte) {
            Ok(0) => (),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
            result => panic!("non-agent received a local response: {result:?}"),
        }
        assert_eq!(
            fs::read(guest.root.path().join("workspace/file")).unwrap(),
            b"outside sentinel"
        );
        assert_eq!(
            call(&mut host, 1, &[])[0],
            1,
            "local refusal killed the host door"
        );
    }
}
