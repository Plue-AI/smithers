//! Documents on the daemon mutation executor. Network sends stay outside it.
use super::{
    disk::Disk,
    gone::Gone,
    host::{Host, Notice},
    state::digest,
    Error,
};
use crate::{
    conn::Frame,
    document_payload::Document,
    hooks::{self, Actor, Base, BatchFailure, DocumentBatch, DocumentWrite, Documents, FileWrite},
    lock::LockCx,
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use yrs::{
    sync::SyncMessage,
    updates::{decoder::Decode, encoder::Encode},
};

pub struct Service<D: Disk> {
    inner: Mutex<State<D>>,
    clock: Arc<dyn hooks::Clock>,
    started: std::time::Instant,
    unix_ms: u64,
}
struct Peer {
    path: String,
    seq: u64,
    last: Option<[u8; 32]>,
}
struct State<D: Disk> {
    host: Host<D>,
    peers: BTreeMap<u32, Peer>,
    output: VecDeque<Frame>,
    notices: Vec<Notice>,
    awareness_clocks: BTreeMap<(u32, u64), u32>,
}
fn error(e: Error) -> hooks::Error {
    hooks::Error {
        code: match e {
            Error::Unsupported => 2,
            Error::Invalid => 1,
            Error::Forged => 11,
            Error::Epoch | Error::Stale => 4,
            Error::ReadOnly => 7,
            Error::Gone => 5,
            Error::Io(_) => 12,
            Error::Provider(error) => return error,
        },
        ..hooks::Error::unsupported()
    }
}
// Principal envelopes are opaque bytes. A reversible key must not use lossy
// UTF-8 or confuse a binary reference with another actor's displayed name.
fn principal_key(bytes: &[u8]) -> hooks::Result<String> {
    if bytes.is_empty() || bytes.len() > 1024 {
        return Err(error(Error::Invalid));
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn actor(a: &Actor) -> hooks::Result<String> {
    Ok(match a {
        Actor::Principal(bytes) => principal_key(bytes)?,
        Actor::Session(id) => format!("session:{id}"),
        Actor::Run(id) => format!("run:{id}"),
        Actor::Outside => "outside".into(),
    })
}
fn frame(stream: u32, d: Document) -> hooks::Result<Frame> {
    Ok(Frame {
        kind: 4,
        stream,
        payload: d.encode_v2().map_err(|_| error(Error::Invalid))?,
    })
}
impl<D: Disk> Service<D> {
    pub fn new(host: Host<D>, clock: Arc<dyn hooks::Clock>) -> Self {
        let started = clock.mono();
        let unix_ms = clock
            .now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self {
            started,
            unix_ms,
            inner: Mutex::new(State {
                host,
                peers: BTreeMap::new(),
                output: VecDeque::new(),
                notices: vec![],
                awareness_clocks: BTreeMap::new(),
            }),
            clock,
        }
    }
    fn now(&self) -> u64 {
        self.unix_ms.saturating_add(
            self.clock
                .mono()
                .saturating_duration_since(self.started)
                .as_millis() as u64,
        )
    }
    fn state(&self) -> hooks::Result<std::sync::MutexGuard<'_, State<D>>> {
        self.inner
            .lock()
            .map_err(|_| error(Error::Io("document lock poisoned".into())))
    }
    /// The branch-files adapter reads the same state that issued stream receipts.
    pub fn projections(&self, _cx: &mut LockCx) -> hooks::Result<Vec<super::host::Projection>> {
        let s = self.state()?;
        s.host.ready().map_err(error)?;
        s.host
            .paths()
            .iter()
            .map(|path| s.host.projection(path).map_err(error))
            .collect()
    }
    /// The watcher/files adapter consumes saved, gone, activity and outside
    /// receipts under LockCx. Stream delivery must not consume these receipts.
    pub fn take_notices(&self, _cx: &mut LockCx) -> hooks::Result<Vec<Notice>> {
        let mut s = self.state()?;
        s.collect()?;
        Ok(std::mem::take(&mut s.notices))
    }
}
impl<D: Disk> State<D> {
    fn collect(&mut self) -> hooks::Result<()> {
        for notice in self.host.notices() {
            match &notice {
                Notice::Saved {
                    path,
                    epoch: _,
                    sv,
                    at_ms,
                    ..
                } => {
                    for (&id, peer) in &self.peers {
                        if &peer.path == path {
                            self.output.push_back(frame(
                                id,
                                Document {
                                    msg: 6,
                                    at_ms: *at_ms,
                                    through_seq: peer.seq,
                                    data: sv.clone(),
                                    ..Default::default()
                                },
                            )?);
                        }
                    }
                }
                Notice::Gone { path, state } => {
                    let (kind, by, to) = match state {
                        Gone::Deleted { by } => (1, by.clone(), String::new()),
                        Gone::Renamed { by, to } => (2, by.clone(), to.clone()),
                    };
                    for (&id, peer) in &self.peers {
                        if &peer.path == path {
                            self.output.push_back(frame(
                                id,
                                Document {
                                    msg: 7,
                                    gone_kind: kind,
                                    gone_by: by.clone(),
                                    gone_to: to.clone(),
                                    ..Default::default()
                                },
                            )?);
                        }
                    }
                }
                _ => (),
            }
            self.notices.push(notice);
        }
        Ok(())
    }
    fn broadcast(&mut self, path: &str) -> hooks::Result<()> {
        for id in self.host.streams_for(path) {
            self.output.push_back(frame(
                id,
                Document {
                    msg: 3,
                    data: SyncMessage::Update(self.host.state(id).map_err(error)?).encode_v1(),
                    ..Default::default()
                },
            )?);
        }
        Ok(())
    }
}
impl<D: Disk> Documents for Service<D> {
    fn text(&self, stream: u32) -> hooks::Result<String> {
        self.state()?.host.text(stream).map_err(error)
    }
    fn disconnected(&self) -> hooks::Result<()> {
        let streams: Vec<_> = self.state()?.peers.keys().copied().collect();
        for stream in streams {
            self.close(stream)?;
        }
        // No awareness removals or saved frames may cross into the successor
        // transport under the dead host's stream ids. Durable notices remain.
        self.state()?.output.clear();
        Ok(())
    }
    fn ready(&self) -> hooks::Result<()> {
        self.state()?.host.ready().map_err(error)
    }
    fn open_authenticated(&self, path: &str, by: &[u8]) -> hooks::Result<u32> {
        let key = principal_key(by)?;
        let by = key.as_str();
        if by.is_empty() {
            return Err(error(Error::Forged));
        }
        let mut epoch = [0; 16];
        getrandom::fill(&mut epoch).map_err(|_| error(Error::Io("entropy".into())))?;
        let mut s = self.state()?;
        let id = s.host.open(path, epoch, self.now()).map_err(error)?;
        let epoch = s.host.epoch(id).map_err(error)?;
        // The host allocates browser ids. This id belongs only to its peer.
        let client = match s.host.client(id, by, self.now()) {
            Ok(client) => client as u32,
            Err(Error::ReadOnly) => 1,
            Err(e) => {
                let _ = s.host.close(id, self.now());
                return Err(error(e));
            }
        };
        s.peers.insert(
            id,
            Peer {
                path: path.into(),
                seq: 0,
                last: None,
            },
        );
        s.output.push_back(frame(
            id,
            Document {
                msg: 5,
                epoch,
                client_id: client,
                ..Default::default()
            },
        )?);
        s.collect()?;
        Ok(id)
    }
    fn close(&self, stream: u32) -> hooks::Result<()> {
        let mut s = self.state()?;
        let path = s
            .peers
            .get(&stream)
            .ok_or_else(|| error(Error::Invalid))?
            .path
            .clone();
        let clients = s
            .awareness_clocks
            .iter()
            .filter(|((id, _), _)| *id == stream)
            .map(|((_, client), clock)| {
                (
                    yrs::ClientID::new(*client),
                    yrs::sync::awareness::AwarenessUpdateEntry {
                        clock: clock.saturating_add(1),
                        json: "null".into(),
                    },
                )
            })
            .collect();
        let removal = yrs::sync::AwarenessUpdate { clients };
        s.host.close(stream, self.now()).map_err(error)?;
        s.peers.remove(&stream);
        s.awareness_clocks.retain(|(id, _), _| *id != stream);
        s.output.retain(|f| f.stream != stream);
        if !removal.clients.is_empty() {
            for id in s.host.streams_for(&path) {
                s.output.push_back(frame(
                    id,
                    Document {
                        msg: 4,
                        data: removal.encode_v1(),
                        ..Default::default()
                    },
                )?);
            }
        }
        Ok(())
    }
    fn frame(&self, f: &Frame) -> hooks::Result<Frame> {
        let input = Document::decode_v2(&f.payload).map_err(|_| error(Error::Invalid))?;
        let mut s = self.state()?;
        s.collect()?;
        let peer = s
            .peers
            .get(&f.stream)
            .ok_or_else(|| error(Error::Invalid))?;
        let document_path = peer.path.clone();
        if input.msg == 2 {
            if input.data.len() > 64 * 1024 {
                return Err(error(Error::Invalid));
            }
            let update = yrs::sync::AwarenessUpdate::decode_v1(&input.data)
                .map_err(|_| error(Error::Invalid))?;
            if update.clients.len() != 1 || update.encode_v1() != input.data {
                return Err(error(Error::Invalid));
            }
            let (client, entry) = update.clients.iter().next().unwrap();
            let key = principal_key(&input.actor)?;
            let by = key.as_str();
            let value: serde_json::Value =
                serde_json::from_str(&entry.json).map_err(|_| error(Error::Invalid))?;
            let (colour, line) = if value.is_null() {
                ("", None)
            } else {
                let object = value.as_object().ok_or_else(|| error(Error::Invalid))?;
                if object
                    .keys()
                    .any(|k| !matches!(k.as_str(), "actor" | "colour" | "line" | "anchor" | "head"))
                    || value["actor"]["id"].as_str() != Some(by)
                    || ["anchor", "head"].iter().any(|key| {
                        object
                            .get(*key)
                            .is_some_and(|v| !valid_relative_position(v))
                    })
                {
                    return Err(error(Error::Forged));
                }
                let colour = value["colour"]
                    .as_str()
                    .ok_or_else(|| error(Error::Invalid))?;
                let line = match object.get("line") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(line) if line.is_u64() => {
                        let n = line
                            .as_u64()
                            .and_then(|n| u32::try_from(n).ok())
                            .ok_or_else(|| error(Error::Invalid))?;
                        Some((document_path.as_str(), n))
                    }
                    Some(line) => {
                        let path = line["path"].as_str().ok_or_else(|| error(Error::Invalid))?;
                        let n = line["line"]
                            .as_u64()
                            .and_then(|n| u32::try_from(n).ok())
                            .ok_or_else(|| error(Error::Invalid))?;
                        Some((path, n))
                    }
                };
                (colour, line)
            };
            let path = peer.path.clone();
            let key = (f.stream, client.get());
            if s.awareness_clocks
                .get(&key)
                .is_some_and(|clock| *clock >= entry.clock)
            {
                return frame(
                    f.stream,
                    Document {
                        msg: 4,
                        data: input.data,
                        ..Default::default()
                    },
                );
            }
            s.host
                .peer_awareness(f.stream, client.get(), by, colour, line)
                .map_err(error)?;
            s.awareness_clocks.insert(key, entry.clock);
            for id in s.host.streams_for(&path) {
                if id != f.stream {
                    s.output.push_back(frame(
                        id,
                        Document {
                            msg: 4,
                            data: input.data.clone(),
                            ..Default::default()
                        },
                    )?);
                }
            }
            return frame(
                f.stream,
                Document {
                    msg: 4,
                    data: input.data,
                    ..Default::default()
                },
            );
        }
        if input.msg != 1 {
            return Err(error(Error::Invalid));
        }
        let message = SyncMessage::decode_v1(&input.data).map_err(|_| error(Error::Invalid))?;
        if !matches!(&message, SyncMessage::SyncStep1(_)) && message.encode_v1() != input.data {
            return Err(error(Error::Invalid));
        }
        if matches!(&message, SyncMessage::SyncStep1(_)) && !valid_sync_step1(&input.data) {
            return Err(error(Error::Invalid));
        }
        let key = principal_key(&input.actor)?;
        let by = key.as_str();
        match message {
            SyncMessage::SyncStep1(sv) => {
                let epoch = s.host.epoch(f.stream).map_err(error)?;
                let replies = s
                    .host
                    .sync_message(f.stream, epoch, by, SyncMessage::SyncStep1(sv), self.now())
                    .map_err(error)?;
                frame(
                    f.stream,
                    Document {
                        msg: 3,
                        data: replies[0].encode_v1(),
                        ..Default::default()
                    },
                )
            }
            SyncMessage::SyncStep2(bytes) | SyncMessage::Update(bytes) => {
                let fingerprint = digest(&f.payload);
                if input.seq == 0 && peer.seq != 0 {
                    return Err(error(Error::Forged));
                }
                if input.seq != 0
                    && (input.seq < peer.seq
                        || (input.seq == peer.seq && peer.last != Some(fingerprint)))
                {
                    return Err(error(Error::Forged));
                }
                #[cfg(all(feature = "killpoints", debug_assertions))]
                let before = s.host.current_digest(&peer.path);
                s.host
                    .peer_update(f.stream, by, &bytes, self.now())
                    .map_err(error)?;
                #[cfg(all(feature = "killpoints", debug_assertions))]
                let text_changed = before != s.host.current_digest(&s.peers[&f.stream].path);
                if input.seq != 0 {
                    s.host
                        .require_receipt(f.stream, self.now())
                        .map_err(error)?;
                    let peer = s.peers.get_mut(&f.stream).unwrap();
                    peer.seq = input.seq;
                    peer.last = Some(fingerprint);
                }
                let path = s.peers[&f.stream].path.clone();
                for id in s.host.streams_for(&path) {
                    if id != f.stream {
                        s.output.push_back(frame(
                            id,
                            Document {
                                msg: 3,
                                data: SyncMessage::Update(bytes.clone()).encode_v1(),
                                ..Default::default()
                            },
                        )?);
                    }
                }
                // No save acknowledgment here: only flush/tick can issue one.
                #[cfg(all(feature = "killpoints", debug_assertions))]
                if input.seq != 0 && text_changed {
                    crate::events::DOCUMENT_EDITED
                        .store(true, std::sync::atomic::Ordering::Release);
                    crate::events::killpoint("K7a");
                }
                frame(
                    f.stream,
                    Document {
                        msg: 3,
                        data: SyncMessage::Update(bytes).encode_v1(),
                        ..Default::default()
                    },
                )
            }
        }
    }
    fn flush_all(&self, _cx: &mut LockCx) -> hooks::Result<u16> {
        let mut s = self.state()?;
        let count = s.host.flush_all(self.now()).map_err(error)?;
        s.collect()?;
        Ok(count)
    }
    fn reconcile_all(&self, _cx: &mut LockCx, by: &Actor) -> hooks::Result<()> {
        let mut s = self.state()?;
        s.host
            .reconcile_all(&actor(by)?, self.now())
            .map_err(error)?;
        for path in s.host.paths() {
            s.broadcast(&path)?;
        }
        s.collect()
    }
    fn write_through(
        &self,
        _cx: &mut LockCx,
        path: &str,
        base: &Base,
        bytes: &[u8],
        by: &Actor,
    ) -> Option<hooks::Result<DocumentWrite>> {
        Some(
            self.write_batch(
                _cx,
                &[FileWrite {
                    path: path.into(),
                    base: base.clone(),
                    content: Some(bytes.into()),
                }],
                by,
            )
            .and_then(|mut result| {
                if let Some(failure) = result.failure {
                    return Err(failure.error);
                }
                result.writes.pop().ok_or_else(hooks::Error::unsupported)
            }),
        )
    }
    fn write_batch(
        &self,
        _cx: &mut LockCx,
        changes: &[FileWrite],
        by: &Actor,
    ) -> hooks::Result<DocumentBatch> {
        let mut s = self.state()?;
        s.host.ready().map_err(error)?;
        let by = actor(by)?;
        if changes.is_empty() || changes.len() > 256 {
            return Err(error(Error::Invalid));
        }
        let mut paths = std::collections::BTreeSet::new();
        let mut bytes = 0usize;
        for change in changes {
            if !super::disk::valid_path(&change.path) || !paths.insert(change.path.as_str()) {
                return Err(error(Error::Invalid));
            }
            let content = change.content.as_deref().unwrap_or_default();
            bytes = bytes
                .checked_add(content.len())
                .ok_or_else(|| error(Error::Invalid))?;
            if bytes > super::MAX_TEXT_BYTES || std::str::from_utf8(content).is_err() {
                return Err(error(Error::ReadOnly));
            }
        }
        for path in &paths {
            for (at, _) in path.match_indices('/') {
                if paths.contains(&path[..at]) {
                    return Err(error(Error::Invalid));
                }
            }
        }
        let mut result = DocumentBatch::default();
        let mut prepared = Vec::with_capacity(changes.len());
        let mut cost = 0usize;
        for (index, change) in changes.iter().enumerate() {
            match s.host.prepare_write(&change.path, &change.base, self.now()) {
                Ok(snapshot) => {
                    cost = cost.saturating_add(snapshot.cost);
                    // Bound retained CRDT snapshots as well as request bytes.
                    if cost > super::MAX_STATE_BYTES {
                        return Err(hooks::Error {
                            code: 8,
                            limit: Some(super::MAX_STATE_BYTES as u32),
                            ..hooks::Error::unsupported()
                        });
                    }
                    prepared.push(snapshot);
                }
                Err(e) => {
                    result.failure = Some(BatchFailure {
                        index,
                        error: error(e),
                        preflight: true,
                    });
                    return Ok(result);
                }
            }
        }
        // A metadata refusal must precede document activation: a dirty document
        // left by application can otherwise save later despite a failed RPC.
        for (index, change) in changes.iter().enumerate() {
            if let Err(e) = s.host.admit_write(&change.path, &by) {
                result.failure = Some(BatchFailure {
                    index,
                    error: error(e),
                    preflight: true,
                });
                return Ok(result);
            }
        }
        for (index, (snapshot, change)) in prepared.into_iter().zip(changes).enumerate() {
            let current = snapshot.current;
            let written = (|| {
                let open = s.host.activate_write(snapshot, self.now()).map_err(error)?;
                let (digest, raced) = if let Some(content) = &change.content {
                    let text = std::str::from_utf8(content).map_err(|_| error(Error::Invalid))?;
                    let (digest, raced) = s
                        .host
                        .write_saved(&change.path, current, text, &by, self.now())
                        .map_err(error)?
                        .ok_or_else(hooks::Error::unsupported)?;
                    if open {
                        s.broadcast(&change.path)?;
                    }
                    (Some(digest), raced)
                } else {
                    (
                        None,
                        s.host
                            .delete_saved(&change.path, &by, self.now())
                            .map_err(error)?,
                    )
                };
                s.collect()?;
                Ok(DocumentWrite { digest, raced })
            })();
            match written {
                Ok(write) => result.writes.push(write),
                Err(error) => {
                    result.failure = Some(BatchFailure {
                        index,
                        error,
                        preflight: false,
                    });
                    break;
                }
            }
        }
        Ok(result)
    }

    fn completed_write(&self, _cx: &mut LockCx, path: &str, by: &Actor) -> hooks::Result<()> {
        let mut s = self.state()?;
        s.host
            .completed_write(path, &actor(by)?, self.now())
            .map_err(error)?;
        s.broadcast(path)?;
        s.collect()
    }
    fn gone(&self, _cx: &mut LockCx, path: &str, gone: Gone) -> hooks::Result<()> {
        let mut s = self.state()?;
        s.host.gone(path, gone).map_err(error)?;
        s.collect()
    }
    fn tick(&self, cx: &mut LockCx) -> hooks::Result<()> {
        let mut s = self.state()?;
        let before: Vec<_> = s
            .host
            .paths()
            .into_iter()
            .map(|p| {
                let d = s.host.current_digest(&p);
                (p, d)
            })
            .collect();
        s.host
            .tick(self.now(), !cx.rewrite_pending)
            .map_err(error)?;
        for (path, old) in before {
            if s.host.current_digest(&path) != old {
                s.broadcast(&path)?;
            }
        }
        s.collect()
    }
    fn poll(&self, cx: &mut LockCx) -> hooks::Result<Vec<Frame>> {
        if let Err(error) = self.tick(cx) {
            // Metadata changes temporarily bar writes until the existing
            // watcher settles its moved-off check. Keep the stream and queued
            // edits alive; a later tick retries without issuing a save receipt.
            if error.code != 3 || error.detail.as_deref() != Some("moved-off check required") {
                return Err(error);
            }
        }
        Ok(self.state()?.output.drain(..).collect())
    }
    fn all_flushed(&self) -> bool {
        self.state().is_ok_and(|s| s.host.all_flushed())
    }
}

// State vectors are maps: Yrs may encode their entries in a different order
// from Yjs. Validate canonical integers and exhaustion in the received order,
// rather than requiring a hash-map iteration order to match the browser.
fn valid_sync_step1(data: &[u8]) -> bool {
    use yrs::encoding::{
        read::{Cursor, Read},
        write::Write,
    };
    let validate = || -> std::result::Result<bool, yrs::encoding::read::Error> {
        if data.first() != Some(&0) {
            return Ok(false);
        }
        let mut outer = Cursor::new(&data[1..]);
        let vector = outer.read_buf()?.to_vec();
        if outer.has_content() {
            return Ok(false);
        }
        let mut encoded = vec![0];
        encoded.write_buf(&vector);
        if encoded != data {
            return Ok(false);
        }
        let mut cursor = Cursor::new(&vector);
        let count: u32 = cursor.read_var()?;
        if count as usize > vector.len() {
            return Ok(false);
        }
        let mut clients = std::collections::BTreeSet::new();
        let mut canonical = vec![];
        canonical.write_var(count);
        for _ in 0..count {
            let client: u32 = cursor.read_var()?;
            let clock: u32 = cursor.read_var()?;
            if !clients.insert(client) {
                return Ok(false);
            }
            canonical.write_var(client);
            canonical.write_var(clock);
        }
        Ok(!cursor.has_content() && canonical == vector)
    };
    validate().unwrap_or(false)
}

// Relative positions are bounded presentation data. They never choose a path,
// actor, client assignment or execution identity.
fn valid_relative_position(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| match key.as_str() {
        "tname" => value.as_str().is_some(),
        "assoc" => value.as_i64().is_some_and(|v| i32::try_from(v).is_ok()),
        "type" | "item" => value.as_object().is_some_and(|id| {
            id.len() == 2
                && id
                    .get("client")
                    .and_then(|v| v.as_u64())
                    .is_some_and(|v| v <= 0xffff_ffff)
                && id
                    .get("clock")
                    .and_then(|v| v.as_u64())
                    .is_some_and(|v| v <= 9_007_199_254_740_991)
        }),
        _ => false,
    })
}

#[cfg(test)]
mod sync_vector_tests {
    use super::valid_sync_step1;

    #[test]
    fn browser_vectors_accept_both_orders_but_refuse_malformed_maps() {
        for vector in [
            &[0, 5, 2, 1, 2, 3, 4][..],
            &[0, 5, 2, 3, 4, 1, 2],
            &[0, 1, 0],
        ] {
            assert!(valid_sync_step1(vector), "{vector:?}");
        }
        for vector in [
            &[][..],
            &[1, 1, 0],
            &[0, 5, 2, 1, 2, 1, 4],    // duplicate client
            &[0, 6, 2, 1, 2, 3, 4, 0], // trailing vector data
            &[0, 1, 0, 0],             // trailing frame data
            &[0, 2, 0x80, 0],          // nonminimal count
            &[0, 4, 1, 0x81, 0, 2],    // nonminimal client
            &[0, 4, 1, 1, 0x82, 0],    // nonminimal clock
            &[0, 1, 2],                // truncated entries
            &[0, 0x81, 0, 0],          // nonminimal vector length
        ] {
            assert!(!valid_sync_step1(vector), "{vector:?}");
        }
    }
}
