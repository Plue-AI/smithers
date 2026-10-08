//! Descriptor delivery for ADR 0004 sessions. The broker registry owns lifetime
//! and identity; this object owns only bounded stream bytes and delivery offsets.
//! Callers use nonblocking descriptors and schedule `flush`/`poll` on readiness.
use crate::{
    conn::Frame,
    credit::ReadOutcome,
    stream::{SessionReceiver, SessionSender},
};
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
};

fn invalid() -> io::Error {
    io::ErrorKind::InvalidInput.into()
}

/// Implemented with broker-held descriptors/process groups, never request PIDs.
pub trait Input: Write {
    fn eof(&mut self) -> io::Result<()>;
    fn resize(&mut self, rows: u16, cols: u16) -> io::Result<()>;
    fn signal(&mut self, signal: u8) -> io::Result<()>;
    fn close(&mut self) -> io::Result<()>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    Signal { signal: u8, core: bool },
}

pub struct Pipe<I> {
    id: u32,
    input: I,
    receiver: SessionReceiver,
    sender: SessionSender,
    pending: VecDeque<u8>,
    retained_fds: VecDeque<(u8, usize)>,
    acknowledged: u64,
    input_eof: bool,
    input_finished: bool,
    outputs: u8,
    output_eof: u8,
    exit: Option<Exit>,
    exit_sent: bool,
    closed: bool,
}

impl<I: Input> Pipe<I> {
    /// Output bits are 1<<fd: stdout alone (PTY/TCP), or stdout and stderr.
    pub fn new(id: u32, input: I, stderr: bool) -> io::Result<Self> {
        if id == 0 || id > 0x7fff_ffff {
            return Err(invalid());
        }
        Ok(Self {
            id,
            input,
            receiver: Default::default(),
            sender: Default::default(),
            pending: Default::default(),
            retained_fds: Default::default(),
            acknowledged: 0,
            input_eof: false,
            input_finished: false,
            outputs: if stderr { 6 } else { 2 },
            output_eof: 0,
            exit: None,
            exit_sent: false,
            closed: false,
        })
    }
    fn frame(&self, payload: Vec<u8>) -> Frame {
        Frame {
            kind: 5,
            stream: self.id,
            payload,
        }
    }
    pub fn received(&self) -> u64 {
        self.receiver.received()
    }
    pub fn buffered_input(&self) -> usize {
        self.pending.len()
    }

    /// Credit available for another copy of local output on the host transport.
    pub fn available(&self) -> usize {
        self.sender.available()
    }

    /// Copy already-read PTY bytes into the existing bounded credit pipe. This
    /// transport never reads a descriptor and never owns keyboard input.
    pub fn relay(&mut self, frame: &Frame) -> io::Result<Option<Frame>> {
        if self.closed || frame.stream != self.id || frame.kind != 5 {
            return Err(invalid());
        }
        match frame.payload.as_slice() {
            [1, fd @ 1..=2, bytes @ ..] if !bytes.is_empty() => {
                if bytes.len() > self.available() {
                    return Err(invalid());
                }
                self.poll(*fd, &mut io::Cursor::new(bytes))
            }
            [2, fd @ 1..=2] if self.outputs & (1 << fd) != 0 => {
                self.output_eof |= 1 << fd;
                Ok(Some(self.frame(vec![2, *fd])))
            }
            // The caller copies waitpid status separately, never PTY text.
            [5, ..] => Ok(self.poll_exit()),
            [6, ..] => Ok(None), // local stdin receipts belong only to its owner
            _ => Err(invalid()),
        }
    }

    /// Validate the entire envelope before touching descriptors. Window receipts
    /// are produced by `flush`, only for bytes accepted by the actual consumer.
    pub fn accept(&mut self, frame: &Frame) -> io::Result<()> {
        frame.encode().map_err(|_| invalid())?;
        if self.closed || frame.kind != 5 || frame.stream != self.id {
            return Err(invalid());
        }
        let p = &frame.payload;
        match p[0] {
            1 if p[1] == 0 => {
                self.receiver.data(p.len() - 2)?;
                self.pending.extend(&p[2..]);
            }
            2 if p[1] == 0 => {
                if !self.input_eof {
                    self.receiver.eof()?;
                    self.input_eof = true;
                }
            }
            3 => {
                let cols = u16::from_be_bytes(p[1..3].try_into().unwrap());
                let rows = u16::from_be_bytes(p[3..5].try_into().unwrap());
                if rows == 0 || cols == 0 {
                    return Err(invalid());
                }
                self.input.resize(rows, cols)?;
            }
            4 => self.input.signal(p[1])?,
            6 => {
                let n = u32::from_be_bytes(p[1..5].try_into().unwrap());
                self.sender.window(n)?;
                self.acknowledge(n as usize);
            }
            7 => self.close()?,
            _ => return Err(invalid()),
        }
        Ok(())
    }

    /// Never blocks deliberately: WouldBlock preserves undelivered bytes and
    /// cumulative offset. EOF is delayed until the last queued byte is written.
    pub fn flush(&mut self) -> io::Result<Option<Frame>> {
        if self.closed {
            return Err(invalid());
        }
        let mut consumed = 0;
        while !self.pending.is_empty() {
            let (first, _) = self.pending.as_slices();
            match self.input.write(first) {
                Ok(0) => {
                    if consumed != 0 {
                        break;
                    }
                    return Err(io::ErrorKind::WriteZero.into());
                }
                Ok(n) if n <= first.len() => {
                    self.pending.drain(..n);
                    // Advance immediately: a later write error cannot undo bytes.
                    self.receiver.consumed(n)?;
                    consumed += n;
                }
                Ok(_) => return Err(io::ErrorKind::InvalidData.into()),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || consumed != 0 => break,
                Err(e) => return Err(e),
            }
        }
        if self.pending.is_empty() && self.input_eof && !self.input_finished {
            match self.input.eof() {
                Ok(()) => self.input_finished = true,
                Err(_) if consumed != 0 => (), // return delivered credit; retry EOF
                Err(e) => return Err(e),
            }
        }
        if consumed != 0 {
            return Ok(Some(self.frame(
                [&[6], (consumed as u32).to_be_bytes().as_slice()].concat(),
            )));
        }
        Ok(None)
    }

