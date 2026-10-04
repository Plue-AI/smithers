//! Yjs-compatible Markdown operations for the existing Go wiki service.
//! Persistence, authorization, revision ordering and delivery remain in Go.

use crate::document_core;
use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, Text, Transact, Update};

use crate::FfiError;

const MAX_MARKDOWN_BYTES: usize = 1 << 20;
const MAX_UPDATE_BYTES: usize = 1 << 20;
const MAX_STATE_BYTES: usize = 8 << 20;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Seed { markdown: String },
    Apply { state: String, update: String },
    Replace { state: String, markdown: String },
}

#[derive(Debug, Serialize)]
pub(crate) struct Document {
    pub state: String,
    pub state_vector: String,
    pub markdown: String,
}

fn invalid(message: &str) -> FfiError {
    FfiError::InvalidArgument(message.to_owned())
}

fn decode(value: &str, limit: usize) -> Result<Update, FfiError> {
    if value.len() > limit.div_ceil(3) * 4 {
        return Err(invalid("wiki document update exceeds its size limit"));
    }
    let bytes = BASE64_STANDARD
        .decode(value)
        .map_err(|_| invalid("wiki document update must be base64"))?;
    if bytes.len() > limit {
        return Err(invalid("wiki document update exceeds its size limit"));
    }
    document_core::decode(&bytes).map_err(|_| invalid("invalid Yjs v1 wiki document update"))
}

fn apply(doc: &Doc, update: Update) -> Result<(), FfiError> {
    document_core::apply(doc, update)
        .map_err(|_| invalid("wiki document update could not be integrated"))
}

