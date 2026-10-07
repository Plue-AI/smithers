use smithers_machined::conn::{self, Frame, ProtocolError};
use std::path::PathBuf;
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/backend/internal/compose/testdata/cocontracts")
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn manifest() -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(root().join("MANIFEST.json")).unwrap()).unwrap()
}
struct Vector {
    secret: Vec<u8>,
    boot: [u8; 16],
    nonce: [u8; 32],
    mac: Vec<u8>,
    input: Vec<u8>,
}
fn vector(manifest: &serde_json::Value, name: &str) -> Vector {
    let v = &manifest["handshake_vectors"][name];
    let field = |k: &str| hex(v[k].as_str().unwrap_or_else(|| panic!("vector {name}.{k}")));
    Vector {
        secret: field("secret"),
        boot: field("boot_id").try_into().unwrap(),
        nonce: field("nonce").try_into().unwrap(),
        mac: field("mac"),
        input: field("mac_input"),
    }
}
/// A HostProof answering a committed challenge: the production verifier must
/// accept exactly the vector's mac.
fn proof_verifies(manifest: &serde_json::Value, entry: &serde_json::Value, frame: &Frame) -> bool {
    let v = vector(manifest, entry["vector"].as_str().unwrap());
    let fields = conn::fields("proof", &frame.payload[1..]).unwrap();
    conn::verify_host_mac(&v.secret, conn::PROTOCOL, &v.boot, &v.nonce, fields[1].1)
}
fn fixtures(ok: bool) {
    let manifest = manifest();
    for entry in manifest["frames"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        let expected = entry["expected"].as_str().unwrap();
        if (expected == "ok") != ok {
            continue;
        };
        let bytes = std::fs::read(root().join(format!("{name}.bin"))).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root().join(format!("{name}.json"))).unwrap())
                .unwrap();
        let decoded = if entry["local"].as_bool() == Some(true) {
            Frame::decode_local(&bytes)
        } else {
            Frame::decode(&bytes)
        };
        if ok {
            let frame = decoded.unwrap_or_else(|e| panic!("{name}: {e:?}"));
            // A current-protocol proof verifies exactly when no handshake
            // refusal is recorded; version refusals run as refusal_sequences.
            let handshake = entry["handshake"].as_str();
            if entry["vector"].is_string()
                && frame.payload[0] == 2
                && handshake != Some("version_mismatch")
            {
                assert_eq!(
                    proof_verifies(&manifest, entry, &frame),
                    handshake.is_none(),
                    "{name}"
                );
            }
            let literal = Frame {
                kind: json["kind"].as_u64().unwrap() as u8,
                stream: json["stream"].as_u64().unwrap() as u32,
                payload: hex(json["payload"].as_str().unwrap()),
            };
            assert_eq!(frame, literal, "{name}");
            let encoded = if entry["local"].as_bool() == Some(true) {
                literal.encode_local()
            } else {
                literal.encode()
            };
            assert_eq!(encoded.unwrap(), bytes, "{name}");
        } else {
            let err = match expected {
                "truncated" => ProtocolError::Truncated,
                "frame_too_large" => ProtocolError::FrameTooLarge,
                "unknown_kind" => ProtocolError::UnknownKind,
                "bad_stream" => ProtocolError::BadStream,
                "unknown_message" => ProtocolError::UnknownMessage,
                "unknown_method" => ProtocolError::UnknownMethod,
                "version_mismatch" => ProtocolError::VersionMismatch,
                "unknown_field" => ProtocolError::UnknownField,
                "unordered_field" => ProtocolError::UnorderedField,
                "missing_field" => ProtocolError::MissingField,
                "trailing_bytes" => ProtocolError::TrailingBytes,
                "bad_utf8" => ProtocolError::BadUtf8,
                "bad_value" => ProtocolError::BadValue,
                _ => panic!("unknown expected refusal"),
            };
            assert_eq!(decoded, Err(err), "{name}")
        }
    }
}
#[test]
fn wire_golden_frames() {
    fixtures(true)
}
#[test]
fn wire_refusals() {
    fixtures(false)
}
#[test]
fn header_refusal_order_and_bounded_read() {
    use std::io::{Cursor, Read};
    struct NoPayload(Cursor<Vec<u8>>);
    impl Read for NoPayload {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            assert!(self.0.position() < 9, "oversized payload was read");
            self.0.read(out)
        }
    }
    for (kind, stream, len, expected) in [
        (99, 1, 9999999, ProtocolError::UnknownKind),
        (1, 1, 9999999, ProtocolError::BadStream),
        (1, 0, 1114113, ProtocolError::FrameTooLarge),
    ] {
        let mut bytes = (len as u32).to_be_bytes().to_vec();
        bytes.push(kind);
        bytes.extend((stream as u32).to_be_bytes());
        assert_eq!(
            Frame::read(&mut NoPayload(Cursor::new(bytes))),
            Err(expected)
        );
    }
}
#[test]
fn all_truncations_refuse_without_panicking() {
    let bytes = std::fs::read(root().join("req_write_file.bin")).unwrap();
    for n in 0..bytes.len() {
        assert_eq!(Frame::decode(&bytes[..n]), Err(ProtocolError::Truncated))
    }
}
#[test]
fn manifest_protocol_is_the_codec_protocol() {
    assert_eq!(manifest()["protocol"].as_u64(), Some(conn::PROTOCOL as u64));
}
/// The committed vectors were computed with Python's hmac from the ADR text.
#[test]
fn host_proof_matches_committed_hmac_vectors() {
    use smithers_machined::conn::{host_mac, verify_host_mac, PROTOCOL};
    let manifest = manifest();
    let names: Vec<String> = manifest["handshake_vectors"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert!(!names.is_empty());
    for name in names {
        let v = vector(&manifest, &name);
        let input = [
            b"smithers-machined host".as_slice(),
            &PROTOCOL.to_be_bytes(),
            &v.boot,
            &v.nonce,
        ]
        .concat();
        assert_eq!(input, v.input, "{name} mac input");
        let got = host_mac(&v.secret, PROTOCOL, &v.boot, &v.nonce);
        assert_eq!(got.as_slice(), v.mac, "{name}");
        assert!(verify_host_mac(
            &v.secret, PROTOCOL, &v.boot, &v.nonce, &got
        ));
        let mut bad = got;
        bad[31] ^= 1;
        assert!(!verify_host_mac(
            &v.secret, PROTOCOL, &v.boot, &v.nonce, &bad
        ));
        assert!(!verify_host_mac(
            &v.secret,
            PROTOCOL - 1,
            &v.boot,
            &v.nonce,
            &got
        ));
        assert!(!verify_host_mac(
            b"other", PROTOCOL, &v.boot, &v.nonce, &got
        ));
    }
}
/// Daemon-detected handshake refusals run through the production daemon
/// handshake (`link::authenticate`) over TCP. The daemon's nonce is random, so
/// its Challenge is compared up to the nonce; every host frame is the
/// committed bytes; the daemon must end with `Goodbye{expected}`.
#[test]
fn daemon_handshake_refusals_match_corpus() {
    use smithers_machined::link::{self, Identity};
    use std::net::{TcpListener, TcpStream};
    let manifest = manifest();
    let v = vector(&manifest, "a");
    let mut ran = 0;
    for (name, seq) in manifest["refusal_sequences"].as_object().unwrap() {
        if seq["by"] != "daemon" {
            continue;
        }
        ran += 1;
        let expected = match seq["expected"].as_str().unwrap() {
            "handshake_order" => ProtocolError::HandshakeOrder,
            "version_mismatch" => ProtocolError::VersionMismatch,
            "auth_failed" => ProtocolError::AuthFailed,
            other => panic!("{name}: {other}"),
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let identity = Identity::new(
            v.boot,
            v.secret.clone().try_into().unwrap(),
            b"boot-token".to_vec(),
        )
        .unwrap();
        let daemon = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            link::authenticate(socket, &identity, 7, &[1]).err()
        });
        let mut host = TcpStream::connect(addr).unwrap();
        host.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        for step in seq["steps"].as_array().unwrap() {
            let frame = step["frame"].as_str().unwrap();
            let bytes = std::fs::read(root().join(format!("{frame}.bin"))).unwrap();
            if frame.starts_with("hello_challenge") {
                let got = Frame::read(&mut host).unwrap().encode().unwrap();
                // magic, protocol and boot_id are fixed; the 32-byte nonce is random.
                assert_eq!(got[..got.len() - 32], bytes[..bytes.len() - 32], "{name}");
            } else {
                std::io::Write::write_all(&mut host, &bytes).unwrap();
            }
        }
        assert_eq!(daemon.join().unwrap(), Some(expected), "{name}");
        let goodbye = Frame::read(&mut host).unwrap();
        assert_eq!(
            goodbye.payload,
            vec![5, 0, 0, 0, 2, 1, expected as u8],
            "{name}"
        );
    }
    assert!(ran > 0, "no daemon-detected refusal sequences");
}

