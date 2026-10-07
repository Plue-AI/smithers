//! Internal watcher records, mapped to ADR 0004 by the sole dispatcher adapter.
//! These have no encoder, transport, host schema or acknowledgement machinery.
use crate::{
    attrib::{Sample, Window},
    burst::{Burst, Bursts, Key},
    versions::{self, Files, Objects, Version},
};
use sha2::{Digest as _, Sha256};
use std::{collections::BTreeMap, io};

#[derive(Clone, Debug)]
pub struct Closed<A, B, C> {
    pub burst_id: [u8; 16],
    pub actor: Option<A>,
    pub session: Option<u32>,
    pub files: Files<B>,
    pub versions_commit: C,
    pub renamed_to: BTreeMap<String, String>,
    pub last_path: String,
}
#[derive(Clone, Debug)]
pub struct Checkpoint<A, B> {
    pub recorded: BTreeMap<String, Version<B>>,
    pub bursts: Bursts<A, Version<B>>,
    renames: BTreeMap<String, String>,
    identities: Vec<(Key<A>, [u8; 16], Option<Window<A>>)>,
}
impl<A: Clone + Eq, B: Clone> Checkpoint<A, B> {
    pub fn renames(&self) -> &BTreeMap<String, String> {
        &self.renames
    }
    pub fn identities(&self) -> Vec<(Key<A>, [u8; 16])> {
        self.identities
            .iter()
            .map(|(key, id, _)| (key.clone(), *id))
            .collect()
    }
    /// CPU windows cannot be trusted across a daemon restart. Exact Smithers
    /// actors survive; interrupted outside bursts recover as outside.
    pub fn restore(
        recorded: BTreeMap<String, Version<B>>,
        bursts: Bursts<A, Version<B>>,
        identities: Vec<(Key<A>, [u8; 16])>,
        renames: BTreeMap<String, String>,
    ) -> io::Result<Self> {
        let valid = |path: &String| {
            crate::ignore::relative(std::path::Path::new(path)) && !path.contains('\0')
        };
        if recorded.keys().any(|p| !valid(p))
            || bursts
                .pending()
                .iter()
                .any(|b| b.files.keys().any(|p| !valid(p)))
            || renames.iter().any(|(from, to)| {
                !valid(from)
                    || !valid(to)
                    || !bursts
                        .pending()
                        .iter()
                        .any(|b| b.files.contains_key(from) && b.files.contains_key(to))
            })
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if identities.len() != bursts.pending().len()
            || identities.iter().enumerate().any(|(i, (key, id))| {
                !bursts.pending().iter().any(|b| &b.key == key)
                    || identities[..i]
                        .iter()
                        .any(|(k, other)| k == key || other == id)
            })
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(Self {
            recorded,
            bursts,
            renames,
            identities: identities
                .into_iter()
                .map(|(key, id)| (key, id, None))
                .collect(),
        })
    }
}
impl<A: Clone + Eq, B: Clone> Default for Checkpoint<A, B> {
    fn default() -> Self {
        Self {
            recorded: BTreeMap::new(),
            bursts: Bursts::default(),
            renames: BTreeMap::new(),
            identities: vec![],
        }
    }
}
/// All methods execute inside the core's shared FIFO mutation job. Production
/// must supply authenticated actors/session samples, confined reads, the real
/// checkpoint/object provider, and durable outbox. There are no no-op defaults.
pub trait Provider<A>: Objects {
    /// Verify authenticated host/actor/session and daemon identity, codec and
    /// shared lock attachment, and durable checkpoint/outbox/ref/capture and
    /// moved-off providers. This is required even for an empty working copy.
    fn activate(&mut self) -> io::Result<()>;
    /// Only an authenticated, unambiguous binding updates session presence.
    fn actor_session(&mut self, actor: &A) -> io::Result<Option<u32>>;
    fn samples(&mut self) -> io::Result<Vec<Sample<A>>>;
    fn read(&mut self, path: &str) -> io::Result<Option<(Vec<u8>, u32)>>;
    /// Pins all checkpoint blobs and syncs the checkpoint atomically before
    /// success. Recovery reloads through Checkpoint::restore.
    fn checkpoint(&mut self, state: &Checkpoint<A, Self::Blob>) -> io::Result<()>;
    /// Idempotent on burst_id; core pins + syncfs objects BEFORE durable append.
    /// Returning success is a durable receipt, never a transport hint.
    fn append(&mut self, event: &Closed<A, Self::Blob, Self::Commit>) -> io::Result<()>;
    fn hint(
        &mut self,
        path: &str,
        actor: Option<&A>,
        post_digest: Option<[u8; 32]>,
    ) -> io::Result<()>;
    fn where_file(&mut self, session: u32, path: &str) -> io::Result<()>;
    fn moved_off(&mut self) -> io::Result<()>;
    fn snapshot(&mut self) -> io::Result<()>;
    /// Saved document bytes have already reached disk on this mutation lock.
    /// Feed their exact digest before draining the corresponding inotify event.
    fn saved_writes(&mut self) -> Vec<(String, A, [u8; 32])> {
        vec![]
    }
}
pub struct Changes<A, B> {
    pub state: Checkpoint<A, B>,
    own: BTreeMap<String, [u8; 32]>,
    metadata_at: Option<u64>,
    blocked: bool,
    resync_required: bool,
    poisoned: bool,
    samples: Vec<Sample<A>>,
    previous_samples: Vec<Sample<A>>,
}
impl<A: Eq + Clone, B: Eq + Clone> Changes<A, B> {
    pub fn new(state: Checkpoint<A, B>) -> Self {
        let mut own = BTreeMap::new();
        for burst in state.bursts.pending() {
            if matches!(burst.key, Key::Smithers(_)) {
                for (path, file) in &burst.files {
                    if let Some(version) = &file.after {
                        own.insert(path.clone(), version.post_digest);
                    }
                }
            }
        }
        Self {
            state,
            own,
            metadata_at: None,
            blocked: true,
            resync_required: true,
            poisoned: false,
            samples: vec![],
            previous_samples: vec![],
        }
    }
    fn healthy(&self) -> io::Result<()> {
        if self.poisoned {
            Err(io::Error::other(
                "reload watcher checkpoint after IO failure",
            ))
        } else {
            Ok(())
        }
    }
    fn save<P: Provider<A, Blob = B>>(&mut self, p: &mut P) -> io::Result<()> {
        if let Err(e) = p.checkpoint(&self.state) {
            self.poisoned = true;
            return Err(e);
        }
        Ok(())
    }
    /// Baseline sampling precedes external writes, not just the first event.
    /// Keep polling while idle so formatter CPU spent before close is counted.
    pub fn sample<P: Provider<A, Blob = B>>(&mut self, p: &mut P) -> io::Result<()> {
        self.healthy()?;
        match p.samples() {
            Ok(samples) => {
                for (_, _, w) in &mut self.state.identities {
                    if let Some(w) = w {
                        w.observe(&samples);
                    }
                }
                self.previous_samples = std::mem::replace(&mut self.samples, samples);
                Ok(())
            }
            Err(e) => {
                self.blocked = true;
                self.poisoned = true;
                Err(e)
            }
        }
    }
    fn close<P: Provider<A, Blob = B>>(
        &mut self,
        p: &mut P,
        b: &Burst<A, Version<B>>,
    ) -> io::Result<()> {
        let (_, id, window) = self
            .state
            .identities
            .iter()
            .find(|(k, _, _)| k == &b.key)
            .ok_or_else(|| io::Error::other("missing burst identity"))?
            .clone();
        let mut files = b.files.clone();
        let (actor, session) = match &b.key {
            Key::Smithers(a) => (Some(a.clone()), p.actor_session(a)?),
            Key::Outside => match window.and_then(|w| w.actor()) {
                Some((s, a)) => (Some(a), Some(s)),
                None => (None, None),
            },
        };
        if matches!(b.key, Key::Outside) {
            for (path, file) in &mut files {
                file.after = match p.read(path)? {
                    Some((bytes, mode)) => Some(versions::record(p, &bytes, mode)?),
                    None => None,
                };
            }
        }
        files.retain(|_, f| f.before != f.after);
        if files.is_empty() {
            self.state
                .renames
                .retain(|from, to| !b.files.contains_key(from) && !b.files.contains_key(to));
            self.state.identities.retain(|(key, _, _)| key != &b.key);
            return Ok(());
        }
        let recorded_files = files.clone();
        let mut renamed_to = BTreeMap::new();
        for (from, to) in &self.state.renames {
            if files
                .get(from)
                .is_some_and(|f| f.before.is_some() && f.after.is_none())
                && files
                    .get(to)
                    .is_some_and(|f| f.before.is_none() && f.after.is_some())
            {
                let after = files.remove(to).unwrap().after;
                files.get_mut(from).unwrap().after = after;
                renamed_to.insert(from.clone(), to.clone());
            }
        }
        let versions_commit = versions::commit(p, &files)?;
        #[cfg(all(feature = "killpoints", debug_assertions))]
        killpoint("K2");
        p.append(&Closed {
            burst_id: id,
            actor,
            session,
            files: files.clone(),
            versions_commit,
            renamed_to,
            last_path: b.last_path.clone(),
        })?;
        for (path, file) in recorded_files {
            match file.after {
                Some(v) => {
                    self.state.recorded.insert(path, v);
                }
                None => {
                    self.state.recorded.remove(&path);
                }
            }
        }
        if let Some(s) = session {
            p.where_file(s, &b.last_path)?;
        }
        self.state.identities.retain(|(key, _, _)| key != &b.key);
        self.state
            .renames
            .retain(|from, to| !b.files.contains_key(from) && !b.files.contains_key(to));
        Ok(())
    }
    fn close_due<P: Provider<A, Blob = B>>(
        &mut self,
        p: &mut P,
        now: u64,
        next: Option<(&Key<A>, &str)>,
        all: bool,
    ) -> io::Result<()> {
        self.healthy()?;
        let pending = self.state.bursts.pending().len();
        let mut bursts = std::mem::take(&mut self.state.bursts);
        let result = if all {
            bursts.close_all(|b| self.close(p, b))
        } else {
            bursts.before(now, next, |b| self.close(p, b))
        };
        self.state.bursts = bursts;
        if result.is_err() {
            self.poisoned = true;
            return result;
        }
        if self.state.bursts.pending().len() != pending {
            self.save(p)?;
        }
        Ok(())
    }
    pub fn tick<P: Provider<A, Blob = B>>(&mut self, p: &mut P, now: u64) -> io::Result<()> {
        self.sample(p)?;
        self.close_due(p, now, None, false)?;
        if !self.resync_required
            && self
                .metadata_at
                .is_some_and(|t| now.saturating_sub(t) >= 200)
        {
            self.blocked = true;
            p.moved_off()?;
            self.metadata_at = None;
            self.blocked = false;
        }
        Ok(())
    }
    pub fn metadata(&mut self, now: u64) {
        self.metadata_at = Some(now);
        self.blocked = true;
    }
    /// Dispatcher calls drain first, then this, then its confined atomic write.
    pub fn before_write<P: Provider<A, Blob = B>>(
        &mut self,
        p: &mut P,
        now: u64,
        path: &str,
        actor: &A,
    ) -> io::Result<()> {
        self.healthy()?;
        if self.writes_blocked() {
            return Err(io::Error::other("moved-off check required"));
        }
        self.sample(p)?;
        self.close_due(p, now, Some((&Key::Smithers(actor.clone()), path)), false)
    }
    fn touch<P: Provider<A, Blob = B>>(
        &mut self,
        p: &mut P,
        now: u64,
        key: Key<A>,
        path: &str,
        after: Option<Version<B>>,
    ) -> io::Result<()> {
        self.close_due(p, now, Some((&key, path)), false)?;
        let opened = !self.state.identities.iter().any(|(k, _, _)| k == &key);
        if opened {
            let mut id = [0; 16];
            #[cfg(target_os = "linux")]
            {
                let mut offset = 0;
                while offset < id.len() {
                    match rustix::rand::getrandom(
                        &mut id[offset..],
                        rustix::rand::GetRandomFlags::empty(),
                    ) {
                        Ok(0) => return Err(io::Error::other("random source exhausted")),
                        Ok(n) => offset += n,
                        Err(rustix::io::Errno::INTR) => continue,
                        Err(e) => return Err(e.into()),
                    }
                }
            }
            #[cfg(not(target_os = "linux"))]
            return Err(io::ErrorKind::Unsupported.into());
            let window = if matches!(key, Key::Outside) {
                Some(Window::new(if self.previous_samples.is_empty() {
                    &self.samples
                } else {
                    &self.previous_samples
                }))
            } else {
                None
            };
            self.state.identities.push((key.clone(), id, window));
        }
        let before = self.state.recorded.get(path).cloned();
        self.state
            .bursts
            .record(key.clone(), path.into(), before, after.clone());
        if matches!(key, Key::Smithers(_)) {
            match after {
                Some(v) => {
                    self.state.recorded.insert(path.into(), v);
                }
                None => {
                    self.state.recorded.remove(path);
                }
            }
        }
        // Outside recovery compares the complete scan with recorded versions;
        // only its stable open-burst identity needs an eager checkpoint. Own
        // writes update recorded versions immediately and persist every touch.
        if opened || matches!(key, Key::Smithers(_)) {
            self.save(p)?;
        }
        #[cfg(all(feature = "killpoints", debug_assertions))]
        killpoint("K1");
        Ok(())
    }
    pub fn own_write<P: Provider<A, Blob = B>>(
        &mut self,
        p: &mut P,
        now: u64,
        path: &str,
        actor: &A,
        version: Version<B>,
    ) -> io::Result<()> {
        self.touch(
            p,
            now,
            Key::Smithers(actor.clone()),
            path,
            Some(version.clone()),
        )?;
        self.own.insert(path.into(), version.post_digest);
        p.hint(path, Some(actor), Some(version.post_digest))
    }
    pub fn outside<P: Provider<A, Blob = B>>(
        &mut self,
        p: &mut P,
        now: u64,
        path: &str,
    ) -> io::Result<()> {
        self.healthy()?;
        let bytes = p.read(path)?;
        let digest = bytes.as_ref().map(|(b, _)| Sha256::digest(b).into());
        if digest.is_some_and(|d| self.own.get(path) == Some(&d)) {
            return Ok(());
        }
        self.own.remove(path);
        if self.state.recorded.get(path).map(|v| v.post_digest) == digest
            && !self
                .state
                .bursts
                .pending()
                .iter()
                .any(|b| b.files.contains_key(path))
        {
            return Ok(());
        }
        // Outside versions are captured at close, never per event.
        self.touch(p, now, Key::Outside, path, None)?;
        self.sample(p)?;
        let actor = self
            .state
            .identities
            .iter()
            .find(|(k, _, _)| *k == Key::Outside)
            .and_then(|(_, _, w)| w.as_ref())
            .and_then(|w| w.actor())
            .map(|(_, a)| a);
        p.hint(path, actor.as_ref(), digest)
    }
    pub fn rename(&mut self, from: &str, to: &str) {
        // Editor temp-and-rename saves modify the destination. Only a known
        // recorded source moving to a new path is a rename activity entry.
        if let Some(source) = self
            .state
            .renames
            .iter()
            .find(|(_, dest)| dest.as_str() == from)
            .map(|(source, _)| source.clone())
        {
            self.state.renames.insert(source, to.into());
        } else if self.state.recorded.contains_key(from) && !self.state.recorded.contains_key(to) {
            self.state.renames.insert(from.into(), to.into());
        }
    }
    pub fn close_all<P: Provider<A, Blob = B>>(&mut self, p: &mut P) -> io::Result<()> {
        self.sample(p)?;
        self.close_due(p, 0, None, true)
    }
    /// Called after a re-arm scan; includes deletes by unioning recorded paths.
    /// Admission stays blocked until snapshot, durable events and moved-off all
    /// succeed. Recovery uses exactly this path, including interrupted bursts.
    pub fn resync<P: Provider<A, Blob = B>>(
        &mut self,
        p: &mut P,
        now: u64,
        paths: Vec<String>,
    ) -> io::Result<()> {
        self.healthy()?;
        self.begin_resync();
        p.snapshot()?;
        let mut paths: std::collections::BTreeSet<_> = paths.into_iter().collect();
        paths.extend(self.state.recorded.keys().cloned());
        self.samples = p.samples()?;
        self.previous_samples = self.samples.clone();
        for (k, _, w) in &mut self.state.identities {
            if *k == Key::Outside {
                *w = None;
            }
        }
        for path in paths {
            self.outside(p, now, &path)?;
        }
        // Overflow is always outside, regardless of session CPU growth.
        for (k, _, w) in &mut self.state.identities {
            if *k == Key::Outside {
                *w = None;
            }
        }
        self.close_all(p)?;
        self.state
            .bursts
            .reset_clock(now)
            .map_err(io::Error::other)?;
        self.save(p)?;
        p.moved_off()?;
        self.metadata_at = None;
        self.resync_required = false;
        self.blocked = false;
        Ok(())
    }
    pub fn retain_paths(&mut self, paths: &std::collections::BTreeSet<String>) {
        self.state.recorded.retain(|p, _| paths.contains(p));
        self.state.bursts.retain_paths(|p| paths.contains(p));
        self.state
            .identities
            .retain(|(key, _, _)| self.state.bursts.pending().iter().any(|b| &b.key == key));
        self.state
            .renames
            .retain(|from, to| paths.contains(from) && paths.contains(to));
        self.own.retain(|p, _| paths.contains(p));
    }
    pub fn begin_resync(&mut self) {
        self.blocked = true;
        self.resync_required = true;
    }
    pub fn needs_resync(&self) -> bool {
        self.resync_required
    }
    pub fn writes_blocked(&self) -> bool {
        self.blocked || self.resync_required || self.poisoned
    }
}
#[cfg(all(feature = "killpoints", debug_assertions))]
pub(crate) fn killpoint(point: &str) {
    if std::env::var("SMITHERS_MACHINED_KILL_AT").ok().as_deref() == Some(point) {
        std::process::exit(73);
    }
}

