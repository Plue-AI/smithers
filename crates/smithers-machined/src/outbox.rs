//! Durable object pinning and acknowledgement ordering. Wire bytes belong to
//! ADR 0004's codec; this layer never invents another event encoding.
use crate::outbox_store::Store;
use std::{collections::BTreeSet, io};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub seq: u64,
    pub event_id: [u8; 16],
    pub pin: Option<String>,
    pub captured_head: Option<String>,
}

/// Implemented by the sole Durable codec. Inspection must validate the complete
/// payload, including equality of its embedded seq with the filename seq.
pub trait Codec {
    fn inspect(&self, seq: u64, bytes: &[u8]) -> io::Result<Entry>;
}

/// Repository operations run only as machined, on the mutation executor.
pub trait Objects {
    fn pin(&mut self, id: [u8; 16], oid: &str) -> io::Result<()>;
    fn sync(&mut self) -> io::Result<()>;
    fn pending(&mut self) -> io::Result<Vec<[u8; 16]>>;
    fn unpin(&mut self, id: [u8; 16]) -> io::Result<()>;
    fn ack_head(&mut self, oid: &str) -> io::Result<()>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ack {
    Applied,
    Duplicate,
    MissingObjects,
    StaleBase,
    Rejected,
}

pub struct Outbox<C, O> {
    store: Store,
    codec: C,
    objects: O,
    owner: u32,
    failed: bool,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

impl<C: Codec, O: Objects> Outbox<C, O> {
    pub fn open(store: Store, codec: C, mut objects: O, owner: u32) -> io::Result<Self> {
        let mut live = BTreeSet::new();
        let mut required = BTreeSet::new();
        for seq in store.sequences() {
            let entry = codec.inspect(seq, &store.read(seq, owner)?)?;
            if entry.seq != seq || !live.insert(entry.event_id) {
                return Err(invalid("invalid or duplicate outbox identity"));
            }
            if entry.pin.is_some() {
                required.insert(entry.event_id);
            }
        }
        let pending: BTreeSet<_> = objects.pending()?.into_iter().collect();
        if !required.is_subset(&pending) {
            return Err(invalid("outbox objects are not pinned"));
        }
        for id in pending.difference(&required) {
            objects.unpin(*id)?;
        }
        Ok(Self {
            store,
            codec,
            objects,
            owner,
            failed: false,
        })
    }

    fn healthy(&self) -> io::Result<()> {
        if self.failed {
            Err(invalid("reopen outbox after repository or IO failure"))
        } else {
            Ok(())
        }
    }