#[test]
fn sequenced_document_golden_payloads() {
    use smithers_machined::document_payload::Document;
    for (name, seq) in [
        ("doc-input-v2", 0x0102030405060708),
        ("doc-saved-v2", 0x0102030405060708),
        ("doc-input-v2-zero", 0),
        ("doc-saved-v2-max", u64::MAX),
    ] {
        let bytes = std::fs::read(root().join(format!("{name}.bin"))).unwrap();
        let f = Frame::decode(&bytes).unwrap();
        let d = Document::decode_v2(&f.payload).unwrap();
        if seq != 0 {
            assert!(d.encode().is_err());
        }
        let offset = if d.msg == 1 {
            assert_eq!(d.actor, b"Be");
            assert_eq!(d.seq, seq);
            assert_eq!(d.data, [0, 2, 0]);
            13
        } else {
            assert_eq!(d.at_ms, 1791028800000);
            assert_eq!(d.through_seq, seq);
            assert_eq!(d.data, [1, 42, 1]);
            9
        };
        assert_eq!(d.encode_v2().unwrap(), f.payload);
        for n in 0..8 {
            assert!(Document::decode_v2(&f.payload[..offset + n]).is_err());
        }
    }
    for name in [
        "doc-awareness-input",
        "doc-sync",
        "doc-awareness",
        "doc-epoch",
        "doc-gone",
        "doc-renamed",
        "doc-unsupported-detail",
    ] {
        let bytes = std::fs::read(root().join(format!("{name}.bin"))).unwrap();
        let d = Document::decode_v2(&bytes[9..]).unwrap();
        assert_eq!(d, Document::decode(&bytes[9..]).unwrap());
        assert_eq!(d.encode_v2().unwrap(), bytes[9..]);
    }
    for msg in [1, 6] {
        assert!(Document {
            msg,
            actor: b"Be".to_vec(),
            data: vec![0; (4 << 20) - 9],
            ..Default::default()
        }
        .encode_v2()
        .is_err());
    }
}

