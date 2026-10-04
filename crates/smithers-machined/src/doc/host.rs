//! Internal document engine. T-COL-08 mounts it through Documents/LockCx and the
//! T-COL-08b authenticated codec; no actor or frame is accepted from raw callers.
use super::{
    authors, core,
    disk::{self, Disk, Displaced},
    gone::Gone,
    merge, reconcile,
    state::{digest, Digest, Record},
    Error, Result, MAX_STATE_BYTES, MAX_TEXT_BYTES,
};
use std::collections::{BTreeMap, BTreeSet};
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, Transact};

#[derive(Default, Clone)]
pub struct Gates {
    pub codec: bool,
    pub dispatcher: bool,
    pub envelopes: bool,
    pub saved_epoch: bool,
    pub authenticated_machine: bool,
    pub mutation_lock: bool,
    pub capture_rewrite: bool,
    pub attribution: bool,
    pub versions: bool,
    pub topology: bool,
    pub kernel: bool,
    pub non_root_machine: bool,
}
impl Gates {
    pub fn check(&self) -> Result<()> {
        if self.codec
            && self.dispatcher
            && self.envelopes
            && self.saved_epoch
            && self.authenticated_machine
            && self.mutation_lock
            && self.capture_rewrite
            && self.attribution
            && self.versions
            && self.topology
            && self.kernel
            && self.non_root_machine
        {
            Ok(())
        } else {
            Err(Error::Unsupported)
        }
    }
}

