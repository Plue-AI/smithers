//! Production socketpair and FIFO evidence; kernel freeze remains a guest gate.
use super::{control, Controls};
use rustix::net::{socketpair, AddressFamily, SocketFlags, SocketType};
use smithers_machined::{
    freeze,
    hooks::*,
    lock::{Executor, LockCx},
};
use std::{
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

struct Ports {
    calls: Arc<Mutex<Vec<&'static str>>>,
    fault: &'static str,
}
impl Ports {
    fn record(&self, name: &'static str) {
        self.calls.lock().unwrap().push(name);
    }
}
impl Controls for Ports {
    fn freeze(&mut self, timeout: Duration) -> io::Result<Option<u32>> {
        assert_eq!(timeout, Duration::from_secs(1));
        self.record("freeze");
        Ok((self.fault == "busy").then_some(7))
    }
    fn thaw(&mut self) -> io::Result<()> {
        self.record("thaw");
        Ok(())
    }
    fn kill(&mut self) -> io::Result<u16> {
        panic!("rewrite must not kill sessions")
    }
}
impl Documents for Ports {
    fn flush_all(&self, _: &mut LockCx) -> Result<u16> {
        self.record("flush");
        Ok(0)
    }
    fn reconcile_all(&self, _: &mut LockCx, _: &Actor) -> Result<()> {
        self.record("reconcile");
        Ok(())
    }
}
impl Watcher for Ports {
    fn drain(&self, _: &mut LockCx) -> Result<()> {
        self.record("drain");
        Ok(())
    }
    fn close_bursts(&self, _: &mut LockCx) -> Result<()> {
        self.record("bursts");
        Ok(())
    }
}
impl Core for Ports {
    fn capture_local(&self, _: &mut LockCx) -> Result<()> {
        self.record("capture");
        if self.fault == "capture" {
            Err(Error::unsupported())
        } else {
            Ok(())
        }
    }
    fn restore_rewrite(&self, _: &mut LockCx) -> Result<()> {
        self.record("restore");
        Ok(())
    }
}

#[test]
fn fifo_rewrite_uses_production_socketpair_and_thaws_before_next_job() {
    for fault in ["none", "capture", "rewrite", "busy"] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (server, client) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let kernel_calls = calls.clone();
        let broker = std::thread::spawn(move || {
            control::serve(
                &server,
                &mut Ports {
                    calls: kernel_calls,
                    fault,
                },
            )
            .unwrap();
        });
        let ports = Arc::new(Ports {
            calls: calls.clone(),
            fault,
        });
        let executor = Executor::start(Hooks {
            broker: Arc::new(control::SocketpairBroker::new(client).unwrap()),
            core: ports.clone(),
            documents: ports.clone(),
            watcher: ports,
            ..Default::default()
        })
        .unwrap();
        // Hold the first job until both mutations are queued, so ordering does
        // not depend on which thread the scheduler happens to run first.
        let (release, held) = std::sync::mpsc::channel();
        let rewrite_calls = calls.clone();
        let first = executor
            .lock
            .enqueue("rewrite", move |cx| {
                held.recv().unwrap();
                freeze::freeze_then(cx, &Actor::Outside, |cx| {
                    assert!(cx.rewrite_pending);
                    rewrite_calls.lock().unwrap().push("rewrite");
                    if fault == "rewrite" {
                        Err(Error::unsupported())
                    } else {
                        Ok(())
                    }
                })
            })
            .unwrap();
        let next_calls = calls.clone();
        let next = executor
            .lock
            .enqueue("next mutation", move |cx| {
                assert!(!cx.rewrite_pending);
                next_calls.lock().unwrap().push("next");
            })
            .unwrap();
        release.send(()).unwrap();
        let result = first.wait().unwrap();
        if fault == "none" {
            assert!(result.is_ok());
        } else if fault == "busy" {
            let error = result.unwrap_err();
            assert_eq!(error.code, 9);
            assert_eq!(error.session, Some(7));
        } else {
            assert!(result.is_err());
        }
        next.wait().unwrap();
        executor.shutdown().unwrap();
        broker.join().unwrap();
        let expected: &[&str] = match fault {
            "none" => &[
                "freeze",
                "flush",
                "drain",
                "bursts",
                "capture",
                "rewrite",
                "reconcile",
                "thaw",
                "next",
            ],
            "rewrite" => &[
                "freeze",
                "flush",
                "drain",
                "bursts",
                "capture",
                "rewrite",
                "restore",
                "reconcile",
                "thaw",
                "next",
            ],
            "capture" => &[
                "freeze", "flush", "drain", "bursts", "capture", "thaw", "next",
            ],
            "busy" => &["freeze", "thaw", "next"],
            _ => unreachable!(),
        };
        assert_eq!(*calls.lock().unwrap(), expected, "{fault}");
    }
}

