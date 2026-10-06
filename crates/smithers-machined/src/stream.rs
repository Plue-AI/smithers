//! Session reattachment on the shared object/session credit pipe (ADR 0004).
//! The one-shot helper cannot retain byte offsets across host disconnects.
use crate::credit::{ReadOutcome, Receiver, Sender, INITIAL_CREDIT};
use std::collections::VecDeque;
use std::io::{self, Read};

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// One outgoing direction. Retains only bytes not acknowledged by the peer.
#[derive(Default)]
pub struct SessionSender {
    pipe: Sender,
    retained: VecDeque<u8>,
    acknowledged: u64,
    closed: bool,
}

impl SessionSender {
    pub fn read(&mut self, source: &mut impl Read) -> io::Result<ReadOutcome> {
        let outcome = self.pipe.read(source)?;
        if let ReadOutcome::Data(bytes) = &outcome {
            self.retained.extend(bytes);
        }
        debug_assert!(self.retained.len() <= INITIAL_CREDIT);
        Ok(outcome)
    }

    pub fn window(&mut self, bytes: u32) -> io::Result<()> {
        let next = self
            .acknowledged
            .checked_add(bytes as u64)
            .ok_or_else(|| invalid("byte offset overflow"))?;
        self.pipe.window(bytes)?;
        self.retained.drain(..bytes as usize);
        self.acknowledged = next;
        Ok(())
    }

    /// Replaces lost window messages with the peer's cumulative received count.
    /// Replay is not a new send and must not consume credit a second time.
    pub fn attach(&mut self, received: u64) -> io::Result<Vec<u8>> {
        let delta = received
            .checked_sub(self.acknowledged)
            .filter(|delta| *delta <= self.retained.len() as u64)
            .ok_or_else(|| invalid("received offset outside replay buffer"))?;
        if delta != 0 {
            self.window(delta as u32)?;
        } else {
            // Validate closed state without polling a source or returning credit.
            if self.closed {
                return Err(invalid("stream closed"));
            }
        }
        Ok(self.retained.iter().copied().collect())
    }

    pub fn close(&mut self) {
        self.pipe.close();
        self.closed = true;
        self.retained.clear();
    }
}

/// One incoming direction. Acknowledgements follow actual consumer delivery.
#[derive(Default)]
pub struct SessionReceiver {
    pipe: Receiver,
    received: u64,
}

impl SessionReceiver {
    pub fn data(&mut self, bytes: usize) -> io::Result<()> {
        self.pipe.data(bytes)
    }
    pub fn consumed(&mut self, bytes: usize) -> io::Result<u32> {
        let next = self
            .received
            .checked_add(bytes as u64)
            .ok_or_else(|| invalid("byte offset overflow"))?;
        let window = self.pipe.consumed(bytes)?;
        self.received = next;
        Ok(window)
    }
    pub fn received(&self) -> u64 {
        self.received
    }
    pub fn eof(&mut self) -> io::Result<()> {
        self.pipe.eof()
    }
    pub fn close(&mut self) {
        self.pipe.close();
    }
}

