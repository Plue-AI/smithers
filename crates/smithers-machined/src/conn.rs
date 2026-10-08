//! ADR 0004 framing and canonical tagged payload validation.
use std::io::{Read, Write};
include!("schema.rs");
pub const PROTOCOL: u16 = 8;
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
        writer.write_all(&bytes)?;
        Ok(())
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
                // ADR 0004 ruling 5: resize, signal and exit are forbidden on
                // an object stream (bad_value); an unknown msg is
                // unknown_message on both stream kinds.
                if self.kind == 6 && matches!(msg, 3..=5) {
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
            // ADR 0004 ruling 3: a reserved variant is refused before its body
            // is decoded. Event 6 (doc_edit) waits for T-COL-08a; event 5
            // (transcript) is defined by ruling 2.
            if typ == "event" && v == 6 {
                return Err(BadValue);
            }
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
            let body = self.take(n)?;
            let mut inner = Cursor(body);
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
            // ADR 0004 ruling 2: every transcript bound is checked by the
            // shared decoder, not only by transcript::wire.
            if typ == "transcript" {
                transcript_bounds(fields, body)?;
            }
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
            "str" | "str1024" | "content" | "bytes1024" | "record" => {
                let (width, limit) = match typ {
                    "str" => (2, 4096),
                    "str1024" => (2, 1024),
                    "content" | "record" => (4, 1048576),
                    _ => (4, 1024),
                };
                let n = self.number(width)? as usize;
                if n > limit {
                    return Err(BadValue);
                };
                let bytes = self.take(n)?;
                // A record is UTF-8 without NUL (the str rule, bad_utf8) and
                // one non-empty line without its newline (a bound, bad_value).
                if typ == "record" && (std::str::from_utf8(bytes).is_err() || bytes.contains(&0)) {
                    return Err(BadUtf8);
                }
                if typ == "record" && (bytes.is_empty() || bytes.contains(&b'\n')) {
                    return Err(BadValue);
                }
                if width == 2 && (std::str::from_utf8(bytes).is_err() || bytes.contains(&0)) {
                    return Err(BadUtf8);
                };
                return Ok(());
            }
            _ => {}
        }
        let (width, min, max) = match typ {
            "bool" => (1, 0, 1),
            "u16" => (2, 0, 65535),
            "u32" => (4, 0, 4294967295),
            "u64" => (8, 0, u64::MAX),
            "magic" => (4, 0x534d4d44, 0x534d4d44),
            "version" => (2, 1, PROTOCOL as u64),
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
/// Ruling 2's bounds over a transcript body whose tags and types the schema
/// has already accepted.
fn transcript_bounds(schema: &[(u8, bool, &str)], body: &[u8]) -> Result<(), ProtocolError> {
    let mut c = Cursor(body);
    let mut v: [&[u8]; 10] = [&[]; 10];
    while !c.0.is_empty() {
        let tag = c.number(1)? as usize;
        let start = c.0;
        c.value(
            schema
                .iter()
                .find(|f| f.0 as usize == tag)
                .ok_or(UnknownField)?
                .2,
        )?;
        v[tag] = &start[..start.len() - c.0.len()];
    }
    let n = |b: &[u8]| b.iter().fold(0u64, |a, x| (a << 8) | u64::from(*x));
    let (session, start, end) = (n(v[2]), n(v[7]), n(v[8]));
    let ok = n(v[1]) == 1
        && (1..=0x7fff_ffff).contains(&session)
        && v[3] != [0; 16]
        && v[4] != [0; 16]
        && v[5].len() > 2
        && n(v[6]) >= 1
        && end > start
        && end - start == (v[9].len() as u64 - 4) + 1;
    if ok {
        Ok(())
    } else {
        Err(BadValue)
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

/// Nonce proof, never the relay secret, crosses the connection. HostProof.mac
/// is HMAC-SHA256(secret, "smithers-machined host" || u16 big-endian protocol
/// || boot_id || nonce), so the protocol is authenticated (ADR 0004 ruling 1).
pub fn host_mac(secret: &[u8], protocol: u16, boot: &[u8; 16], nonce: &[u8; 32]) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts every key length");
    mac.update(b"smithers-machined host");
    mac.update(&protocol.to_be_bytes());
    mac.update(boot);
    mac.update(nonce);
    mac.finalize().into_bytes().into()
}
pub fn verify_host_mac(
    secret: &[u8],
    protocol: u16,
    boot: &[u8; 16],
    nonce: &[u8; 32],
    proof: &[u8],
) -> bool {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts every key length");
    mac.update(b"smithers-machined host");
    mac.update(&protocol.to_be_bytes());
    mac.update(boot);
    mac.update(nonce);
    mac.verify_slice(proof).is_ok()
}

/// Typed extraction uses the same schema validator as Frame, so hook owners
/// never add parsers or relax unknown-field / length refusals.
pub struct WriteArgs {
    pub path: String,
    pub base: crate::hooks::Base,
    pub content: Vec<u8>,
    pub actor: crate::hooks::Actor,
}
pub fn write_args(bytes: &[u8]) -> Result<WriteArgs, ProtocolError> {
    let mut check = Cursor(bytes);
    check.value("args3")?;
    if !check.0.is_empty() {
        return Err(TrailingBytes);
    }
    let mut c = Cursor(bytes);
    c.take(5)?;
    let n = c.number(2)? as usize;
    let path = std::str::from_utf8(c.take(n)?)
        .map_err(|_| BadUtf8)?
        .to_owned();
    c.take(1)?;
    let variant = c.number(1)?;
    c.take(4)?;
    let base = if variant == 1 {
        c.take(1)?;
        crate::hooks::Base::Digest(c.take(32)?.try_into().unwrap())
    } else {
        crate::hooks::Base::Absent
    };
    c.take(1)?;
    let n = c.number(4)? as usize;
    let content = c.take(n)?.to_vec();
    c.take(7)?;
    let n = c.number(4)? as usize;
    let actor = crate::hooks::Actor::Principal(c.take(n)?.to_vec());
    Ok(WriteArgs {
        path,
        base,
        content,
        actor,
    })
}
pub fn register_run_args(bytes: &[u8]) -> Result<(String, u32), ProtocolError> {
    let mut check = Cursor(bytes);
    check.value("args10")?;
    if !check.0.is_empty() {
        return Err(TrailingBytes);
    }
    let mut c = Cursor(bytes);
    c.take(5)?;
    let n = c.number(2)? as usize;
    let run = std::str::from_utf8(c.take(n)?)
        .map_err(|_| BadUtf8)?
        .to_owned();
    c.take(1)?;
    let session = c.number(4)? as u32;
    Ok((run, session))
}
pub fn actor_bytes(actor: &crate::hooks::Actor) -> Vec<u8> {
    use crate::hooks::Actor;
    match actor {
        Actor::Principal(p) => {
            let mut bytes = (p.len() as u32).to_be_bytes().to_vec();
            bytes.extend(p);
            tagged(1, &[field(1, bytes)])
        }
        Actor::Session(s) => tagged(2, &[field(1, s.to_be_bytes())]),
        Actor::Run(r) => {
            let mut bytes = (r.len() as u16).to_be_bytes().to_vec();
            bytes.extend(r.as_bytes());
            tagged(3, &[field(1, bytes)])
        }
        Actor::Outside => tagged(4, &[]),
    }
}
pub fn file_written(
    path: &str,
    actor: &crate::hooks::Actor,
    digest: Option<[u8; 32]>,
) -> Result<Vec<u8>, ProtocolError> {
    let mut text = (path.len() as u16).to_be_bytes().to_vec();
    text.extend(path.as_bytes());
    let mut fields = vec![field(1, text), field(2, actor_bytes(actor))];
    if let Some(d) = digest {
        fields.push(field(3, d));
    }
    let hint = tagged(1, &fields);
    let frame = Frame {
        kind: 2,
        stream: 0,
        payload: tagged(2, &[field(1, &hint)]),
    };
    frame.encode()?;
    Ok(hint)
}

/// Extract open_doc using the shared schema. Legacy S2 path-only requests remain
/// decodable, but cannot activate an S3 document provider.
pub fn open_doc_args(bytes: &[u8]) -> Result<(String, Option<Vec<u8>>), ProtocolError> {
    let mut check = Cursor(bytes);
    check.value("args13")?;
    if !check.0.is_empty() {
        return Err(TrailingBytes);
    }
    let mut c = Cursor(bytes);
    c.take(5)?;
    let n = c.number(2)? as usize;
    let path = std::str::from_utf8(c.take(n)?)
        .map_err(|_| BadUtf8)?
        .to_owned();
    let actor = if c.0.is_empty() {
        None
    } else {
        c.take(7)?;
        let n = c.number(4)? as usize;
        if n == 0 {
            return Err(BadValue);
        }
        Some(c.take(n)?.to_vec())
    };
    Ok((path, actor))
}

/// Rebase uses the existing ADR 0004 schema; only the onto object and the
/// authenticated host actor reach unprivileged rewrite code.
pub fn rebase_args(bytes: &[u8]) -> Result<([u8; 20], crate::hooks::Actor), ProtocolError> {
    let mut check = Cursor(bytes);
    check.value("args11")?;
    if !check.0.is_empty() {
        return Err(TrailingBytes);
    }
    let mut c = Cursor(bytes);
    c.take(5)?;
    let onto = c.take(20)?.try_into().unwrap();
    c.take(7)?;
    let n = c.number(4)? as usize;
    Ok((onto, crate::hooks::Actor::Principal(c.take(n)?.to_vec())))
}

/// Return uses the same authenticated host actor union as rebase.
pub fn return_to_item_actor(bytes: &[u8]) -> Result<crate::hooks::Actor, ProtocolError> {
    let fields = fields("args12", bytes)?;
    let actor = &fields[0].1[10..];
    if actor.is_empty() {
        return Err(BadValue);
    }
    Ok(crate::hooks::Actor::Principal(actor.to_vec()))
}

/// Borrow the validated fields of a named ADR structure. Hook implementations
/// use the same schema parser as framing, rather than another TLV decoder.
pub fn fields<'a>(name: &str, bytes: &'a [u8]) -> Result<Vec<(u8, &'a [u8])>, ProtocolError> {
    let schema = structure(name).ok_or(BadValue)?;
    let mut check = Cursor(bytes);
    check.value(name)?;
    if !check.0.is_empty() {
        return Err(TrailingBytes);
    }
    let mut inner = Cursor(&bytes[4..]);
    let mut result = vec![];
    while !inner.0.is_empty() {
        let tag = inner.number(1)? as u8;
        let typ = schema.iter().find(|f| f.0 == tag).ok_or(UnknownField)?.2;
        let start = inner.0;
        inner.value(typ)?;
        result.push((tag, &start[..start.len() - inner.0.len()]));
    }
    Ok(result)
}

/// Local writes use the identical typed values but never accept an actor field.
pub fn local_write_args(bytes: &[u8], principal: [u8; 16]) -> Result<WriteArgs, ProtocolError> {
    if principal == [0; 16] {
        return Err(BadValue);
    }
    let fields = fields("local_write", bytes)?;
    let mut host_fields: Vec<Vec<u8>> = fields
        .iter()
        .map(|(tag, value)| field(*tag, value))
        .collect();
    host_fields.push(field(
        4,
        actor_bytes(&crate::hooks::Actor::Principal(vec![])),
    ));
    let mut args = write_args(&structure_bytes(&host_fields))?;
    args.actor = crate::hooks::Actor::Principal(principal.to_vec());
    Ok(args)
}

/// Method 16 uses the ordinary ADR 0004 list of User structures. Semantic
/// identity and uniqueness validation remains the broker's responsibility.
pub fn roster_args(bytes: &[u8]) -> Result<Vec<crate::broker::sessions::User>, ProtocolError> {
    let mut check = Cursor(bytes);
    check.value("args16")?;
    if !check.0.is_empty() {
        return Err(TrailingBytes);
    }
    let mut c = Cursor(bytes);
    c.take(5)?;
    let count = c.number(2)? as usize;
    let mut members = Vec::with_capacity(count);
    for _ in 0..count {
        c.take(5)?;
        let n = c.number(2)? as usize;
        let login = std::str::from_utf8(c.take(n)?)
            .map_err(|_| BadUtf8)?
            .to_owned();
        c.take(1)?;
        let uid = c.number(4)? as u32;
        members.push(crate::broker::sessions::User { login, uid });
    }
    Ok(members)
}

/// Validated durable envelope used by disk replay and acknowledgement handling.
#[derive(Clone, Debug)]
pub struct Durable {
    pub seq: u64,
    pub id: [u8; 16],
    pub event: Vec<u8>,
}
impl Durable {
    pub fn frame(&self) -> Frame {
        Frame {
            kind: 2,
            stream: 0,
            payload: tagged(
                1,
                &[
                    field(1, self.seq.to_be_bytes()),
                    field(2, self.id),
                    field(3, &self.event),
                ],
            ),
        }
    }
    pub fn decode(payload: &[u8]) -> Result<Self, ProtocolError> {
        let frame = Frame {
            kind: 2,
            stream: 0,
            payload: payload.into(),
        };
        frame.validate(false)?;
        if payload[0] != 1 {
            return Err(BadValue);
        }
        Ok(Self {
            seq: u64::from_be_bytes(payload[6..14].try_into().unwrap()),
            id: payload[15..31].try_into().unwrap(),
            event: payload[32..].into(),
        })
    }
    pub fn captured_head(&self) -> Option<crate::hooks::Oid> {
        (self.event[0] == 2).then(|| self.event[6..26].try_into().unwrap())
    }
}
#[derive(Debug)]
pub struct Acknowledgement {
    pub seq: u64,
    pub outcome: u8,
    pub haves: Vec<crate::hooks::Oid>,
}
impl Acknowledgement {
    pub fn decode(frame: &Frame) -> Result<Self, ProtocolError> {
        frame.validate(false)?;
        if frame.kind != 2 || frame.payload[0] != 3 {
            return Err(BadValue);
        }
        let mut c = Cursor(&frame.payload[5..]);
        c.take(1)?;
        let seq = c.number(8)?;
        c.take(1)?;
        let outcome = c.number(1)? as u8;
        let mut haves = vec![];
        while !c.0.is_empty() {
            match c.number(1)? {
                3 => c.value("list:oid")?,
                4 => c.value("error")?,
                5 => {
                    let count = c.number(2)?;
                    for _ in 0..count {
                        haves.push(c.take(20)?.try_into().unwrap());
                    }
                }
                _ => return Err(UnknownField),
            }
        }
        Ok(Self {
            seq,
            outcome,
            haves,
        })
    }
}

/// Borrow list entries using the same schema parser as framing.
pub fn list<'a>(name: &str, bytes: &'a [u8]) -> Result<Vec<&'a [u8]>, ProtocolError> {
    let mut cursor = Cursor(bytes);
    let count = cursor.number(2)? as usize;
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let start = cursor.0;
        cursor.value(name)?;
        entries.push(&start[..start.len() - cursor.0.len()]);
    }
    if !cursor.0.is_empty() {
        return Err(TrailingBytes);
    }
    Ok(entries)
}

