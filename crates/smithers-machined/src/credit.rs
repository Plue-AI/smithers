//! ADR 0004 stream credit, independent of framing. Shared by objects and sessions.
//! No existing guest pipe bounds source reads by peer acknowledgement.
use std::io::{self, Read};

pub const INITIAL_CREDIT: usize = 262_144;
pub const MAX_DATA: usize = 65_536;

#[derive(Debug, PartialEq, Eq)]
pub enum ReadOutcome {
    Blocked,
    Data(Vec<u8>),
    Eof,
}

/// One sending direction. Neither EOF nor peer refusal consumes source bytes.
#[derive(Debug)]
pub struct Sender {
    credit: usize,
    eof: bool,
    closed: bool,
}

impl Default for Sender {
    fn default() -> Self {
        Self {
            credit: INITIAL_CREDIT,
            eof: false,
            closed: false,
        }
    }
}

fn invalid(detail: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, detail)
}

impl Sender {
    pub fn read(&mut self, source: &mut impl Read) -> io::Result<ReadOutcome> {
        if self.closed {
            return Err(invalid("stream closed"));
        }
        if self.eof {
            return Ok(ReadOutcome::Eof);
        }
        if self.credit == 0 {
            return Ok(ReadOutcome::Blocked);
        }
        let mut bytes = vec![0; self.credit.min(MAX_DATA)];
        let count = loop {
            match source.read(&mut bytes) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => break result?,
            }
        };
        if count == 0 {
            self.eof = true;
            return Ok(ReadOutcome::Eof);
        }
        bytes.truncate(count);
        self.credit -= count;
        Ok(ReadOutcome::Data(bytes))
    }

    /// A window may return only bytes actually sent, including after EOF.
    pub fn window(&mut self, bytes: u32) -> io::Result<()> {
        if self.closed || bytes == 0 || bytes as usize > INITIAL_CREDIT - self.credit {
            return Err(invalid("invalid window"));
        }
        self.credit += bytes as usize;
        Ok(())
    }

    /// Called for both close and refusal; source must never be polled afterward.
    pub fn close(&mut self) {
        self.closed = true;
    }
    pub fn outstanding(&self) -> usize {
        INITIAL_CREDIT - self.credit
    }
}

/// One receiving direction. Credit returns only after the consumer spools data.
#[derive(Debug)]
pub struct Receiver {
    pending: usize,
    eof: bool,
    closed: bool,
}

impl Default for Receiver {
    fn default() -> Self {
        Self {
            pending: 0,
            eof: false,
            closed: false,
        }
    }
}

impl Receiver {
    pub fn data(&mut self, bytes: usize) -> io::Result<()> {
        if self.closed || self.eof || bytes > MAX_DATA || bytes > INITIAL_CREDIT - self.pending {
            return Err(invalid("invalid data"));
        }
        self.pending += bytes;
        Ok(())
    }

    pub fn consumed(&mut self, bytes: usize) -> io::Result<u32> {
        if self.closed || bytes == 0 || bytes > self.pending {
            return Err(invalid("invalid consumption"));
        }
        self.pending -= bytes;
        Ok(bytes as u32)
    }

    pub fn eof(&mut self) -> io::Result<()> {
        if self.closed || self.eof {
            return Err(invalid("invalid eof"));
        }
        self.eof = true;
        Ok(())
    }

    pub fn close(&mut self) {
        self.closed = true;
    }
    pub fn pending(&self) -> usize {
        self.pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct NoRead;
    impl Read for NoRead {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            panic!("source polled");
        }
    }

    #[test]
    fn zero_credit_stops_reads_and_window_resumes() {
        let mut sender = Sender::default();
        let mut source = Cursor::new(vec![7; 524_289]);
        for _ in 0..4 {
            assert_eq!(
                sender.read(&mut source).unwrap(),
                ReadOutcome::Data(vec![7; 65_536])
            );
        }
        assert_eq!(sender.outstanding(), 262_144);
        assert_eq!(sender.read(&mut NoRead).unwrap(), ReadOutcome::Blocked);
        sender.window(1).unwrap();
        assert_eq!(
            sender.read(&mut source).unwrap(),
            ReadOutcome::Data(vec![7])
        );
        assert_eq!(source.position(), 262_145);
    }

    #[test]
    fn large_transfer_is_bounded_and_byte_exact_in_both_directions() {
        for seed in [0_u8, 97] {
            let input: Vec<_> = (0..1_048_579)
                .map(|n| (n as u8).wrapping_add(seed))
                .collect();
            let mut source = Cursor::new(&input);
            let mut sender = Sender::default();
            let mut receiver = Receiver::default();
            let mut output = Vec::new();
            loop {
                match sender.read(&mut source).unwrap() {
                    ReadOutcome::Data(data) => {
                        receiver.data(data.len()).unwrap();
                        output.extend_from_slice(&data);
                        assert!(receiver.pending() <= 262_144);
                        let window = receiver.consumed(data.len()).unwrap();
                        sender.window(window).unwrap();
                    }
                    ReadOutcome::Eof => {
                        receiver.eof().unwrap();
                        break;
                    }
                    ReadOutcome::Blocked => panic!("consumer returned credit"),
                }
            }
            assert_eq!(output, input);
            assert_eq!(sender.outstanding(), 0);
            assert_eq!(receiver.pending(), 0);
        }
    }

    #[test]
    fn eof_close_refusal_and_invalid_credit_do_not_read() {
        let mut sender = Sender::default();
        assert!(sender.window(1).is_err());
        assert!(sender.window(0).is_err());
        assert_eq!(sender.read(&mut Cursor::new([])).unwrap(), ReadOutcome::Eof);
        assert_eq!(sender.read(&mut NoRead).unwrap(), ReadOutcome::Eof);
        sender.close();
        assert!(sender.read(&mut NoRead).is_err());
        assert!(sender.window(1).is_err());
    }

    #[test]
    fn receiver_refuses_overrun_without_changing_accounting() {
        let mut receiver = Receiver::default();
        assert!(receiver.data(65_537).is_err());
        assert!(receiver.consumed(1).is_err());
        assert!(receiver.consumed(0).is_err());
        for _ in 0..4 {
            receiver.data(65_536).unwrap();
        }
        assert!(receiver.data(1).is_err());
        assert_eq!(receiver.pending(), 262_144);
        assert_eq!(receiver.consumed(1).unwrap(), 1);
        receiver.data(1).unwrap();
        receiver.eof().unwrap();
        assert!(receiver.eof().is_err());
        assert!(receiver.data(0).is_err());
        assert_eq!(receiver.consumed(262_144).unwrap(), 262_144);
        receiver.close();
        assert!(receiver.data(1).is_err());
        assert!(receiver.eof().is_err());
        assert!(receiver.consumed(1).is_err());
    }

    #[test]
    fn source_error_retains_credit_and_interrupted_read_retries() {
        struct Flaky(u8);
        impl Read for Flaky {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                self.0 += 1;
                match self.0 {
                    1 => Err(io::ErrorKind::Interrupted.into()),
                    2 => Err(io::ErrorKind::Other.into()),
                    _ => {
                        buf[0] = 9;
                        Ok(1)
                    }
                }
            }
        }
        let mut sender = Sender::default();
        let mut source = Flaky(0);
        assert!(sender.read(&mut source).is_err());
        assert_eq!(sender.outstanding(), 0);
        assert_eq!(
            sender.read(&mut source).unwrap(),
            ReadOutcome::Data(vec![9])
        );
        assert!(sender.window(2).is_err());
        assert_eq!(sender.outstanding(), 1);
        sender.window(1).unwrap();
    }
}