    /// stdout and stderr share the one direction's 256 KiB credit. A source EOF
    /// does not end the other source, and neither source is read at zero credit.
    pub fn poll(&mut self, fd: u8, source: &mut impl Read) -> io::Result<Option<Frame>> {
        if self.closed || !(1..=2).contains(&fd) || self.outputs & (1 << fd) == 0 {
            return Err(invalid());
        }
        if self.output_eof & (1 << fd) != 0 {
            return Ok(None);
        }
        // Sender EOF is per direction; translate per-descriptor EOF to a local
        // observation instead so stderr remains readable after stdout closes.
        struct Source<'a, R> {
            reader: &'a mut R,
            eof: bool,
        }
        impl<R: Read> Read for Source<'_, R> {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                match self.reader.read(bytes) {
                    Ok(0) => {
                        self.eof = true;
                        Err(io::ErrorKind::WouldBlock.into())
                    }
                    result => result,
                }
            }
        }
        let mut source = Source {
            reader: source,
            eof: false,
        };
        let outcome = self.sender.read(&mut source);
        if source.eof {
            self.output_eof |= 1 << fd;
            return Ok(Some(self.frame(vec![2, fd])));
        }
        match outcome {
            Ok(ReadOutcome::Data(bytes)) => {
                if let Some((_, n)) = self.retained_fds.back_mut().filter(|(last, _)| *last == fd) {
                    *n += bytes.len();
                } else {
                    self.retained_fds.push_back((fd, bytes.len()));
                }
                Ok(Some(self.frame([&[1, fd], bytes.as_slice()].concat())))
            }
            Ok(ReadOutcome::Blocked) => Ok(None),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(e),
            Ok(ReadOutcome::Eof) => unreachable!("descriptor adapter does not return EOF"),
        }
    }

    /// waitpid may precede the last stdout read. Send exit only after both EOFs,
    /// so the host never tears down a stream with unread output.
    pub fn exited(&mut self, exit: Exit) -> io::Result<()> {
        if self.closed || self.exit.is_some() {
            return Err(invalid());
        }
        if let Exit::Signal { signal, .. } = exit {
            if !(1..=7).contains(&signal) {
                return Err(invalid());
            }
        }
        self.exit = Some(exit);
        Ok(())
    }
    pub fn poll_exit(&mut self) -> Option<Frame> {
        if self.closed || self.exit_sent || self.output_eof != self.outputs {
            return None;
        }
        let payload = exit_payload(self.exit?);
        self.exit_sent = true;
        Some(self.frame(payload))
    }

    /// Registry authorization/grace validation must precede this operation.
    /// A failed offset leaves retained output and input delivery unchanged.
    fn acknowledge(&mut self, mut bytes: usize) {
        self.acknowledged += bytes as u64;
        while bytes != 0 {
            let (_, n) = self
                .retained_fds
                .front_mut()
                .expect("retained descriptor accounting");
            let used = bytes.min(*n);
            *n -= used;
            bytes -= used;
            if *n == 0 {
                self.retained_fds.pop_front();
            }
        }
    }
    pub fn attach(&mut self, received: u64) -> io::Result<(u64, Vec<Frame>)> {
        if self.closed {
            return Err(invalid());
        }
        let bytes = self.sender.attach(received)?;
        // The peer resumes stdin at the delivered offset, not at the number of
        // bytes accepted by this transport. Keeping undelivered bytes here would
        // enqueue the replay twice. Validate output offsets before discarding.
        self.receiver.reattach(self.input_finished)?;
        self.pending.clear();
        self.input_eof = self.input_finished;
        self.acknowledge((received - self.acknowledged) as usize);
        let mut offset = 0;
        let mut frames = Vec::new();
        for &(fd, count) in &self.retained_fds {
            for chunk in bytes[offset..offset + count].chunks(crate::credit::MAX_DATA) {
                frames.push(self.frame([&[1, fd], chunk].concat()));
            }
            offset += count;
        }
        // Byte offsets cannot acknowledge zero-byte controls. Recreate terminal
        // controls on attach so a lost EOF/exit does not strand the host.
        for fd in 1..=2 {
            if self.output_eof & (1 << fd) != 0 {
                frames.push(self.frame(vec![2, fd]));
            }
        }
        if self.output_eof == self.outputs {
            if let Some(exit) = self.exit {
                frames.push(self.frame(exit_payload(exit)));
                self.exit_sent = true;
            }
        }
        Ok((self.receiver.received(), frames))
    }
    /// The registry already closed the descriptor. Discard replay without
    /// delivering a second HUP or EOF to the process.
    pub fn closed_by_owner(&mut self) {
        self.closed = true;
        self.sender.close();
        self.receiver.close();
        self.pending.clear();
        self.retained_fds.clear();
    }
    pub fn close(&mut self) -> io::Result<()> {
        if !self.closed {
            self.input.close()?;
            self.closed_by_owner();
        }
        Ok(())
    }
}

fn exit_payload(exit: Exit) -> Vec<u8> {
    match exit {
        Exit::Code(code) => [&[5, 0], code.to_be_bytes().as_slice()].concat(),
        Exit::Signal { signal, core } => vec![5, 1, signal, u8::from(core)],
    }
}
