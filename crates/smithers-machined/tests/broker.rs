use smithers_machined::{
    broker::{
        control::{self, Controls},
        lifecycle::{self, Process},
    },
    conn,
};
use std::{io, time::Duration};
#[cfg(target_os = "linux")]
#[path = "broker/freeze.rs"]
mod freeze;
#[derive(Default)]
struct Kernel {
    calls: Vec<&'static str>,
}
impl Controls for Kernel {
    fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
        self.calls.push("freeze");
        Ok(Some(7))
    }
    fn thaw(&mut self) -> io::Result<()> {
        self.calls.push("thaw");
        Ok(())
    }
    fn kill(&mut self) -> io::Result<u16> {
        self.calls.push("kill");
        Ok(3)
    }
}
fn packet(variant: u8, fields: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = 9u32.to_be_bytes().to_vec();
    bytes.extend(conn::tagged(variant, fields));
    bytes
}
#[cfg(target_os = "linux")]
#[test]
fn broker_root_inputs_refused_before_privileged_side_effects() {
    use rustix::net::{
        recv, send, socketpair, AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType,
    };
    let (parent, child) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let worker = std::thread::spawn(move || {
        let mut kernel = Kernel::default();
        control::serve(&parent, &mut kernel).unwrap();
        kernel.calls
    });
    rustix::net::sockopt::set_socket_timeout(
        &child,
        rustix::net::sockopt::Timeout::Recv,
        Some(Duration::from_secs(2)),
    )
    .unwrap();
    let exchange = |bytes: &[u8]| {
        assert_eq!(
            send(&child, bytes, SendFlags::empty()).unwrap(),
            bytes.len()
        );
        let mut response = vec![0; 65536];
        let (length, _) = recv(&child, &mut response, RecvFlags::empty()).unwrap();
        response.truncate(length);
        response
    };
    for bytes in [
        packet(1, &[conn::field(1, 0u32.to_be_bytes())]),
        packet(1, &[conn::field(1, 1001u32.to_be_bytes())]),
        packet(2, &[conn::field(1, b"/workspace/evil")]),
        packet(3, &[conn::field(1, b"../../root")]),
        packet(4, &[conn::field(1, b"/bin/sh")]),
        packet(7, &[conn::field(1, 0u32.to_be_bytes())]),
        packet(8, &[conn::field(1, b"LD_PRELOAD=evil")]),
    ] {
        let response = exchange(&bytes);
        assert_eq!(&response[..4], &9u32.to_be_bytes());
        assert_eq!(response[4], 255);
    }
    // Length validation remains a unit assertion; the authority inputs above
    // traverse the same seqpacket server used by the installed root broker.
    let mut kernel = Kernel::default();
    assert!(control::handle(&vec![0; 65537], &mut kernel).is_err());
    for n in 0..9 {
        assert!(control::handle(&vec![0; n], &mut kernel).is_err());
    }
    assert!(kernel.calls.is_empty());
    let response = exchange(&packet(1, &[conn::field(1, 1000u32.to_be_bytes())]));
    assert_eq!(
        response,
        packet(
            1,
            &[conn::field(1, [0]), conn::field(2, 7u32.to_be_bytes())]
        )
    );
    drop(child);
    assert_eq!(worker.join().unwrap(), ["freeze"]);
    assert!(conn::fields("broker_frozen", &response[5..]).is_ok());
    assert!(conn::fields(
        "broker_frozen",
        &conn::structure_bytes(&[conn::field(1, [2])])
    )
    .is_err());
}
struct Child {
    log: Vec<String>,
    starts: usize,
    fail_cleanup: bool,
}
impl Process for Child {
    fn kill_sessions(&mut self) -> io::Result<()> {
        self.log.push("kill".into());
        if self.fail_cleanup {
            Err(io::ErrorKind::TimedOut.into())
        } else {
            Ok(())
        }
    }
    fn run_daemon(&mut self) -> io::Result<(i32, Duration)> {
        self.log.push("start".into());
        self.starts += 1;
        Ok((
            if self.starts == 3 { 78 } else { 137 },
            Duration::from_secs(1),
        ))
    }
    fn delay(&mut self, duration: Duration) {
        self.log.push(format!("wait:{}", duration.as_millis()));
    }
}
#[test]
fn killed_daemon_is_cleaned_before_restart_and_failed_barrier_never_starts() {
    let mut child = Child {
        log: vec![],
        starts: 0,
        fail_cleanup: false,
    };
    assert!(lifecycle::supervise(&mut child).is_err());
    assert_eq!(
        child.log,
        [
            "kill", "start", "kill", "wait:250", "kill", "start", "kill", "wait:500", "kill",
            "start", "kill"
        ]
    );
    let mut child = Child {
        log: vec![],
        starts: 0,
        fail_cleanup: true,
    };
    assert_eq!(
        lifecycle::supervise(&mut child).unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(child.starts, 0);
}

#[cfg(target_os = "linux")]
#[test]
fn production_seqpacket_correlates_freeze_thaw_and_kill() {
    use rustix::net::{socketpair, AddressFamily, SocketFlags, SocketType};
    use smithers_machined::hooks::Broker;
    let (parent, child) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let worker = std::thread::spawn(move || {
        let mut kernel = Kernel::default();
        control::serve(&parent, &mut kernel).unwrap();
        kernel.calls
    });
    let broker = control::SocketpairBroker::new(child).unwrap();
    assert_eq!(broker.freeze(Duration::from_secs(1)).unwrap(), Some(7));
    broker.thaw().unwrap();
    assert_eq!(broker.kill_sessions(None).unwrap(), 3);
    assert_eq!(broker.kill_sessions(Some(&[1])).unwrap_err().code, 2);
    drop(broker);
    assert_eq!(worker.join().unwrap(), ["freeze", "thaw", "kill"]);
}
