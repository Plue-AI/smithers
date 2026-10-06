use smithers_machined::{
    client,
    conn::{self, Frame},
    hooks::Actor,
};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
};
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}
#[test]
fn client_write_refusal_over_local_socket_and_actor_from_run() {
    let request = client::request(
        &args(&["write-file", "a", "--base", "absent"]),
        &mut &b"new"[..],
    )
    .unwrap();
    let (_, method, body) = request.request().unwrap();
    assert_eq!(method, 3);
    let write = conn::local_write_args(body, "trusted-run".into()).unwrap();
    assert_eq!(write.actor, Actor::Run("trusted-run".into()));
    assert_eq!(write.content, b"new");
    let (mut caller, mut server) = UnixStream::pair().unwrap();
    let expected = request.encode_local().unwrap();
    let thread = std::thread::spawn(move || {
        let mut bytes = vec![0; expected.len()];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, expected);
        let response = smithers_machined::daemon::refused(
            1,
            smithers_machined::hooks::Error {
                code: 4,
                current_digest: Some([9; 32]),
                ..smithers_machined::hooks::Error::unsupported()
            },
        );
        response.write(&mut server).unwrap();
    });
    let mut output = vec![];
    assert!(!client::exchange(&mut caller, &request, &mut output).unwrap());
    assert_eq!(
        String::from_utf8(output).unwrap(),
        format!(
            "{{\"error\":{{\"code\":\"stale\",\"current_digest\":\"{}\"}}}}\n",
            "09".repeat(32)
        )
    );
    thread.join().unwrap();
}
#[test]
fn forged_actor_refused_before_write() {
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/backend/internal/compose/testdata/cocontracts/req_write_file.bin"
    ))
    .to_vec();
    assert_eq!(
        Frame::decode_local(&bytes),
        Err(conn::ProtocolError::UnknownField)
    );
    let frame = Frame::decode(&bytes).unwrap();
    assert!(conn::local_write_args(frame.request().unwrap().2, "trusted".into()).is_err());
}
#[test]
fn client_read_binary_and_rejects_bad_arguments() {
    for values in [
        &["read-file", "../escape"][..],
        &["write-file", "a"][..],
        &["write-file", "a", "--base", "bad"][..],
    ] {
        assert!(client::request(&args(values), &mut &b""[..]).is_err());
    }
    let request = client::request(&args(&["read-file", "a"]), &mut &b""[..]).unwrap();
    let (mut caller, mut server) = UnixStream::pair().unwrap();
    let expected = request.encode_local().unwrap();
    let thread = std::thread::spawn(move || {
        let mut bytes = vec![0; expected.len()];
        server.read_exact(&mut bytes).unwrap();
        let response = smithers_machined::daemon::response(
            1,
            2,
            conn::structure_bytes(&[
                conn::field(1, [0, 0, 0, 4, 0, 255, 1, 128]),
                conn::field(2, [7; 32]),
                conn::field(3, 420u32.to_be_bytes()),
            ]),
        );
        server.write_all(&response.encode().unwrap()).unwrap();
    });
    let mut output = vec![];
    assert!(client::exchange(&mut caller, &request, &mut output).unwrap());
    let json: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(json["content_b64"], "AP8BgA==");
    assert_eq!(json["mode"], 420);
    thread.join().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn kernel_peer_must_be_agent_in_a_registered_cgroup() {
    struct Runs;
    impl smithers_machined::hooks::Sessions for Runs {
        fn run_of_cgroup(&self, path: &str) -> Option<String> {
            (path == "/smithers/sessions/7").then(|| "run-7".into())
        }
    }
    use smithers_machined::local::run_for_peer;
    assert_eq!(
        run_for_peer(19999, "0::/smithers/sessions/7\n", &Runs).unwrap(),
        "run-7"
    );
    for (uid, groups) in [
        (0, "0::/smithers/sessions/7"),
        (20001, "0::/smithers/sessions/7"),
        (19999, "0::/smithers/sessions/8"),
        (19999, "0::/other/7"),
        (19999, "0::/smithers/sessions/7\n0::/smithers/sessions/8"),
    ] {
        assert_eq!(run_for_peer(uid, groups, &Runs).unwrap_err().code, 11);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn local_open_refuses_identity_and_kind_selection() {
    use smithers_machined::local::validate_open;
    fn string(s: &str) -> Vec<u8> {
        [(s.len() as u16).to_be_bytes().as_slice(), s.as_bytes()].concat()
    }
    for (login, uid, kind, allowed) in [
        ("agent", 19999u32, 1u8, true),
        ("agent", 19999, 2, false),
        ("agent", 19999, 3, false),
        ("ben", 20001, 1, false),
        ("root", 0, 1, false),
        ("agent", 20001, 1, false),
    ] {
        let body = conn::structure_bytes(&[
            conn::field(
                1,
                conn::structure_bytes(&[
                    conn::field(1, string(login)),
                    conn::field(2, uid.to_be_bytes()),
                ]),
            ),
            conn::field(2, [kind]),
        ]);
        assert_eq!(
            validate_open(&body).is_ok(),
            allowed,
            "{login}:{uid} kind {kind}"
        );
    }
    for bytes in [vec![], vec![0; 65_537]] {
        assert!(validate_open(&bytes).is_err());
    }
}
