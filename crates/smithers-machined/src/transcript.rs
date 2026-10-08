//! Byte framing only; the install-shipped host adapters own semantic parsing.
//! Record identity is (source lifetime, generation, start, end). A newline is
//! included in the byte range but excluded from the UTF-8 payload.
//!
//! Every byte of a source is in exactly one record's range, so ranges stay
//! contiguous whatever a line holds. A record is as long as its line, byte for
//! byte: a byte that cannot cross the wire (not UTF-8, or NUL) is sent as `?`,
//! and a line with nothing in it is carried as leading whitespace of the next
//! record. Neither stops a source. Only a line longer than a record can be
//! (1 MiB) does.
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
    /// Nothing but whitespace is pending: a blank line so far. Kept as the
    /// bytes arrive, so a long run of blank lines is not scanned again each.
    blank: bool,
}

fn whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r')
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
            blank: true,
        })
    }
    /// A framer as a checkpoint saved it.
    #[cfg(target_os = "linux")]
    fn restored(generation: u64, offset: u64, pending: Vec<u8>, failed: bool) -> Self {
        Self {
            generation,
            offset,
            blank: pending.iter().copied().all(whitespace),
            pending,
            failed,
        }
    }
    pub fn offset(&self) -> u64 {
        self.offset
    }
    /// One bounded read at a time. A line longer than a record can be stops
    /// the source; no resynchronization silently drops a record. Use a clone
    /// while persisting outputs, then commit that clone only after all outbox
    /// appends succeed.
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
                // A blank line is no record. Its bytes, and a space for its
                // newline, stay pending and lead the next record: JSON reads
                // through leading whitespace, and no byte leaves the ranges.
                if self.blank {
                    if self.pending.len() == MAX_RECORD_BYTES {
                        self.failed = true;
                        return Err(invalid("transcript record exceeds 1 MiB"));
                    }
                    self.pending.push(b' ');
                    continue;
                }
                let start = self.offset - self.pending.len() as u64 - 1;
                records.push(Record {
                    generation: self.generation,
                    start,
                    end: self.offset,
                    text: readable(&self.pending),
                });
                self.pending.clear();
                self.blank = true;
            } else {
                if self.pending.len() == MAX_RECORD_BYTES {
                    self.failed = true;
                    return Err(invalid("transcript record exceeds 1 MiB"));
                }
                self.pending.push(*byte);
                self.blank &= whitespace(*byte);
            }
        }
        Ok(records)
    }
}

/// A line's text for the wire, exactly as long as the line. A byte that is not
/// part of valid UTF-8, and a NUL, cannot be sent; each becomes `?`, one byte
/// for one, so the record still covers its own bytes of the source and nothing
/// after it moves. The member sees the `?` where their agent wrote the byte.
fn readable(line: &[u8]) -> String {
    let mut text = String::with_capacity(line.len());
    let mut rest = line;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                text.push_str(valid);
                break;
            }
            Err(error) => {
                let (valid, after) = rest.split_at(error.valid_up_to());
                text.push_str(&String::from_utf8_lossy(valid));
                // An invalid sequence has a length; one cut off by the end of
                // the line runs to the end.
                let bad = error.error_len().unwrap_or(after.len());
                text.extend(std::iter::repeat_n('?', bad));
                rest = &after[bad..];
            }
        }
    }
    if text.contains('\0') {
        text = text.replace('\0', "?");
    }
    text
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{CheckpointStore, Tail};

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
    fn a_line_that_cannot_cross_the_wire_is_read_with_marks_and_the_next_follows() {
        // Not UTF-8, a sequence cut off by the end of the line, and a NUL:
        // each such byte is one `?`, so every record is as long as its line.
        let mut f = Framer::new(1).unwrap();
        let records = f
            .push(b"{\"t\":\"caf\xc3\"}\n{\"t\":\"a\xffb\xfe\"}\n{\"t\":\"x\0y\"}\n\xe2\x82\n{\"ok\":1}\n")
            .unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.text.as_str())
                .collect::<Vec<_>>(),
            [
                "{\"t\":\"caf?\"}",
                "{\"t\":\"a?b?\"}",
                "{\"t\":\"x?y\"}",
                "??",
                "{\"ok\":1}"
            ]
        );
        // Ranges are the source's own: contiguous, each one byte longer than
        // its text, ending where the bytes end.
        let mut next = 0;
        for record in &records {
            assert_eq!(record.start, next);
            assert_eq!(record.end - record.start, record.text.len() as u64 + 1);
            next = record.end;
        }
        assert_eq!(next, f.offset());
        // Valid multi-byte text is untouched, also when a read splits it.
        let mut f = Framer::new(1).unwrap();
        assert!(f.push(b"{\"t\":\"\xe2\x82").unwrap().is_empty());
        assert_eq!(
            f.push(b"\xac \xf0\x9f\x99\x82\"}\n").unwrap()[0].text,
            "{\"t\":\"€ 🙂\"}"
        );
    }

    #[test]
    fn a_blank_line_is_carried_by_the_next_record_and_loses_no_byte() {
        let mut f = Framer::new(1).unwrap();
        assert_eq!(
            f.push(b"{\"a\":1}\n\n\n \t\r\n{\"b\":2}\n\n").unwrap(),
            vec![
                Record {
                    generation: 1,
                    start: 0,
                    end: 8,
                    text: "{\"a\":1}".into()
                },
                // Two empty lines and a line of whitespace: their newlines are
                // spaces at the head of the record that follows them.
                Record {
                    generation: 1,
                    start: 8,
                    end: 22,
                    text: "   \t\r {\"b\":2}".into()
                },
            ]
        );
        // A trailing blank line waits like any partial record.
        assert_eq!(f.offset(), 23);
        assert_eq!(
            f.push(b"{\"c\":3}\n").unwrap(),
            vec![Record {
                generation: 1,
                start: 22,
                end: 31,
                text: " {\"c\":3}".into()
            }]
        );
    }

    #[test]
    fn only_a_line_longer_than_a_record_stops_the_source() {
        assert!(Framer::new(0).is_err());
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
        // Stopped for good: nothing after the line is guessed at.
        assert!(f.push(b"\n").is_err());
        assert!(f.push(b"{}\n").is_err());
        // The same bound holds for a megabyte of blank lines.
        let mut f = Framer::new(1).unwrap();
        for _ in 0..16 {
            assert!(f.push(&vec![b'\n'; READ_BYTES]).unwrap().is_empty());
        }
        assert!(f.push(b"\n").is_err());
        assert!(Framer::new(1)
            .unwrap()
            .push(&vec![0; READ_BYTES + 1])
            .is_err());
    }
}
pub mod wire;

#[cfg(target_os = "linux")]
pub mod discovery;
#[cfg(target_os = "linux")]
pub mod launch;
#[cfg(target_os = "linux")]
pub mod pump;
#[cfg(target_os = "linux")]
pub mod reader;
#[cfg(target_os = "linux")]
pub mod resolve;
