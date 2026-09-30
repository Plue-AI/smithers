//! The `flows_jj_call` ABI: UTF-8 JSON in, UTF-8 JSON out, no panics across
//! the boundary.
//!
//! Exports (wasm32-wasip1 reactor module):
//! - `memory` — the linear memory (exported by the linker).
//! - `_initialize()` — reactor init; the host calls it once after
//!   instantiation.
//! - `flows_jj_alloc(size) -> ptr` / `flows_jj_free(ptr, size)` — buffer
//!   management. The host allocates the request buffer, writes JSON, calls,
//!   then frees BOTH buffers (wasm never frees the request).
//! - `flows_jj_call(req_ptr, req_len) -> u64` — dispatch. The return value
//!   packs the response buffer as `(ptr << 32) | len`; `0` means allocation
//!   failed. The response is always a JSON `Response`.
//!
//! Everything is wrapped in `std::panic::catch_unwind` so a bug surfaces as
//! an `{"err":...}` response rather than tearing down the instance. (On
//! wasm32-wasip1 panics abort before unwinding — the host shim additionally
//! guards the call — but the catch is real on native targets and in tests.)

use std::panic;
use std::panic::AssertUnwindSafe;
use std::path::Path;

use crate::error::ErrorCode;
use crate::error::OpError;
use crate::ops;
use crate::protocol::ErrPayload;
use crate::protocol::OkPayload;
use crate::protocol::Request;
use crate::protocol::Response;

/// Handles one raw request, catching panics. This is the whole ABI minus the
/// pointer packing, and what native tests exercise.
pub fn call_json(request: &[u8]) -> Vec<u8> {
    catching(AssertUnwindSafe(|| handle(request)))
}

/// Runs `handler`, converting a panic into an `{"err":...}` response.
fn catching(handler: impl FnOnce() -> Vec<u8> + panic::UnwindSafe) -> Vec<u8> {
    panic::catch_unwind(handler).unwrap_or_else(|payload| {
        let message = if let Some(text) = payload.downcast_ref::<&str>() {
            (*text).to_owned()
        } else if let Some(text) = payload.downcast_ref::<String>() {
            text.clone()
        } else {
            "unknown panic".to_owned()
        };
        encode(&Response::Err(ErrPayload {
            code: ErrorCode::Unknown,
            message: format!("jj: panic: {message}"),
            command: "jj".to_owned(),
        }))
    })
}

fn handle(request: &[u8]) -> Vec<u8> {
    let request: Request = match serde_json::from_slice(request) {
        Ok(request) => request,
        Err(err) => {
            return encode(&Response::Err(ErrPayload {
                code: ErrorCode::Unknown,
                message: format!("jj: malformed request: {err}"),
                command: "jj".to_owned(),
            }));
        }
    };
    // The message is deliberately bare: the TypeScript bridge prefixes every
    // error with `jj {method}: ` (mirroring how `NodeJj` prefixes stderr), so
    // a crate-side prefix would appear twice in every surfaced message.
    let response = match dispatch(&request) {
        Ok(payload) => Response::Ok(payload),
        Err(err) => Response::Err(ErrPayload {
            code: err.code,
            message: err.message,
            command: request.command(),
        }),
    };
    encode(&response)
}

fn dispatch(request: &Request) -> Result<OkPayload, OpError> {
    match request {
        Request::Init { root } => {
            ops::init(Path::new(root))?;
            Ok(OkPayload::Unit {})
        }
        Request::Snapshot { root, message } => {
            let ops::Snapshot {
                commit_id,
                change_id,
                operation_id,
            } = ops::snapshot(Path::new(root), message.as_deref())?;
            Ok(OkPayload::Snapshot {
                commit_id,
                change_id,
                operation_id,
            })
        }
        Request::Restore { root, change_id } => {
            ops::restore(Path::new(root), change_id)?;
            Ok(OkPayload::Unit {})
        }
        Request::Diff { root, from, to } => {
            let diff = ops::diff(Path::new(root), from, to)?;
            Ok(OkPayload::Diff { diff })
        }
        Request::WorkspaceAdd { root, name, path } => {
            ops::workspace_add(Path::new(root), name, path)?;
            Ok(OkPayload::Unit {})
        }
        Request::WorkspaceForget { root, name } => {
            ops::workspace_forget(Path::new(root), name)?;
            Ok(OkPayload::Unit {})
        }
        Request::OpRestore { root, operation_id } => {
            ops::op_restore(Path::new(root), operation_id)?;
            Ok(OkPayload::Unit {})
        }
        Request::Status { root } => {
            let status = ops::status(Path::new(root))?;
            Ok(OkPayload::Status { status })
        }
    }
}

/// Serializes a response. Serialization of these types cannot fail (string
/// keys, no non-finite floats), but a hand-written fallback keeps the
/// "no panics" promise absolute.
fn encode(response: &Response) -> Vec<u8> {
    serde_json::to_vec(response).unwrap_or_else(|err| {
        format!(
            "{{\"err\":{{\"code\":\"unknown\",\"message\":\"response serialization failed: {err}\",\"command\":\"jj\"}}}}"
        )
        .into_bytes()
    })
}