#[test]
fn protocol_three_admission_has_literal_cross_language_fields() {
    use smithers_machined::broker::{
        request::Request,
        sessions::{Admission, Kind, User},
    };
    let bytes=hex("00000047010000000001000000420100000009020600000037010000000d0100056167656e740200004e1f02020300010005636f646578050102030405060708090a0b0c0d0e0f1006000572756e2d31");
    let frame = Frame::decode(&bytes).unwrap();
    let (id, method, args) = frame.request().unwrap();
    assert_eq!((id, method), (9, 6));
    assert_eq!(
        Request::decode(method, args).unwrap(),
        Request::Open {
            user: User {
                login: "agent".into(),
                uid: 19999
            },
            kind: Kind::Exec,
            argv: vec!["codex".into()],
            size: None,
            admission: Some(Admission {
                principal: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
                run: Some("run-1".into())
            })
        }
    );
    assert_eq!(frame.encode().unwrap(), bytes);
}

#[test]
fn protocol_four_session_cancellation_has_literal_cross_language_fields() {
    use smithers_machined::broker::request::Request;
    let bytes = hex("0000001b01000000000100000016010000000902090000000b0103000000050100000007");
    let frame = Frame::decode(&bytes).unwrap();
    let (id, method, args) = frame.request().unwrap();
    assert_eq!((id, method), (9, 9));
    assert_eq!(
        Request::decode(method, args).unwrap(),
        Request::KillSession(7)
    );
    assert_eq!(
        Frame::decode_local(&bytes),
        Err(ProtocolError::UnknownMethod)
    );
    assert_eq!(frame.encode().unwrap(), bytes);
    for bad in [0u32, 0x8000_0000, u32::MAX] {
        let args = conn::structure_bytes(&[conn::field(
            1,
            [
                vec![3],
                conn::structure_bytes(&[conn::field(1, bad.to_be_bytes())]),
            ]
            .concat(),
        )]);
        assert!(Request::decode(9, &args).is_err());
    }
}
