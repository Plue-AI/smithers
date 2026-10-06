//! I5: in-process Yjs v1 documents. See live_document.h for ownership and trust.
use crate::{document_core as core, live_document_decode::decode};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use yrs::sync::AwarenessUpdate;
use yrs::updates::encoder::Encode;
use yrs::{DeepObservable, Doc, GetString, Map, ReadTxn, StateVector, Transact};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_TEXT: usize = 1024 * 1024;
type Result<T> = std::result::Result<T, u32>;
struct Document {
    doc: Doc,
    root: &'static str,
}
static NEXT: AtomicU64 = AtomicU64::new(1);
type Documents = HashMap<u64, Arc<Mutex<Document>>>;
static DOCUMENTS: OnceLock<Mutex<Documents>> = OnceLock::new();
fn documents() -> &'static Mutex<Documents> {
    DOCUMENTS.get_or_init(Default::default)
}

/// status: 0 success, 1 refused, 2 invalid input/handle, 3 caught panic.
#[repr(C)]
pub struct LdResult {
    pub data: *mut u8,
    pub len: usize,
    pub status: u32,
}
fn boundary(f: impl FnOnce() -> Result<Vec<u8>>) -> LdResult {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(bytes)) => {
            let bytes = bytes.into_boxed_slice();
            let len = bytes.len();
            LdResult {
                data: Box::into_raw(bytes) as *mut u8,
                len,
                status: 0,
            }
        }
        result => LdResult {
            data: std::ptr::null_mut(),
            len: 0,
            status: match result {
                Ok(Err(status)) => status,
                _ => 3,
            },
        },
    }
}
// The caller must supply a readable allocation of len bytes, as for any C slice.
unsafe fn input<'a>(data: *const u8, len: usize) -> Result<&'a [u8]> {
    if len > MAX_BYTES || (len != 0 && data.is_null()) {
        return Err(2);
    }
    Ok(if len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(data, len) }
    })
}
fn with(h: u64, f: impl FnOnce(&mut Document) -> Result<Vec<u8>>) -> Result<Vec<u8>> {
    let doc = documents()
        .lock()
        .map_err(|_| 3u32)?
        .get(&h)
        .cloned()
        .ok_or(2u32)?;
    // Poisoned documents stay unavailable after panic; other documents remain usable.
    let mut doc = doc.lock().map_err(|_| 3u32)?;
    f(&mut doc)
}
fn restore(root: &'static str, state: &[u8]) -> Result<Doc> {
    let doc = core::document(None);
    doc.get_or_insert_text(root);
    doc.get_or_insert_map("authors");
    if !state.is_empty() {
        core::apply(&doc, decode(state).map_err(|_| 2u32)?).map_err(|_| 2u32)?;
    }
    core::validate(&doc, root, true).map_err(|_| 1u32)?;
    if doc.transact().has_missing_updates() {
        return Err(1);
    }
    if doc
        .get_or_insert_text(root)
        .get_string(&doc.transact())
        .len()
        > MAX_TEXT
    {
        return Err(1);
    }
    Ok(doc)
}

/// kind 0 = code/content, 1 = wiki/markdown. Zero means open failed.
#[no_mangle]
pub unsafe extern "C" fn ld_open(kind: u32, state: *const u8, len: usize) -> u64 {
    catch_unwind(AssertUnwindSafe(|| -> Result<u64> {
        let root = match kind {
            0 => "content",
            1 => "markdown",
            _ => return Err(2),
        };
        let doc = restore(root, unsafe { input(state, len)? })?;
        let h = NEXT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| 2u32)?;
        documents()
            .lock()
            .map_err(|_| 3u32)?
            .insert(h, Arc::new(Mutex::new(Document { doc, root })));
        Ok(h)
    }))
    .ok()
    .and_then(std::result::Result::ok)
    .unwrap_or(0)
}