    /// The encoder binds a newly minted event id and allocated seq into bytes.
    /// An interrupted append may leave an orphan pin; startup removes it.
    pub fn append(&mut self, encode: impl FnOnce(u64) -> io::Result<Vec<u8>>) -> io::Result<u64> {
        self.healthy()?;
        let seq = self.store.next_sequence()?;
        let bytes = encode(seq)?;
        let entry = self.codec.inspect(seq, &bytes)?;
        if entry.seq != seq {
            return Err(invalid("event sequence mismatch"));
        }
        for old in self.store.sequences() {
            if self
                .codec
                .inspect(old, &self.store.read(old, self.owner)?)?
                .event_id
                == entry.event_id
            {
                return Err(invalid("duplicate event identity"));
            }
        }
        let result = (|| {
            if let Some(oid) = &entry.pin {
                self.objects.pin(entry.event_id, oid)?;
            }
            self.objects.sync()?;
            self.store.append(|_| Ok(bytes))
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    /// Ordered replay bytes are returned unchanged, including after reconnect.
    pub fn oldest(&self) -> io::Result<Option<(Entry, Vec<u8>)>> {
        self.healthy()?;
        let Some(seq) = self.store.sequences().next() else {
            return Ok(None);
        };
        let bytes = self.store.read(seq, self.owner)?;
        Ok(Some((self.codec.inspect(seq, &bytes)?, bytes)))
    }

    /// Call only after authenticated host receipt decoding. Missing objects
    /// retain both entry and pin; stale base never advances acked/head.
    pub fn acknowledge(&mut self, seq: u64, ack: Ack) -> io::Result<()> {
        self.healthy()?;
        let (entry, _) = self
            .oldest()?
            .ok_or_else(|| invalid("ack for empty outbox"))?;
        if entry.seq != seq {
            return Err(invalid("acknowledgement out of order"));
        }
        if ack == Ack::MissingObjects {
            return Ok(());
        }
        let result = (|| {
            if matches!(ack, Ack::Applied | Ack::Duplicate) {
                if let Some(head) = &entry.captured_head {
                    self.objects.ack_head(head)?;
                }
            }
            self.store.remove(seq, ack == Ack::Rejected)?;
            if entry.pin.is_some() {
                self.objects.unpin(entry.event_id)?;
            }
            Ok(())
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicU64, Ordering},
        },
    };
    struct Fixture {
        path: PathBuf,
        owner: u32,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "outbox-lifecycle-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            fs::create_dir(path.join("outbox")).unwrap();
            fs::set_permissions(path.join("outbox"), fs::Permissions::from_mode(0o700)).unwrap();
            let owner = fs::metadata(&path).unwrap().uid();
            Self { path, owner }
        }
        fn store(&self) -> Store {
            Store::open(&self.path.join("outbox"), self.owner).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.path).unwrap();
        }
    }
    // An explicitly independent fixture encoding; never used on a connection.
    struct FixtureCodec;
    impl Codec for FixtureCodec {
        fn inspect(&self, seq: u64, bytes: &[u8]) -> io::Result<Entry> {
            if bytes.len() != 2 || bytes[0] as u64 != seq {
                return Err(invalid("bad fixture bytes"));
            }
            Ok(Entry {
                seq,
                event_id: [bytes[1]; 16],
                pin: Some("a".repeat(40)),
                captured_head: Some("b".repeat(40)),
            })
        }
    }
    #[derive(Default)]
    struct State {
        pins: BTreeSet<[u8; 16]>,
        log: Vec<String>,
        fail: Option<&'static str>,
    }
    #[derive(Clone, Default)]
    struct FakeObjects(Arc<Mutex<State>>);
    impl FakeObjects {
        fn step(&self, name: &'static str) -> io::Result<()> {
            let mut state = self.0.lock().unwrap();
            state.log.push(name.into());
            if state.fail == Some(name) {
                return Err(io::ErrorKind::Other.into());
            }
            Ok(())
        }
    }
    impl Objects for FakeObjects {
        fn pin(&mut self, id: [u8; 16], _: &str) -> io::Result<()> {
            self.step("pin")?;
            if !self.0.lock().unwrap().pins.insert(id) {
                return Err(invalid("collision"));
            }
            Ok(())
        }
        fn sync(&mut self) -> io::Result<()> {
            self.step("sync")
        }
        fn pending(&mut self) -> io::Result<Vec<[u8; 16]>> {
            Ok(self.0.lock().unwrap().pins.iter().copied().collect())
        }
        fn unpin(&mut self, id: [u8; 16]) -> io::Result<()> {
            self.step("unpin")?;
            self.0.lock().unwrap().pins.remove(&id);
            Ok(())
        }
        fn ack_head(&mut self, _: &str) -> io::Result<()> {
            self.step("head")
        }
    }
    #[test]
    fn receipts_preserve_order_and_stale_base_never_moves_head() {
        for ack in [Ack::Applied, Ack::Duplicate, Ack::StaleBase, Ack::Rejected] {
            let fixture = Fixture::new();
            let objects = FakeObjects::default();
            let mut box_ = Outbox::open(
                fixture.store(),
                FixtureCodec,
                objects.clone(),
                fixture.owner,
            )
            .unwrap();
            box_.append(|_| Ok(vec![1, 7])).unwrap();
            box_.append(|_| Ok(vec![2, 8])).unwrap();
            assert!(box_.acknowledge(2, ack).is_err());
            box_.acknowledge(1, Ack::MissingObjects).unwrap();
            assert_eq!(box_.oldest().unwrap().unwrap().1, [1, 7]);
            assert_eq!(objects.0.lock().unwrap().pins.len(), 2);
            objects.0.lock().unwrap().log.clear();
            box_.acknowledge(1, ack).unwrap();
            assert_eq!(
                objects.0.lock().unwrap().log,
                if matches!(ack, Ack::Applied | Ack::Duplicate) {
                    vec!["head", "unpin"]
                } else {
                    vec!["unpin"]
                }
            );
            assert_eq!(box_.oldest().unwrap().unwrap().1, [2, 8]);
            assert_eq!(
                fixture
                    .path
                    .join("outbox/dead/00000000000000000001.ev")
                    .exists(),
                ack == Ack::Rejected
            );
            drop(box_);
            let box_ = Outbox::open(
                fixture.store(),
                FixtureCodec,
                objects.clone(),
                fixture.owner,
            )
            .unwrap();
            assert_eq!(box_.oldest().unwrap().unwrap().1, [2, 8]);
        }
    }
    #[test]
    fn missing_pins_refuse_start_and_orphans_are_removed() {
        let fixture = Fixture::new();
        let objects = FakeObjects::default();
        objects.0.lock().unwrap().pins.insert([9; 16]);
        let mut box_ = Outbox::open(
            fixture.store(),
            FixtureCodec,
            objects.clone(),
            fixture.owner,
        )
        .unwrap();
        assert!(objects.0.lock().unwrap().pins.is_empty());
        box_.append(|_| Ok(vec![1, 7])).unwrap();
        drop(box_);
        objects.0.lock().unwrap().pins.clear();
        assert!(Outbox::open(fixture.store(), FixtureCodec, objects, fixture.owner).is_err());
    }
    #[test]
    fn failures_poison_until_reopen_and_preserve_recovery() {
        for step in ["pin", "sync", "head", "unpin"] {
            let fixture = Fixture::new();
            let objects = FakeObjects::default();
            let mut box_ = Outbox::open(
                fixture.store(),
                FixtureCodec,
                objects.clone(),
                fixture.owner,
            )
            .unwrap();
            if matches!(step, "head" | "unpin") {
                box_.append(|_| Ok(vec![1, 7])).unwrap();
            }
            objects.0.lock().unwrap().fail = Some(step);
            let result = if matches!(step, "head" | "unpin") {
                box_.acknowledge(1, Ack::Applied).map(|_| 1)
            } else {
                box_.append(|_| Ok(vec![1, 7]))
            };
            assert!(result.is_err());
            assert!(box_.oldest().is_err());
            drop(box_);
            objects.0.lock().unwrap().fail = None;
            let recovered = Outbox::open(
                fixture.store(),
                FixtureCodec,
                objects.clone(),
                fixture.owner,
            )
            .unwrap();
            assert_eq!(recovered.oldest().unwrap().is_some(), step == "head");
            assert_eq!(
                objects.0.lock().unwrap().pins.len(),
                usize::from(step == "head")
            );
        }
    }
    #[test]
    fn duplicate_identity_and_invalid_payload_do_not_pin_or_append() {
        let fixture = Fixture::new();
        let objects = FakeObjects::default();
        let mut box_ = Outbox::open(
            fixture.store(),
            FixtureCodec,
            objects.clone(),
            fixture.owner,
        )
        .unwrap();
        assert!(box_.append(|_| Ok(vec![99])).is_err());
        assert!(objects.0.lock().unwrap().log.is_empty());
        box_.append(|_| Ok(vec![1, 7])).unwrap();
        assert!(box_.append(|_| Ok(vec![2, 7])).is_err());
        assert_eq!(box_.oldest().unwrap().unwrap().1, [1, 7]);
    }
}
