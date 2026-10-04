//! Disposable probe encoding, not a second production wire contract.
//! Existing host PTYs and SSH viewer managers do not represent guest frames.
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const CREDIT: u32 = 262_144;
const MAX_FRAME: usize = 65_536;
const MAX_DATA: usize = 8_192;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Frame {
    Data { stream: u8, bytes: Vec<u8> },
    Eof { stream: u8 },
    Resize { cols: u16, rows: u16 },
    Signal { name: String },
    Exit { code: u8 },
    ExitSignal { name: String, core: bool },
    Window { bytes: u32 },
    Close {},
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid session frame")
}
pub fn valid_signal(name: &str) -> bool {
    matches!(
        name,
        "INT" | "TERM" | "HUP" | "KILL" | "QUIT" | "USR1" | "USR2"
    )
}
impl Frame {
    pub fn validate(&self) -> io::Result<()> {
        let valid = match self {
            Self::Data { stream, bytes } => {
                *stream <= 2 && !bytes.is_empty() && bytes.len() <= MAX_DATA
            }
            Self::Eof { stream } => *stream <= 2,
            Self::Resize { cols, rows } => *cols > 0 && *rows > 0,
            Self::Signal { name } | Self::ExitSignal { name, .. } => valid_signal(name),
            Self::Window { bytes } => *bytes > 0 && *bytes <= CREDIT,
            Self::Exit { .. } | Self::Close {} => true,
        };
        if valid { Ok(()) } else { Err(invalid()) }
    }
    pub fn read(reader: &mut impl Read) -> io::Result<Self> {
        let mut length = [0; 4];
        reader.read_exact(&mut length)?;
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > MAX_FRAME {
            return Err(invalid());
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes)?;
        let frame: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        frame.validate()?;
        Ok(frame)
    }
    pub fn write(&self, writer: &mut impl Write) -> io::Result<()> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| invalid())?;
        if bytes.len() > MAX_FRAME {
            return Err(invalid());
        }
        writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
        writer.write_all(&bytes)
    }
}

/// Retain only unacknowledged bytes; absolute offsets make replay idempotent.
#[derive(Debug, Default)]
pub struct Credit {
    acknowledged: u64,
    sent: u64,
    retained: std::collections::VecDeque<u8>,
}
impl Credit {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn available(&self) -> usize {
        CREDIT as usize - self.retained.len()
    }
    pub fn send(&mut self, bytes: &[u8]) -> io::Result<u64> {
        if bytes.is_empty() || bytes.len() > self.available() {
            return Err(invalid());
        }
        let next = self
            .sent
            .checked_add(bytes.len() as u64)
            .ok_or_else(invalid)?;
        let offset = self.sent;
        self.retained.extend(bytes);
        self.sent = next;
        Ok(offset)
    }
    pub fn acknowledge(&mut self, received: u64) -> io::Result<()> {
        if received < self.acknowledged || received > self.sent {
            return Err(invalid());
        }
        self.retained
            .drain(..(received - self.acknowledged) as usize);
        self.acknowledged = received;
        Ok(())
    }
    pub fn replay(&self, received: u64) -> io::Result<Vec<u8>> {
        if received < self.acknowledged || received > self.sent {
            return Err(invalid());
        }
        Ok(self
            .retained
            .iter()
            .skip((received - self.acknowledged) as usize)
            .copied()
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_frames_and_unknown_fields() {
        let fixtures = [
            (
                r#"{"type":"data","stream":0,"bytes":[0,255,10]}"#,
                Frame::Data {
                    stream: 0,
                    bytes: vec![0, 255, 10],
                },
            ),
            (r#"{"type":"eof","stream":1}"#, Frame::Eof { stream: 1 }),
            (
                r#"{"type":"resize","cols":120,"rows":40}"#,
                Frame::Resize {
                    cols: 120,
                    rows: 40,
                },
            ),
            (
                r#"{"type":"signal","name":"INT"}"#,
                Frame::Signal { name: "INT".into() },
            ),
            (r#"{"type":"exit","code":7}"#, Frame::Exit { code: 7 }),
            (
                r#"{"type":"exit_signal","name":"TERM","core":false}"#,
                Frame::ExitSignal {
                    name: "TERM".into(),
                    core: false,
                },
            ),
            (
                r#"{"type":"window","bytes":262144}"#,
                Frame::Window { bytes: 262144 },
            ),
            (r#"{"type":"close"}"#, Frame::Close {}),
        ];
        for (json, expected) in fixtures {
            let mut wire = (json.len() as u32).to_be_bytes().to_vec();
            wire.extend(json.as_bytes());
            assert_eq!(Frame::read(&mut &wire[..]).unwrap(), expected);
            let mut encoded = vec![];
            expected.write(&mut encoded).unwrap();
            assert_eq!(encoded, wire);
        }
        for json in [
            r#"{"type":"close","uid":0}"#,
            r#"{"type":"window","bytes":0}"#,
            r#"{"type":"signal","name":"STOP"}"#,
            r#"{"type":"eof","stream":3}"#,
            r#"{"type":"resize","cols":0,"rows":40}"#,
            r#"{"type":"data","stream":0,"bytes":[]}"#,
        ] {
            let mut wire = (json.len() as u32).to_be_bytes().to_vec();
            wire.extend(json.as_bytes());
            assert!(Frame::read(&mut &wire[..]).is_err(), "{json}");
        }
        assert!(Frame::read(&mut &[0, 1, 0, 1][..]).is_err());
        assert!(Frame::read(&mut &[0, 0, 0, 0][..]).is_err());
        assert!(Frame::read(&mut &[0, 0, 0, 2, b'{'][..]).is_err());
        assert!(
            Frame::Data {
                stream: 0,
                bytes: vec![1; 8193]
            }
            .validate()
            .is_err()
        );
        assert!(Frame::Window { bytes: 262145 }.validate().is_err());
    }
    #[test]
    fn stalled_output_replay_and_credit_bound() {
        let mut credit = Credit::new();
        let bytes: Vec<u8> = (0..262144).map(|i| (i % 251) as u8).collect();
        assert_eq!(credit.send(&bytes).unwrap(), 0);
        assert_eq!(credit.available(), 0);
        assert!(credit.send(&[1]).is_err());
        assert!(credit.acknowledge(262145).is_err());
        assert_eq!(credit.replay(100000).unwrap(), bytes[100000..]);
        credit.acknowledge(100000).unwrap();
        assert!(credit.replay(99999).is_err());
        assert!(credit.acknowledge(99999).is_err());
        assert_eq!(credit.available(), 100000);
        assert_eq!(credit.send(&bytes[..100000]).unwrap(), 262144);
        let expected = [&bytes[100000..], &bytes[..100000]].concat();
        assert_eq!(credit.replay(100000).unwrap(), expected);
        credit.acknowledge(362144).unwrap();
        credit.acknowledge(362144).unwrap();
        assert_eq!(credit.available(), 262144);
        assert!(credit.replay(362145).is_err());
        assert!(credit.send(&[]).is_err());
    }
}
