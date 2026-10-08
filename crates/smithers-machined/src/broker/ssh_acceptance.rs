//! Raw private-envelope acceptance for an approved test bundle.
//! No diagnostic listener or production opcode is added. Run in an isolated
//! reference guest; never execute a checkout-built test binary as root.
use super::control;
use crate::conn;
#[cfg(test)]
use rustix::net::{
    recv, send, socketpair, AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType,
};
#[cfg(test)]
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

/// Only these literal commands in the debug acceptance image select a fatal
/// framing profile. No SSH string is parsed into a packet size or root argv.
#[cfg(all(feature = "testing", debug_assertions))]
pub(super) fn fatal_profile(argv: &[String]) -> Option<usize> {
    if argv.len() != 3 || argv[0] != "/bin/sh" || argv[1] != "-c" {
        return None;
    }
    match argv[2].as_str() {
        "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-1" => Some(1),
        "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-4" => Some(4),
        "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-8" => Some(8),
        "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-65537" => Some(65537),
        "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-65561" => Some(65561),
        "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-70000" => Some(70000),
        _ => None,
    }
}

/// Fixed input-validation cases on the installed daemon's existing private
/// channel, immediately after a successful member open. There is no caller
/// supplied packet, selector, listener, or privileged acceptance process.
/// Compile only into an approved debug acceptance image, never a release.
pub(super) fn installed(broker: &control::SocketpairBroker, id: u32) -> crate::hooks::Result<()> {
    let before = broker.registry()?;
    let owner = before.iter().find(|entry| entry.id == id);
    if owner.is_none() {
        return Err(crate::hooks::Error {
            code: 12,
            ..crate::hooks::Error::unsupported()
        });
    }
    // The acceptance image is used on an isolated fresh/retained guest. Never
    // let a sentinel select a real session, even in an incorrectly reused VM.
    if before.iter().any(|entry| entry.id >= 0x7fff_ff00) {
        return Err(crate::hooks::Error {
            code: 12,
            ..crate::hooks::Error::unsupported()
        });
    }
    let owner = owner.unwrap();
    if owner.user.uid < 20000 {
        return Ok(());
    }
    let mut cases: Vec<_> = malformed_envelopes()
        .into_iter()
        .map(|(name, packet)| (name, packet, 1))
        .collect();
    cases.push((
        "foreign close",
        conn::tagged(8, &[conn::field(1, 0x7fff_ffffu32.to_be_bytes())]),
        1,
    ));
    cases.push((
        "foreign attach",
        conn::tagged(
            15,
            &[
                conn::field(1, 0x7fff_ffffu32.to_be_bytes()),
                conn::field(2, 0u64.to_be_bytes()),
            ],
        ),
        1,
    ));
    for stream in [id, 0x7fff_ffffu32] {
        for payload in [
            vec![4, 0],
            vec![4, 255],
            vec![3, 0, 0, 0, 80],
            vec![6, 255, 255, 255, 255],
        ] {
            let mut body = vec![17];
            body.extend((payload.len() as u32).to_be_bytes());
            body.push(5);
            body.extend(stream.to_be_bytes());
            body.extend(payload);
            cases.push(("stream control", body, 1));
        }
    }
    for (name, packet, expected) in cases {
        match broker.acceptance_body(packet[0], &packet[1..]) {
            Err(error) if error.code == expected => (),
            _ => {
                return Err(crate::hooks::Error {
                    code: 12,
                    ..crate::hooks::Error::unsupported()
                })
            }
        }
        // Other sessions may be admitted concurrently. Compare this session's
        // trusted ownership, rather than requiring a globally idle registry.
        let after = broker.registry()?;
        if !after.iter().any(|entry| {
            entry.id == id
                && entry.user == owner.user
                && entry.kind == owner.kind
                && entry.principal == owner.principal
        }) {
            return Err(crate::hooks::Error {
                code: 12,
                ..crate::hooks::Error::unsupported()
            });
        }
        eprintln!(
            "{}",
            serde_json::json!({"event":"ssh-input-validation", "session":id, "case":name})
        );
    }
    for packet in [
        open_identity(
            owner.user.login.as_bytes(),
            0,
            vec![conn::field(5, [1; 16])],
        ),
        open_identity(b"root", owner.user.uid, vec![conn::field(5, [1; 16])]),
    ] {
        if !matches!(broker.acceptance_body(packet[0], &packet[1..]), Err(error) if error.code == 1)
        {
            return Err(crate::hooks::Error {
                code: 12,
                ..crate::hooks::Error::unsupported()
            });
        }
    }
    eprintln!(
        "{}",
        serde_json::json!({"event":"ssh-input-validation-complete", "session":id, "uid":owner.user.uid})
    );
    Ok(())
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
    for (name, fields) in [
        (
            "duplicate login",
            vec![
                conn::field(1, text(b"maya")),
                conn::field(1, text(b"root")),
                conn::field(2, 20000u32.to_be_bytes()),
            ],
        ),
        (
            "duplicate uid",
            vec![
                conn::field(1, text(b"maya")),
                conn::field(2, 20000u32.to_be_bytes()),
                conn::field(2, 0u32.to_be_bytes()),
            ],
        ),
        (
            "unknown identity selector",
            vec![
                conn::field(1, text(b"maya")),
                conn::field(2, 20000u32.to_be_bytes()),
                conn::field(3, text(b"/sys/fs/cgroup")),
            ],
        ),
    ] {
        cases.push((
            name,
            conn::tagged(
                6,
                &[
                    conn::field(1, conn::structure_bytes(&fields)),
                    conn::field(2, [2]),
                    conn::field(3, [0, 1, 0, 7, b'/', b'b', b'i', b'n', b'/', b's', b'h']),
                ],
            ),
        ));
    }
    cases.push(("invalid UTF-8 login", open_identity(&[255], 20000, vec![])));
    cases.push(("oversized login", open_identity(&[b'a'; 33], 20000, vec![])));
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

// Socket exchange plumbing only. Installed acceptance uses the hook above and
// the production Processes kernel; this guard cannot spawn a process.
#[test]
fn installed_cases_use_the_existing_correlated_channel() {
    struct Guard {
        registry: bool,
        accept_invalid: bool,
        kills: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }
    impl control::Controls for Guard {
        fn session(&mut self, request: super::request::Request) -> io::Result<Vec<u8>> {
            match request {
                super::request::Request::Open { user, .. }
                    if user.login == "maya" && user.uid == 20000 =>
                {
                    Ok(conn::structure_bytes(&[conn::field(1, 1u32.to_be_bytes())]))
                }
                super::request::Request::KillSession(1) => {
                    self.kills.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(conn::structure_bytes(&[conn::field(1, 1u16.to_be_bytes())]))
                }
                super::request::Request::Close(0x7fff_ffff) => {
                    Err(io::ErrorKind::InvalidInput.into())
                }
                super::request::Request::Attach {
                    session: 0x7fff_ffff,
                    ..
                } => Err(io::ErrorKind::InvalidInput.into()),
                super::request::Request::Open { user, .. }
                    if user.login == "maya" && user.uid == 20001 =>
                {
                    Err(io::ErrorKind::InvalidInput.into())
                }
                _ => panic!("unexpected provider input: {request:?}"),
            }
        }
        fn stream(&mut self, op: u8, _: &[u8]) -> io::Result<Vec<u8>> {
            match op {
                25 => Ok(if self.registry {
                    br#"[{"id":1,"user":{"login":"maya","uid":20000},"kind":"Exec","run":null,"principal":[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"closed":false,"exited":false}]"#.to_vec()
                } else {
                    b"[]".to_vec()
                }),
                17 if self.accept_invalid => Ok(vec![]),
                17 => Err(io::ErrorKind::InvalidInput.into()),
                _ => panic!("unexpected private operation: {op}"),
            }
        }
        fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
            panic!()
        }
        fn thaw(&mut self) -> io::Result<()> {
            panic!()
        }
        fn kill(&mut self) -> io::Result<u16> {
            panic!()
        }
    }
    for (registry, accept_invalid, passes) in [
        (true, false, true),
        (true, true, false),
        (false, false, false),
    ] {
        let (server, client) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let kills = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = kills.clone();
        let worker = std::thread::spawn(move || {
            control::serve(
                &server,
                &mut Guard {
                    registry,
                    accept_invalid,
                    kills,
                },
            )
            .unwrap()
        });
        let broker = control::SocketpairBroker::new(client).unwrap();
        assert_eq!(installed(&broker, 1).is_ok(), passes);
        #[cfg(all(feature = "testing", debug_assertions))]
        let broker = {
            let broker = broker.with_installed_input_validation();
            let packet = open(vec![conn::field(5, [1; 16])]);
            assert_eq!(
                crate::hooks::Sessions::call(&broker, 6, &packet[1..]).is_ok(),
                passes
            );
            assert_eq!(
                observed.load(std::sync::atomic::Ordering::SeqCst),
                usize::from(!passes)
            );
            broker
        };
        #[cfg(not(all(feature = "testing", debug_assertions)))]
        assert_eq!(observed.load(std::sync::atomic::Ordering::SeqCst), 0);
        drop(broker);
        worker.join().unwrap();
    }
}

