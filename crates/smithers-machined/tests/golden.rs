#![cfg(feature = "testing")]
//! Independent L1 fixture oracles; serde is enabled only for testing projections.
use smithers_machined::{
    conn::{Frame, ProtocolError},
    msg::{Direction, Message},
};
use std::path::PathBuf;
fn direction(value: &str) -> Direction {
    match value {
        "host_to_daemon" | "host->daemon" => Direction::HostToDaemon,
        "daemon_to_host" | "daemon->host" => Direction::DaemonToHost,
        "local" => Direction::Local,
        _ => panic!("unknown L1 direction {value}"),
    }
}
fn refusal(name: &str) -> ProtocolError {
    use ProtocolError::*;
    match name {
        "truncated" => Truncated,
        "frame_too_large" => FrameTooLarge,
        "unknown_kind" => UnknownKind,
        "bad_stream" => BadStream,
        "unknown_message" => UnknownMessage,
        "unknown_method" => UnknownMethod,
        "unknown_field" => UnknownField,
        "unordered_field" => UnorderedField,
        "missing_field" => MissingField,
        "trailing_bytes" => TrailingBytes,
        "bad_utf8" => BadUtf8,
        "bad_value" => BadValue,
        "version_mismatch" => VersionMismatch,
        "auth_failed" => AuthFailed,
        "superseded" => Superseded,
        "handshake_order" => HandshakeOrder,
        _ => panic!("unknown L1 refusal {name}"),
    }
}
#[test]
fn wire_golden_frames() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/backend/internal/compose/testdata/cocontracts");
    if !root.join("MANIFEST.json").exists() {
        eprintln!("WAITING on T-COL-03r L1: independent ADR 0004 golden frames are not on main");
        return;
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("MANIFEST.json")).unwrap()).unwrap();
    assert_eq!(manifest["protocol"], 1);
    assert_eq!(manifest["yrs"], "=0.27.4");
    let frames = manifest["frames"].as_array().expect("L1 frames list");
    assert!(!frames.is_empty());
    for entry in frames {
        let name = entry["name"].as_str().unwrap();
        let bytes = std::fs::read(root.join(format!("{name}.bin"))).unwrap();
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(&bytes);
        let hash: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(entry["sha256"], hash, "{name} hash");
        let d = direction(entry["direction"].as_str().unwrap());
        let decoded = Frame::decode(&bytes).and_then(|f| {
            if d == Direction::Local {
                smithers_machined::msg::local_request(&f, "golden-run").map(|r| {
                    (
                        f.stream,
                        Message::Control(smithers_machined::msg::Control::Request(r)),
                    )
                })
            } else {
                Message::decode(&f, d).map(|m| (f.stream, m))
            }
        });
        let expected = entry["expected"].as_str().unwrap();
        if expected != "ok" {
            assert_eq!(decoded.unwrap_err(), refusal(expected), "{name}");
            continue;
        }
        // Test-only externally tagged Rust projection. L1 supplies the independent
        // JSON; a schema mismatch is an explicit continuation failure, never a skip.
        let oracle: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join(format!("{name}.json"))).unwrap())
                .unwrap();
        let value: Message =
            serde_json::from_value(oracle["message"].clone()).expect("L1 JSON message projection");
        let stream = oracle["stream"].as_u64().unwrap() as u32;
        assert_eq!(decoded.unwrap(), (stream, value.clone()), "{name} decode");
        assert_eq!(
            value.frame(stream, d).unwrap().encode().unwrap(),
            bytes,
            "{name} encode"
        );
    }
}
#[test]
fn independent_json_oracle_is_not_produced_by_the_encoder() {
    // ADR 0004 printed Ack seq7 applied, both oracles are committed literals.
    let oracle =
        r#"{"Events":{"Ack":{"seq":7,"outcome":1,"oids":null,"error":null,"haves":null}}}"#;
    let expected = [
        0, 0, 0, 16, 2, 0, 0, 0, 0, 3, 0, 0, 0, 11, 1, 0, 0, 0, 0, 0, 0, 0, 7, 2, 1,
    ];
    let value: Message = serde_json::from_str(oracle).unwrap();
    assert_eq!(
        Message::decode(&Frame::decode(&expected).unwrap(), Direction::HostToDaemon).unwrap(),
        value
    );
    assert_eq!(
        value
            .frame(0, Direction::HostToDaemon)
            .unwrap()
            .encode()
            .unwrap(),
        expected
    );
}
