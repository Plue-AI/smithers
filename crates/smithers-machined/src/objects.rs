//! Bundle transport uses the same bounded credit pipe as sessions.
use crate::{
    conn::Frame,
    credit::{ReadOutcome, Sender},
};
use std::io::{self, Read};

/// The unprivileged repository owner exports the pinned event's objects. The
/// link allocates ids from its shared stream counter, never a private counter.
pub trait Bundles {
    type Source: Read;
    fn export(
        &mut self,
        event: &crate::conn::Durable,
        haves: &[crate::hooks::Oid],
    ) -> io::Result<Self::Source>;
}

enum Sending<R> {
    Idle,
    Bundle(u64, BundleSender<R>),
    Receipt,
}

/// One event in flight. The authenticated link multiplexes other kinds itself
/// and gives this pump only object windows/close and durable acknowledgements.
/// No event is released until the peer confirms successful bundle import.
pub struct Delivery<B: Bundles> {
    bundles: B,
    sending: Sending<B::Source>,
    #[cfg(all(feature = "killpoints", debug_assertions))]
    capture_stream: Option<u32>,
}
impl<B: Bundles> Delivery<B> {
    pub fn new(bundles: B) -> Self {
        Self {
            bundles,
            sending: Sending::Idle,
            #[cfg(all(feature = "killpoints", debug_assertions))]
            capture_stream: None,
        }
    }
    pub fn begin<R: crate::outbox::Refs>(
        &mut self,
        outbox: &crate::outbox::Outbox<R>,
        stream: u32,
    ) -> io::Result<bool> {
        if !matches!(self.sending, Sending::Idle) || stream == 0 || stream > 0x7fff_ffff {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let Some(event) = outbox.front()? else {
            return Ok(false);
        };
        let source = self.bundles.export(&event, outbox.haves())?;
        #[cfg(all(feature = "killpoints", debug_assertions))]
        {
            self.capture_stream = event.captured_head().map(|_| stream);
        }
        self.sending = Sending::Bundle(event.seq, BundleSender::new(stream, source)?);
        Ok(true)
    }
    pub fn next_frame(&mut self) -> io::Result<Option<Frame>> {
        match &mut self.sending {
            Sending::Bundle(_, sender) => sender.next_frame(),
            _ => Ok(None),
        }
    }
    pub fn receive<R: crate::outbox::Refs>(
        &mut self,
        outbox: &mut crate::outbox::Outbox<R>,
        frame: &Frame,
    ) -> io::Result<Option<Frame>> {
        match &mut self.sending {
            Sending::Bundle(seq, sender) => {
                sender.receive(frame)?;
                if !sender.verified() {
                    return Ok(None);
                }
                #[cfg(all(feature = "killpoints", debug_assertions))]
                crate::events::killpoint("K3b");
                let event = outbox.after_bundle(*seq)?;
                self.sending = Sending::Receipt;
                Ok(Some(event))
            }
            Sending::Receipt => {
                outbox.acknowledge(frame)?;
                self.sending = Sending::Idle;
                Ok(None)
            }
            Sending::Idle => Err(io::ErrorKind::InvalidData.into()),
        }
    }
    /// Called only after the authenticated socket write succeeds.
    #[cfg(all(feature = "killpoints", debug_assertions))]
    pub(crate) fn sent(&mut self, frame: &Frame) {
        if frame.kind == 6
            && frame.payload.first() == Some(&1)
            && self.capture_stream == Some(frame.stream)
        {
            self.capture_stream = None;
            crate::events::killpoint("K5b");
        }
        if frame.kind == 2
            && crate::conn::Durable::decode(&frame.payload)
                .is_ok_and(|event| event.captured_head().is_some())
        {
            crate::events::killpoint("K5c");
        }
    }

    /// A Welcome starts replay from disk and invalidates the previous stream.
    pub fn reconnect<R: crate::outbox::Refs>(&mut self, outbox: &mut crate::outbox::Outbox<R>) {
        self.sending = Sending::Idle;
        #[cfg(all(feature = "killpoints", debug_assertions))]
        {
            self.capture_stream = None;
        }
        outbox.reconnect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn refused_bundle_stops_reading_and_cannot_certify_import() {
        let mut sender = BundleSender::new(1, Cursor::new(vec![1; 300_000])).unwrap();
        sender.next_frame().unwrap().unwrap();
        assert_eq!(
            sender
                .receive(&Frame {
                    kind: 6,
                    stream: 1,
                    payload: {
                        let mut bytes = vec![255];
                        bytes.extend(crate::conn::structure_bytes(&[crate::conn::field(1, [2])]));
                        bytes
                    },
                })
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(!sender.verified());
        assert_eq!(
            sender.next_frame().unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
        assert!(sender
            .receive(&Frame {
                kind: 6,
                stream: 1,
                payload: vec![7]
            })
            .is_err());
    }
}

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
