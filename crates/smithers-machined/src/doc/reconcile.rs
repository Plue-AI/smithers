//! Line edits preserve identities on untouched lines and UTF-16 browser offsets.
use super::{core, Error, Result};
use yrs::{Doc, GetString, Text, Transact};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Reuse the Myers implementation rather than a second bounded diff algorithm.
pub fn hunks(old: &str, new: &str) -> Vec<Hunk> {
    let a: Vec<_> = old.split_inclusive('\n').collect();
    let b: Vec<_> = new.split_inclusive('\n').collect();
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &a, &b);
    let mut out: Vec<Hunk> = vec![];
    let (mut old_at, mut new_at) = (0, 0);
    let mut adjoining = false;
    for op in ops {
        let old_len = op.old_range().len();
        let new_len = op.new_range().len();
        if op.tag() == similar::DiffTag::Equal {
            adjoining = false;
        } else {
            let text = b[new_at..new_at + new_len].concat();
            if adjoining {
                let last = out.last_mut().unwrap();
                last.end = old_at + old_len;
                last.text.push_str(&text);
            } else {
                out.push(Hunk {
                    start: old_at,
                    end: old_at + old_len,
                    text,
                });
            }
            adjoining = true;
        }
        old_at += old_len;
        new_at += new_len;
    }
    out
}

/// Apply all changed lines as one attributed transaction in a scratch replica.
pub fn replace(doc: &Doc, new: &str, client: u64) -> Result<Vec<u8>> {
    let old = doc
        .get_or_insert_text("content")
        .get_string(&doc.transact());
    let scratch = core::document(Some(client));
    scratch.get_or_insert_text("content");
    scratch.get_or_insert_map("authors");
    core::apply(
        &scratch,
        core::decode(&core::state(doc)).map_err(|_| Error::Invalid)?,
    )
    .map_err(|_| Error::Invalid)?;
    let text = scratch.get_or_insert_text("content");
    let lines: Vec<_> = old.split_inclusive('\n').collect();
    let mut offsets = vec![0u32];
    let mut byte_offsets = vec![0usize];
    for line in lines {
        offsets.push(offsets.last().unwrap() + line.encode_utf16().count() as u32);
        byte_offsets.push(byte_offsets.last().unwrap() + line.len());
    }
    let mut txn = scratch.transact_mut();
    for h in hunks(&old, new).into_iter().rev() {
        let old_region = &old[byte_offsets[h.start]..byte_offsets[h.end]];
        let prefix_bytes = old_region
            .chars()
            .zip(h.text.chars())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum::<usize>();
        let old_tail = &old_region[prefix_bytes..];
        let new_tail = &h.text[prefix_bytes..];
        let suffix_bytes = old_tail
            .chars()
            .rev()
            .zip(new_tail.chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum::<usize>();
        let start = offsets[h.start] + old_region[..prefix_bytes].encode_utf16().count() as u32;
        let len = old_tail[..old_tail.len() - suffix_bytes]
            .encode_utf16()
            .count() as u32;
        let inserted = &new_tail[..new_tail.len() - suffix_bytes];
        if len > 0 {
            text.remove_range(&mut txn, start, len);
        }
        if !inserted.is_empty() {
            text.insert(&mut txn, start, inserted);
        }
    }
    Ok(txn.encode_update_v1())
}
