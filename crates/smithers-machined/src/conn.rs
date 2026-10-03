//! ADR 0004 framing and canonical tagged primitives. Bounds precede allocation.
use std::io::{Read, Write};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ProtocolError {}
impl ProtocolError {
    pub fn from_code(code: u8) -> Result<Self, Self> {
        use ProtocolError::*;
        [
            Truncated,
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
        ]
        .get(code.wrapping_sub(1) as usize)
        .copied()
        .ok_or(BadValue)
    }
}
pub const MAX_FILE_BYTES: usize = 1 << 20;
pub const INITIAL_CREDIT: u32 = 262_144;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Hello = 0,
    Control,
    Events,
    Presence,
    Documents,
    Sessions,
    Objects,
}
impl Kind {
    pub fn parse(v: u8) -> Result<Self, ProtocolError> {
        [
            Self::Hello,
            Self::Control,
            Self::Events,
            Self::Presence,
            Self::Documents,
            Self::Sessions,
            Self::Objects,
        ]
        .get(v as usize)
        .copied()
        .ok_or(ProtocolError::UnknownKind)
    }
    pub fn limit(self) -> usize {
        match self {
            Self::Hello => 8192,
            Self::Control => MAX_FILE_BYTES + 65536,
            Self::Events | Self::Documents => 4 << 20,
            Self::Presence => 65536,
            Self::Sessions | Self::Objects => 65552,
        }
    }
    fn check_stream(self, stream: u32) -> Result<(), ProtocolError> {
        if (self as u8 <= 3) != (stream == 0) {
            Err(ProtocolError::BadStream)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub kind: Kind,
    pub stream: u32,
    pub payload: Vec<u8>,
}
impl Frame {
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        self.kind.check_stream(self.stream)?;
        if self.payload.len() > self.kind.limit() {
            return Err(ProtocolError::FrameTooLarge);
        }
        let mut out = Vec::with_capacity(9 + self.payload.len());
        out.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        out.push(self.kind as u8);
        out.extend_from_slice(&self.stream.to_be_bytes());
        out.extend_from_slice(&self.payload);
        Ok(out)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let (kind, stream, len) = decode_header(bytes)?;
        if bytes.len() < 9 + len {
            return Err(ProtocolError::Truncated);
        }
        if bytes.len() != 9 + len {
            return Err(ProtocolError::TrailingBytes);
        }
        Ok(Self {
            kind,
            stream,
            payload: bytes[9..].to_vec(),
        })
    }
    pub fn read(reader: &mut impl Read) -> Result<Self, ProtocolError> {
        let mut hdr = [0; 9];
        reader
            .read_exact(&mut hdr)
            .map_err(|_| ProtocolError::Truncated)?;
        let (kind, stream, len) = decode_header(&hdr)?;
        let mut payload = vec![0; len];
        reader
            .read_exact(&mut payload)
            .map_err(|_| ProtocolError::Truncated)?;
        Ok(Self {
            kind,
            stream,
            payload,
        })
    }
    pub fn write(&self, writer: &mut impl Write) -> Result<(), ProtocolError> {
        writer
            .write_all(&self.encode()?)
            .map_err(|_| ProtocolError::Truncated)
    }
}
pub fn decode_header(bytes: &[u8]) -> Result<(Kind, u32, usize), ProtocolError> {
    if bytes.len() < 9 {
        return Err(ProtocolError::Truncated);
    }
    let kind = Kind::parse(bytes[4])?;
    let stream = u32::from_be_bytes(bytes[5..9].try_into().unwrap());
    kind.check_stream(stream)?;
    let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    if len > kind.limit() {
        return Err(ProtocolError::FrameTooLarge);
    }
    Ok((kind, stream, len))
}
pub struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Cursor<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }
    pub fn take(&mut self, n: usize) -> Result<&'a [u8], ProtocolError> {
        let end = self.pos.checked_add(n).ok_or(ProtocolError::BadValue)?;
        let value = self
            .bytes
            .get(self.pos..end)
            .ok_or(ProtocolError::Truncated)?;
        self.pos = end;
        Ok(value)
    }
    pub fn done(&self) -> bool {
        self.pos == self.bytes.len()
    }
    pub fn finish(&self) -> Result<(), ProtocolError> {
        if self.done() {
            Ok(())
        } else {
            Err(ProtocolError::TrailingBytes)
        }
    }
    pub fn structure(&mut self) -> Result<Cursor<'a>, ProtocolError> {
        let n = u32::decode(self)? as usize;
        Ok(Cursor::new(self.take(n)?))
    }
}
pub trait Wire: Sized {
    fn encode(&self, out: &mut Vec<u8>) -> Result<(), ProtocolError>;
    fn decode(input: &mut Cursor<'_>) -> Result<Self, ProtocolError>;
    fn bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        let mut out = Vec::new();
        self.encode(&mut out)?;
        Ok(out)
    }
    fn from_bytes(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let mut c = Cursor::new(bytes);
        let value = Self::decode(&mut c)?;
        c.finish()?;
        Ok(value)
    }
}
macro_rules! number {
    ($($ty:ty),*) => { $(impl Wire for $ty {
        fn encode(&self, out: &mut Vec<u8>) -> Result<(), ProtocolError> { out.extend_from_slice(&self.to_be_bytes()); Ok(()) }
        fn decode(c: &mut Cursor<'_>) -> Result<Self, ProtocolError> { Ok(Self::from_be_bytes(c.take(std::mem::size_of::<Self>())?.try_into().unwrap())) }
    })* };
}
number!(u8, u16, u32, u64, i32);
impl<const N: usize> Wire for [u8; N] {
    fn encode(&self, out: &mut Vec<u8>) -> Result<(), ProtocolError> {
        out.extend_from_slice(self);
        Ok(())
    }
    fn decode(c: &mut Cursor<'_>) -> Result<Self, ProtocolError> {
        Ok(c.take(N)?.try_into().unwrap())
    }
}
impl Wire for String {
    fn encode(&self, out: &mut Vec<u8>) -> Result<(), ProtocolError> {
        if self.len() > 4096 {
            return Err(ProtocolError::BadValue);
        }
        if self.contains('\0') {
            return Err(ProtocolError::BadUtf8);
        }
        (self.len() as u16).encode(out)?;
        out.extend_from_slice(self.as_bytes());
        Ok(())
    }
    fn decode(c: &mut Cursor<'_>) -> Result<Self, ProtocolError> {
        let n = u16::decode(c)? as usize;
        if n > 4096 {
            return Err(ProtocolError::BadValue);
        }
        let s = std::str::from_utf8(c.take(n)?).map_err(|_| ProtocolError::BadUtf8)?;
        if s.contains('\0') {
            return Err(ProtocolError::BadUtf8);
        }
        Ok(s.to_owned())
    }
}
impl<T: Wire> Wire for Vec<T> {
    fn encode(&self, out: &mut Vec<u8>) -> Result<(), ProtocolError> {
        let len = u16::try_from(self.len()).map_err(|_| ProtocolError::BadValue)?;
        len.encode(out)?;
        for v in self {
            v.encode(out)?;
        }
        Ok(())
    }
    fn decode(c: &mut Cursor<'_>) -> Result<Self, ProtocolError> {
        let n = u16::decode(c)?;
        let mut out = Vec::new();
        for _ in 0..n {
            out.push(T::decode(c)?);
        }
        Ok(out)
    }
}
#[cfg_attr(feature = "testing", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bytes(pub Vec<u8>);
impl Wire for Bytes {
    fn encode(&self, out: &mut Vec<u8>) -> Result<(), ProtocolError> {
        u32::try_from(self.0.len())
            .map_err(|_| ProtocolError::BadValue)?
            .encode(out)?;
        out.extend_from_slice(&self.0);
        Ok(())
    }
    fn decode(c: &mut Cursor<'_>) -> Result<Self, ProtocolError> {
        let n = u32::decode(c)? as usize;
        Ok(Self(c.take(n)?.to_vec()))
    }
}
pub fn structure(body: Vec<u8>, out: &mut Vec<u8>) -> Result<(), ProtocolError> {
    u32::try_from(body.len())
        .map_err(|_| ProtocolError::BadValue)?
        .encode(out)?;
    out.extend_from_slice(&body);
    Ok(())
}
