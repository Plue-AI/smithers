//! Outside snapshots are retained even when live edits win an overlapping hunk.
use super::reconcile::{hunks, Hunk};
#[derive(Debug, PartialEq, Eq)]
pub struct Merge {
    pub text: String,
    pub overlap: bool,
    pub outside: String,
}
fn overlaps(a: &Hunk, b: &Hunk) -> bool {
    match (a.start == a.end, b.start == b.end) {
        (true, true) => a.start == b.start,
        (true, false) => b.start < a.start && a.start < b.end,
        (false, true) => a.start < b.start && b.start < a.end,
        (false, false) => a.start < b.end && b.start < a.end,
    }
}
pub fn merge(base: &str, ours: &str, theirs: &str) -> Merge {
    let mut edits = hunks(base, ours);
    let outside = hunks(base, theirs);
    let mut overlap = false;
    let mut accepted = vec![];
    for h in outside {
        if edits.iter().any(|e| e == &h) {
            continue;
        }
        if edits.iter().any(|e| overlaps(e, &h)) {
            overlap = true;
        } else {
            accepted.push(h);
        }
    }
    edits.extend(accepted);
    edits.sort_by_key(|h| (h.start, h.end));
    let lines: Vec<_> = base.split_inclusive('\n').collect();
    let mut text = String::new();
    let mut cursor = 0;
    for h in edits {
        text.push_str(&lines[cursor..h.start].concat());
        text.push_str(&h.text);
        cursor = h.end;
    }
    text.push_str(&lines[cursor..].concat());
    Merge {
        text,
        overlap,
        outside: theirs.into(),
    }
}