/// Internal output only. The sole wire encoder belongs to T-COL-08b.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Saved {
        path: String,
        epoch: [u8; 16],
        sv: Vec<u8>,
        digest: Digest,
        at_ms: u64,
    },
    Outside {
        path: String,
        version: String,
        by: String,
    },
    Activity {
        path: String,
        actor: String,
    },
    Gone {
        path: String,
        state: Gone,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Editor {
    pub actor: String,
    pub colour: String,
    pub path: String,
    pub line: u32,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Projection {
    pub path: String,
    pub saved_digest: Digest,
    pub saved_at_ms: Option<u64>,
    pub editors: Vec<Editor>,
    pub read_only: bool,
    pub gone: Option<Gone>,
    pub outside_change: Option<(String, String)>,
}
struct Document {
    doc: Doc,
    epoch: [u8; 16],
    base: String,
    last_disk: Digest,
    dirty_since: Option<u64>,
    updated: u64,
    subscribers: BTreeSet<u32>,
    closing: Option<u64>,
    gone: Option<Gone>,
    readonly: bool,
    activity: BTreeMap<String, u64>,
    displaced: Vec<Pending>,
    editors: BTreeMap<(u32, String), Editor>,
    saved_at_ms: Option<u64>,
    outside_change: Option<(String, String)>,
}
struct Pending {
    token: Displaced,
    base: String,
    expected: Digest,
    saved: Digest,
    observed: Digest,
    quiet: u64,
    deadline: u64,
}
pub struct Host<D: Disk> {
    pub disk: D,
    gates: Gates,
    docs: BTreeMap<String, Document>,
    streams: BTreeMap<u32, String>,
    stream_ids: Box<dyn FnMut() -> Result<u32> + Send>,
    notices: Vec<Notice>,
    clients: BTreeMap<(u32, String), u64>,
}
impl<D: Disk> Host<D> {
    pub fn new(
        disk: D,
        gates: Gates,
        stream_ids: impl FnMut() -> Result<u32> + Send + 'static,
    ) -> Self {
        Self {
            disk,
            gates,
            docs: BTreeMap::new(),
            streams: BTreeMap::new(),
            stream_ids: Box::new(stream_ids),
            notices: vec![],
            clients: BTreeMap::new(),
        }
    }
    pub fn notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }
    /// Epoch randomness comes from the authority's OS entropy provider; the
    /// production adapter must not expose this input in RPC or stream schemas.
    pub fn open(&mut self, path: &str, fresh_epoch: [u8; 16], now: u64) -> Result<u32> {
        self.gates.check()?;
        if !disk::valid_path(path) {
            return Err(Error::Invalid);
        }
        // ADR 0004's one allocator is shared with sessions and object streams.
        // Missing allocation refuses before reading the file or state record.
        let stream = (self.stream_ids)()?;
        if stream == 0 || stream > 0x7fff_ffff || self.streams.contains_key(&stream) {
            return Err(Error::Invalid);
        }
        if !self.docs.contains_key(path) {
            let bytes = self.disk.read(path)?.ok_or(Error::Gone)?;
            let text = std::str::from_utf8(&bytes);
            let readonly = bytes.len() > MAX_TEXT_BYTES || text.is_err();
            let text = if readonly { "" } else { text.unwrap() };
            let key = digest(path.as_bytes());
            let record = if readonly {
                None
            } else {
                self.disk.load_record(key)?
            };
            let mut entry = match record {
                Some(record) => {
                    let doc = record.document()?;
                    let saved = digest(record.text.as_bytes());
                    Document {
                        doc,
                        epoch: record.epoch,
                        base: record.text,
                        last_disk: saved,
                        dirty_since: if digest(&bytes) == record.previous && digest(&bytes) != saved
                        {
                            Some(now)
                        } else {
                            None
                        },
                        updated: now,
                        subscribers: BTreeSet::new(),
                        closing: None,
                        gone: None,
                        readonly,
                        activity: BTreeMap::new(),
                        displaced: vec![],
                        editors: BTreeMap::new(),
                        saved_at_ms: None,
                        outside_change: None,
                    }
                }
                None => {
                    let doc = core::document(None);
                    doc.get_or_insert_map("authors");
                    let client = authors::allocate(&doc, "outside")?;
                    doc.get_or_insert_text("content");
                    let update = reconcile::replace(&doc, text, client)?;
                    core::apply(&doc, core::decode(&update).map_err(|_| Error::Invalid)?)
                        .map_err(|_| Error::Invalid)?;
                    Document {
                        doc,
                        epoch: fresh_epoch,
                        base: text.into(),
                        last_disk: digest(&bytes),
                        dirty_since: if readonly { None } else { Some(now) },
                        updated: now,
                        subscribers: BTreeSet::new(),
                        closing: None,
                        gone: None,
                        readonly,
                        activity: BTreeMap::new(),
                        displaced: vec![],
                        editors: BTreeMap::new(),
                        saved_at_ms: None,
                        outside_change: None,
                    }
                }
            };
            // Outside changes are reconciled only if this is not an interrupted
            // save. In that case the record is completed on disk first.
            if !readonly && digest(&bytes) != entry.last_disk && entry.dirty_since.is_none() {
                Self::outside(
                    (&mut self.disk, &mut self.notices),
                    path,
                    &mut entry,
                    &bytes,
                    "outside",
                    now,
                    None,
                )?;
            }
            if !readonly {
                for recovered in self.disk.recover_temps(path, key)? {
                    let bytes = self.disk.read_displaced(recovered.token)?;
                    entry.displaced.push(Pending {
                        token: recovered.token,
                        base: recovered.record.previous_text,
                        expected: recovered.record.previous,
                        saved: digest(recovered.record.text.as_bytes()),
                        observed: digest(&bytes),
                        quiet: now,
                        deadline: now.saturating_add(2000),
                    });
                }
            }
            self.docs.insert(path.into(), entry);
        }
        let doc = self.docs.get_mut(path).unwrap();
        doc.subscribers.insert(stream);
        doc.closing = None;
        self.streams.insert(stream, path.into());
        Ok(stream)
    }
    pub fn close(&mut self, stream: u32, now: u64) -> Result<()> {
        let path = self.streams.remove(&stream).ok_or(Error::Invalid)?;
        self.clients.retain(|(s, _), _| *s != stream);
        let doc = self.docs.get_mut(&path).unwrap();
        doc.subscribers.remove(&stream);
        doc.editors.retain(|(id, _), _| *id != stream);
        if doc.subscribers.is_empty() {
            doc.closing = Some(now.saturating_add(60_000));
        }
        Ok(())
    }
    pub fn text(&self, stream: u32) -> Result<String> {
        let doc = self.entry(stream)?;
        Ok(doc
            .doc
            .get_or_insert_text("content")
            .get_string(&doc.doc.transact()))
    }
    fn entry(&self, stream: u32) -> Result<&Document> {
        let path = self.streams.get(&stream).ok_or(Error::Invalid)?;
        self.docs.get(path).ok_or(Error::Invalid)
    }
    pub fn epoch(&self, stream: u32) -> Result<[u8; 16]> {
        Ok(self.entry(stream)?.epoch)
    }
    pub fn state(&self, stream: u32) -> Result<Vec<u8>> {
        Ok(core::state(&self.entry(stream)?.doc))
    }
    /// Called only with the authenticated actor from the host codec.
    pub fn client(&mut self, stream: u32, actor: &str, now: u64) -> Result<u64> {
        let path = self.streams.get(&stream).ok_or(Error::Invalid)?;
        let doc = self.docs.get_mut(path).unwrap();
        if doc.readonly {
            return Err(Error::ReadOnly);
        }
        if let Some(id) = self.clients.get(&(stream, actor.into())) {
            return Ok(*id);
        }
        let id = authors::fresh(&doc.doc, actor)?;
        self.clients.insert((stream, actor.into()), id);
        Self::dirty(doc, now);
        Ok(id)
    }
    fn dirty(doc: &mut Document, now: u64) {
        doc.dirty_since.get_or_insert(now);
        doc.updated = now;
    }
    pub fn update(
        &mut self,
        stream: u32,
        epoch: [u8; 16],
        actor: &str,
        bytes: &[u8],
        now: u64,
    ) -> Result<()> {
        self.gates.check()?;
        if bytes.len() > MAX_TEXT_BYTES {
            return Err(Error::Invalid);
        }
        let path = self.streams.get(&stream).ok_or(Error::Invalid)?;
        let doc = self.docs.get_mut(path).unwrap();
        if epoch != doc.epoch {
            return Err(Error::Epoch);
        }
        if doc.readonly {
            return Err(Error::ReadOnly);
        }
        if doc.gone.is_some() {
            return Err(Error::Gone);
        }
        if !self.clients.contains_key(&(stream, actor.into())) {
            return Err(Error::Forged);
        }
        authors::checked_actor_update(&doc.doc, bytes, actor)?;
        // Validate limits in a scratch replica before changing live state.
        let scratch = core::document(None);
        scratch.get_or_insert_text("content");
        scratch.get_or_insert_map("authors");
        core::apply(
            &scratch,
            core::decode(&core::state(&doc.doc)).map_err(|_| Error::Invalid)?,
        )
        .map_err(|_| Error::Invalid)?;
        core::apply(&scratch, core::decode(bytes).map_err(|_| Error::Invalid)?)
            .map_err(|_| Error::Invalid)?;
        if scratch
            .get_or_insert_text("content")
            .get_string(&scratch.transact())
            .len()
            > MAX_TEXT_BYTES
            || core::state(&scratch).len() > MAX_STATE_BYTES
        {
            return Err(Error::Invalid);
        }
        let before = core::state(&doc.doc);
        core::apply(&doc.doc, core::decode(bytes).map_err(|_| Error::Invalid)?)
            .map_err(|_| Error::Invalid)?;
        if core::state(&doc.doc) != before {
            Self::dirty(doc, now);
            doc.activity.insert(actor.into(), now.saturating_add(2000));
        }
        Ok(())
    }
    /// The shared authenticated codec supplies a decoded Yjs message. This
    /// engine never invents a daemon frame or parses a caller-supplied actor.
    pub fn sync_message(
        &mut self,
        stream: u32,
        epoch: [u8; 16],
        actor: &str,
        message: yrs::sync::SyncMessage,
        now: u64,
    ) -> Result<Vec<yrs::sync::SyncMessage>> {
        self.gates.check()?;
        if epoch != self.entry(stream)?.epoch {
            return Err(Error::Epoch);
        }
        match message {
            yrs::sync::SyncMessage::SyncStep1(sv) => {
                let doc = self.entry(stream)?;
                if doc.readonly {
                    return Err(Error::ReadOnly);
                }
                let txn = doc.doc.transact();
                Ok(vec![
                    yrs::sync::SyncMessage::SyncStep2(txn.encode_state_as_update_v1(&sv)),
                    yrs::sync::SyncMessage::SyncStep1(txn.state_vector()),
                ])
            }
            yrs::sync::SyncMessage::SyncStep2(bytes) | yrs::sync::SyncMessage::Update(bytes) => {
                self.update(stream, epoch, actor, &bytes, now)?;
                Ok(vec![])
            }
        }
    }
    /// The envelope codec validates awareness's field whitelist and clock.
    /// It passes only the authenticated actor and that actor's line/colour.
    pub fn awareness(
        &mut self,
        stream: u32,
        epoch: [u8; 16],
        actor: &str,
        colour: &str,
        line: Option<u32>,
    ) -> Result<()> {
        self.gates.check()?;
        if epoch != self.entry(stream)?.epoch {
            return Err(Error::Epoch);
        }
        if !self.clients.contains_key(&(stream, actor.into())) {
            return Err(Error::Forged);
        }
        let path = self.streams.get(&stream).unwrap();
        let doc = self.docs.get_mut(path).unwrap();
        if let Some(line) = line {
            if line == 0 || colour.len() > 64 {
                return Err(Error::Invalid);
            }
            doc.editors.insert(
                (stream, actor.into()),
                Editor {
                    actor: actor.into(),
                    colour: colour.into(),
                    path: path.clone(),
                    line,
                },
            );
        } else {
            doc.editors.remove(&(stream, actor.into()));
        }
        Ok(())
    }
    pub fn projection(&self, path: &str) -> Result<Projection> {
        let doc = self.docs.get(path).ok_or(Error::Invalid)?;
        Ok(Projection {
            path: path.into(),
            saved_digest: doc.last_disk,
            saved_at_ms: doc.saved_at_ms,
            editors: doc.editors.values().cloned().collect(),
            read_only: doc.readonly,
            gone: doc.gone.clone(),
            outside_change: doc.outside_change.clone(),
        })
    }
    pub fn write_through(
        &mut self,
        path: &str,
        base: Digest,
        text: &str,
        actor: &str,
        now: u64,
    ) -> Result<bool> {
        self.gates.check()?;
        let Some(doc) = self.docs.get_mut(path) else {
            return Ok(false);
        };
        if doc.readonly {
            return Err(Error::ReadOnly);
        }
        if text.len() > MAX_TEXT_BYTES {
            return Err(Error::Invalid);
        }
        let current = doc
            .doc
            .get_or_insert_text("content")
            .get_string(&doc.doc.transact());
        if digest(current.as_bytes()) != base {
            return Err(Error::Stale);
        }
        // Restore uses this same boundary and clears gone only after a real save.
        if current != text || doc.gone.is_some() {
            let client = authors::allocate(&doc.doc, actor)?;
            let update = reconcile::replace(&doc.doc, text, client)?;
            core::apply(&doc.doc, core::decode(&update).map_err(|_| Error::Invalid)?)
                .map_err(|_| Error::Invalid)?;
            doc.gone = None;
            Self::dirty(doc, now);
            doc.activity.insert(actor.into(), now.saturating_add(2000));
        }
        Ok(true)
    }
    fn outside(
        ports: (&mut D, &mut Vec<Notice>),
        path: &str,
        doc: &mut Document,
        bytes: &[u8],
        actor: &str,
        now: u64,
        base: Option<&str>,
    ) -> Result<()> {
        let (disk, notices) = ports;
        if digest(bytes) == doc.last_disk {
            return Ok(());
        }
        let version = disk.record_outside(path, bytes, actor)?;
        let theirs = std::str::from_utf8(bytes).map_err(|_| Error::ReadOnly)?;
        if bytes.len() > MAX_TEXT_BYTES {
            return Err(Error::ReadOnly);
        }
        let ours = doc
            .doc
            .get_or_insert_text("content")
            .get_string(&doc.doc.transact());
        let merged = merge::merge(base.unwrap_or(&doc.base), &ours, theirs);
        if merged.text.len() > MAX_TEXT_BYTES {
            return Err(Error::ReadOnly);
        }
        let client = authors::allocate(&doc.doc, actor)?;
        let update = reconcile::replace(&doc.doc, &merged.text, client)?;
        core::apply(&doc.doc, core::decode(&update).map_err(|_| Error::Invalid)?)
            .map_err(|_| Error::Invalid)?;
        if merged.overlap {
            doc.outside_change = Some((version.clone(), actor.into()));
            notices.push(Notice::Outside {
                path: path.into(),
                version,
                by: actor.into(),
            });
        }
        Self::dirty(doc, now);
        Ok(())
    }
    /// Only completed-write events call this; IN_MODIFY is not an admission.
    pub fn completed_write(&mut self, path: &str, actor: &str, now: u64) -> Result<()> {
        self.gates.check()?;
        let Some(doc) = self.docs.get_mut(path) else {
            return Ok(());
        };
        let bytes = self.disk.read(path)?.ok_or(Error::Gone)?;
        Self::outside(
            (&mut self.disk, &mut self.notices),
            path,
            doc,
            &bytes,
            actor,
            now,
            None,
        )
    }
    pub fn gone(&mut self, path: &str, state: Gone) -> Result<()> {
        self.gates.check()?;
        if let Some(doc) = self.docs.get_mut(path) {
            doc.gone = Some(state.clone());
            self.notices.push(Notice::Gone {
                path: path.into(),
                state,
            });
        }
        Ok(())
    }
    /// T-COL-03r invokes this only on its mutation lock thread.
    fn save(
        disk: &mut D,
        notices: &mut Vec<Notice>,
        path: &str,
        doc: &mut Document,
        now: u64,
    ) -> Result<()> {
        if doc.readonly || doc.gone.is_some() || doc.dirty_since.is_none() {
            return Ok(());
        }
        let text = doc
            .doc
            .get_or_insert_text("content")
            .get_string(&doc.doc.transact());
        let key = digest(path.as_bytes());
        let record = Record {
            epoch: doc.epoch,
            previous: doc.last_disk,
            previous_text: doc.base.clone(),
            text: text.clone(),
            state: core::state(&doc.doc),
        };
        disk.store_record(key, &record)?;
        let token = disk.swap_text(path, key, text.as_bytes())?;
        if let Some(token) = token {
            // Always leave an inode open until quiet, even if its first read
            // matches base: an in-place writer may still hold it at the swap.
            let bytes = disk.read_displaced(token)?;
            doc.displaced.push(Pending {
                token,
                base: doc.base.clone(),
                expected: doc.last_disk,
                saved: digest(text.as_bytes()),
                observed: digest(&bytes),
                quiet: now,
                deadline: now.saturating_add(2000),
            });
        }
        doc.last_disk = digest(text.as_bytes());
        doc.base = text;
        doc.dirty_since = None;
        doc.saved_at_ms = Some(now);
        disk.own_write(path, doc.last_disk);
        notices.push(Notice::Saved {
            path: path.into(),
            epoch: doc.epoch,
            sv: doc.doc.transact().state_vector().encode_v1(),
            digest: doc.last_disk,
            at_ms: now,
        });
        Ok(())
    }
    /// Timers poll with monotonic milliseconds. The caller runs save jobs on the
    /// shared FIFO lock; the displaced-inode quiet wait does not hold that lock.
    pub fn tick(&mut self, now: u64, saves_allowed: bool) -> Result<()> {
        self.gates.check()?;
        for (path, doc) in &mut self.docs {
            let mut pending = std::mem::take(&mut doc.displaced);
            while let Some(mut p) = pending.pop() {
                let result = (|| {
                    let bytes = self.disk.read_displaced(p.token)?;
                    let observed = digest(&bytes);
                    if observed != p.observed {
                        p.observed = observed;
                        p.quiet = now;
                    }
                    if now >= p.quiet.saturating_add(200) || now >= p.deadline {
                        if observed != p.expected && observed != p.saved {
                            Self::outside(
                                (&mut self.disk, &mut self.notices),
                                path,
                                doc,
                                &bytes,
                                "outside",
                                now,
                                Some(&p.base),
                            )?;
                        }
                        self.disk.remove_displaced(p.token)?;
                        Ok(true)
                    } else {
                        Ok(false)
                    }
                })();
                match result {
                    Ok(true) => (),
                    Ok(false) => doc.displaced.push(p),
                    Err(error) => {
                        doc.displaced.push(p);
                        doc.displaced.extend(pending);
                        return Err(error);
                    }
                }
            }
            let due = doc.dirty_since.is_some_and(|first| {
                now >= doc.updated.saturating_add(200) || now >= first.saturating_add(1000)
            });
            if saves_allowed && (due || doc.closing.is_some_and(|at| now >= at)) {
                Self::save(&mut self.disk, &mut self.notices, path, doc, now)?;
            }
            let editors: Vec<_> = doc
                .activity
                .iter()
                .filter(|(_, at)| now >= **at)
                .map(|(actor, _)| actor.clone())
                .collect();
            for actor in editors {
                doc.activity.remove(&actor);
                self.notices.push(Notice::Activity {
                    path: path.clone(),
                    actor,
                });
            }
        }
        self.docs.retain(|_, doc| {
            !(doc.closing.is_some_and(|at| now >= at)
                && doc.dirty_since.is_none()
                && doc.displaced.is_empty())
        });
        Ok(())
    }
    pub fn flush_all(&mut self, now: u64) -> Result<u16> {
        self.gates.check()?;
        let mut count = 0;
        for (path, doc) in &mut self.docs {
            if !doc.readonly && doc.gone.is_none() {
                Self::save(&mut self.disk, &mut self.notices, path, doc, now)?;
                count += 1;
            }
        }
        Ok(count)
    }
    pub fn all_flushed(&self) -> bool {
        self.docs
            .values()
            .all(|doc| doc.dirty_since.is_none() && doc.displaced.is_empty())
    }
    pub fn reconcile_all(&mut self, actor: &str, now: u64) -> Result<()> {
        self.gates.check()?;
        let paths: Vec<_> = self.docs.keys().cloned().collect();
        for path in paths {
            self.completed_write(&path, actor, now)?;
        }
        Ok(())
    }
}