/// Encodes the internal close record through the sole ADR 0004 codec. The
/// shared EventSink allocates seq/event_id and owns pinning, syncfs and delivery.
pub fn wire_events(
    event: &Closed<crate::hooks::Actor, crate::hooks::Oid, crate::hooks::Oid>,
) -> Result<Vec<Vec<u8>>, crate::conn::ProtocolError> {
    use crate::conn::{actor_bytes, field, structure_bytes, tagged, Frame, ProtocolError};
    let text = |s: &str| {
        let mut b = (s.len() as u16).to_be_bytes().to_vec();
        b.extend(s.as_bytes());
        b
    };
    // Leave room for the largest actor envelope, seq/id and part metadata.
    const BUDGET: usize = 4 * 1024 * 1024 - 2048;
    let mut groups: Vec<Vec<Vec<u8>>> = vec![vec![]];
    let mut size = 0;
    for (path, file) in &event.files {
        let renamed = event.renamed_to.get(path);
        let change = if renamed.is_some() {
            4
        } else if file.before.is_none() {
            1
        } else if file.after.is_none() {
            3
        } else {
            2
        };
        let mut fields = vec![field(1, text(path)), field(2, [change])];
        if let Some(to) = renamed {
            fields.push(field(3, text(to)));
        }
        if let Some(v) = &file.before {
            fields.push(field(4, v.blob));
        }
        if let Some(v) = &file.after {
            fields.push(field(5, v.blob));
            fields.push(field(6, v.post_digest));
        }
        let encoded = structure_bytes(&fields);
        if size + encoded.len() > BUDGET || groups.last().unwrap().len() == u16::MAX as usize {
            groups.push(vec![]);
            size = 0;
        }
        size += encoded.len();
        groups.last_mut().unwrap().push(encoded);
    }
    let parts = u16::try_from(groups.len()).map_err(|_| ProtocolError::BadValue)?;
    let actor = event
        .actor
        .as_ref()
        .unwrap_or(&crate::hooks::Actor::Outside);
    groups
        .into_iter()
        .enumerate()
        .map(|(i, group)| {
            let mut files = (group.len() as u16).to_be_bytes().to_vec();
            for f in group {
                files.extend(f);
            }
            let mut fields = vec![
                field(1, event.burst_id),
                field(2, actor_bytes(actor)),
                field(3, files),
                field(4, event.versions_commit),
            ];
            if parts > 1 {
                fields.push(field(5, (i as u16 + 1).to_be_bytes()));
                fields.push(field(6, parts.to_be_bytes()));
            }
            let event = tagged(1, &fields);
            Frame {
                kind: 2,
                stream: 0,
                payload: tagged(
                    1,
                    &[
                        field(1, 1u64.to_be_bytes()),
                        field(2, [0; 16]),
                        field(3, &event),
                    ],
                ),
            }
            .encode()?;
            Ok(event)
        })
        .collect()
}
