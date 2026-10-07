//! ADR 0004 S3 payload codec; stream framing belongs to the shared connection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Document {
    pub msg: u8,
    pub actor: Vec<u8>,
    pub data: Vec<u8>,
    pub epoch: [u8; 16],
    pub client_id: u32,
    pub at_ms: u64,
    pub seq: u64,
    pub through_seq: u64,
    pub refusal: u8,
    pub refusal_body: Vec<u8>,
    pub gone_kind: u8,
    pub gone_by: String,
    pub gone_to: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadDocumentPayload;
type Result<T> = std::result::Result<T, BadDocumentPayload>;
impl Document {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        Self::decode_mode(bytes, false)
    }
    /// Requires explicit protocol 2 selection; protocol 1 recordings stay readable.
    pub fn decode_v2(bytes: &[u8]) -> Result<Self> {
        Self::decode_mode(bytes, true)
    }
    fn decode_mode(bytes: &[u8], sequenced: bool) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > 4 << 20 {
            return Err(BadDocumentPayload);
        }
        let mut d = Self {
            msg: bytes[0],
            ..Default::default()
        };
        let p = &bytes[1..];
        match d.msg {
            1 | 2 => {
                if p.len() < 10 || p[0] != 1 || p[5] != 1 {
                    return Err(BadDocumentPayload);
                }
                let n = u32::from_be_bytes(p[6..10].try_into().unwrap()) as usize;
                let body = u32::from_be_bytes(p[1..5].try_into().unwrap()) as usize;
                if n == 0 || n > 1024 || body != n + 5 || p.len() < n + 10 {
                    return Err(BadDocumentPayload);
                }
                d.actor = p[10..10 + n].to_vec();
                let mut tail = &p[10 + n..];
                if sequenced && d.msg == 1 {
                    if tail.len() < 8 {
                        return Err(BadDocumentPayload);
                    }
                    d.seq = u64::from_be_bytes(tail[..8].try_into().unwrap());
                    tail = &tail[8..];
                }
                d.data = tail.to_vec();
            }
            3 | 4 => d.data = p.to_vec(),
            7 => {
                if p.is_empty() || (p[0] != 1 && p[0] != 2) {
                    return Err(BadDocumentPayload);
                }
                d.gone_kind = p[0];
                let (by, mut rest) = take_string(&p[1..])?;
                d.gone_by = by;
                if d.gone_kind == 2 {
                    let (to, tail) = take_string(rest)?;
                    if to.is_empty() {
                        return Err(BadDocumentPayload);
                    }
                    d.gone_to = to;
                    rest = tail;
                }
                if !rest.is_empty() {
                    return Err(BadDocumentPayload);
                }
            }
            5 => {
                if p.len() != 20 {
                    return Err(BadDocumentPayload);
                }
                d.epoch.copy_from_slice(&p[..16]);
                d.client_id = u32::from_be_bytes(p[16..].try_into().unwrap());
                if d.client_id == 0 {
                    return Err(BadDocumentPayload);
                }
            }
            6 => {
                if p.len() < 8 {
                    return Err(BadDocumentPayload);
                }
                d.at_ms = u64::from_be_bytes(p[..8].try_into().unwrap());
                let mut tail = &p[8..];
                if sequenced {
                    if tail.len() < 8 {
                        return Err(BadDocumentPayload);
                    }
                    d.through_seq = u64::from_be_bytes(tail[..8].try_into().unwrap());
                    tail = &tail[8..];
                }
                d.data = tail.to_vec();
            }
            255 => {
                d.refusal = refusal(p)?;
                d.refusal_body = p.to_vec();
            }
            _ => return Err(BadDocumentPayload),
        }
        Ok(d)
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.encode_mode(false)
    }
    pub fn encode_v2(&self) -> Result<Vec<u8>> {
        self.encode_mode(true)
    }
    fn encode_mode(&self, sequenced: bool) -> Result<Vec<u8>> {
        if !sequenced && (self.seq != 0 || self.through_seq != 0) {
            return Err(BadDocumentPayload);
        }
        let mut b = vec![self.msg];
        match self.msg {
            1 | 2 => {
                if self.actor.is_empty() || self.actor.len() > 1024 {
                    return Err(BadDocumentPayload);
                }
                b.push(1);
                b.extend_from_slice(&((5 + self.actor.len()) as u32).to_be_bytes());
                b.push(1);
                b.extend_from_slice(&(self.actor.len() as u32).to_be_bytes());
                b.extend_from_slice(&self.actor);
                if sequenced && self.msg == 1 {
                    b.extend_from_slice(&self.seq.to_be_bytes());
                }
                b.extend_from_slice(&self.data);
            }
            3 | 4 => b.extend_from_slice(&self.data),
            7 => {
                if self.gone_kind != 1 && self.gone_kind != 2 {
                    return Err(BadDocumentPayload);
                }
                b.push(self.gone_kind);
                put_string(&mut b, &self.gone_by)?;
                if self.gone_kind == 2 {
                    if self.gone_to.is_empty() {
                        return Err(BadDocumentPayload);
                    }
                    put_string(&mut b, &self.gone_to)?;
                }
            }
            5 => {
                if self.client_id == 0 {
                    return Err(BadDocumentPayload);
                }
                b.extend_from_slice(&self.epoch);
                b.extend_from_slice(&self.client_id.to_be_bytes());
            }
            6 => {
                b.extend_from_slice(&self.at_ms.to_be_bytes());
                if sequenced {
                    b.extend_from_slice(&self.through_seq.to_be_bytes());
                }
                b.extend_from_slice(&self.data);
            }
            255 => {
                let minimal = [0, 0, 0, 2, 1, self.refusal];
                let body = if self.refusal_body.is_empty() {
                    &minimal[..]
                } else {
                    &self.refusal_body
                };
                refusal(body)?;
                b.extend_from_slice(body);
            }
            _ => return Err(BadDocumentPayload),
        }
        if b.len() > 4 << 20 {
            return Err(BadDocumentPayload);
        }
        Ok(b)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_golden_payloads() {
        let frames: &[&[u8]] = &[
 include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-renamed.bin"),
 include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-unsupported-detail.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-input.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-awareness-input.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-sync.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-awareness.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-epoch.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-saved.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-gone.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-unsupported.bin"),
            include_bytes!("../../../packages/backend/internal/compose/testdata/cocontracts/doc-spoof.bin"),
        ];
        for b in frames {
            assert_eq!(b[4], 4);
            assert_eq!(&b[5..9], &[0, 0, 0, 9]);
            let f = crate::conn::Frame::decode(b).unwrap();
            assert_eq!(f.encode().unwrap(), *b);
            let d = Document::decode(&f.payload).unwrap();
            assert_eq!(d.encode().unwrap(), b[9..]);
            match d.msg {
                1 | 2 => assert_eq!(d.actor, b"Be"),
                7 => {
                    assert_eq!(d.gone_by, "Ben");
                    if d.gone_kind == 2 {
                        assert_eq!(d.gone_to, "deliver.ts");
                    }
                }
                5 => {
                    assert_eq!(d.client_id, 42);
                    assert_eq!(
                        d.epoch,
                        [0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255]
                    );
                }
                6 => {
                    assert_eq!(d.at_ms, 1791028800000);
                    assert_eq!(d.data, [1, 42, 1]);
                }
                _ => {}
            }
        }
    }
    #[test]
    fn document_malformed_payloads() {
        for b in [&[][..], &[0], &[1], &[5], &[6], &[255, 0, 0, 0, 2, 1, 0]] {
            assert!(Document::decode(b).is_err());
        }
        for msg in [0, 1, 2, 5, 255] {
            assert!(Document {
                msg,
                ..Default::default()
            }
            .encode()
            .is_err());
        }
    }
}

fn refusal(p: &[u8]) -> Result<u8> {
    let mut payload = vec![255];
    payload.extend_from_slice(p);
    crate::conn::Frame {
        kind: 4,
        stream: 1,
        payload,
    }
    .encode()
    .map_err(|_| BadDocumentPayload)?;
    Ok(p[5])
}

fn put_string(b: &mut Vec<u8>, s: &str) -> Result<()> {
    if s.len() > 4096 || s.as_bytes().contains(&0) {
        return Err(BadDocumentPayload);
    }
    b.extend_from_slice(&(s.len() as u16).to_be_bytes());
    b.extend_from_slice(s.as_bytes());
    Ok(())
}
fn take_string(p: &[u8]) -> Result<(String, &[u8])> {
    if p.len() < 2 {
        return Err(BadDocumentPayload);
    }
    let n = u16::from_be_bytes(p[..2].try_into().unwrap()) as usize;
    if n > 4096 || p.len() < n + 2 || p[2..2 + n].contains(&0) {
        return Err(BadDocumentPayload);
    }
    let s = std::str::from_utf8(&p[2..2 + n]).map_err(|_| BadDocumentPayload)?;
    Ok((s.to_owned(), &p[2 + n..]))
}