/// Qualification on the reference guest, never a regular-file cgroup fixture.
/// The session parent must be empty so the test cannot freeze other work.
#[test]
#[ignore = "requires protected writable cgroup-v2 guest hierarchy; no sudo in Linux lane"]
fn kernel_freeze_thaw_over_production_socketpair() {
    use smithers_machined::{broker::cgroups::Cgroups, hooks::Broker};
    let path = "/sys/fs/cgroup/smithers/sessions";
    let events = std::fs::read_to_string(format!("{path}/cgroup.events")).unwrap();
    assert!(events.lines().any(|line| line == "populated 0"));
    let mut kernel = Cgroups::open().unwrap();
    let (server, client) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let worker = std::thread::spawn(move || control::serve(&server, &mut kernel).unwrap());
    let broker = control::SocketpairBroker::new(client).unwrap();
    let start = std::time::Instant::now();
    assert_eq!(broker.freeze(Duration::from_secs(1)).unwrap(), None);
    let elapsed = start.elapsed();
    let frozen = std::fs::read_to_string(format!("{path}/cgroup.events"));
    broker.thaw().unwrap();
    assert!(elapsed < Duration::from_secs(1));
    assert!(frozen.unwrap().lines().any(|line| line == "frozen 1"));
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    loop {
        let events = std::fs::read_to_string(format!("{path}/cgroup.events")).unwrap();
        if events.lines().any(|line| line == "frozen 0") {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "kernel did not thaw");
        std::thread::sleep(Duration::from_millis(1));
    }
    drop(broker);
    worker.join().unwrap();
}

/// Run only from an approved main image. The launcher uses fixed system code;
/// the counter process enters its broker-owned cgroup and drops all identities
/// before Python starts. No branch artifact is executed by root.
#[test]
#[ignore = "requires approved main guest image and protected writable cgroup-v2 hierarchy"]
fn kernel_freeze_stops_member_process_and_thaw_resumes_it() {
    use smithers_machined::{broker::cgroups::Cgroups, hooks::Broker};
    use std::{
        io::Read,
        os::unix::process::CommandExt,
        process::{Command, Stdio},
    };
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "approved guest launcher only"
    );
    let path = "/sys/fs/cgroup/smithers/sessions";
    let events = std::fs::read_to_string(format!("{path}/cgroup.events")).unwrap();
    assert!(
        events.lines().any(|line| line == "populated 0"),
        "never freeze other work"
    );
    let mut kernel = Cgroups::open().unwrap();
    let procs = kernel.create(723).unwrap();
    let mut command = Command::new("/usr/bin/python3");
    command.args(["-I", "-u", "-c", "import os,time\nassert os.getuid()==20000 and os.getgid()==20000\nassert os.getgroups()==[20000]\nn=0\nwhile True:\n print(n,flush=True); n+=1; time.sleep(0.01)"])
        .env_clear().current_dir("/").stdout(Stdio::piped());
    // SAFETY: the post-fork closure uses only identity/write syscalls and stack
    // arithmetic. Repository data and executables never enter this root path.
    unsafe {
        command.pre_exec(move || {
            use std::os::fd::AsRawFd;
            let mut pid = libc::getpid() as u32;
            let mut bytes = [0u8; 10];
            let mut offset = bytes.len();
            while pid != 0 {
                offset -= 1;
                bytes[offset] = b'0' + (pid % 10) as u8;
                pid /= 10;
            }
            let length = bytes.len() - offset;
            if libc::write(procs.as_raw_fd(), bytes[offset..].as_ptr().cast(), length)
                != length as isize
            {
                return Err(io::Error::last_os_error());
            }
            let gid = 20000;
            if libc::setgroups(1, &gid) != 0
                || libc::setresgid(gid, gid, gid) != 0
                || libc::setresuid(20000, 20000, 20000) != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    struct Member(std::process::Child);
    impl Drop for Member {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut member = Member(command.spawn().unwrap());
    let mut output = member.0.stdout.take().unwrap();
    rustix::fs::fcntl_setfl(&output, rustix::fs::OFlags::NONBLOCK).unwrap();
    fn collect(output: &mut impl Read) -> Vec<u8> {
        let mut bytes = vec![];
        let mut buffer = [0u8; 4096];
        loop {
            match output.read(&mut buffer) {
                Ok(0) => panic!("member exited"),
                Ok(n) => bytes.extend_from_slice(&buffer[..n]),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return bytes,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => (),
                Err(e) => panic!("member output: {e}"),
            }
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while collect(&mut output).is_empty() {
        assert!(std::time::Instant::now() < deadline, "member never ran");
        std::thread::sleep(Duration::from_millis(10));
    }
    let (server, client) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let worker = std::thread::spawn(move || control::serve(&server, &mut kernel).unwrap());
    let broker = control::SocketpairBroker::new(client).unwrap();
    struct Thaw<'a>(&'a control::SocketpairBroker);
    impl Drop for Thaw<'_> {
        fn drop(&mut self) {
            let _ = self.0.thaw();
        }
    }
    let thaw = Thaw(&broker);
    assert_eq!(broker.freeze(Duration::from_secs(1)).unwrap(), None);
    assert!(std::fs::read_to_string(format!("{path}/cgroup.events"))
        .unwrap()
        .lines()
        .any(|line| line == "frozen 1"));
    collect(&mut output); // Drain output produced before the kernel barrier.
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        collect(&mut output).is_empty(),
        "member ran inside frozen hierarchy"
    );
    broker.thaw().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while collect(&mut output).is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "member did not resume"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(thaw);
    assert_eq!(broker.kill_sessions(None).unwrap(), 1);
    assert!(!member.0.wait().unwrap().success());
    assert!(std::fs::read_to_string(format!("{path}/cgroup.events"))
        .unwrap()
        .lines()
        .any(|line| line == "populated 0"));
    assert!(!std::path::Path::new(path).join("s723").exists());
    drop(broker);
    worker.join().unwrap();
}
