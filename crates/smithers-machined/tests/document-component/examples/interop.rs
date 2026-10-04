//! Test-only JSON process harness, not a daemon wire format or runtime entry point.
use base64::prelude::{Engine as _, BASE64_STANDARD as B64};
use smithers_document_component::{authors, core};
use std::io::{self, Read};
use yrs::updates::encoder::Encode;
use yrs::{GetString, Map, ReadTxn, Text, Transact};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let input: serde_json::Value = serde_json::from_str(&input).unwrap();
    let doc = core::document(None);
    let text = doc.get_or_insert_text("content");
    let map = doc.get_or_insert_map("authors");
    if let Some(state) = input["state"].as_str() {
        core::apply(&doc, core::decode(&B64.decode(state).unwrap()).unwrap()).unwrap();
        let update = B64.decode(input["update"].as_str().unwrap()).unwrap();
        authors::checked_actor_update(&doc, &update, input["actor"].as_str().unwrap()).unwrap();
        core::apply(&doc, core::decode(&update).unwrap()).unwrap();
    } else {
        let mut txn = doc.transact_mut();
        map.insert(&mut txn, "11", "alice");
        map.insert(&mut txn, "22", "bob");
        text.insert(&mut txn, 0, "Start 🦀\n");
    }
    core::validate(&doc, "content", true).unwrap();
    let txn = doc.transact();
    println!(
        "{}",
        serde_json::json!({ "state": B64.encode(core::state(&doc)),
        "sv":B64.encode(txn.state_vector().encode_v1()), "text":text.get_string(&txn) })
    );
}
