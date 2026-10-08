//! ADR 0004 variant 5. Semantic normalization stays in the pinned host adapter.
use super::Record;
use crate::conn::{field, fields, tagged, Durable, ProtocolError};

/// Whether a durable event is a transcript record. It is text: it names no
/// git object, has no pin and travels with no bundle.
pub fn objectless(event: &Durable) -> bool {
    event.event.first() == Some(&5)
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub session: u32,
    pub participant: [u8; 16],
    pub lifetime: [u8; 16],
    pub profile: String,
}
impl Source {
    /// Caller derives Source from the broker registry, never an import request.
    pub fn event(&self, record: &Record) -> Result<Vec<u8>, ProtocolError> {
        if self.session == 0
            || self.session > 0x7fffffff
            || self.participant == [0; 16]
            || self.lifetime == [0; 16]
            || self.profile.is_empty()
            || self.profile.len() > 4096
            || record.generation == 0
            || record.end <= record.start
            || record.end - record.start - 1 != record.skipped.unwrap_or(record.text.len() as u64)
        {
            return Err(ProtocolError::BadValue);
        }
        let mut profile = (self.profile.len() as u16).to_be_bytes().to_vec();
        profile.extend(self.profile.as_bytes());
        let mut text = (record.text.len() as u32).to_be_bytes().to_vec();
        text.extend(record.text.as_bytes());
        let mut event = tagged(
            5,
            &[
                field(1, 1u16.to_be_bytes()),
                field(2, self.session.to_be_bytes()),
                field(3, self.participant),
                field(4, self.lifetime),
                field(5, profile),
                field(6, record.generation.to_be_bytes()),
                field(7, record.start.to_be_bytes()),
                field(8, record.end.to_be_bytes()),
                field(9, text),
            ],
        );
        if let Some(skipped) = record.skipped {
            event.extend(field(10, skipped.to_be_bytes()));
            let length = (event.len() - 5) as u32;
            event[1..5].copy_from_slice(&length.to_be_bytes());
        }
        // Validate through the shared codec before persisting to the outbox.
        Durable {
            seq: 1,
            id: [1; 16],
            event: event.clone(),
        }
        .frame()
        .encode()?;
        Ok(event)
    }
    pub fn decode(event: &[u8]) -> Result<(Self, Record), ProtocolError> {
        if event.first() != Some(&5) {
            return Err(ProtocolError::UnknownMessage);
        }
        let values = fields("transcript", &event[1..])?;
        let get = |tag| values.iter().find(|(t, _)| *t == tag).unwrap().1;
        if get(1) != 1u16.to_be_bytes() {
            return Err(ProtocolError::BadValue);
        }
        let source = Self {
            session: u32::from_be_bytes(get(2).try_into().unwrap()),
            participant: get(3).try_into().unwrap(),
            lifetime: get(4).try_into().unwrap(),
            profile: String::from_utf8(get(5)[2..].to_vec()).map_err(|_| ProtocolError::BadUtf8)?,
        };
        let record = Record {
            generation: u64::from_be_bytes(get(6).try_into().unwrap()),
            start: u64::from_be_bytes(get(7).try_into().unwrap()),
            end: u64::from_be_bytes(get(8).try_into().unwrap()),
            text: String::from_utf8(get(9)[4..].to_vec()).map_err(|_| ProtocolError::BadUtf8)?,
            skipped: values
                .iter()
                .find(|(tag, _)| *tag == 10)
                .map(|(_, bytes)| u64::from_be_bytes((*bytes).try_into().unwrap())),
        };
        source.event(&record)?;
        Ok((source, record))
    }
}

#[test]
fn transcript_wire_literal() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/backend/internal/compose/testdata/cocontracts/ev_transcript.bin");
    let frame = crate::conn::Frame::decode(&std::fs::read(path).unwrap()).unwrap();
    let durable = Durable::decode(&frame.payload).unwrap();
    let (source, record) = Source::decode(&durable.event).unwrap();
    assert_eq!(source.session, 1);
    assert_eq!(source.profile, "claude-code/2.1.0");
    assert_eq!(source.participant, [0x44; 16]);
    assert_eq!(source.lifetime, [0x33; 16]);
    assert_eq!(
        record,
        Record {
            generation: 1,
            start: 0,
            end: 16,
            text: "{\"type\":\"user\"}".into(),
            skipped: None,
        }
    );
    assert_eq!(source.event(&record).unwrap(), durable.event);
}

#[test]
fn skipped_roundtrip_and_both_refused() {
    let source = Source {
        session: 1,
        participant: [1; 16],
        lifetime: [2; 16],
        profile: "codex-rollout/0.160".into(),
    };
    for n in [1048577, 5242880] {
        let mut record = Record {
            generation: 1,
            start: 9,
            end: 9 + n + 1,
            text: "Skipped oversized transcript line.".into(),
            skipped: Some(n),
        };
        let event = source.event(&record).unwrap();
        assert_eq!(
            Source::decode(&event).unwrap(),
            (source.clone(), record.clone())
        );
        record.text = "{\"type\":\"user\"}".into();
        // Even with a valid skipped span, an agent line is not a daemon note.
        assert_eq!(source.event(&record), Err(ProtocolError::BadValue));
        record.skipped = Some(u64::MAX);
        assert_eq!(source.event(&record), Err(ProtocolError::BadValue));
    }
}
