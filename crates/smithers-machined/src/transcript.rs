//! Byte framing only; the install-shipped host adapters own semantic parsing.
//! Record identity is (source lifetime, generation, start, end). A newline is
//! included in the byte range but excluded from the UTF-8 payload.
use std::io;

/// Leaves space for identity and the ADR 0004 envelope within the 4 MiB limit.
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
pub const READ_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub generation: u64,
    pub start: u64,
    pub end: u64,
    pub text: String,
}

#[derive(Clone)]
pub struct Framer {
    generation: u64,
    offset: u64,
    pending: Vec<u8>,
    failed: bool,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

impl Framer {
    pub fn new(generation: u64) -> io::Result<Self> {
        if generation == 0 {
            return Err(invalid("zero source generation"));
        }
        Ok(Self {
            generation,
            offset: 0,
            pending: Vec::new(),
            failed: false,
        })
    }
    pub fn offset(&self) -> u64 {
        self.offset
    }
    /// One bounded read at a time. Invalid data stops the source visibly; no
    /// resynchronization silently drops a record. Use a clone while persisting
    /// outputs, then commit that clone only after all outbox appends succeed.
    pub fn push(&mut self, bytes: &[u8]) -> io::Result<Vec<Record>> {
        if self.failed || bytes.len() > READ_BYTES {
            return Err(invalid("stopped source or oversized reader message"));
        }
        let mut records = Vec::new();
        for byte in bytes {
            self.offset = match self.offset.checked_add(1) {
                Some(n) => n,
                None => {
                    self.failed = true;
                    return Err(invalid("source offset exhausted"));
                }
            };
            if *byte == b'\n' {
                let start = self.offset - self.pending.len() as u64 - 1;
                let text = match std::str::from_utf8(&self.pending) {
                    Ok(text) if !text.is_empty() && !text.contains('\0') => text.to_owned(),
                    _ => {
                        self.failed = true;
                        return Err(invalid("malformed transcript record"));
                    }
                };
                records.push(Record {
                    generation: self.generation,
                    start,
                    end: self.offset,
                    text,
                });
                self.pending.clear();
            } else {
                if self.pending.len() == MAX_RECORD_BYTES {
                    self.failed = true;
                    return Err(invalid("transcript record exceeds 1 MiB"));
                }
                self.pending.push(*byte);
            }
        }
        Ok(records)
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::Tail;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_utf8_and_offsets_are_literal() {
        let mut f = Framer::new(7).unwrap();
        assert!(f.push(b"{\"text\":\"\xc3").unwrap().is_empty());
        assert_eq!(
            f.push(b"\xa9\"}\n{}\npar").unwrap(),
            vec![
                Record {
                    generation: 7,
                    start: 0,
                    end: 14,
                    text: "{\"text\":\"é\"}".into()
                },
                Record {
                    generation: 7,
                    start: 14,
                    end: 17,
                    text: "{}".into()
                },
            ]
        );
        assert_eq!(
            f.push(b"tial\n").unwrap(),
            vec![Record {
                generation: 7,
                start: 17,
                end: 25,
                text: "partial".into()
            }]
        );
    }
    #[test]
    fn bounded_errors_stop_source() {
        assert!(Framer::new(0).is_err());
        for bytes in [b"\n".as_slice(), b"\xff\n", b"x\0\n"] {
            let mut f = Framer::new(1).unwrap();
            assert!(f.push(bytes).is_err());
            assert!(f.push(b"{}\n").is_err());
        }
        let mut f = Framer::new(1).unwrap();
        for _ in 0..16 {
            assert!(f.push(&vec![b'x'; READ_BYTES]).unwrap().is_empty());
        }
        assert_eq!(f.push(b"\n").unwrap()[0].text.len(), MAX_RECORD_BYTES);
        let mut f = Framer::new(1).unwrap();
        for _ in 0..16 {
            f.push(&vec![b'x'; READ_BYTES]).unwrap();
        }
        assert!(f.push(b"x").is_err());
        assert!(f.push(b"\n").is_err());
        assert!(Framer::new(1)
            .unwrap()
            .push(&vec![0; READ_BYTES + 1])
            .is_err());
    }
}
