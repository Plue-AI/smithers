//! JSON request/response types for the `flows_jj_call` ABI.
//!
//! One op per call. The request/response shapes are FROZEN — they are the
//! contract between this crate and the TypeScript bridge in
//! `packages/jj/src/browser/`. `root` is an absolute path inside the WASI
//! namespace: the jj workspace root.

use serde::Deserialize;
use serde::Serialize;

use crate::error::ErrorCode;

/// A single `Jj` op request.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Init {
        root: String,
    },
    Snapshot {
        root: String,
        #[serde(default)]
        message: Option<String>,
    },
    Restore {
        root: String,
        change_id: String,
    },
    Diff {
        root: String,
        from: String,
        to: String,
    },
    WorkspaceAdd {
        root: String,
        name: String,
        path: String,
    },
    WorkspaceForget {
        root: String,
        name: String,
    },
    Status {
        root: String,
    },
}

impl Request {
    /// The human-oriented equivalent CLI command, reported in the `command`
    /// field of error responses. Error *messages* stay bare — the TypeScript
    /// bridge prefixes them with `jj {method}: `, exactly like `NodeJj` does
    /// with stderr, so a crate-side prefix would double up.
    pub fn command(&self) -> String {
        match self {
            Self::Init { .. } => "jj init".into(),
            Self::Snapshot { message: None, .. } => "jj describe --quiet && jj new --quiet".into(),
            Self::Snapshot {
                message: Some(message),
                ..
            } => format!("jj describe -m {message:?} --quiet && jj new --quiet"),
            Self::Restore { change_id, .. } => format!("jj restore --from {change_id}"),
            Self::Diff { from, to, .. } => format!("jj diff --from {from} --to {to} --git"),
            Self::WorkspaceAdd { name, path, .. } => {
                format!("jj workspace add --name {name} {path}")
            }
            Self::WorkspaceForget { name, .. } => format!("jj workspace forget {name}"),
            Self::Status { .. } => "jj status".into(),
        }
    }
}

/// The `ok` payload of a response. Serialized untagged: `snapshot` returns
/// `{"commitId":"...","changeId":"..."}` (restore by `commitId`; `changeId`
/// is display only), `diff` returns `{"diff":"..."}`, `status` returns
/// `{"status":"..."}`, everything else returns `{}`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OkPayload {
    Snapshot {
        #[serde(rename = "commitId")]
        commit_id: String,
        #[serde(rename = "changeId")]
        change_id: String,
    },
    Diff {
        diff: String,
    },
    Status {
        status: String,
    },
    Unit {},
}

/// The `err` payload of a response.
#[derive(Clone, Debug, Serialize)]
pub struct ErrPayload {
    pub code: ErrorCode,
    pub message: String,
    pub command: String,
}

/// A complete response: exactly one of `{"ok":...}` or `{"err":...}`.
#[derive(Clone, Debug, Serialize)]
pub enum Response {
    #[serde(rename = "ok")]
    Ok(OkPayload),
    #[serde(rename = "err")]
    Err(ErrPayload),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn every_request_command_uses_the_public_cli_shape() {
        let cases = [
            (r#"{"op":"init","root":"/repo"}"#, "jj init"),
            (
                r#"{"op":"snapshot","root":"/repo"}"#,
                "jj describe --quiet && jj new --quiet",
            ),
            (
                r#"{"op":"snapshot","root":"/repo","message":null}"#,
                "jj describe --quiet && jj new --quiet",
            ),
            (
                r#"{"op":"snapshot","root":"/repo","message":""}"#,
                "jj describe -m \"\" --quiet && jj new --quiet",
            ),
            (
                r#"{"op":"snapshot","root":"/repo","message":"line\n\"quoted\" 雪"}"#,
                "jj describe -m \"line\\n\\\"quoted\\\" 雪\" --quiet && jj new --quiet",
            ),
            (
                r#"{"op":"restore","root":"/repo","changeId":"ab-12"}"#,
                "jj restore --from ab-12",
            ),
            (
                r#"{"op":"diff","root":"/repo","from":"left","to":"right"}"#,
                "jj diff --from left --to right --git",
            ),
            (
                r#"{"op":"workspaceAdd","root":"/repo","name":"other","path":"/work/雪"}"#,
                "jj workspace add --name other /work/雪",
            ),
            (
                r#"{"op":"workspaceAdd","root":"/repo","name":"two words","path":"/work/space dir"}"#,
                "jj workspace add --name two words /work/space dir",
            ),
            (
                r#"{"op":"workspaceForget","root":"/repo","name":"other"}"#,
                "jj workspace forget other",
            ),
            (r#"{"op":"status","root":"/repo"}"#, "jj status"),
        ];
        for (json, command) in cases {
            let request: Request = serde_json::from_str(json).unwrap();
            assert_eq!(request.command(), command, "request {json}");
        }
    }

    #[test]
    fn request_parser_rejects_missing_or_wrongly_typed_fields() {
        for json in [
            r#"{"op":"status"}"#,
            r#"{"op":"status","root":null}"#,
            r#"{"op":"snapshot","root":"/repo","message":7}"#,
            r#"{"op":"restore","root":"/repo","change_id":"id"}"#,
            r#"{"op":"diff","root":"/repo","from":"a"}"#,
            r#"{"op":"workspaceAdd","root":"/repo","name":"n"}"#,
            r#"{"op":"workspaceForget","root":"/repo","name":false}"#,
            r#"{"op":"unknown","root":"/repo"}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "accepted {json}"
            );
        }
    }

    #[test]
    fn response_envelopes_and_payloads_are_exact() {
        let cases = [
            (Response::Ok(OkPayload::Unit {}), json!({"ok": {}})),
            (
                Response::Ok(OkPayload::Snapshot {
                    commit_id: "c雪".into(),
                    change_id: "x".into(),
                }),
                json!({"ok": {"commitId": "c雪", "changeId": "x"}}),
            ),
            (
                Response::Ok(OkPayload::Diff {
                    diff: "-old\n+new\n".into(),
                }),
                json!({"ok": {"diff": "-old\n+new\n"}}),
            ),
            (
                Response::Ok(OkPayload::Status {
                    status: "A 雪\n".into(),
                }),
                json!({"ok": {"status": "A 雪\n"}}),
            ),
            (
                Response::Err(ErrPayload {
                    code: ErrorCode::InvalidRef,
                    message: "bad ref".into(),
                    command: "jj restore --from x".into(),
                }),
                json!({"err": {"code": "invalid_ref", "message": "bad ref", "command": "jj restore --from x"}}),
            ),
        ];
        for (response, expected) in cases {
            let actual: Value = serde_json::to_value(response).unwrap();
            assert_eq!(actual, expected);
        }
    }
}
