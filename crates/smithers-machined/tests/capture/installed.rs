//! Unprivileged namespace evidence for the shipped executable. The only fake
//! provider is the empty session census, shared with journey rehearsals.
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
    seen: Vec<(u64, [u8; 16])>,
}
fn guest() -> (Guest, Host) {
    let init = std::env::var("SMITHERS_NAMESPACE_INIT")
        .expect("build rehearsal_daemon and set SMITHERS_NAMESPACE_INIT");
    let root = tempfile::tempdir().unwrap();
    for dir in ["workspace", "state", "run", "run/machined"] {
        fs::create_dir(root.path().join(dir)).unwrap();
    }
    fs::set_permissions(root.path().join("state"), fs::Permissions::from_mode(0o700)).unwrap();
    let jj = std::env::var("SMITHERS_TEST_JJ").unwrap_or("jj".into());
    let out = Command::new(&jj)
        .args(["git", "init"])
        .arg(root.path().join("workspace"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
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
    let binary = env!("CARGO_BIN_EXE_smithers-machined");
    let mut child = Command::new("bwrap")
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
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port: u16 = line.trim().parse().expect("namespace init relay port");
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    authenticate(&mut stream);
    {
        let store = tempfile::tempdir().unwrap();
        assert!(Command::new("/usr/bin/git")
            .args(["init", "--bare"])
            .arg(store.path())
            .output()
            .unwrap()
            .status
            .success());
        (
            Guest { child, root, head },
            Host {
                stream,
                store,
                bundle: Vec::new(),
                captured: None,
                acknowledge: true,
                seen: Vec::new(),
            },
        )
    }
}
fn authenticate(stream: &mut TcpStream) {
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
    .write(&mut host.stream)
    .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "request never completed"
        );
        let f = Frame::read(&mut host.stream).unwrap();
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
            .write(&mut host.stream)
            .unwrap();
        }
        if f.kind == 2 && f.payload[0] == 1 {
            let event = conn::Durable::decode(&f.payload).unwrap();
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
                .write(&mut host.stream)
                .unwrap();
            }
            if stop_at_event && event.captured_head().is_some() {
                return f.payload;
            }
        }
        if f.kind == 1 {
            return conn::fields("response", &f.payload[1..]).unwrap()[1]
                .1
                .to_vec();
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
            start.elapsed() < Duration::from_secs(1),
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
