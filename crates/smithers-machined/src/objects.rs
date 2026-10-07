//! Bundle transport uses the same bounded credit pipe as sessions.
use crate::{
    conn::Frame,
    credit::{ReadOutcome, Sender},
};
use std::io::{self, Read};

pub struct BundleSender<R> {
    source: R,
    credit: Sender,
    stream: u32,
    eof: bool,
    verified: bool,
    refused: bool,
}
impl<R: Read> BundleSender<R> {
    pub fn new(stream: u32, source: R) -> io::Result<Self> {
        if stream == 0 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(Self {
            source,
            credit: Sender::default(),
            stream,
            eof: false,
            verified: false,
            refused: false,
        })
    }
    pub fn next_frame(&mut self) -> io::Result<Option<Frame>> {
        if self.refused {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        if self.eof {
            return Ok(None);
        }
        let payload = match self.credit.read(&mut self.source)? {
            ReadOutcome::Blocked => return Ok(None),
            ReadOutcome::Data(bytes) => {
                let mut p = vec![1, 0];
                p.extend(bytes);
                p
            }
            ReadOutcome::Eof => {
                self.eof = true;
                vec![2, 0]
            }
        };
        Ok(Some(Frame {
            kind: 6,
            stream: self.stream,
            payload,
        }))
    }
    pub fn receive(&mut self, frame: &Frame) -> io::Result<()> {
        frame.encode().map_err(|_| io::ErrorKind::InvalidData)?;
        if frame.kind != 6 || frame.stream != self.stream || self.refused || self.verified {
            return Err(io::ErrorKind::InvalidData.into());
        }
        match frame.payload[0] {
            6 => self
                .credit
                .window(u32::from_be_bytes(frame.payload[1..5].try_into().unwrap())),
            7 if self.eof => {
                self.credit.close();
                self.verified = true;
                Ok(())
            }
            255 => {
                self.credit.close();
                self.refused = true;
                Err(io::ErrorKind::PermissionDenied.into())
            }
            _ => Err(io::ErrorKind::InvalidData.into()),
        }
    }
    /// Only peer close after EOF certifies that the host imported the bundle.
    pub fn verified(&self) -> bool {
        self.verified
    }
}
