//! Disk-only record format, not a daemon/host wire envelope.
//! State is bounded and checksummed before Yrs decoding; text is checked against it.
use super::{core, Error, Result, MAX_STATE_BYTES, MAX_TEXT_BYTES};
use sha2::{Digest as _, Sha256};
use yrs::{Doc, GetString, Transact};
pub type Digest = [u8; 32];
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
}
impl Record {
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.state.len() > MAX_STATE_BYTES
            || self.text.len() > MAX_TEXT_BYTES
            || self.previous_text.len() > MAX_TEXT_BYTES
        {
            return Err(Error::Invalid);
        }
        let mut bytes = b"SMTHDOC1".to_vec();
        bytes.extend(self.epoch);
        bytes.extend(self.previous);
        bytes.extend(digest(self.text.as_bytes()));
        bytes.extend((self.text.len() as u32).to_be_bytes());
        bytes.extend((self.state.len() as u32).to_be_bytes());
        bytes.extend((self.previous_text.len() as u32).to_be_bytes());
        bytes.extend(self.text.as_bytes());
        bytes.extend(&self.state);
        bytes.extend(self.previous_text.as_bytes());
        bytes.extend(digest(&bytes));
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 132
            || bytes.len() > MAX_STATE_BYTES + 2 * MAX_TEXT_BYTES + 132
            || &bytes[..8] != b"SMTHDOC1"
        {
            return Err(Error::Invalid);
        }
        let text_len = u32::from_be_bytes(bytes[88..92].try_into().unwrap()) as usize;
        let state_len = u32::from_be_bytes(bytes[92..96].try_into().unwrap()) as usize;
        let base_len = u32::from_be_bytes(bytes[96..100].try_into().unwrap()) as usize;
        if text_len > MAX_TEXT_BYTES
            || base_len > MAX_TEXT_BYTES
            || state_len > MAX_STATE_BYTES
            || bytes.len() != 132 + text_len + state_len + base_len
            || digest(&bytes[..bytes.len() - 32]).as_slice() != &bytes[bytes.len() - 32..]
        {
            return Err(Error::Invalid);
        }
        let record = Self {
            epoch: bytes[8..24].try_into().unwrap(),
            previous: bytes[24..56].try_into().unwrap(),
            text: String::from_utf8(bytes[100..100 + text_len].to_vec())
                .map_err(|_| Error::Invalid)?,
            state: bytes[100 + text_len..100 + text_len + state_len].to_vec(),
            previous_text: String::from_utf8(
                bytes[100 + text_len + state_len..bytes.len() - 32].to_vec(),
            )
            .map_err(|_| Error::Invalid)?,
        };
        if digest(record.text.as_bytes()).as_slice() != &bytes[56..88]
            || digest(record.previous_text.as_bytes()) != record.previous
        {
            return Err(Error::Invalid);
        }
        let doc = record.document()?;
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
