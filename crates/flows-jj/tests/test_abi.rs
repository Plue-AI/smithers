//! Tests for the JSON ABI layer itself: request parsing, response shapes,
//! and error classification as seen across the `flows_jj_call` boundary.
//!
//! `abi::call_json` is exactly `flows_jj_call` minus the wasm pointer
//! packing, which only compiles on wasm32.

use std::fs;
use std::path::PathBuf;

use flows_jj::abi::call_json;
use serde_json::Value;
use serde_json::json;
use tempfile::TempDir;

fn call(request: &Value) -> Value {
    let response = call_json(serde_json::to_string(request).unwrap().as_bytes());
    serde_json::from_slice(&response).expect("response must be valid JSON")
}

fn temp_root() -> (TempDir, PathBuf) {
    let temp_dir = tempfile::Builder::new()
        .prefix("flows-jj-abi-test-")
        .tempdir()
        .unwrap();
    let root = temp_dir.path().join("repo");
    (temp_dir, root)
}

#[test]
fn malformed_json_is_an_unknown_error() {
    let response = call_json(b"{not json");
    let value: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(value["err"]["code"], "unknown");
    assert!(
        value["err"]["message"]
            .as_str()
            .unwrap()
            .contains("malformed request"),
        "{value}"
    );
    assert_eq!(value["err"]["command"], "jj");
}

#[test]
fn empty_input_is_an_unknown_error() {
    let value: Value = serde_json::from_slice(&call_json(b"")).unwrap();
    assert_eq!(value["err"]["code"], "unknown");
}

#[test]
fn unknown_op_is_an_unknown_error() {
    let value = call(&json!({"op": "frobnicate", "root": "/nowhere"}));
    assert_eq!(value["err"]["code"], "unknown");
}

#[test]
fn missing_field_is_an_unknown_error() {
    let value = call(&json!({"op": "restore", "root": "/nowhere"}));
    assert_eq!(value["err"]["code"], "unknown");
    assert!(
        value["err"]["message"]
            .as_str()
            .unwrap()
            .contains("changeId"),
        "message should name the missing field: {value}"
    );
}

#[test]
fn full_roundtrip_through_the_abi() {
    let (_temp, root) = temp_root();
    let root_str = root.to_str().unwrap();

    // init → {"ok":{}}
    let value = call(&json!({"op": "init", "root": root_str}));
    assert_eq!(value, json!({"ok": {}}));

    // snapshot → {"ok":{"commitId":"...","changeId":"..."}}
    fs::write(root.join("a.txt"), "alpha\n").unwrap();
    let value = call(&json!({"op": "snapshot", "root": root_str, "message": "first"}));
    let change_id = value["ok"]["changeId"]
        .as_str()
        .expect("changeId")
        .to_owned();
    assert_eq!(change_id.len(), 12);
    let commit_id = value["ok"]["commitId"]
        .as_str()
        .expect("commitId")
        .to_owned();
    // SimpleBackend commit ids are BLAKE2b-512: 128 hex characters.
    assert_eq!(commit_id.len(), 128);
    assert!(commit_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(value["ok"].as_object().unwrap().len(), 3);

    // snapshot without message is valid (optional field).
    fs::write(root.join("a.txt"), "alpha two\n").unwrap();
    let value = call(&json!({"op": "snapshot", "root": root_str}));
    let s2 = value["ok"]["commitId"]
        .as_str()
        .expect("changeId")
        .to_owned();
    assert_ne!(s2, commit_id);
    assert_eq!(value["ok"]["changeId"].as_str().unwrap(), change_id);
    assert_eq!(value["ok"]["operationId"].as_str().unwrap().len(), 128);

    // diff → {"ok":{"diff":"..."}}
    let value = call(&json!({"op": "diff", "root": root_str, "from": commit_id, "to": s2}));
    let diff = value["ok"]["diff"].as_str().expect("diff");
    assert!(diff.contains("diff --git a/a.txt b/a.txt"), "{diff}");
    assert!(diff.contains("-alpha"), "{diff}");
    assert!(diff.contains("+alpha two"), "{diff}");

    // status → {"ok":{"status":"..."}}
    let value = call(&json!({"op": "status", "root": root_str}));
    let status = value["ok"]["status"].as_str().expect("status");
    assert!(status.contains("Working copy  (@) : "), "{status}");

    // restore → {"ok":{}}, by the immutable commit id
    let value = call(&json!({"op": "restore", "root": root_str, "changeId": commit_id}));
    assert_eq!(value, json!({"ok": {}}));
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "alpha\n");

    // workspaceAdd / workspaceForget → {"ok":{}}
    let lane = _temp.path().join("lane");
    let value = call(&json!({
        "op": "workspaceAdd",
        "root": root_str,
        "name": "lane",
        "path": lane.to_str().unwrap(),
    }));
    assert_eq!(value, json!({"ok": {}}));
    let value = call(&json!({"op": "workspaceForget", "root": root_str, "name": "lane"}));
    assert_eq!(value, json!({"ok": {}}));
}

#[test]
fn restore_to_unknown_id_reports_invalid_ref_with_command() {
    let (_temp, root) = temp_root();
    let root_str = root.to_str().unwrap();
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("a.txt"), "alpha\n").unwrap();
    assert_eq!(
        call(&json!({"op": "init", "root": root_str})),
        json!({"ok": {}})
    );
    call(&json!({"op": "snapshot", "root": root_str}));

    let value = call(&json!({"op": "restore", "root": root_str, "changeId": "kkkkkkkkkkkk"}));
    assert_eq!(value["err"]["code"], "invalid_ref");
    assert_eq!(value["err"]["command"], "jj restore --from kkkkkkkkkkkk");
    let message = value["err"]["message"].as_str().unwrap();
    assert!(message.contains("doesn't exist"), "{message}");
    // The message is bare: the TypeScript bridge prefixes `jj restore: `
    // unconditionally, so a crate-side prefix would surface doubled
    // ("jj restore: jj restore: ...").
    assert!(!message.starts_with("jj "), "{message}");
}

#[test]
fn diff_with_unknown_revision_reports_invalid_ref() {
    let (_temp, root) = temp_root();
    let root_str = root.to_str().unwrap();
    fs::create_dir_all(&root).unwrap();
    assert_eq!(
        call(&json!({"op": "init", "root": root_str})),
        json!({"ok": {}})
    );
    call(&json!({"op": "snapshot", "root": root_str}));

    let value = call(&json!({"op": "diff", "root": root_str, "from": "kkkkkkkkkkkk", "to": "@"}));
    assert_eq!(value["err"]["code"], "invalid_ref");
    assert_eq!(
        value["err"]["command"],
        "jj diff --from kkkkkkkkkkkk --to @ --git"
    );
}

#[test]
fn response_has_exactly_one_top_level_key() {
    let (_temp, root) = temp_root();
    let value = call(&json!({"op": "init", "root": root.to_str().unwrap()}));
    let object = value.as_object().unwrap();
    assert_eq!(object.len(), 1);
    assert!(object.contains_key("ok"));
}
