//! Item-position checks for the metadata watcher and overflow resync.
//! The caller runs this on the shared mutation-lock thread. Repository queries
//! belong to the unprivileged daemon; the root broker never receives a revset.
use std::io;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fact {
    pub by: String,
    pub item: String,
    pub pre_move_commit: String,
}

/// The daemon's trusted jj executor. Arguments are passed directly, never via
/// a shell. Failure (including a corrupt repository) must remain a failure.
/// This is not a host execution fallback or a second wire protocol.
pub trait Query {
    fn jj(&mut self, args: &[String]) -> io::Result<String>;
}

fn invalid(detail: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, detail)
}
fn change_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|c| (b'k'..=b'z').contains(&c))
}
fn commit_id(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

/// One detection policy for native repository queries and the CLI fixtures.
/// Resolving history is deferred: repeated delivery cannot move the target.
pub fn detect_position(
    item: &str,
    by: &str,
    on_item: bool,
    prior: Option<&Fact>,
    previous: impl FnOnce() -> io::Result<String>,
) -> io::Result<Option<Fact>> {
    if item.is_empty() || on_item {
        return Ok(None);
    }
    if let Some(fact) = prior {
        if fact.item == item && commit_id(&fact.pre_move_commit) {
            return Ok(Some(fact.clone()));
        }
    }
    let commit = previous()?;
    if !commit_id(&commit) {
        return Err(invalid("invalid pre-move commit"));
    }
    Ok(Some(Fact {
        by: by.into(),
        item: item.into(),
        pre_move_commit: commit,
    }))
}
fn revisions<Q: Query>(
    q: &mut Q,
    operation: Option<&str>,
    revset: &str,
) -> io::Result<Vec<String>> {
    let mut args = vec![];
    if let Some(operation) = operation {
        args.extend([
            "--ignore-working-copy".into(),
            "--at-operation".into(),
            operation.into(),
        ]);
    }
    args.extend([
        "log".into(),
        "--no-graph".into(),
        "-r".into(),
        revset.into(),
        "-T".into(),
        "commit_id ++ \"\\n\"".into(),
    ]);
    let result = q.jj(&args)?;
    if result.len() > 1024 * 1024 {
        return Err(invalid("revision response too large"));
    }
    result
        .lines()
        .map(|line| {
            if commit_id(line) {
                Ok(line.to_owned())
            } else {
                Err(invalid("invalid commit id"))
            }
        })
        .collect()
}

/// Called by the metadata watcher, including overflow recovery. The current
/// query imports colocated git HEAD and snapshots before checking position.
/// Same-tree moves count; bookmark names and tree equality do not. Redelivery
/// keeps the original return target until the working copy is back on the item.
pub fn detect<Q: Query>(
    q: &mut Q,
    change: &str,
    item: &str,
    by: &str,
    prior: Option<&Fact>,
) -> io::Result<Option<Fact>> {
    if item.is_empty() {
        return Ok(None);
    } // scratch branch
    if !change_id(change) {
        return Err(invalid("invalid item change id"));
    }
    let present = format!("present({change})");
    let on_item = !revisions(q, None, &present)?.is_empty()
        && !revisions(q, None, &format!("{present}::@"))?.is_empty();
    detect_position(item, by, on_item, prior, || previous_commit(q, &present))
}

fn previous_commit<Q: Query>(q: &mut Q, present: &str) -> io::Result<String> {
    let operations = q.jj(&[
        "--ignore-working-copy".into(),
        "op".into(),
        "log".into(),
        "--no-graph".into(),
        "-T".into(),
        "id ++ \"\\n\"".into(),
    ])?;
    if operations.len() > 16 * 1024 * 1024 {
        return Err(invalid("operation response too large"));
    }
    for op in operations.lines() {
        if op.len() != 128 || !op.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(invalid("invalid operation id"));
        }
        if op.bytes().all(|c| c == b'0') {
            continue;
        } // root operation has no workspace
        if !revisions(q, Some(op), &format!("{present}::@"))?.is_empty() {
            let commits = revisions(q, Some(op), "@")?;
            if commits.len() != 1 {
                return Err(invalid("ambiguous working-copy commit"));
            }
            return Ok(commits[0].clone());
        }
    }
    Err(invalid("pre-move history unavailable"))
}
