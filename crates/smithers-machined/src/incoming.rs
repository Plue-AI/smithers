//! Host-owned object streams. Spool before returning credit; certify only a
//! durable verified import. Import never holds the daemon mutation lock.
use crate::{conn::Frame, credit, hooks};
use std::{
    io::{self, Write},
    sync::{mpsc, Arc, Mutex},
};

pub const LIMIT: u64 = 256 * 1024 * 1024;
pub trait Bundle: Write + Send {
    fn finish(self: Box<Self>, stream: u32) -> io::Result<()>;
}
pub trait Store: Send + Sync {
    fn begin(&self) -> io::Result<Box<dyn Bundle>>;
}
struct Receiving {
    stream: u32,
    size: u64,
    credit: credit::Receiver,
    bundle: Box<dyn Bundle>,
}
struct Import {
    stream: u32,
    generation: u64,
    result: mpsc::Receiver<io::Result<()>>,
}
#[derive(Default)]
struct State {
    last: u32,
    generation: u64,
    receiving: Option<Receiving>,
    importing: Option<Import>,
}
pub struct Incoming {
    store: Arc<dyn Store>,
    state: Mutex<State>,
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
fn refused(stream: u32) -> Frame {
    Frame {
        kind: 6,
        stream,
        payload: crate::conn::tagged(
            255,
            &hooks::Error {
                code: 12,
                ..hooks::Error::unsupported()
            }
            .fields(),
        ),
    }
}
impl Incoming {
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self {
            store,
            state: Mutex::new(State::default()),
        }
    }
    fn state(&self) -> io::Result<std::sync::MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| io::Error::other("incoming bundle state poisoned"))
    }
    pub fn disconnect(&self) -> io::Result<()> {
        let mut state = self.state()?;
        state.generation = state.generation.checked_add(1).ok_or_else(invalid)?;
        state.receiving = None;
        // Keep the one importer until terminal, bounding work even across
        // repeated reconnects. Its immutable object pins grant no admission.
        Ok(())
    }
    pub fn frame(&self, frame: &Frame) -> io::Result<Option<Frame>> {
        frame.encode().map_err(|_| invalid())?;
        if frame.kind != 6
            || frame.stream < 0x8000_0000
            || !matches!(frame.payload[0], 1 | 2)
            || frame.payload[1] != 0
        {
            return Err(invalid());
        }
        let mut state = self.state()?;
        if state.importing.is_some() {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        if state.receiving.is_none() {
            if frame.payload[0] != 1 || frame.payload.len() == 2 || frame.stream <= state.last {
                return Err(invalid());
            }
            state.last = frame.stream;
            let bundle = match self.store.begin() {
                Ok(bundle) => bundle,
                Err(_) => return Ok(Some(refused(frame.stream))),
            };
            state.receiving = Some(Receiving {
                stream: frame.stream,
                size: 0,
                credit: credit::Receiver::default(),
                bundle,
            });
        }
        let receiving = state.receiving.as_mut().ok_or_else(invalid)?;
        if receiving.stream != frame.stream {
            return Err(invalid());
        }
        if frame.payload[0] == 1 {
            let bytes = &frame.payload[2..];
            if bytes.is_empty() || receiving.size + bytes.len() as u64 > LIMIT {
                return Err(invalid());
            }
            receiving.credit.data(bytes.len())?;
            if receiving.bundle.write_all(bytes).is_err() {
                state.receiving = None;
                return Ok(Some(refused(frame.stream)));
            }
            receiving.size += bytes.len() as u64;
            let window = receiving.credit.consumed(bytes.len())?;
            return Ok(Some(Frame {
                kind: 6,
                stream: frame.stream,
                payload: [vec![6], window.to_be_bytes().to_vec()].concat(),
            }));
        }
        receiving.credit.eof()?;
        if receiving.bundle.flush().is_err() {
            state.receiving = None;
            return Ok(Some(refused(frame.stream)));
        }
        let receiving = state.receiving.take().ok_or_else(invalid)?;
        let (tx, result) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("bundle-import".into())
            .spawn(move || {
                let _ = tx.send(receiving.bundle.finish(receiving.stream));
            })?;
        state.importing = Some(Import {
            stream: frame.stream,
            generation: state.generation,
            result,
        });
        Ok(None)
    }
    pub fn poll(&self) -> io::Result<Option<Frame>> {
        let mut state = self.state()?;
        let Some(import) = &state.importing else {
            return Ok(None);
        };
        let result = match import.result.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => return Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => {
                Err(io::Error::other("bundle importer stopped"))
            }
        };
        let import = state.importing.take().ok_or_else(invalid)?;
        if import.generation != state.generation {
            return Ok(None);
        }
        Ok(Some(match result {
            Ok(()) => Frame {
                kind: 6,
                stream: import.stream,
                payload: vec![7],
            },
            Err(_) => refused(import.stream),
        }))
    }
}