/// The raw wasm exports. Pointer packing only exists on wasm32, where
/// pointers fit in `u32`; native tests go through [`call_json`].
#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::alloc::Layout;
    use std::alloc::alloc;
    use std::alloc::dealloc;

    /// Reactor initialization. The ABI requires this export and the host
    /// calls it exactly once after instantiation. Rust links no static
    /// constructors into this module (wasm-ld would synthesize `_initialize`
    /// itself if `__wasm_call_ctors` existed — if that ever happens, this
    /// definition becomes a duplicate-symbol link error and must be removed),
    /// so the function has nothing to do; it exists to make instantiation
    /// explicit and keep the export surface frozen.
    #[unsafe(no_mangle)]
    pub extern "C" fn _initialize() {}

    /// Allocates `size` bytes inside wasm linear memory. Returns 0 when the
    /// allocation fails or `size` is 0.
    #[unsafe(no_mangle)]
    pub extern "C" fn flows_jj_alloc(size: u32) -> u32 {
        let Ok(layout) = Layout::array::<u8>(size as usize) else {
            return 0;
        };
        if layout.size() == 0 {
            return 0;
        }
        // SAFETY: layout has non-zero size.
        let ptr = unsafe { alloc(layout) };
        ptr as u32
    }

    /// Frees a buffer produced by `flows_jj_alloc` (or returned from
    /// `flows_jj_call`). `ptr`/`size` must match the original allocation.
    #[unsafe(no_mangle)]
    pub extern "C" fn flows_jj_free(ptr: u32, size: u32) {
        if ptr == 0 || size == 0 {
            return;
        }
        let Ok(layout) = Layout::array::<u8>(size as usize) else {
            return;
        };
        // SAFETY: the contract requires (ptr, size) to be a live allocation
        // made by flows_jj_alloc with the same size.
        unsafe { dealloc(ptr as *mut u8, layout) };
    }

    /// Dispatches one JSON request; returns `(ptr << 32) | len` of the JSON
    /// response, or 0 if the response buffer could not be allocated.
    #[unsafe(no_mangle)]
    pub extern "C" fn flows_jj_call(req_ptr: u32, req_len: u32) -> u64 {
        let request: &[u8] = if req_len == 0 {
            &[]
        } else {
            // SAFETY: the host wrote req_len bytes at req_ptr, a buffer it
            // obtained from flows_jj_alloc.
            unsafe { std::slice::from_raw_parts(req_ptr as *const u8, req_len as usize) }
        };
        let response = super::call_json(request);
        let len = response.len() as u32;
        let ptr = flows_jj_alloc(len);
        if ptr == 0 {
            return 0;
        }
        // SAFETY: ptr is a fresh allocation of len bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(response.as_ptr(), ptr as *mut u8, response.len());
        }
        (u64::from(ptr) << 32) | u64::from(len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn response(bytes: &[u8]) -> Value {
        serde_json::from_slice(&call_json(bytes)).unwrap()
    }

    fn request(value: Value) -> Value {
        response(&serde_json::to_vec(&value).unwrap())
    }

    #[test]
    fn response_codec_preserves_control_characters_and_unicode_in_every_string_payload() {
        let text = "quote\" slash\\ newline\n tab\t nul\0 日本語 🦀";
        let cases = [
            (
                Response::Ok(OkPayload::Snapshot {
                    commit_id: text.into(),
                    change_id: text.into(),
                    operation_id: text.into(),
                }),
                json!({"ok": {"commitId": text, "changeId": text, "operationId": text}}),
            ),
            (
                Response::Ok(OkPayload::Diff { diff: text.into() }),
                json!({"ok": {"diff": text}}),
            ),
            (
                Response::Ok(OkPayload::Status {
                    status: text.into(),
                }),
                json!({"ok": {"status": text}}),
            ),
            (
                Response::Err(ErrPayload {
                    code: ErrorCode::Unknown,
                    message: text.into(),
                    command: text.into(),
                }),
                json!({"err": {"code": "unknown", "message": text, "command": text}}),
            ),
        ];
        for (response, expected) in cases {
            let bytes = encode(&response);
            assert!(!bytes.contains(&0), "NUL must be JSON-escaped on the wire");
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
        }
    }

    #[test]
    fn panic_becomes_err_response() {
        let json = catching(|| panic!("boom"));
        let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(value["err"]["code"], "unknown");
        assert!(value["err"]["message"].as_str().unwrap().contains("boom"));
        assert_eq!(value["err"]["command"], "jj");
    }

    #[test]
    fn panic_with_string_payload_becomes_err_response() {
        let json = catching(|| panic!("boom {}", 42));
        let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert!(
            value["err"]["message"]
                .as_str()
                .unwrap()
                .contains("boom 42")
        );
    }

    #[test]
    fn non_string_panic_has_stable_fallback() {
        let json = catching(|| panic::panic_any(7_u8));
        assert_eq!(
            serde_json::from_slice::<Value>(&json).unwrap(),
            json!({"err": {"code": "unknown", "message": "jj: panic: unknown panic", "command": "jj"}})
        );
    }

    #[test]
    fn owned_string_panic_keeps_its_message() {
        let json = catching(|| panic::panic_any(String::from("owned panic")));
        assert_eq!(
            serde_json::from_slice::<Value>(&json).unwrap(),
            json!({"err": {"code": "unknown", "message": "jj: panic: owned panic", "command": "jj"}})
        );
    }

    #[test]
    fn malformed_requests_return_complete_errors_and_allow_recovery() {
        for malformed in [
            &b""[..],
            &b"\xff"[..],
            &b"{"[..],
            &b"{\"op\":\"unknown\",\"root\":\"/repo\"}"[..],
            &b"{\"op\":\"status\",\"root\":null}"[..],
        ] {
            let result = response(malformed);
            let error = result["err"].as_object().unwrap();
            assert_eq!(result.as_object().unwrap().len(), 1);
            assert_eq!(error.len(), 3);
            assert_eq!(error["code"], "unknown");
            assert_eq!(error["command"], "jj");
            assert!(
                error["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("jj: malformed request: ")
            );
        }

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let init = serde_json::to_vec(&json!({"op": "init", "root": root})).unwrap();
        assert_eq!(response(&init), json!({"ok": {}}));
        assert!(root.join(".jj").is_dir());
    }

    #[test]
    fn valid_operation_failure_uses_its_command_and_bare_message() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let init = serde_json::to_vec(&json!({"op": "init", "root": root})).unwrap();
        assert_eq!(response(&init), json!({"ok": {}}));

        let restore =
            serde_json::to_vec(&json!({"op": "restore", "root": root, "changeId": "missing"}))
                .unwrap();
        assert_eq!(
            response(&restore),
            json!({"err": {"code": "invalid_ref", "message": "revision \"missing\" doesn't exist", "command": "jj restore --from missing"}})
        );
        let status = serde_json::to_vec(&json!({"op": "status", "root": root})).unwrap();
        let status_response = response(&status);
        assert_eq!(status_response.as_object().unwrap().len(), 1);
        assert!(
            status_response["ok"]["status"]
                .as_str()
                .unwrap()
                .starts_with("The working copy has no changes.\n")
        );
    }

    #[test]
    fn dispatch_round_trips_every_operation_and_recovers_after_refusal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        assert_eq!(
            request(json!({"op": "init", "root": root})),
            json!({"ok": {}})
        );
        std::fs::write(root.join("note.txt"), "before\n").unwrap();
        let first = request(json!({"op": "snapshot", "root": root, "message": "first"}));
        let first_id = first["ok"]["commitId"].as_str().unwrap();
        assert_eq!(first["ok"].as_object().unwrap().len(), 3);
        assert_eq!(first_id.len(), 128);

        std::fs::write(root.join("note.txt"), "after\n").unwrap();
        let second = request(json!({"op": "snapshot", "root": root}));
        let second_id = second["ok"]["commitId"].as_str().unwrap();
        assert_ne!(first_id, second_id);
        let diff = request(json!({"op": "diff", "root": root, "from": first_id, "to": second_id}));
        assert_eq!(diff.as_object().unwrap().len(), 1);
        let diff_text = diff["ok"]["diff"].as_str().unwrap();
        assert!(
            diff_text.contains("--- a/note.txt\n+++ b/note.txt\n"),
            "{diff_text}"
        );
        assert!(diff_text.contains("-before\n+after\n"), "{diff_text}");

        let invalid =
            request(json!({"op": "diff", "root": root, "from": "missing", "to": second_id}));
        assert_eq!(invalid["err"]["code"], "invalid_ref");
        assert_eq!(
            invalid["err"]["command"],
            format!("jj diff --from missing --to {second_id} --git")
        );
        assert_eq!(
            invalid["err"]["message"],
            "revision \"missing\" doesn't exist"
        );
        assert_eq!(std::fs::read(root.join("note.txt")).unwrap(), b"after\n");

        assert_eq!(
            request(json!({"op": "restore", "root": root, "changeId": first_id})),
            json!({"ok": {}})
        );
        assert_eq!(std::fs::read(root.join("note.txt")).unwrap(), b"before\n");
        let status = request(json!({"op": "status", "root": root}));
        assert!(
            status["ok"]["status"]
                .as_str()
                .unwrap()
                .contains("A note.txt\n")
        );

        let lane = temp.path().join("lane");
        assert_eq!(
            request(json!({"op": "workspaceAdd", "root": root, "name": "lane", "path": lane})),
            json!({"ok": {}})
        );
        assert_eq!(
            request(json!({"op":"restore", "root":lane, "changeId":second_id})),
            json!({"ok":{}})
        );
        assert_eq!(std::fs::read(lane.join("note.txt")).unwrap(), b"after\n");
        assert_eq!(
            request(json!({"op": "workspaceForget", "root": root, "name": "lane"})),
            json!({"ok": {}})
        );
        assert_eq!(std::fs::read(lane.join("note.txt")).unwrap(), b"after\n");
        assert!(request(json!({"op": "status", "root": root}))["ok"]["status"].is_string());
    }
}