/// Accept only the authenticated subscriber's new structs; known foreign structs
/// in a reconnect are allowed. The returned bytes are the broadcast update.
#[no_mangle]
pub unsafe extern "C" fn ld_apply(h: u64, client: u64, data: *const u8, len: usize) -> LdResult {
    boundary(|| {
        with(h, |entry| {
            let bytes = unsafe { input(data, len)? };
            if client > u32::MAX as u64 || client == entry.doc.client_id().get() {
                return Err(1);
            }
            let authors = entry.doc.get_or_insert_map("authors");
            if authors
                .get(&entry.doc.transact(), &client.to_string())
                .is_none()
            {
                return Err(1);
            }
            let update = decode::<yrs::Update>(bytes).map_err(|_| 2u32)?;
            let sv = entry.doc.transact().state_vector();
            if update
                .insertions(true)
                .iter()
                .any(|(id, ranges)| id.get() != client && ranges.iter().any(|r| r.end > sv.get(id)))
            {
                return Err(1);
            }
            // Validate before touching the live document, including delete-only writes.
            // A missing causal predecessor is refused and can be retried after sync;
            // otherwise a hidden pending authors write could be activated later.
            let scratch = restore(entry.root, &core::state(&entry.doc))?;
            let changed = Arc::new(AtomicBool::new(false));
            let signal = changed.clone();
            let _watch = scratch
                .get_or_insert_map("authors")
                .observe_deep(move |_, _| {
                    signal.store(true, Ordering::Relaxed);
                });
            core::apply(&scratch, update).map_err(|_| 2u32)?;
            core::validate(&scratch, entry.root, true).map_err(|_| 1u32)?;
            if changed.load(Ordering::Relaxed)
                || scratch.transact().has_missing_updates()
                || scratch
                    .get_or_insert_text(entry.root)
                    .get_string(&scratch.transact())
                    .len()
                    > MAX_TEXT
            {
                return Err(1);
            }
            let mut txn = entry.doc.transact_mut();
            txn.apply_update(decode(bytes).map_err(|_| 2u32)?)
                .map_err(|_| 2u32)?;
            // Never echo untrusted duplicates: their ids may be known here but
            // not yet known by a lagging peer. Broadcast only admitted changes.
            Ok(txn.encode_update_v1())
        })
    })
}
#[no_mangle]
pub extern "C" fn ld_sync1(h: u64) -> LdResult {
    boundary(|| with(h, |e| Ok(e.doc.transact().state_vector().encode_v1())))
}
#[no_mangle]
pub unsafe extern "C" fn ld_sync2(h: u64, data: *const u8, len: usize) -> LdResult {
    boundary(|| {
        with(h, |e| {
            let sv = decode::<StateVector>(unsafe { input(data, len)? }).map_err(|_| 2u32)?;
            Ok(e.doc.transact().encode_state_as_update_v1(&sv))
        })
    })
}
/// Awareness is transient. The authenticated host must stamp actor/colour and
/// restrict client ids before calling; this ABI deliberately has no socket identity.
/// Decode and canonicalize without storing awareness in durable document state.
#[no_mangle]
pub unsafe extern "C" fn ld_awareness(h: u64, data: *const u8, len: usize) -> LdResult {
    boundary(|| {
        with(h, |_| {
            let bytes = unsafe { input(data, len)? };
            if bytes.len() > 64 * 1024 {
                return Err(2);
            }
            let update = decode::<AwarenessUpdate>(bytes).map_err(|_| 2u32)?;
            for entry in update.clients.values() {
                let value: serde_json::Value =
                    serde_json::from_str(&entry.json).map_err(|_| 2u32)?;
                if !value.is_null() && !value.is_object() {
                    return Err(2);
                }
            }
            Ok(update.encode_v1())
        })
    })
}
/// Trusted host only. Returns the authors delta for broadcast to all peers.
#[no_mangle]
pub unsafe extern "C" fn ld_set_author(
    h: u64,
    client: u64,
    data: *const u8,
    len: usize,
) -> LdResult {
    boundary(|| {
        with(h, |e| {
            let actor = std::str::from_utf8(unsafe { input(data, len)? }).map_err(|_| 2u32)?;
            if actor.is_empty()
                || actor.len() > 4096
                || client > u32::MAX as u64
                || client == e.doc.client_id().get()
            {
                return Err(2);
            }
            let map = e.doc.get_or_insert_map("authors");
            if let Some(previous) = map.get(&e.doc.transact(), &client.to_string()) {
                if previous.to_string(&e.doc.transact()) != actor {
                    return Err(1);
                }
                return Ok(vec![0, 0]);
            }
            let mut txn = e.doc.transact_mut();
            map.insert(&mut txn, client.to_string(), actor);
            Ok(txn.encode_update_v1())
        })
    })
}
#[no_mangle]
pub extern "C" fn ld_state(h: u64) -> LdResult {
    boundary(|| with(h, |e| Ok(core::state(&e.doc))))
}
#[no_mangle]
pub unsafe extern "C" fn ld_text(h: u64, data: *const u8, len: usize) -> LdResult {
    boundary(|| {
        with(h, |e| {
            if unsafe { input(data, len)? } != e.root.as_bytes() {
                return Err(2);
            }
            Ok(e.doc
                .get_or_insert_text(e.root)
                .get_string(&e.doc.transact())
                .into_bytes())
        })
    })
}
#[no_mangle]
pub extern "C" fn ld_close(h: u64) -> LdResult {
    boundary(|| {
        documents()
            .lock()
            .map_err(|_| 3u32)?
            .remove(&h)
            .ok_or(2u32)?;
        Ok(vec![])
    })
}
/// Free exactly once, with the unchanged successful result returned by this ABI.
#[no_mangle]
pub unsafe extern "C" fn ld_free(result: LdResult) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !result.data.is_null() {
            unsafe {
                drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                    result.data,
                    result.len,
                )))
            };
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Text, WriteTxn};
    fn take(result: LdResult) -> Result<Vec<u8>> {
        let status = result.status;
        let bytes = if status == 0 {
            unsafe { std::slice::from_raw_parts(result.data, result.len) }.to_vec()
        } else {
            vec![]
        };
        unsafe { ld_free(result) };
        if status == 0 {
            Ok(bytes)
        } else {
            Err(status)
        }
    }
    fn open() -> u64 {
        let h = unsafe { ld_open(0, std::ptr::null(), 0) };
        assert_ne!(h, 0);
        h
    }
    fn author(h: u64, client: u64) {
        take(unsafe { ld_set_author(h, client, b"alice".as_ptr(), 5) }).unwrap();
    }
    fn apply(h: u64, client: u64, bytes: &[u8]) -> Result<Vec<u8>> {
        take(unsafe { ld_apply(h, client, bytes.as_ptr(), bytes.len()) })
    }
    fn replica(h: u64, client: u64) -> Doc {
        let doc = core::document(Some(client));
        doc.get_or_insert_text("content");
        doc.get_or_insert_map("authors");
        core::apply(&doc, core::decode(&take(ld_state(h)).unwrap()).unwrap()).unwrap();
        doc
    }
    fn delta(doc: &Doc, f: impl FnOnce(&mut yrs::TransactionMut)) -> Vec<u8> {
        let mut txn = doc.transact_mut();
        f(&mut txn);
        txn.encode_update_v1()
    }
    #[test]
    fn thousand_large_document_cycles() {
        let doc = core::document(Some(42));
        let expected = "x".repeat(MAX_TEXT);
        doc.get_or_insert_text("content")
            .insert(&mut doc.transact_mut(), 0, &expected);
        let state = core::state(&doc);
        for _ in 0..1000 {
            let h = unsafe { ld_open(0, state.as_ptr(), state.len()) };
            assert_ne!(h, 0);
            assert_eq!(
                take(unsafe { ld_text(h, b"content".as_ptr(), 7) }).unwrap(),
                expected.as_bytes()
            );
            take(ld_close(h)).unwrap();
            assert_eq!(take(ld_state(h)), Err(2));
        }
    }
    #[test]
    fn admission_and_delete_only_receipts() {
        let h = open();
        author(h, 11);
        author(h, 22);
        let a = replica(h, 11);
        let text = a.get_or_insert_text("content");
        let update = delta(&a, |t| text.insert(t, 0, "a🐙é"));
        let before = take(ld_state(h)).unwrap();
        assert_eq!(apply(h, 22, &update), Err(1));
        assert_eq!(take(ld_state(h)).unwrap(), before);
        assert_eq!(apply(h, 11, &update).unwrap(), update);
        assert_eq!(apply(h, 11, &update).unwrap(), vec![0, 0]);
        assert_eq!(
            take(unsafe { ld_text(h, b"content".as_ptr(), 7) }).unwrap(),
            "a🐙é".as_bytes()
        );
        let sv = take(ld_sync1(h)).unwrap();
        let deletion = delta(&a, |t| text.remove_range(t, 1, 2));
        apply(h, 11, &deletion).unwrap();
        assert_eq!(take(ld_sync1(h)).unwrap(), sv); // deletion still broadcasts
        assert_eq!(
            take(unsafe { ld_text(h, b"content".as_ptr(), 7) }).unwrap(),
            "aé".as_bytes()
        );
        let state = take(ld_state(h)).unwrap();
        let restored = unsafe { ld_open(0, state.as_ptr(), state.len()) };
        assert_ne!(restored, 0);
        let b = replica(h, 22);
        let retry = core::state(&b);
        apply(h, 22, &retry).unwrap(); // known foreign structs
        take(ld_close(restored)).unwrap();
        take(ld_close(h)).unwrap();
    }
    #[test]
    fn authors_writes_and_unknown_roots_are_atomic_refusals() {
        let h = open();
        author(h, 11);
        for mode in 0..5 {
            let a = replica(h, 11);
            let map = a.get_or_insert_map("authors");
            let update = delta(&a, |t| match mode {
                0 => {
                    map.insert(t, "11", "mallory");
                }
                1 => {
                    map.insert(t, "11", "alice");
                } // same-value assignment is a write
                2 => {
                    map.remove(t, "11");
                }
                3 => {
                    map.insert(t, "999", "mallory");
                    map.remove(t, "999");
                }
                _ => {
                    t.get_or_insert_map("unexpected").insert(t, "x", "y");
                }
            });
            let before = take(ld_state(h)).unwrap();
            assert_eq!(apply(h, 11, &update), Err(1), "mode {mode}");
            assert_eq!(take(ld_state(h)).unwrap(), before);
        }
        take(ld_close(h)).unwrap();
    }
    #[test]
    fn known_foreign_structs_are_not_echoed_to_lagging_peers() {
        let h = open();
        author(h, 11);
        author(h, 22);
        let alice = replica(h, 11);
        let text = alice.get_or_insert_text("content");
        let original = delta(&alice, |t| text.insert(t, 0, "safe"));
        apply(h, 11, &original).unwrap();
        let forged = core::document(Some(11));
        let text = forged.get_or_insert_text("content");
        let changed = delta(&forged, |t| text.insert(t, 0, "evil"));
        assert_eq!(apply(h, 22, &changed).unwrap(), vec![0, 0]);
        assert_eq!(
            take(unsafe { ld_text(h, b"content".as_ptr(), 7) }).unwrap(),
            b"safe"
        );
        take(ld_close(h)).unwrap();
    }
    #[test]
    fn compact_deleted_history_and_large_client_ids_restore() {
        let h = open();
        let client = u32::MAX as u64;
        author(h, client);
        let a = replica(h, client);
        let text = a.get_or_insert_text("content");
        let inserted = delta(&a, |t| text.insert(t, 0, &"a".repeat(4096)));
        apply(h, client, &inserted).unwrap();
        let deleted = delta(&a, |t| text.remove_range(t, 0, 4096));
        apply(h, client, &deleted).unwrap();
        let state = take(ld_state(h)).unwrap();
        assert!(state.len() < 512);
        let restored = unsafe { ld_open(0, state.as_ptr(), state.len()) };
        assert_ne!(restored, 0);
        take(ld_close(restored)).unwrap();
        take(ld_close(h)).unwrap();
    }
    #[test]
    fn missing_dependency_refuses_then_retries_after_sync() {
        let h = open();
        author(h, 11);
        let a = replica(h, 11);
        let text = a.get_or_insert_text("content");
        let first = delta(&a, |t| text.insert(t, 0, "A"));
        let second = delta(&a, |t| text.insert(t, 1, "B"));
        assert_eq!(apply(h, 11, &second), Err(1));
        apply(h, 11, &first).unwrap();
        apply(h, 11, &second).unwrap();
        assert_eq!(
            take(unsafe { ld_text(h, b"content".as_ptr(), 7) }).unwrap(),
            b"AB"
        );
        take(ld_close(h)).unwrap();
    }
    #[test]
    fn boundary_handles_lengths_panics_and_poison() {
        let h = open();
        author(h, 11);
        assert_eq!(
            take(unsafe { ld_apply(h, 11, std::ptr::null(), 1) }),
            Err(2)
        );
        assert_eq!(
            take(unsafe { ld_apply(h, 11, std::ptr::null(), MAX_BYTES + 1) }),
            Err(2)
        );
        assert_eq!(unsafe { ld_open(99, std::ptr::null(), 0) }, 0);
        assert_eq!(take(boundary(|| panic!("test caught ABI panic"))), Err(3));
        // Use an actual C ABI entry around the same production boundary.
        extern "C" fn injected_core_panic(h: u64) -> LdResult {
            boundary(|| with(h, |_| panic!("poison this handle")))
        }
        assert_eq!(take(injected_core_panic(h)), Err(3));
        assert_eq!(take(ld_state(h)), Err(3));
        take(ld_close(h)).unwrap();
        assert_eq!(take(ld_state(h)), Err(2));
        assert_eq!(take(ld_close(h)), Err(2));
        let next = open();
        assert_ne!(next, h);
        take(ld_close(next)).unwrap();
    }
    #[test]
    fn decode_apply_boundary_corpus() {
        let h = open();
        author(h, 11);
        let before = take(ld_state(h)).unwrap();
        let mut seed = 0x9287_2e35_u64;
        for n in 0..1024 {
            let mut bytes = vec![0; n % 128];
            for b in &mut bytes {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                *b = seed as u8;
            }
            let _ = apply(h, 11, &bytes);
            let _ = take(unsafe { ld_sync2(h, bytes.as_ptr(), bytes.len()) });
            let _ = take(unsafe { ld_awareness(h, bytes.as_ptr(), bytes.len()) });
            // Invalid bytes must never introduce foreign state.
            assert_eq!(take(ld_state(h)).unwrap(), before);
        }
        take(ld_close(h)).unwrap();
    }
}
