//! Test-only process adapter exercising the exported C ABI, not a product route.
use base64::prelude::{Engine as _, BASE64_STANDARD as B64};
use smithers_ffi::live_document::*;
use std::io::{self, Read};
fn take(r: LdResult) -> Vec<u8> {
    assert_eq!(r.status, 0);
    let bytes = unsafe { std::slice::from_raw_parts(r.data, r.len) }.to_vec();
    unsafe { ld_free(r) };
    bytes
}
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let input: serde_json::Value = serde_json::from_str(&input).unwrap();
    let state = input["state"]
        .as_str()
        .map(|s| B64.decode(s).unwrap())
        .unwrap_or_default();
    let kind = input["kind"].as_u64().unwrap_or(0) as u32;
    let root = if kind == 0 { "content" } else { "markdown" };
    let h = unsafe { ld_open(kind, state.as_ptr(), state.len()) };
    assert_ne!(h, 0);
    for (id, actor) in [(11, "alice"), (22, "bob")] {
        take(unsafe { ld_set_author(h, id, actor.as_ptr(), actor.len()) });
    }
    if let Some(update) = input["update"].as_str() {
        let update = B64.decode(update).unwrap();
        let client = if input["actor"] == "alice" { 11 } else { 22 };
        take(unsafe { ld_apply(h, client, update.as_ptr(), update.len()) });
    }
    let sv = input["sv"]
        .as_str()
        .map(|s| B64.decode(s).unwrap())
        .unwrap_or_else(|| vec![0]);
    let sync = take(unsafe { ld_sync2(h, sv.as_ptr(), sv.len()) });
    println!(
        "{}",
        serde_json::json!({"state":B64.encode(take(ld_state(h))),"sv":B64.encode(take(ld_sync1(h))),
        "sync":B64.encode(sync),
        "text":String::from_utf8(take(unsafe { ld_text(h,root.as_ptr(),root.len()) })).unwrap()})
    );
    take(ld_close(h));
}
