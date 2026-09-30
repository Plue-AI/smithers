//! Stable-Rust parser-only fuzz target. Never calls call_json or filesystem ops.
//! Replay with SMITHERS_ABI_SEED / SMITHERS_ABI_CASES. No nightly dependency.
use std::panic::{self, AssertUnwindSafe};

use flows_jj::protocol::Request;
use serde_json::{Value, json};

#[path = "support/parser_corpus.rs"]
mod corpus;

// Reconstruct the parsed fields independently, so accepting a request while
// dropping, swapping, or corrupting a field fails the grammar oracle.
fn fields(request: Request) -> Value {
    match request {
        Request::Init { root } => json!({"op":"init","root":root}),
        Request::Snapshot { root, message } => {
            json!({"op":"snapshot","root":root,"message":message})
        }
        Request::Restore { root, change_id } => {
            json!({"op":"restore","root":root,"changeId":change_id})
        }
        Request::Diff { root, from, to } => json!({"op":"diff","root":root,"from":from,"to":to}),
        Request::WorkspaceAdd { root, name, path } => {
            json!({"op":"workspaceAdd","root":root,"name":name,"path":path})
        }
        Request::WorkspaceForget { root, name } => {
            json!({"op":"workspaceForget","root":root,"name":name})
        }
        Request::Status { root } => json!({"op":"status","root":root}),
        Request::OpRestore { root, operation_id } => {
            json!({"op":"opRestore","root":root,"operationId":operation_id})
        }
    }
}

fn parameter(name: &str, fallback: u32, maximum: u32) -> u32 {
    let value =
        std::env::var(name).map_or(fallback, |text| text.parse().expect("unsigned integer"));
    assert!(value <= maximum, "{name} exceeds {maximum}");
    value
}

#[test]
fn generated_parser_campaign() {
    let seed = parameter("SMITHERS_ABI_SEED", 20_260_904, u32::MAX);
    let cases = parameter("SMITHERS_ABI_CASES", 256, 100_000);
    assert!(cases > 0);
    let mut state = seed;
    let mut report = json!({"schemaVersion":1,"tier":"parser","status":"running","seed":seed,
        "requestedCases":cases,"executedRawCases":0,"executedGrammarCases":0});
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        for index in 0..cases {
            // Length boundaries plus arbitrary lengths, including inputs much
            // larger than the old 256-byte raw corpus. No rejection filter:
            // valid random inputs must also be safe to parse and drop.
            let length = match index % 10 {
                0 => 0,
                1 => 1,
                2 => 255,
                3 => 256,
                4 => 257,
                5 => 65_535,
                6 => 65_536,
                7 => 65_537,
                _ => (corpus::next(&mut state) % 4097) as usize,
            };
            let bytes: Vec<u8> = (0..length)
                .map(|_| (corpus::next(&mut state) >> 24) as u8)
                .collect();
            report["pendingIndex"] = json!(index);
            report["pendingKind"] = json!("raw");
            report["pendingInputHex"] = json!(
                bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            let parsed = serde_json::from_slice::<Request>(&bytes);
            // Value coalesces duplicate keys, whereas Request rejects them.
            // Compare fields only for inputs the typed parser accepts; rejected
            // input needs to parse and drop safely, not match a lossy oracle.
            if let Ok(a) = parsed {
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                let b: Request = serde_json::from_value(value).unwrap();
                assert_eq!(fields(a), fields(b));
            }
            report["executedRawCases"] = json!(index + 1);

            report["pendingKind"] = json!("grammar");
            let expected = corpus::request(seed, index);
            let encoded = serde_json::to_vec(&expected).unwrap();
            report["pendingInputHex"] = json!(
                encoded
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            assert_eq!(fields(serde_json::from_slice(&encoded).unwrap()), expected);
            let rejected = corpus::rejected(seed, index);
            report["pendingInputHex"] = json!(
                rejected
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            assert!(
                serde_json::from_slice::<Request>(&rejected).is_err(),
                "accepted hostile grammar seed={seed} index={index}"
            );
            report["executedGrammarCases"] = json!(index + 1);
        }
    }));
    report["status"] = json!(if result.is_ok() { "passed" } else { "failed" });
    if let Some(directory) = std::env::var_os("SMITHERS_ABI_ARTIFACT_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::PathBuf::from(directory).join("parser.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
    }
    if let Err(cause) = result {
        panic::resume_unwind(cause);
    }
    println!("ABI_CAMPAIGN_PARSER seed={seed} raw={cases} grammar={cases}");
}

#[test]
fn parser_byte_boundaries_and_optional_fields() {
    let complete = br#"{"op":"status","root":"/parser-only"}"#;
    let mut storage = complete.to_vec();
    storage.push(0);
    assert!(serde_json::from_slice::<Request>(&storage[..complete.len() - 1]).is_err());
    assert_eq!(
        fields(serde_json::from_slice(&storage[..complete.len()]).unwrap()),
        json!({"op":"status","root":"/parser-only"})
    );
    assert!(serde_json::from_slice::<Request>(&storage).is_err());
    for message in ["", ",\"message\":null"] {
        let bytes = format!("{{\"op\":\"snapshot\",\"root\":\"/parser-only\"{message}}}");
        assert_eq!(
            fields(serde_json::from_slice(bytes.as_bytes()).unwrap()),
            json!({"op":"snapshot","root":"/parser-only","message":null})
        );
    }
    for suffix in [" ", "\n", "\t\r\n"] {
        let bytes = [complete.as_slice(), suffix.as_bytes()].concat();
        assert!(serde_json::from_slice::<Request>(&bytes).is_ok());
    }
    for root in [
        r#""\ud800""#,
        r#""\udfff""#,
        "1e400",
        "18446744073709551616",
    ] {
        let bytes = format!("{{\"op\":\"status\",\"root\":{root}}}");
        assert!(serde_json::from_slice::<Request>(bytes.as_bytes()).is_err());
    }
}