#[test]
fn fatal_profiles_end_the_original_private_channel() {
    struct Guard;
    impl control::Controls for Guard {
        fn session(&mut self, _: super::request::Request) -> io::Result<Vec<u8>> {
            panic!("invalid frame reached provider")
        }
        fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
            panic!()
        }
        fn thaw(&mut self) -> io::Result<()> {
            panic!()
        }
        fn kill(&mut self) -> io::Result<u16> {
            panic!()
        }
    }
    for length in [1, 4, 8, 65537, 65561, 70000] {
        let (server, client) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let worker = std::thread::spawn(move || {
            assert_eq!(
                control::serve(&server, &mut Guard).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        });
        let broker = control::SocketpairBroker::new(client).unwrap();
        assert!(broker.acceptance_fatal(9).is_err());
        broker.acceptance_fatal(length).unwrap();
        assert_eq!(broker.acceptance_body(21, &[]).unwrap_err().code, 12);
        worker.join().unwrap();
    }
}

#[cfg(all(feature = "testing", debug_assertions))]
#[test]
fn framing_profiles_accept_only_literal_installed_commands() {
    for (command, length) in [
        (
            "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-1",
            1,
        ),
        (
            "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-4",
            4,
        ),
        (
            "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-8",
            8,
        ),
        (
            "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-65537",
            65537,
        ),
        (
            "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-65561",
            65561,
        ),
        (
            "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-70000",
            70000,
        ),
    ] {
        let argv = vec!["/bin/sh".into(), "-c".into(), command.into()];
        assert_eq!(fatal_profile(&argv), Some(length));
        let mut extra = argv.clone();
        extra.push("extra".into());
        assert_eq!(fatal_profile(&extra), None);
        let mut branch_shell = argv.clone();
        branch_shell[0] = "/workspace/sh".into();
        assert_eq!(fatal_profile(&branch_shell), None);
        let mut combined = argv;
        combined[2].push_str("; touch /etc/canary");
        assert_eq!(fatal_profile(&combined), None);
    }
    for argv in [
        vec![],
        vec!["/bin/sh".into()],
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "/opt/smithers/bin/smithers-machined ssh-acceptance-framing-9".into(),
        ],
    ] {
        assert_eq!(fatal_profile(&argv), None);
    }
}
