//! The authenticated envelope adapter supplies opaque actor bytes, never a uid.
use super::{core, Error, Result};
use std::collections::BTreeMap;
use yrs::{Doc, Map, Out, ReadTxn, Transact};

pub fn entries(doc: &Doc) -> Result<BTreeMap<String, String>> {
    doc.get_or_insert_map("authors")
        .iter(&doc.transact())
        .map(|(key, value)| match value {
            Out::Any(yrs::Any::String(value)) => Ok((key.to_owned(), value.to_string())),
            _ => Err(Error::Invalid),
        })
        .collect()
}

/// Id allocation lives in the authority and is persisted in the authors root.
pub fn allocate(doc: &Doc, actor: &str) -> Result<u64> {
    let authors = entries(doc)?;
    if let Some((id, _)) = authors.iter().find(|(_, v)| v.as_str() == actor) {
        return id.parse().map_err(|_| Error::Invalid);
    }
    fresh(doc, actor)
}

/// Each simultaneous subscriber needs a distinct clock space, even for one actor.
pub fn fresh(doc: &Doc, actor: &str) -> Result<u64> {
    let authors = entries(doc)?;
    let sv = doc.transact().state_vector();
    let mut id = 1u64;
    while authors.contains_key(&id.to_string())
        || id == doc.client_id().get()
        || sv.get(&yrs::ClientID::new(id)) != 0
    {
        id += 1;
        if id > u32::MAX as u64 {
            return Err(Error::Invalid);
        }
    }
    doc.get_or_insert_map("authors")
        .insert(&mut doc.transact_mut(), id.to_string(), actor);
    Ok(id)
}

/// Validate in a disposable replica: rejection cannot mutate live state.
/// Unknown structs, roots and any change to the authority-owned map are refused.
pub fn checked_update(doc: &Doc, bytes: &[u8], client: u64) -> Result<()> {
    checked(doc, bytes, |id| id == client)
}

pub fn checked_actor_update(doc: &Doc, bytes: &[u8], actor: &str) -> Result<()> {
    let authors = entries(doc)?;
    checked(doc, bytes, |id| {
        authors
            .get(&id.to_string())
            .is_some_and(|value| value == actor)
    })
}

fn checked(doc: &Doc, bytes: &[u8], allocated: impl Fn(u64) -> bool) -> Result<()> {
    let update = core::decode(bytes).map_err(|_| Error::Invalid)?;
    let sv = doc.transact().state_vector();
    // Sync step 2 may replay already integrated structs from other authors.
    // Only newly introduced structs need an id allocated to this actor.
    if update.insertions(true).iter().any(|(id, ranges)| {
        !allocated(id.get()) && ranges.iter().any(|range| range.end > sv.get(id))
    }) {
        return Err(Error::Forged);
    }
    let scratch = core::document(None);
    scratch.get_or_insert_text("content");
    scratch.get_or_insert_map("authors");
    core::apply(
        &scratch,
        core::decode(&core::state(doc)).map_err(|_| Error::Invalid)?,
    )
    .map_err(|_| Error::Invalid)?;
    core::apply(&scratch, update).map_err(|_| Error::Invalid)?;
    core::validate(&scratch, "content", true).map_err(|_| Error::Forged)?;
    if entries(doc)? != entries(&scratch)? {
        return Err(Error::Forged);
    }
    Ok(())
}
