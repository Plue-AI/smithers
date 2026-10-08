//! Raw private-envelope acceptance for an approved test bundle.
//! No diagnostic listener or production opcode is added. Run in an isolated
//! reference guest; never execute a checkout-built test binary as root.
use super::{
    cgroups::Cgroups,
    control,
    spawn::{InstalledAdmission, Processes},
    supervisor::Supervisor,
};
use crate::conn;
use rustix::net::{
    recv, send, socketpair, AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType,
};
use std::{io, time::Duration};

fn text(value: &[u8]) -> Vec<u8> {
    let mut bytes = (value.len() as u16).to_be_bytes().to_vec();
    bytes.extend(value);
    bytes
}
fn open(extra: Vec<Vec<u8>>) -> Vec<u8> {
    open_identity(b"maya", 20000, extra)
}
fn open_identity(login: &[u8], uid: u32, extra: Vec<Vec<u8>>) -> Vec<u8> {
    let user = conn::structure_bytes(&[
        conn::field(1, text(login)),
        conn::field(2, uid.to_be_bytes()),
    ]);
    let mut fields = vec![
        conn::field(1, user),
        conn::field(2, [2]),
        conn::field(3, [0, 1, 0, 7, b'/', b'b', b'i', b'n', b'/', b's', b'h']),
    ];
    fields.extend(extra);
    conn::tagged(6, &fields)
}