pub(crate) fn execute(request: Request) -> Result<Document, FfiError> {
    // Browser editors index strings in UTF-16 code units, including astral
    // characters. A Rust byte offset must never split a browser character.
    let doc = document_core::document(None);
    let text = doc.get_or_insert_text("markdown");
    let replacement = match request {
        Request::Seed { markdown } => Some(markdown),
        Request::Apply { state, update } => {
            apply(&doc, decode(&state, MAX_STATE_BYTES)?)?;
            apply(&doc, decode(&update, MAX_UPDATE_BYTES)?)?;
            None
        }
        Request::Replace { state, markdown } => {
            apply(&doc, decode(&state, MAX_STATE_BYTES)?)?;
            Some(markdown)
        }
    };
    if let Some(markdown) = replacement {
        if markdown.len() > MAX_MARKDOWN_BYTES {
            return Err(invalid("wiki Markdown exceeds 1 MiB"));
        }
        let mut txn = doc.transact_mut();
        let length = text.len(&txn);
        if length != 0 {
            text.remove_range(&mut txn, 0, length);
        }
        if !markdown.is_empty() {
            text.insert(&mut txn, 0, &markdown);
        }
    }
    document_core::validate(&doc, "markdown", false)
        .map_err(|_| invalid("wiki documents may contain only the Markdown text root"))?;
    let txn = doc.transact();
    let markdown = text.get_string(&txn);
    if markdown.len() > MAX_MARKDOWN_BYTES {
        return Err(invalid("merged wiki Markdown exceeds 1 MiB"));
    }
    // Unlike encode_diff, this preserves pending inserts AND pending deletes.
    // A delayed predecessor must still integrate after process restart or
    // compaction; resetting a Doc from its rendered Markdown would lose that.
    let state = document_core::state(&doc);
    if state.len() > MAX_STATE_BYTES {
        return Err(invalid("merged wiki document state exceeds 8 MiB"));
    }
    Ok(Document {
        state: BASE64_STANDARD.encode(state),
        state_vector: BASE64_STANDARD.encode(txn.state_vector().encode_v1()),
        markdown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::updates::decoder::Decode;
    use yrs::{OffsetKind, Options, StateVector};

    fn seed(markdown: &str) -> Document {
        execute(Request::Seed {
            markdown: markdown.into(),
        })
        .unwrap()
    }

    fn client(state: &str) -> Doc {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        doc.get_or_insert_text("markdown");
        apply(&doc, decode(state, MAX_STATE_BYTES).unwrap()).unwrap();
        doc
    }

    fn merge(state: &str, update: &str) -> Document {
        execute(Request::Apply {
            state: state.into(),
            update: update.into(),
        })
        .unwrap()
    }

    fn insert(doc: &Doc, index: u32, value: &str) -> String {
        let text = doc.get_or_insert_text("markdown");
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, index, value);
        BASE64_STANDARD.encode(txn.encode_update_v1())
    }

    #[test]
    fn concurrent_clients_converge_and_retries_do_not_duplicate_text() {
        let initial = seed("Start 🐙\n");
        let a = insert(&client(&initial.state), 9, "Alice\n");
        let b = insert(&client(&initial.state), 9, "Bob\n");
        let ab = merge(&merge(&initial.state, &a).state, &b);
        let ba = merge(&merge(&initial.state, &b).state, &a);
        assert_eq!(ab.markdown, ba.markdown);
        // Yjs state vectors are client-clock maps; wire entry order is not
        // canonical. Compare causal state rather than base64 byte ordering.
        let vector = |encoded: &str| {
            StateVector::decode_v1(&BASE64_STANDARD.decode(encoded).unwrap()).unwrap()
        };
        assert_eq!(vector(&ab.state_vector), vector(&ba.state_vector));
        assert!(ab.markdown.contains("Alice\n"));
        assert!(ab.markdown.contains("Bob\n"));
        let retried = merge(&ab.state, &a);
        assert_eq!(retried.markdown, ab.markdown);
        assert_eq!(retried.state, ab.state);
    }

    #[test]
    fn a_missing_predecessor_survives_serialization_and_a_later_restart() {
        let initial = seed("");
        let editor = client(&initial.state);
        let first = insert(&editor, 0, "first");
        let second = insert(&editor, 5, " second");
        let pending = merge(&initial.state, &second);
        assert_eq!(pending.markdown, "");
        assert_eq!(merge(&pending.state, &first).markdown, "first second");
    }

    #[test]
    fn an_early_delete_survives_restart_without_resurrecting_text() {
        let initial = seed("");
        let editor = client(&initial.state);
        let inserted = insert(&editor, 0, "temporary");
        let text = editor.get_or_insert_text("markdown");
        let deleted = {
            let mut txn = editor.transact_mut();
            text.remove_range(&mut txn, 0, 9);
            BASE64_STANDARD.encode(txn.encode_update_v1())
        };
        let pending = merge(&initial.state, &deleted);
        let result = merge(&pending.state, &inserted);
        assert_eq!(result.markdown, "");
        assert_eq!(merge(&result.state, &inserted).markdown, "");
    }

    #[test]
    fn replacing_markdown_preserves_causal_history_and_unicode() {
        let initial = seed("hello 🐙");
        let replaced = execute(Request::Replace {
            state: initial.state.clone(),
            markdown: "new 🦀 text".into(),
        })
        .unwrap();
        assert_eq!(replaced.markdown, "new 🦀 text");
        assert_eq!(
            merge(&replaced.state, &initial.state).markdown,
            replaced.markdown
        );
        let emptied = execute(Request::Replace {
            state: replaced.state,
            markdown: String::new(),
        })
        .unwrap();
        assert_eq!(emptied.markdown, "");
    }

    #[test]
    fn rejects_invalid_inputs_and_unrelated_roots() {
        let initial = seed("");
        for update in ["not-base64!", "AQ==", ""] {
            assert!(execute(Request::Apply {
                state: initial.state.clone(),
                update: update.into()
            })
            .is_err());
        }
        assert!(execute(Request::Seed {
            markdown: "x".repeat(MAX_MARKDOWN_BYTES + 1)
        })
        .is_err());
        let doc = Doc::new();
        doc.get_or_insert_text("unexpected")
            .insert(&mut doc.transact_mut(), 0, "hidden");
        let update = BASE64_STANDARD.encode(
            doc.transact()
                .encode_state_as_update_v1(&StateVector::default()),
        );
        assert!(execute(Request::Apply {
            state: initial.state,
            update
        })
        .is_err());
    }
}
