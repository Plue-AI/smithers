//! Disk-only record format, not a daemon/host wire envelope.
//! State is bounded and checksummed before Yrs decoding; text is checked against it.
use super::{core, Error, Result, MAX_STATE_BYTES, MAX_TEXT_BYTES};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeSet;
use yrs::{Doc, GetString, Transact};
pub type Digest = [u8; 32];
pub const MAX_RECORD_BYTES: usize = 2 * MAX_STATE_BYTES + 2 * MAX_TEXT_BYTES + 136;
pub fn digest(bytes: &[u8]) -> Digest {
    Sha256::digest(bytes).into()
}
#[derive(Clone, Debug)]
pub struct Record {
    pub epoch: [u8; 16],
    pub previous: Digest,
    pub previous_text: String,
    pub text: String,
    pub state: Vec<u8>,
    /// Text-author clients recovered from protocol 1 records remain readable,
    /// but can never authorize new protocol-5 edits or presence.
    pub retired_clients: BTreeSet<u64>,
}
impl Record {
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.state.len() > MAX_STATE_BYTES
            || self.text.len() > MAX_TEXT_BYTES
            || self.previous_text.len() > MAX_TEXT_BYTES
            || self.retired_clients.len() > MAX_STATE_BYTES / 8
        {
            return Err(Error::Invalid);
        }
        let mut bytes = b"SMTHDOC2".to_vec();
        bytes.extend(self.epoch);
        bytes.extend(self.previous);
        bytes.extend(digest(self.text.as_bytes()));
        bytes.extend((self.text.len() as u32).to_be_bytes());
        bytes.extend((self.state.len() as u32).to_be_bytes());
        bytes.extend((self.previous_text.len() as u32).to_be_bytes());
        bytes.extend(self.text.as_bytes());
        bytes.extend(&self.state);
        bytes.extend(self.previous_text.as_bytes());
        bytes.extend((self.retired_clients.len() as u32).to_be_bytes());
        for id in &self.retired_clients {
            bytes.extend(id.to_be_bytes());
        }
        bytes.extend(digest(&bytes));
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 132
            || bytes.len() > MAX_RECORD_BYTES
            || (&bytes[..8] != b"SMTHDOC1" && &bytes[..8] != b"SMTHDOC2")
        {
            return Err(Error::Invalid);
        }
        let text_len = u32::from_be_bytes(bytes[88..92].try_into().unwrap()) as usize;
        let state_len = u32::from_be_bytes(bytes[92..96].try_into().unwrap()) as usize;
        let base_len = u32::from_be_bytes(bytes[96..100].try_into().unwrap()) as usize;
        let body_end = 100usize + text_len + state_len + base_len;
        let legacy = &bytes[..8] == b"SMTHDOC1";
        let mut retired_clients = BTreeSet::new();
        let expected = if legacy {
            body_end + 32
        } else {
            let count = bytes.get(body_end..body_end + 4).ok_or(Error::Invalid)?;
            let count = u32::from_be_bytes(count.try_into().unwrap()) as usize;
            if count > MAX_STATE_BYTES / 8 {
                return Err(Error::Invalid);
            }
            let raw = bytes
                .get(body_end + 4..body_end + 4 + count * 8)
                .ok_or(Error::Invalid)?;
            let mut last = 0;
            for entry in raw.chunks_exact(8) {
                let id = u64::from_be_bytes(entry.try_into().unwrap());
                if id == 0 || id <= last {
                    return Err(Error::Invalid);
                }
                last = id;
                retired_clients.insert(id);
            }
            body_end + 4 + count * 8 + 32
        };
        if text_len > MAX_TEXT_BYTES
            || base_len > MAX_TEXT_BYTES
            || state_len > MAX_STATE_BYTES
            || bytes.len() != expected
            || digest(&bytes[..bytes.len() - 32]).as_slice() != &bytes[bytes.len() - 32..]
        {
            return Err(Error::Invalid);
        }
        let mut record = Self {
            retired_clients,
            epoch: bytes[8..24].try_into().unwrap(),
            previous: bytes[24..56].try_into().unwrap(),
            text: String::from_utf8(bytes[100..100 + text_len].to_vec())
                .map_err(|_| Error::Invalid)?,
            state: bytes[100 + text_len..100 + text_len + state_len].to_vec(),
            previous_text: String::from_utf8(bytes[100 + text_len + state_len..body_end].to_vec())
                .map_err(|_| Error::Invalid)?,
        };
        if digest(record.text.as_bytes()).as_slice() != &bytes[56..88]
            || digest(record.previous_text.as_bytes()) != record.previous
        {
            return Err(Error::Invalid);
        }
        let doc = record.document()?;
        let authors = super::authors::entries(&doc)?;
        if legacy {
            record.retired_clients = authors
                .keys()
                .map(|id| {
                    let parsed = id.parse::<u64>().map_err(|_| Error::Invalid)?;
                    if parsed == 0 || parsed.to_string() != *id {
                        return Err(Error::Invalid);
                    }
                    Ok(parsed)
                })
                .collect::<Result<BTreeSet<_>>>()?;
        } else if record
            .retired_clients
            .iter()
            .any(|id| !authors.contains_key(&id.to_string()))
        {
            return Err(Error::Invalid);
        }
        if doc
            .get_or_insert_text("content")
            .get_string(&doc.transact())
            != record.text
        {
            return Err(Error::Invalid);
        }
        Ok(record)
    }
    pub fn document(&self) -> Result<Doc> {
        let doc = core::document(None);
        doc.get_or_insert_text("content");
        doc.get_or_insert_map("authors");
        core::apply(&doc, core::decode(&self.state).map_err(|_| Error::Invalid)?)
            .map_err(|_| Error::Invalid)?;
        core::validate(&doc, "content", true).map_err(|_| Error::Invalid)?;
        super::authors::entries(&doc)?;
        Ok(doc)
    }
}
