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