#[test]
#[ignore = "approved main-built test bundle in isolated microVM with installed cgroup-v2 hierarchy"]
#[allow(non_snake_case)]
fn TestSSHRawPrivilegedBrokerEnvelopes() {
    assert_eq!(rustix::process::geteuid().as_raw(), 0);
    let (server, client) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let broker = std::thread::spawn(move || {
        control::serve(
            &server,
            &mut Supervisor::new(Processes::new(Cgroups::open().unwrap(), InstalledAdmission)),
        )
        .unwrap();
    });
    rustix::net::sockopt::set_socket_timeout(
        &client,
        rustix::net::sockopt::Timeout::Recv,
        Some(Duration::from_secs(2)),
    )
    .unwrap();
    let exchange = |body: &[u8]| {
        let mut packet = 41u32.to_be_bytes().to_vec();
        packet.extend(body);
        send(&client, &packet, SendFlags::NOSIGNAL).unwrap();
        let mut response = [0; 65561];
        let (n, _) = recv(&client, &mut response, RecvFlags::empty()).unwrap();
        assert!(n >= 5);
        assert_eq!(&response[..4], &41u32.to_be_bytes());
        response[..n].to_vec()
    };
    let mut cases = malformed_envelopes();
    cases.extend([
        (
            "foreign close",
            conn::tagged(8, &[conn::field(1, 12345u32.to_be_bytes())]),
        ),
        (
            "foreign attach",
            conn::tagged(
                15,
                &[
                    conn::field(1, 12345u32.to_be_bytes()),
                    conn::field(2, 0u64.to_be_bytes()),
                ],
            ),
        ),
    ]);
    // Actual private stream messages, including foreign IDs and invalid credit,
    // signal and dimensions, reach Supervisor rather than a host validator.
    for payload in [
        vec![4, 0],
        vec![4, 255],
        vec![3, 0, 0, 0, 80],
        vec![6, 255, 255, 255, 255],
    ] {
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.push(5);
        frame.extend(12345u32.to_be_bytes());
        frame.extend(payload);
        let mut packet = vec![17];
        packet.extend(frame);
        cases.push(("foreign stream control", packet));
    }
    for (name, body) in cases {
        let response = exchange(&body);
        assert_eq!(response[4], 255, "{name}");
        let fields = conn::fields("error", &response[5..]).unwrap();
        assert!(matches!(fields[0].1, [1] | [5]), "{name}: {fields:?}");
        // A refused frame must leave the real consumer responsive and empty.
        assert_eq!(exchange(&[21]), [0, 0, 0, 41, 21], "{name}");
    }
    drop(client);
    broker.join().unwrap();
    // Fatal framing violations use new private channels, with the actual
    // bounded receive loop. A truncated oversized packet cannot look valid.
    for length in [1usize, 4, 8, 65537, 65561, 70000] {
        let (server, client) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let broker = std::thread::spawn(move || {
            let mut controls =
                Supervisor::new(Processes::new(Cgroups::open().unwrap(), InstalledAdmission));
            assert_eq!(
                control::serve(&server, &mut controls).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        });
        let mut packet = vec![0; length];
        if length > 4 {
            packet[4] = 6;
        }
        send(&client, &packet, SendFlags::NOSIGNAL).unwrap();
        drop(client);
        broker.join().unwrap();
    }
}

fn malformed_envelopes() -> Vec<(&'static str, Vec<u8>)> {
    // Literal wire fields bypass the authenticated Link's canonical encoder.
    // A branch cannot add any startup selector to this private consumer.
    let mut cases = vec![
        ("root uid", open_identity(b"maya", 0, vec![])),
        ("root login", open_identity(b"root", 20000, vec![])),
        ("agent uid mismatch", open_identity(b"agent", 20000, vec![])),
        ("member uid mismatch", open_identity(b"maya", 19999, vec![])),
        ("path login", open_identity(b"../maya", 20000, vec![])),
        (
            "environment",
            open(vec![conn::field(7, text(b"LD_PRELOAD=/workspace/evil.so"))]),
        ),
        (
            "cwd",
            open(vec![conn::field(7, text(b"/workspace/escape"))]),
        ),
        ("shell", open(vec![conn::field(7, text(b"/workspace/sh"))])),
        (
            "cgroup",
            open(vec![conn::field(
                7,
                text(b"/sys/fs/cgroup/smithers/sessions/../broker"),
            )]),
        ),
        ("duplicate kind", open(vec![conn::field(2, [3])])),
        (
            "exec PTY",
            open(vec![conn::field(
                4,
                conn::structure_bytes(&[
                    conn::field(1, 80u16.to_be_bytes()),
                    conn::field(2, 0u16.to_be_bytes()),
                ]),
            )]),
        ),
        (
            "zero port",
            conn::tagged(7, &[conn::field(1, 0u16.to_be_bytes())]),
        ),
    ];
    let mut nul = open(vec![]);
    *nul.last_mut().unwrap() = 0;
    cases.push(("NUL argv", nul));
    let mut truncated = open(vec![]);
    truncated.pop();
    cases.push(("truncated argv", truncated));
    let mut trailing = open(vec![]);
    trailing.push(0);
    cases.push(("trailing byte", trailing));
    cases
}

// Runnable framing subset. The guard supplies no privileged behavior: any
// provider call panics. Native acceptance above uses the installed kernel.
#[test]
fn raw_envelopes_validate_before_provider_use() {
    struct NoProvider;
    impl control::Controls for NoProvider {
        fn session(&mut self, _: super::request::Request) -> io::Result<Vec<u8>> {
            panic!("malformed input reached privileged provider")
        }
        fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
            panic!("unexpected freeze")
        }
        fn thaw(&mut self) -> io::Result<()> {
            panic!("unexpected thaw")
        }
        fn kill(&mut self) -> io::Result<u16> {
            panic!("unexpected kill")
        }
    }
    let (server, client) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let broker = std::thread::spawn(move || control::serve(&server, &mut NoProvider).unwrap());
    rustix::net::sockopt::set_socket_timeout(
        &client,
        rustix::net::sockopt::Timeout::Recv,
        Some(Duration::from_secs(2)),
    )
    .unwrap();
    for (name, body) in malformed_envelopes() {
        let mut packet = 41u32.to_be_bytes().to_vec();
        packet.extend(body);
        send(&client, &packet, SendFlags::NOSIGNAL).unwrap();
        let mut buffer = [0; 65561];
        let (n, _) = recv(&client, &mut buffer, RecvFlags::empty()).unwrap();
        let response = &buffer[..n];
        assert_eq!(&response[..5], &[0, 0, 0, 41, 255], "{name}");
        assert_eq!(
            conn::fields("error", &response[5..]).unwrap()[0].1,
            [1],
            "{name}"
        );
    }
    drop(client);
    broker.join().unwrap();
    for length in [1usize, 4, 8, 65537, 65561, 70000] {
        let (server, client) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let broker = std::thread::spawn(move || {
            assert_eq!(
                control::serve(&server, &mut NoProvider).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        });
        let mut packet = vec![0; length];
        if length > 4 {
            packet[4] = 6;
        }
        send(&client, &packet, SendFlags::NOSIGNAL).unwrap();
        drop(client);
        broker.join().unwrap();
    }
}
