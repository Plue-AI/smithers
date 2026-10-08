//! The daemon's half of external transcript import (spec §9.6.6): ask the
//! broker which of members' own agent sessions there are to read, hold one
//! owner-uid reader per source, put each framed record in the durable outbox
//! as an ADR 0004 variant 5 event, and keep each reader's checkpoint.
//!
//! The daemon opens no home, no transcript and no path of a member's. It holds
//! sockets the broker bound, repeats to each reader the startup the broker
//! named, and adds only its own checkpoint. Which sessions, whose, and which
//! files are the broker's answers; this module cannot choose any of them.
//!
//! It runs only while the daemon serves an authenticated, reconciled link with
//! a synchronized roster. Otherwise it holds no reader and asks the broker
//! nothing, so nothing is discovered and no home is read.
use super::{
    reader::{Reader, Startup},
    CheckpointStore,
};
use crate::broker::transcripts::Listed;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io,
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

/// Durable events queued, of any kind, past which no transcript is read. The
/// outbox is one queue: a long transcript must not hold a change event back.
pub const QUEUED: u32 = 64;
/// How often the pump asks and reads. A complete record is in the outbox
/// within this of being written.
pub const PASS: Duration = Duration::from_millis(250);

/// The root broker, as the daemon reaches it.
pub trait Broker {
    fn sources(&self) -> io::Result<Vec<Listed>>;
    fn reader(&self, lifetime: [u8; 16]) -> io::Result<(Startup, UnixStream)>;
    fn release(&self, lifetime: [u8; 16], stopped: bool) -> io::Result<()>;
}
/// The daemon's durable outbox.
pub trait Outbox {
    fn depth(&self) -> io::Result<u32>;
    /// Durable before it returns.
    fn append(&self, event: &[u8]) -> io::Result<()>;
    /// Sources whose record the host refused since this was last asked.
    fn refused(&self) -> io::Result<Vec<[u8; 16]>>;
}

fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}

struct Failing {
    count: u32,
    until: Instant,
}

pub struct Pump<B, O> {
    broker: B,
    outbox: O,
    directory: File,
    readers: BTreeMap<[u8; 16], Reader>,
    failing: BTreeMap<[u8; 16], Failing>,
    /// Stopped for good, until the broker has taken the release.
    stopped: BTreeSet<[u8; 16]>,
    swept: Option<BTreeSet<[u8; 16]>>,
}
impl<B: Broker, O: Outbox> Pump<B, O> {
    /// `directory` is the daemon's own checkpoint directory: its, mode 0700.
    pub fn new(broker: B, outbox: O, directory: File) -> io::Result<Self> {
        // The store's own check of the directory, before anything is read.
        CheckpointStore::new(directory.try_clone()?, [1; 16])?;
        Ok(Self {
            broker,
            outbox,
            directory,
            readers: BTreeMap::new(),
            failing: BTreeMap::new(),
            stopped: BTreeSet::new(),
            swept: None,
        })
    }

    /// The link is not being served: hold no reader. Each one's socket closes,
    /// its child exits, and the broker reaps it. Checkpoints stay.
    pub fn idle(&mut self) {
        self.readers.clear();
    }
    pub fn reading(&self) -> usize {
        self.readers.len()
    }

    fn store(&self, lifetime: [u8; 16]) -> io::Result<CheckpointStore> {
        CheckpointStore::new(self.directory.try_clone()?, lifetime)
    }

    /// Stop a source for good: the host refused a record of it, or its reader
    /// could not frame one. Nothing of it is read again.
    fn stop(&mut self, lifetime: [u8; 16]) {
        self.readers.remove(&lifetime);
        self.failing.remove(&lifetime);
        if let Ok(store) = self.store(lifetime) {
            let _ = store.remove();
        }
        // Remembered until the broker has taken the release.
        self.stopped.insert(lifetime);
        let _ = self.broker.release(lifetime, true);
    }

    fn read(&mut self, source: &Listed) -> io::Result<usize> {
        let store = self.store(source.lifetime)?;
        if !self.readers.contains_key(&source.lifetime) {
            let checkpoint = store
                .load()?
                .map(String::from_utf8)
                .transpose()
                .map_err(|_| invalid())?;
            let (startup, socket) = self.broker.reader(source.lifetime)?;
            // What the broker bound is what it listed.
            if startup.source.lifetime != source.lifetime
                || startup.source.session != source.session
                || startup.source.participant != source.participant
                || startup.checkpoint.is_some()
            {
                return Err(invalid());
            }
            let reader = Reader::connect(
                socket,
                &Startup {
                    checkpoint,
                    ..startup
                },
            )?;
            self.readers.insert(source.lifetime, reader);
        }
        let reader = self.readers.get_mut(&source.lifetime).unwrap();
        let outbox = &self.outbox;
        reader.poll(
            || Ok(()),
            |event| outbox.append(event),
            |checkpoint| store.save(checkpoint),
        )
    }

