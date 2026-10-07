use smithers_machined::conn::{Frame, ProtocolError};
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
fn fixtures(ok: bool) {
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root().join("MANIFEST.json")).unwrap()).unwrap();
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
fn nonce_hmac_proof_is_bound_to_boot_and_secret() {
    use smithers_machined::conn::{host_mac, verify_host_mac};
    let expected = hex("9aa6c9a2700eaf0ab0273ca2e43138f0733aaca5d40ced66734236de8f1e8173");
    let got = host_mac(b"secret", &[0x44; 16], &[0x33; 32]);
    assert_eq!(got.as_slice(), expected);
    assert!(verify_host_mac(b"secret", &[0x44; 16], &[0x33; 32], &got));
    assert!(!verify_host_mac(b"other", &[0x44; 16], &[0x33; 32], &got));
    assert!(!verify_host_mac(b"secret", &[0x45; 16], &[0x33; 32], &got));
    assert!(!verify_host_mac(b"secret", &[0x44; 16], &[0x34; 32], &got));
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
