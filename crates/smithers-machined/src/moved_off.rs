//! Metadata and overflow detection on the daemon's mutation lock.
//! Repository queries and attribution are supplied by the watcher provider;
//! query failures must propagate, never masquerade as an absent change.
use crate::hooks::{Actor, Error, Oid, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fact {
    pub by: Actor,
    pub item: String,
    pub pre_move: Oid,
}
#[derive(Clone, Debug)]
pub struct Position {
    pub present: bool,
    pub descends: bool,
    pub working_copy: Oid,
}
fn unavailable() -> Error {
    Error {
        code: 3,
        detail: Some("pre-move history unavailable".into()),
        ..Error::unsupported()
    }
}
/// Operations are newest first. Scratch branches have no item. Repeated
/// metadata events retain the original return target until descent is restored.
pub fn detect(
    item: &str,
    by: Actor,
    current: &Position,
    history: &[Position],
    prior: Option<&Fact>,
) -> Result<Option<Fact>> {
    if item.is_empty() || (current.present && current.descends) {
        return Ok(None);
    }
    if let Some(prior) = prior.filter(|f| f.item == item && f.pre_move != [0; 20]) {
        return Ok(Some(prior.clone()));
    }
    let pre_move = history
        .iter()
        .find(|p| p.present && p.descends && p.working_copy != [0; 20])
        .ok_or_else(unavailable)?
        .working_copy;
    Ok(Some(Fact {
        by,
        item: item.into(),
        pre_move,
    }))
}
/// An off-item snapshot remains recoverable, but must not become the item's
/// published capture. The last verified item head is distinct from Return's @.
pub fn capture_target(
    fact: Option<&Fact>,
    last_captured: Option<Oid>,
    working_copy: Oid,
) -> Result<Oid> {
    match fact {
        None => Ok(working_copy),
        Some(_) => last_captured
            .filter(|head| *head != [0; 20])
            .ok_or_else(unavailable),
    }
}
/// Call under the mutation lock, including for mutations queued before a move.
pub fn guard_agent(fact: Option<&Fact>, actor: &Actor) -> Result<()> {
    if fact.is_some() && matches!(actor, Actor::Run(_)) {
        return Err(Error {
            code: 10,
            ..Error::unsupported()
        });
    }
    Ok(())
}
