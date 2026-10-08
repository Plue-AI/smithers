//! Wake decision and durable settlement on the branch mutation lock.
use crate::{
    conn::{field, tagged},
    hooks::{Error, Oid, Result},
    lock::LockCx,
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Unchanged,
    Moved(Oid),
    Conflict(Vec<String>),
}
pub(crate) fn paths_payload(paths: &[String]) -> Result<Vec<u8>> {
    let count = u16::try_from(paths.len()).map_err(|_| Error::unsupported())?;
    let mut bytes = count.to_be_bytes().to_vec();
    for path in paths {
        let len = u16::try_from(path.len()).map_err(|_| Error::unsupported())?;
        bytes.extend(len.to_be_bytes());
        bytes.extend(path.as_bytes());
    }
    Ok(bytes)
}
impl Outcome {
    pub(crate) fn result(&self) -> Result<Vec<u8>> {
        let value = match self {
            Self::Unchanged => tagged(1, &[]),
            Self::Moved(head) => tagged(2, &[field(1, head)]),
            Self::Conflict(paths) => tagged(3, &[field(1, paths_payload(paths)?)]),
        };
        Ok(crate::conn::structure_bytes(&[field(1, value)]))
    }
    pub(crate) fn event(&self, old: Oid, head: Oid) -> Result<Vec<u8>> {
        let mut fields = vec![field(1, old), field(2, head)];
        match self {
            Self::Moved(_) => fields.push(field(3, [1])),
            Self::Conflict(paths) => {
                fields.push(field(3, [2]));
                fields.push(field(4, paths_payload(paths)?));
            }
            Self::Unchanged => return Err(Error::unsupported()),
        }
        Ok(tagged(3, &fields))
    }
}
/// Native implementation owns the operation checkpoint and recovery journal.
/// It must restore an interrupted move before another wake or session admission.
pub trait Repository {
    fn contains_commit(&mut self, head: Oid) -> Result<bool>;
    fn acknowledged(&mut self) -> Result<Option<Oid>>;
    fn snapshot(&mut self) -> Result<Oid>;
    fn tree(&mut self, head: Oid) -> Result<Oid>;
    fn move_to(&mut self, head: Oid, snapshot: Oid, old: Oid) -> Result<Oid>;
    fn rebase_delta(&mut self, snapshot: Oid, old: Oid, head: Oid) -> Result<Outcome>;
    /// Persist the reconciliation event before advancing base/acked refs. The
    /// recovery journal must replay this operation idempotently after a crash.
    fn settle(&mut self, head: Oid, event: Option<&[u8]>) -> Result<()>;
}
pub fn wake(cx: &mut LockCx, repo: &mut impl Repository, head: Oid) -> Result<Outcome> {
    if cx.rewrite_pending {
        return Err(crate::freeze::pending_error());
    }
    if !repo.contains_commit(head)? {
        return Err(Error {
            code: 5,
            oids: Some(vec![head]),
            ..Error::unsupported()
        });
    }
    let old = repo.acknowledged()?;
    let snapshot = repo.snapshot()?;
    if old.is_none() || old == Some(head) {
        repo.settle(head, None)?;
        return Ok(Outcome::Unchanged);
    }
    let old = old.unwrap();
    // Wake admission remains closed until the journaled rewrite and event settle.
    cx.begin_rewrite()?;
    let outcome = if repo.tree(snapshot)? == repo.tree(old)? {
        Outcome::Moved(repo.move_to(head, snapshot, old)?)
    } else {
        repo.rebase_delta(snapshot, old, head)?
    };
    repo.settle(head, Some(&outcome.event(old, head)?))?;
    cx.settle_rewrite()?;
    Ok(outcome)
}
