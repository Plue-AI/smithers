//! Durable delivery. Ref operations must complete durably before entry deletion.
use crate::{
    conn::{self, Acknowledgement, Durable, Frame},
    hooks::Oid,
    outbox_store::Store,
};
use std::io;

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid outbox delivery")
}
/// Implemented by the unprivileged repository owner, never by the root broker.
pub trait Refs {
    fn pin_and_sync(&mut self, id: [u8; 16], oid: Oid) -> io::Result<()>;
    fn acknowledge_and_sync(&mut self, head: Oid) -> io::Result<()>;
    fn unpin(&mut self, id: [u8; 16]) -> io::Result<()>;
    fn pending(&mut self) -> io::Result<Vec<[u8; 16]>>;
}
pub struct Outbox<R> {
    store: Store,
    owner: u32,
    refs: R,
    sent: Option<u64>,
    haves: Vec<Oid>,
    poisoned: bool,
}
impl<R: Refs> Outbox<R> {
    pub fn open(store: Store, owner: u32, mut refs: R) -> io::Result<Self> {
        let mut ids = vec![];
        for seq in store.sequences() {
            let event = Durable::decode(&store.read(seq, owner)?).map_err(|_| invalid())?;
            if event.seq != seq || ids.contains(&event.id) {
                return Err(invalid());
            }
            ids.push(event.id);
        }
        for id in refs.pending()? {
            if !ids.contains(&id) {
                refs.unpin(id)?;
            }
        }
        Ok(Self {
            store,
            owner,
            refs,
            sent: None,
            haves: vec![],
            poisoned: false,
        })
    }
    pub fn append(&mut self, event: &[u8], pin: Option<Oid>) -> io::Result<(u64, [u8; 16])> {
        if self.poisoned {
            return Err(invalid());
        }
        let mut id = [0; 16];
        getrandom::fill(&mut id).map_err(|e| io::Error::other(e.to_string()))?;
        let seq = self.store.next_sequence()?;
        let envelope = Durable {
            seq,
            id,
            event: event.into(),
        };
        envelope.frame().encode().map_err(|_| invalid())?;
        if let Some(oid) = pin {
            self.refs.pin_and_sync(id, oid)?;
        }
        self.store.append(|_| Ok(envelope.frame().payload))?;
        #[cfg(all(feature = "killpoints", debug_assertions))]
        crate::events::killpoint("K3");
        Ok((seq, id))
    }
    pub fn next_sequence(&self) -> io::Result<u64> {
        self.store.next_sequence()
    }
    pub fn depth(&self) -> u32 {
        self.store.sequences().count() as u32
    }
    pub fn front(&self) -> io::Result<Option<Durable>> {
        if self.poisoned {
            return Err(invalid());
        }
        self.store
            .sequences()
            .next()
            .map(|seq| Durable::decode(&self.store.read(seq, self.owner)?).map_err(|_| invalid()))
            .transpose()
    }
    pub fn contains_capture(&self, head: Oid) -> io::Result<bool> {
        for seq in self.store.sequences() {
            if Durable::decode(&self.store.read(seq, self.owner)?)
                .map_err(|_| invalid())?
                .captured_head()
                == Some(head)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// The link calls this only after the bundle stream has closed successfully.
    /// One in-flight event is within the contract's maximum of 32.
    pub fn after_bundle(&mut self, seq: u64) -> io::Result<Frame> {
        let event = self.front()?.ok_or_else(invalid)?;
        if event.seq != seq || self.sent.is_some() {
            return Err(invalid());
        }
        self.sent = Some(seq);
        Ok(event.frame())
    }
    pub fn haves(&self) -> &[Oid] {
        &self.haves
    }
    pub fn reconnect(&mut self) {
        self.sent = None;
        self.haves.clear();
    }
    pub fn acknowledge(&mut self, frame: &Frame) -> io::Result<()> {
        let ack = Acknowledgement::decode(frame).map_err(|_| invalid())?;
        let event = self.front()?.ok_or_else(invalid)?;
        if ack.seq != event.seq || self.sent != Some(ack.seq) {
            return Err(invalid());
        }
        if ack.outcome == 3 {
            // missing_objects: keep the entry and rebuild from haves
            self.sent = None;
            self.haves = ack.haves;
            return Ok(());
        }
        // Any interrupted acknowledgement requires reopening and replaying disk.
        self.poisoned = true;
        if matches!(ack.outcome, 1 | 2) {
            if let Some(head) = event.captured_head() {
                self.refs.acknowledge_and_sync(head)?;
            }
        }
        self.store.remove(ack.seq, ack.outcome == 4)?;
        self.refs.unpin(event.id)?;
        self.sent = None;
        self.haves.clear();
        self.poisoned = false;
        Ok(())
    }
}

pub fn captured(head: Oid, tree: Oid, base: Oid) -> Vec<u8> {
    conn::tagged(
        2,
        &[
            conn::field(1, head),
            conn::field(2, tree),
            conn::field(3, base),
        ],
    )
}
