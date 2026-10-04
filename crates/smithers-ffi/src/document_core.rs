//! One Yrs core for wiki and daemon documents. Adapters own policy and persistence.
use yrs::updates::decoder::Decode;
use yrs::{Doc, OffsetKind, Options, Out, ReadTxn, StateVector, Transact, Update};

pub fn document(client: Option<u64>) -> Doc {
    let mut options = Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    };
    if let Some(client) = client {
        options.client_id = yrs::ClientID::new(client);
    }
    Doc::with_options(options)
}

pub fn decode(bytes: &[u8]) -> Result<Update, &'static str> {
    Update::decode_v1(bytes).map_err(|_| "invalid Yjs v1 update")
}

pub fn apply(doc: &Doc, update: Update) -> Result<(), &'static str> {
    doc.transact_mut()
        .apply_update(update)
        .map_err(|_| "update could not be integrated")
}

pub fn validate(doc: &Doc, text: &str, authors: bool) -> Result<(), &'static str> {
    if doc.transact().root_refs().any(|(name, value)| {
        !(name == text && matches!(value, Out::YText(_))
            || authors && name == "authors" && matches!(value, Out::YMap(_)))
    }) {
        return Err("unexpected document root");
    }
    Ok(())
}

/// Full state retains pending inserts and deletes across serialization/restart.
pub fn state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}