/// The batch reuses single-write values and one authenticated actor envelope.
pub fn batch_write_args(
    bytes: &[u8],
) -> Result<(Vec<crate::hooks::FileWrite>, crate::hooks::Actor), ProtocolError> {
    let values = fields("args17", bytes)?;
    let actor = values[1].1;
    let mut list = Cursor(values[0].1);
    let count = list.number(2)? as usize;
    if count == 0 || count > 256 {
        return Err(BadValue);
    }
    let mut writes = Vec::with_capacity(count);
    for _ in 0..count {
        let start = list.0;
        list.value("local_mutation")?;
        let raw = &start[..start.len() - list.0.len()];
        let parsed = fields("local_mutation", raw)?;
        let has_content = parsed.iter().any(|(tag, _)| *tag == 3);
        let mut values: Vec<_> = parsed
            .into_iter()
            .map(|(tag, value)| field(tag, value))
            .collect();
        if !has_content {
            values.push(field(3, [0; 4]));
        }
        values.push(field(4, actor));
        let write = write_args(&structure_bytes(&values))?;
        writes.push(crate::hooks::FileWrite {
            path: write.path,
            base: write.base,
            content: has_content.then_some(write.content),
        });
    }
    let principal = fields("principal", &actor[1..])?[0].1;
    Ok((
        writes,
        crate::hooks::Actor::Principal(principal[4..].to_vec()),
    ))
}
pub fn local_batch_write_args(
    bytes: &[u8],
    principal: [u8; 16],
) -> Result<(Vec<crate::hooks::FileWrite>, crate::hooks::Actor), ProtocolError> {
    if principal == [0; 16] {
        return Err(BadValue);
    }
    let values = fields("local_batch", bytes)?;
    batch_write_args(&structure_bytes(&[
        field(1, values[0].1),
        field(
            2,
            actor_bytes(&crate::hooks::Actor::Principal(principal.to_vec())),
        ),
    ]))
}
