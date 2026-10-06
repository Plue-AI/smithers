//! ADR 0004 framing and canonical tagged payload validation.
use std::io::{Read, Write};
include!("schema.rs");
pub const PROTOCOL: u16 = 1;
pub const MAX_FILE_BYTES: usize = 1_048_576;
pub const INITIAL_CREDIT: usize = 262_144;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProtocolError {
    Truncated = 1,
    FrameTooLarge,
    UnknownKind,
    BadStream,
    UnknownMessage,
    UnknownMethod,
    UnknownField,
    UnorderedField,
    MissingField,
    TrailingBytes,
    BadUtf8,
    BadValue,
    VersionMismatch,
    AuthFailed,
    Superseded,
    HandshakeOrder,
}
impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}
impl std::error::Error for ProtocolError {}
use ProtocolError::*;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub stream: u32,
    pub payload: Vec<u8>,
}
fn bound(kind: u8, stream: u32, n: usize) -> Result<(), ProtocolError> {
    let limits = [8192, 1114112, 4194304, 65536, 4194304, 65552, 65552];
    if kind > 6 {
        return Err(UnknownKind);
    };
    if (kind < 4) != (stream == 0) {
        return Err(BadStream);
    };
    if n > limits[kind as usize] {
        return Err(FrameTooLarge);
    };
    Ok(())
}
impl Frame {
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        Self::decode_mode(bytes, false)
    }
    pub fn decode_local(bytes: &[u8]) -> Result<Self, ProtocolError> {
        Self::decode_mode(bytes, true)
    }
    fn decode_mode(bytes: &[u8], local: bool) -> Result<Self, ProtocolError> {
        if bytes.len() < 9 {
            return Err(Truncated);
        };
        let n = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let kind = bytes[4];
        let stream = u32::from_be_bytes(bytes[5..9].try_into().unwrap());
        bound(kind, stream, n)?;
        if bytes.len() - 9 < n {
            return Err(Truncated);
        };
        if bytes.len() - 9 > n {
            return Err(TrailingBytes);
        };
        let frame = Self {
            kind,
            stream,
            payload: bytes[9..].to_vec(),
        };
        frame.validate(local)?;
        Ok(frame)
    }
    pub fn read(reader: &mut impl Read) -> Result<Self, ProtocolError> {
        let frame = Self::read_envelope(reader)?;
        frame.validate(false)?;
        Ok(frame)
    }
    pub(crate) fn read_envelope(reader: &mut impl Read) -> Result<Self, ProtocolError> {
        let mut header = [0; 9];
        reader.read_exact(&mut header).map_err(|_| Truncated)?;
        let n = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        bound(
            header[4],
            u32::from_be_bytes(header[5..].try_into().unwrap()),
            n,
        )?;
        let mut bytes = Vec::from(header);
        bytes.resize(9 + n, 0);
        reader.read_exact(&mut bytes[9..]).map_err(|_| Truncated)?;
        Ok(Self {
            kind: header[4],
            stream: u32::from_be_bytes(header[5..].try_into().unwrap()),
            payload: bytes[9..].to_vec(),
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        self.encode_mode(false)
    }
    pub fn encode_local(&self) -> Result<Vec<u8>, ProtocolError> {
        self.encode_mode(true)
    }
    fn encode_mode(&self, local: bool) -> Result<Vec<u8>, ProtocolError> {
        bound(self.kind, self.stream, self.payload.len())?;
        self.validate(local)?;
        let mut out = (self.payload.len() as u32).to_be_bytes().to_vec();
        out.push(self.kind);
        out.extend(self.stream.to_be_bytes());
        out.extend(&self.payload);
        Ok(out)
    }
    pub fn write(&self, writer: &mut impl Write) -> std::io::Result<()> {
        let bytes = self
            .encode()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        writer.write_all(&bytes)
    }
    pub fn request(&self) -> Result<(u32, u8, &[u8]), ProtocolError> {
        if self.kind != 1 || self.payload.len() < 16 || self.payload[0] != 1 {
            return Err(BadValue);
        };
        Ok((
            u32::from_be_bytes(self.payload[6..10].try_into().unwrap()),
            self.payload[11],
            &self.payload[12..],
        ))
    }
    pub(crate) fn validate(&self, local: bool) -> Result<(), ProtocolError> {
        let mut c = Cursor(&self.payload);
        if self.kind <= 3 {
            if local && self.kind == 1 {
                c.value("local_control")?
            } else {
                c.value(["hello_message", "control", "events", "presence"][self.kind as usize])?
            }
        } else {
            let msg = c.number(1)?;
            if self.kind == 4 && msg != 255 {
                if msg == 0 {
                    return Err(BadValue);
                };
                return Ok(());
            };
            if msg == 255 {
                c.value("error")?
            } else {
                if self.kind == 6 && !matches!(msg, 1 | 2 | 6 | 7) {
                    return Err(BadValue);
                };
                match msg {
                    1 => {
                        let fd = c.number(1)?;
                        if fd > 2 || (self.kind == 6 && fd != 0) || c.0.len() > 65536 {
                            return Err(BadValue);
                        };
                        c.0 = &[]
                    }
                    2 => {
                        let fd = c.number(1)?;
                        if fd > 2 || (self.kind == 6 && fd != 0) {
                            return Err(BadValue);
                        }
                    }
                    3 => {
                        c.take(4)?;
                    }
                    4 => {
                        let sig = c.number(1)?;
                        if !(1..=7).contains(&sig) {
                            return Err(BadValue);
                        }
                    }
                    5 => match c.number(1)? {
                        0 => {
                            c.take(4)?;
                        }
                        1 => {
                            let sig = c.number(1)?;
                            let core = c.number(1)?;
                            if !(1..=7).contains(&sig) || core > 1 {
                                return Err(BadValue);
                            }
                        }
                        _ => return Err(BadValue),
                    },
                    6 => {
                        let n = c.number(4)?;
                        if n == 0 || n > 262144 {
                            return Err(BadValue);
                        }
                    }
                    7 => {}
                    _ => return Err(UnknownMessage),
                }
            }
        };
        if !c.0.is_empty() {
            return Err(TrailingBytes);
        };
        Ok(())
    }
}
struct Cursor<'a>(&'a [u8]);
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ProtocolError> {
        if n > self.0.len() {
            return Err(Truncated);
        };
        let (b, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(b)
    }
    fn number(&mut self, n: usize) -> Result<u64, ProtocolError> {
        Ok(self
            .take(n)?
            .iter()
            .fold(0, |v, b| (v << 8) | u64::from(*b)))
    }
    fn value(&mut self, typ: &str) -> Result<(), ProtocolError> {
        if typ == "local_control" {
            if self.number(1)? != 1 {
                return Err(BadValue);
            };
            return self.value("local_request");
        }
        if is_union(typ) {
            let v = self.number(1)? as u8;
            let name = union(typ, v).ok_or(match typ {
                "call" | "local_call" => UnknownMethod,
                "host_actor" => BadValue,
                _ => UnknownMessage,
            })?;
            return self.value(name);
        }
        let local_fields = [(1, true, "u32"), (2, true, "local_call")];
        if let Some(fields) = if typ == "local_request" {
            Some(local_fields.as_slice())
        } else {
            structure(typ)
        } {
            let n = self.number(4)? as usize;
            let mut inner = Cursor(self.take(n)?);
            let mut last = 0;
            let mut seen = Vec::new();
            while !inner.0.is_empty() {
                let tag = inner.number(1)? as u8;
                if tag <= last {
                    return Err(UnorderedField);
                };
                last = tag;
                let f = fields.iter().find(|f| f.0 == tag).ok_or(UnknownField)?;
                seen.push(tag);
                inner.value(f.2)?
            }
            if fields.iter().any(|f| f.1 && !seen.contains(&f.0)) {
                return Err(MissingField);
            };
            return Ok(());
        }
        if typ.starts_with("list:") || typ == "sessions" {
            let n = self.number(2)?;
            let t = if typ == "sessions" {
                if n > 512 {
                    return Err(BadValue);
                };
                "u32"
            } else {
                &typ[5..]
            };
            for _ in 0..n {
                self.value(t)?
            }
            return Ok(());
        }
        match typ {
            "oid" => {
                self.take(20)?;
                return Ok(());
            }
            "digest" => {
                self.take(32)?;
                return Ok(());
            }
            "id128" => {
                self.take(16)?;
                return Ok(());
            }
            "str" | "str1024" | "content" | "bytes1024" => {
                let (width, limit) = match typ {
                    "str" => (2, 4096),
                    "str1024" => (2, 1024),
                    "content" => (4, 1048576),
                    _ => (4, 1024),
                };
                let n = self.number(width)? as usize;
                if n > limit {
                    return Err(BadValue);
                };
                let bytes = self.take(n)?;
                if width == 2 && (std::str::from_utf8(bytes).is_err() || bytes.contains(&0)) {
                    return Err(BadUtf8);
                };
                return Ok(());
            }
            _ => {}
        }
        let (width, min, max) = match typ {
            "u16" => (2, 0, 65535),
            "u32" => (4, 0, 4294967295),
            "u64" => (8, 0, u64::MAX),
            "magic" => (4, 0x534d4d44, 0x534d4d44),
            "version" => (2, 1, 1),
            "state" | "session_kind" => (1, 1, 3),
            "change" => (1, 1, 4),
            "reconcile_outcome" => (1, 1, 2),
            "ack_outcome" => (1, 1, 5),
            "error_code" => (1, 1, 12),
            "protocol_error" => (1, 1, 16),
            _ => return Err(BadValue),
        };
        let n = self.number(width)?;
        if n < min || n > max {
            return Err(if typ == "version" {
                VersionMismatch
            } else {
                BadValue
            });
        };
        Ok(())
    }
}
pub fn field(tag: u8, value: impl AsRef<[u8]>) -> Vec<u8> {
    let mut b = vec![tag];
    b.extend(value.as_ref());
    b
}
pub fn structure_bytes(fields: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = fields.iter().flatten().copied().collect();
    let mut b = (body.len() as u32).to_be_bytes().to_vec();
    b.extend(body);
    b
}
pub fn tagged(variant: u8, fields: &[Vec<u8>]) -> Vec<u8> {
    let mut b = vec![variant];
    b.extend(structure_bytes(fields));
    b
}
pub fn unsupported(id: u32) -> Frame {
    Frame {
        kind: 1,
        stream: 0,
        payload: tagged(
            2,
            &[
                field(1, id.to_be_bytes()),
                field(2, tagged(255, &[field(1, [2])])),
            ],
        ),
    }
}

/// Nonce proof, never the relay secret, crosses the connection.
pub fn host_mac(secret: &[u8], boot: &[u8; 16], nonce: &[u8; 32]) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts every key length");
    mac.update(b"smithers-machined/v1 host");
    mac.update(boot);
    mac.update(nonce);
    mac.finalize().into_bytes().into()
}
pub fn verify_host_mac(secret: &[u8], boot: &[u8; 16], nonce: &[u8; 32], proof: &[u8]) -> bool {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts every key length");
    mac.update(b"smithers-machined/v1 host");
    mac.update(boot);
    mac.update(nonce);
    mac.verify_slice(proof).is_ok()
}