    /// One pass over what the broker lists. An error means the broker or the
    /// outbox cannot serve now; the caller idles and asks again.
    pub fn pass(&mut self, now: Instant) -> io::Result<()> {
        for lifetime in self.outbox.refused()? {
            self.stop(lifetime);
        }
        let listed = self.broker.sources()?;
        let names: BTreeSet<_> = listed.iter().map(|source| source.lifetime).collect();
        // A source the broker no longer lists is over: its session ended, its
        // member left, or it was released. Its reader is already killed.
        self.readers.retain(|lifetime, _| names.contains(lifetime));
        self.failing.retain(|lifetime, _| names.contains(lifetime));
        self.stopped.retain(|lifetime| names.contains(lifetime));
        if self.swept.as_ref() != Some(&names) {
            CheckpointStore::sweep(&self.directory, &names)?;
            self.swept = Some(names);
        }
        for source in &listed {
            let lifetime = source.lifetime;
            if self.stopped.contains(&lifetime) {
                let _ = self.broker.release(lifetime, true);
                continue;
            }
            if self.outbox.depth()? >= QUEUED {
                break;
            }
            if self
                .failing
                .get(&lifetime)
                .is_some_and(|failing| now < failing.until)
            {
                continue;
            }
            match self.read(source) {
                Ok(read) => {
                    self.failing.remove(&lifetime);
                    // An ended source with nothing left to read is done.
                    if source.ended && read == 0 {
                        self.readers.remove(&lifetime);
                        let _ = self.store(lifetime).and_then(|store| store.remove());
                        let _ = self.broker.release(lifetime, false);
                    }
                }
                Err(_) => {
                    let framing = self
                        .readers
                        .remove(&lifetime)
                        .is_some_and(|reader| reader.source_stopped())
                        || self
                            .store(lifetime)
                            .and_then(|store| store.load())
                            .is_ok_and(|saved| saved.is_some_and(|saved| Reader::stopped(&saved)));
                    if framing {
                        // The reader met a record it cannot frame and stopped
                        // the source. Reading again can only fail the same way.
                        eprintln!(
                            "smithers-machined: transcript source of session {} stopped: a record could not be framed",
                            source.session
                        );
                        self.stop(lifetime);
                        continue;
                    }
                    let failing = self.failing.entry(lifetime).or_insert(Failing {
                        count: 0,
                        until: now,
                    });
                    failing.count += 1;
                    failing.until = now + Duration::from_secs(1 << failing.count.min(5));
                    // A checkpoint the reader keeps refusing is dropped. The
                    // source is read again from its start, and the host's
                    // receipts drop what it already has.
                    if failing.count == 3 {
                        let _ = self.store(lifetime).and_then(|store| store.remove());
                    }
                }
            }
        }
        Ok(())
    }
}

/// Run until the broker says it has no transcript import at all. `serving`
/// is whether the daemon serves a ready link right now.
pub fn run<B: Broker, O: Outbox>(mut pump: Pump<B, O>, serving: impl Fn() -> bool) {
    loop {
        if !serving() {
            pump.idle();
        } else if let Err(error) = pump.pass(Instant::now()) {
            pump.idle();
            if error.kind() == io::ErrorKind::Unsupported {
                return;
            }
        }
        std::thread::sleep(PASS);
    }
}

fn refused(error: crate::hooks::Error) -> io::Error {
    match error.code {
        2 => io::ErrorKind::Unsupported.into(),
        5 => io::ErrorKind::NotFound.into(),
        11 => io::ErrorKind::PermissionDenied.into(),
        _ => io::Error::other("broker refused"),
    }
}
impl Broker for std::sync::Arc<crate::broker::control::SocketpairBroker> {
    fn sources(&self) -> io::Result<Vec<Listed>> {
        self.transcript_sources().map_err(refused)
    }
    fn reader(&self, lifetime: [u8; 16]) -> io::Result<(Startup, UnixStream)> {
        self.transcript_reader(lifetime).map_err(refused)
    }
    fn release(&self, lifetime: [u8; 16], stopped: bool) -> io::Result<()> {
        self.transcript_release(lifetime, stopped).map_err(refused)
    }
}
impl<R, B> Outbox for std::sync::Arc<crate::event_service::Events<R, B>>
where
    R: crate::outbox::Refs + Send,
    B: crate::objects::Bundles + Send,
    B::Source: Send,
{
    fn depth(&self) -> io::Result<u32> {
        crate::event_service::Events::depth(self)
    }
    fn append(&self, event: &[u8]) -> io::Result<()> {
        crate::hooks::EventSink::append(&**self, event, None)
            .map(|_| ())
            .map_err(|_| io::Error::other("outbox append failed"))
    }
    fn refused(&self) -> io::Result<Vec<[u8; 16]>> {
        self.refused_transcripts()
    }
}