/// Object frames share the same accounting as sessions. No bytes are read when
/// the peer has exhausted its window, and EOF is emitted exactly once.
pub struct ObjectSender {
    pipe: Sender,
    stream: u32,
    eof_sent: bool,
    closed: bool,
}
impl ObjectSender {
    pub fn new(stream: u32) -> io::Result<Self> {
        if stream == 0 {
            return Err(invalid("zero object stream"));
        }
        Ok(Self {
            pipe: Sender::default(),
            stream,
            eof_sent: false,
            closed: false,
        })
    }
    pub fn next(&mut self, source: &mut impl Read) -> io::Result<Option<crate::conn::Frame>> {
        if self.closed {
            return Err(invalid("object stream closed"));
        }
        if self.eof_sent {
            return Ok(None);
        }
        let payload = match self.pipe.read(source)? {
            ReadOutcome::Blocked => return Ok(None),
            ReadOutcome::Data(bytes) => {
                let mut payload = vec![1, 0];
                payload.extend(bytes);
                payload
            }
            ReadOutcome::Eof => {
                self.eof_sent = true;
                vec![2, 0]
            }
        };
        Ok(Some(crate::conn::Frame {
            kind: 6,
            stream: self.stream,
            payload,
        }))
    }
    pub fn peer(&mut self, frame: &crate::conn::Frame) -> io::Result<()> {
        frame
            .encode()
            .map_err(|_| invalid("invalid object frame"))?;
        if frame.kind != 6 || frame.stream != self.stream {
            return Err(invalid("wrong object stream"));
        }
        match frame.payload[0] {
            6 => self
                .pipe
                .window(u32::from_be_bytes(frame.payload[1..5].try_into().unwrap())),
            7 | 255 => {
                self.pipe.close();
                self.closed = true;
                Ok(())
            }
            _ => Err(invalid("unexpected object response")),
        }
    }
    pub fn outstanding(&self) -> usize {
        self.pipe.outstanding()
    }
}
/// Spools each frame before returning its credit. EOF alone does not produce a
/// close: the object importer must verify/fetch and sync the objects first.
pub struct ObjectReceiver {
    pipe: Receiver,
    stream: u32,
    eof: bool,
    closed: bool,
}
impl ObjectReceiver {
    pub fn new(stream: u32) -> io::Result<Self> {
        if stream == 0 {
            return Err(invalid("zero object stream"));
        }
        Ok(Self {
            pipe: Receiver::default(),
            stream,
            eof: false,
            closed: false,
        })
    }
    pub fn receive(
        &mut self,
        frame: &crate::conn::Frame,
        destination: &mut impl std::io::Write,
    ) -> io::Result<Option<crate::conn::Frame>> {
        frame
            .encode()
            .map_err(|_| invalid("invalid object frame"))?;
        if self.closed || frame.kind != 6 || frame.stream != self.stream {
            return Err(invalid("wrong or closed object stream"));
        }
        match frame.payload[0] {
            1 => {
                let bytes = &frame.payload[2..];
                if bytes.is_empty() {
                    return Err(invalid("empty object data"));
                }
                self.pipe.data(bytes.len())?;
                if let Err(error) = destination.write_all(bytes) {
                    self.pipe.close();
                    self.closed = true;
                    return Err(error);
                }
                let credit = self.pipe.consumed(bytes.len())?;
                let mut payload = vec![6];
                payload.extend(credit.to_be_bytes());
                Ok(Some(crate::conn::Frame {
                    kind: 6,
                    stream: self.stream,
                    payload,
                }))
            }
            2 => {
                self.pipe.eof()?;
                self.eof = true;
                Ok(None)
            }
            7 | 255 => {
                self.pipe.close();
                self.closed = true;
                Ok(None)
            }
            _ => Err(invalid("unexpected object input")),
        }
    }
    /// Caller owns successful bundle verification/import and durable sync.
    pub fn verified_close(&mut self) -> io::Result<crate::conn::Frame> {
        if self.closed || !self.eof || self.pipe.pending() != 0 {
            return Err(invalid("object stream not verified-ready"));
        }
        self.closed = true;
        self.pipe.close();
        Ok(crate::conn::Frame {
            kind: 6,
            stream: self.stream,
            payload: vec![7],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct NoRead;
    impl Read for NoRead {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            panic!("source polled without credit")
        }
    }

    #[test]
    fn reconnect_replays_only_missing_bytes_in_both_directions() {
        for seed in [0_u8, 91] {
            let input: Vec<_> = (0..1_048_576)
                .map(|n| (n as u8).wrapping_add(seed))
                .collect();
            let mut source = Cursor::new(&input);
            let mut sender = SessionSender::default();
            let mut receiver = SessionReceiver::default();
            let mut output = Vec::new();
            for _ in 0..4 {
                let ReadOutcome::Data(bytes) = sender.read(&mut source).unwrap() else {
                    panic!()
                };
                receiver.data(bytes.len()).unwrap();
                output.extend_from_slice(&bytes);
                receiver.consumed(bytes.len()).unwrap(); // window lost on disconnect
            }
            assert_eq!(sender.read(&mut NoRead).unwrap(), ReadOutcome::Blocked);
            assert_eq!(sender.retained.len(), 262_144);
            assert_eq!(
                sender.attach(receiver.received()).unwrap(),
                Vec::<u8>::new()
            );
            loop {
                match sender.read(&mut source).unwrap() {
                    ReadOutcome::Data(bytes) => {
                        // Only half arrived before the next disconnect.
                        let half = bytes.len() / 2;
                        receiver.data(half).unwrap();
                        output.extend_from_slice(&bytes[..half]);
                        receiver.consumed(half).unwrap();
                        let replay = sender.attach(receiver.received()).unwrap();
                        assert_eq!(replay, bytes[half..]);
                        assert_eq!(sender.attach(receiver.received()).unwrap(), replay);
                        receiver.data(replay.len()).unwrap();
                        output.extend_from_slice(&replay);
                        sender
                            .window(receiver.consumed(replay.len()).unwrap())
                            .unwrap();
                    }
                    ReadOutcome::Eof => {
                        receiver.eof().unwrap();
                        break;
                    }
                    ReadOutcome::Blocked => panic!("credit not returned"),
                }
            }
            assert_eq!(output, input);
            assert_eq!(receiver.received(), 1_048_576);
            assert!(sender.retained.is_empty());
            assert!(sender.attach(0).is_err());
        }
    }

    #[test]
    fn offsets_and_credit_refusals_preserve_replay() {
        let mut sender = SessionSender::default();
        sender.read(&mut Cursor::new(b"abcdef")).unwrap();
        assert!(sender.attach(7).is_err());
        assert!(sender.window(7).is_err());
        assert!(sender.window(0).is_err());
        assert_eq!(sender.attach(2).unwrap(), b"cdef");
        assert!(sender.attach(1).is_err());
        assert_eq!(sender.attach(2).unwrap(), b"cdef");
        assert_eq!(sender.read(&mut Cursor::new([])).unwrap(), ReadOutcome::Eof);
        assert_eq!(sender.attach(4).unwrap(), b"ef");
        sender.close();
        assert!(sender.attach(4).is_err());
        assert!(sender.attach(5).is_err());
        assert!(sender.read(&mut NoRead).is_err());
        assert!(sender.window(1).is_err());
        assert!(sender.retained.is_empty());
    }

    #[test]
    fn receiver_offsets_advance_only_after_delivery() {
        let mut receiver = SessionReceiver::default();
        assert!(receiver.consumed(1).is_err());
        receiver.data(4).unwrap();
        assert_eq!(receiver.received(), 0);
        assert!(receiver.consumed(5).is_err());
        assert_eq!(receiver.consumed(2).unwrap(), 2);
        receiver.eof().unwrap();
        assert!(receiver.data(1).is_err());
        assert_eq!(receiver.consumed(2).unwrap(), 2);
        assert_eq!(receiver.received(), 4);
        receiver.close();
        assert!(receiver.consumed(1).is_err());
        assert!(receiver.eof().is_err());
        receiver.received = u64::MAX;
        assert!(receiver.consumed(1).is_err());
        let mut sender = SessionSender {
            acknowledged: u64::MAX,
            ..SessionSender::default()
        };
        assert!(sender.window(1).is_err());
    }
}
