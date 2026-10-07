//! ADR 0004 variant 5. Semantic normalization stays in the pinned host adapter.
use crate::conn::{field, fields, tagged, Durable, ProtocolError};
use super::Record;

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
        if self.session == 0 || self.session > 0x7fffffff || self.participant == [0;16] || self.lifetime == [0;16] || self.profile.is_empty() || self.profile.len() > 4096 || record.generation == 0 || record.end <= record.start || record.end - record.start != record.text.len() as u64 + 1 {
            return Err(ProtocolError::BadValue);
        }
        let mut profile = (self.profile.len() as u16).to_be_bytes().to_vec();
        profile.extend(self.profile.as_bytes());
        let mut text = (record.text.len() as u32).to_be_bytes().to_vec();
        text.extend(record.text.as_bytes());
        let event = tagged(5, &[
            field(1, 1u16.to_be_bytes()), field(2, self.session.to_be_bytes()),
            field(3, self.participant), field(4, self.lifetime), field(5, profile),
            field(6, record.generation.to_be_bytes()), field(7, record.start.to_be_bytes()),
            field(8, record.end.to_be_bytes()), field(9, text),
        ]);
        // Validate through the shared codec before persisting to the outbox.
        Durable {seq:1,id:[1;16],event:event.clone()}.frame().encode()?;
        Ok(event)
    }
    pub fn decode(event: &[u8]) -> Result<(Self, Record), ProtocolError> {
        if event.first() != Some(&5) { return Err(ProtocolError::UnknownMessage); }
        let values = fields("transcript", &event[1..])?;
        let get = |tag| values.iter().find(|(t,_)| *t==tag).unwrap().1;
        if get(1) != 1u16.to_be_bytes() {return Err(ProtocolError::VersionMismatch);}
        let source = Self {session:u32::from_be_bytes(get(2).try_into().unwrap()),participant:get(3).try_into().unwrap(),lifetime:get(4).try_into().unwrap(),profile:String::from_utf8(get(5)[2..].to_vec()).map_err(|_| ProtocolError::BadUtf8)?};
        let record = Record {generation:u64::from_be_bytes(get(6).try_into().unwrap()),start:u64::from_be_bytes(get(7).try_into().unwrap()),end:u64::from_be_bytes(get(8).try_into().unwrap()),text:String::from_utf8(get(9)[4..].to_vec()).map_err(|_| ProtocolError::BadUtf8)?};
        source.event(&record)?;
        Ok((source,record))
    }
}

#[test]
fn transcript_wire_literal() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/backend/internal/compose/testdata/cocontracts/ev_transcript.bin");
    let frame = crate::conn::Frame::decode(&std::fs::read(path).unwrap()).unwrap();
    let durable = Durable::decode(&frame.payload).unwrap();
    let (source,record)=Source::decode(&durable.event).unwrap();
    assert_eq!(source.session,1); assert_eq!(source.profile,"claude-code/2.1.0");
    assert_eq!(source.participant,[0x44;16]); assert_eq!(source.lifetime,[0x33;16]);
    assert_eq!(record,Record {generation:1,start:0,end:16,text:"{\"type\":\"user\"}".into()});
    assert_eq!(source.event(&record).unwrap(),durable.event);
}
