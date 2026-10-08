//! Injectable lock-thread services. Defaults never touch a workspace or broker.
use crate::{conn::Frame, lock::LockCx};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
pub type Oid = [u8; 20];
pub type Digest = [u8; 32];
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Actor {
    Principal(Vec<u8>),
    Session(u32),
    Run(String),
    Outside,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Base {
    Digest(Digest),
    Absent,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: u8,
    pub detail: Option<String>,
    pub current_digest: Option<Digest>,
    pub session: Option<u32>,
    pub limit: Option<u32>,
    pub protocol: Option<crate::conn::ProtocolError>,
    pub oids: Option<Vec<Oid>>,
}
impl Error {
    pub fn unsupported() -> Self {
        Self {
            code: 2,
            detail: None,
            current_digest: None,
            session: None,
            limit: None,
            protocol: None,
            oids: None,
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub trait Watcher: Send + Sync {
    /// Observe quiet state after draining kernel events, on the mutation lock.
    fn idle(&self, _cx: &mut LockCx) -> Result<bool> {
        Err(Error::unsupported())
    }
    /// Report readiness only after this provider's real dependencies are ready.
    /// Implementing an operation alone must not activate a partial daemon.
    fn ready(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Keep a file RPC in FIFO while external metadata reaches its debounce.
    /// No working-copy mutation is retried or admitted through the barrier.
    fn prepare_write(&self, _cx: &mut LockCx) -> Result<()> {
        Ok(())
    }
    fn before_write(&self, _path: &str, _actor: &Actor) -> Result<()> {
        Err(Error::unsupported())
    }
    fn drain(&self, _cx: &mut LockCx) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Settle metadata produced by our completed rewrite while sessions remain
    /// frozen, so queued saves do not hit the outside-move debounce barrier.
    fn settle_rewrite(&self, _cx: &mut LockCx) -> Result<()> {
        Ok(())
    }
    fn close_bursts(&self, _cx: &mut LockCx) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Called on the FIFO mutation lock with the exact saved bytes and mode.
    /// Persist their version before returning; never reread the working copy.
    fn after_write(&self, _path: &str, _actor: &Actor, _bytes: &[u8], _mode: u32) -> Result<()> {
        Err(Error::unsupported())
    }
    fn after_delete(&self, _path: &str, _actor: &Actor) -> Result<()> {
        Err(Error::unsupported())
    }
    fn resync(&self, _cx: &mut LockCx) -> Result<()> {
        Err(Error::unsupported())
    }
    fn burst_open(&self) -> bool {
        false
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentWrite {
    /// None is a durably recorded deletion.
    pub digest: Option<Digest>,
    pub raced: Option<Digest>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileWrite {
    pub path: String,
    pub base: Base,
    /// None deletes; Some(empty) writes an empty file.
    pub content: Option<Vec<u8>>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchFailure {
    pub index: usize,
    pub error: Error,
    pub preflight: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentBatch {
    /// In input order; only writes with durable version receipts appear here.
    pub writes: Vec<DocumentWrite>,
    pub failure: Option<BatchFailure>,
}
pub trait Documents: Send + Sync {
    /// Continues saving after a host disconnect; called by the lock executor.
    fn tick(&self, _cx: &mut LockCx) -> Result<()> {
        Ok(())
    }
    /// Runs timers and drains output on the same mutation lock as RPCs.
    fn poll(&self, _cx: &mut LockCx) -> Result<Vec<Frame>> {
        Ok(vec![])
    }
    fn completed_write(&self, _cx: &mut LockCx, _path: &str, _actor: &Actor) -> Result<()> {
        Err(Error::unsupported())
    }
    fn gone(&self, _cx: &mut LockCx, _path: &str, _gone: crate::doc::gone::Gone) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Report readiness only after this provider's real dependencies are ready.
    /// Implementing an operation alone must not activate a partial daemon.
    fn ready(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Persist every open document before capture; return the number flushed.
    fn flush_all(&self, _cx: &mut LockCx) -> Result<u16> {
        Err(Error::unsupported())
    }
    /// None means the path is not open. Some(Err(_)) must never fall back to disk.
    fn write_through(
        &self,
        _cx: &mut LockCx,
        _path: &str,
        _base: &Base,
        _content: &[u8],
        _actor: &Actor,
    ) -> Option<Result<DocumentWrite>> {
        None
    }
    /// Compare every base before activating any document. Late outside races
    /// retain their bytes; an I/O failure preserves earlier applied receipts.
    fn write_batch(
        &self,
        _cx: &mut LockCx,
        _changes: &[FileWrite],
        _actor: &Actor,
    ) -> Result<DocumentBatch> {
        Err(Error::unsupported())
    }
    /// Reconcile open documents after a settled rewrite, on the mutation lock.
    fn reconcile_all(&self, _cx: &mut LockCx, _actor: &Actor) -> Result<()> {
        Err(Error::unsupported())
    }
    /// S3 opens bind the host-resolved principal before accepting stream updates.
    /// A legacy path-only implementation cannot activate authenticated documents.
    fn open_authenticated(&self, _path: &str, _actor: &[u8]) -> Result<u32> {
        Err(Error::unsupported())
    }
    fn close(&self, _stream: u32) -> Result<()> {
        Err(Error::unsupported())
    }
    fn frame(&self, _frame: &Frame) -> Result<Frame> {
        Err(Error::unsupported())
    }
    fn all_flushed(&self) -> bool {
        true
    }
}
pub trait Sessions: Send + Sync {
    /// A newly authenticated host needs a snapshot even without session moves.
    fn reset_presence(&self) -> Result<()> {
        Ok(())
    }
    fn disconnected(&self) -> Result<()> {
        Ok(())
    }
    /// Drain bounded nonblocking descriptor output on the mutation lock. A
    /// missing supervisor emits nothing and retains unsupported readiness.
    fn poll(&self) -> Result<Vec<Frame>> {
        Ok(vec![])
    }
    /// Report readiness only after this provider's real dependencies are ready.
    /// Implementing an operation alone must not activate a partial daemon.
    fn ready(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    fn call(&self, _method: u8, _arguments: &[u8]) -> Result<Vec<u8>> {
        Err(Error::unsupported())
    }
    fn frame(&self, _frame: &Frame) -> Result<Option<Frame>> {
        Err(Error::unsupported())
    }
    /// Drain only this local socket's stream. Never implement this by draining
    /// `poll`: that would consume output belonging to the authenticated host.
    fn poll_local(&self, _session: u32) -> Result<Vec<Frame>> {
        Err(Error::unsupported())
    }
    /// Agent-local admission uses the kernel-observed cgroup, not request user
    /// or run fields. The broker must inherit its registered run atomically.
    fn open_local(&self, _caller_cgroup: &str, _arguments: &[u8]) -> Result<Vec<u8>> {
        Err(Error::unsupported())
    }
    fn admission_of_cgroup(&self, _cgroup: &str) -> Option<crate::broker::sessions::Admission> {
        None
    }
    fn live(&self) -> Vec<u32> {
        vec![]
    }
    /// Attributed writes use the authenticated session sink; missing sinks refuse.
    fn where_file(&self, _session: u32, _path: &str) -> Result<()> {
        Err(Error::unsupported())
    }
    fn last_path(&self, _session: u32) -> Option<String> {
        None
    }
}
pub trait Broker: Send + Sync {
    /// Report readiness only after this provider's real dependencies are ready.
    /// Implementing an operation alone must not activate a partial daemon.
    fn ready(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Full roster from the authenticated host, before ready and on changes.
    fn set_roster(&self, _members: &[crate::broker::sessions::User]) -> Result<()> {
        Err(Error::unsupported())
    }
    fn freeze(&self, _timeout: Duration) -> Result<Option<u32>> {
        Err(Error::unsupported())
    }
    fn thaw(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    fn kill_sessions(&self, _sessions: Option<&[u32]>) -> Result<u16> {
        Err(Error::unsupported())
    }
}
pub trait EventSink: Send + Sync {
    /// Diagnostic observations use the production mutation/outbox boundaries.
    fn rebase_started(&self, _onto: Oid, _request: u32) {}
    fn rebase_finished(&self, _failed: bool) {}
    /// Fault builds observe completed socket writes, never queued frames.
    #[cfg(all(feature = "killpoints", debug_assertions))]
    fn sent(&self, _frame: &Frame) {}
    /// Monotonic durable burst-close generation; capture events do not count.
    fn burst_generation(&self) -> u64 {
        0
    }
    /// Discard incomplete transport input; never discard durable events.
    fn disconnected(&self) -> Result<()> {
        Ok(())
    }
    /// Certify that every durable entry has a host receipt. Read the real
    /// outbox, including recovered entries; an unavailable store is not empty.
    /// Called on the mutation executor without waiting for network IO.
    fn drained(&self) -> Result<bool> {
        Err(Error::unsupported())
    }
    fn presence(&self, _payload: &[u8]) -> Result<()> {
        Err(Error::unsupported())
    }
    /// The authenticated link owns reconnect and receipts; append never waits
    /// for a network write on the mutation executor.
    fn reconnect(&self) -> Result<()> {
        Ok(())
    }
    fn poll(&self) -> Result<Vec<Frame>> {
        Ok(vec![])
    }
    fn frame(&self, _frame: &Frame) -> Result<Option<Frame>> {
        Err(Error::unsupported())
    }
    /// Report readiness only after this provider's real dependencies are ready.
    /// Implementing an operation alone must not activate a partial daemon.
    fn ready(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    fn append(&self, _event: &[u8], _pin: Option<Oid>) -> Result<(u64, [u8; 16])> {
        Err(Error::unsupported())
    }
    fn hint(&self, _hint: &[u8]) -> Result<()> {
        Err(Error::unsupported())
    }
}
pub trait Core: Send + Sync {
    /// Daily/size-triggered repository cleanup, under the mutation lock.
    fn maintain(&self, _cx: &mut LockCx) -> Result<()> {
        Ok(())
    }
    /// Runs on the mutation thread, after authenticating the coding run and
    /// before consulting a document or touching disk. Missing item authority
    /// cannot grant coding writes.
    fn validate_coding_write(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Report readiness only after this provider's real dependencies are ready.
    /// Implementing an operation alone must not activate a partial daemon.
    fn ready(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Refuse before freezing unless the native core is ready and onto is
    /// retained locally. This check performs no working-copy mutation.
    fn validate_rebase(&self, _onto: Oid) -> Result<()> {
        Err(Error::unsupported())
    }

    /// Resolve and retain the return target before freezing any writer.
    fn validate_return_to_item(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Native jj edit only. RPC owns freeze/capture/reconcile/thaw.
    fn return_to_item(&self, _cx: &mut LockCx) -> Result<Oid> {
        Err(Error::unsupported())
    }

    /// Persist Return attribution before thaw. Failure retains the rewrite barrier.
    fn returned_by(&self, _actor: &Actor) -> Result<()> {
        Ok(())
    }

    /// Snapshot, pin and enqueue locally while holding the mutation lock.
    /// Unlike capture RPC, this must never wait for host acknowledgement.
    fn capture_local(&self, _cx: &mut LockCx) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Restore the operation retained by capture_local after an interrupted rewrite.
    /// Success means the working tree is fully restored, not merely requested.
    fn restore_rewrite(&self, _cx: &mut LockCx) -> Result<()> {
        Err(Error::unsupported())
    }
    /// Native jj rewrite only. RPC owns freeze/capture/reconcile/thaw.
    fn rebase(&self, _cx: &mut LockCx, _onto: Oid) -> Result<Oid> {
        Err(Error::unsupported())
    }

    /// Inspect the retained native result under the same rewrite lock.
    /// None denotes an older provider without conflict inspection.
    fn rebase_paths(&self, _head: Oid) -> Result<Option<Vec<String>>> {
        Ok(None)
    }

    fn call(&self, _cx: &mut LockCx, _method: u8, _arguments: &[u8]) -> Result<Vec<u8>> {
        Err(Error::unsupported())
    }
}
pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
    fn mono(&self) -> Instant;
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
    fn mono(&self) -> Instant {
        Instant::now()
    }
}
pub struct Disabled;
impl Watcher for Disabled {}
impl Documents for Disabled {}
impl Sessions for Disabled {}
impl Broker for Disabled {}
impl EventSink for Disabled {}
impl Core for Disabled {}
#[derive(Clone)]
pub struct Hooks {
    pub watcher: Arc<dyn Watcher>,
    pub documents: Arc<dyn Documents>,
    pub sessions: Arc<dyn Sessions>,
    pub broker: Arc<dyn Broker>,
    pub events: Arc<dyn EventSink>,
    pub core: Arc<dyn Core>,
    pub clock: Arc<dyn Clock>,
}
impl Default for Hooks {
    fn default() -> Self {
        Self {
            watcher: Arc::new(Disabled),
            documents: Arc::new(Disabled),
            sessions: Arc::new(Disabled),
            broker: Arc::new(Disabled),
            events: Arc::new(Disabled),
            core: Arc::new(Disabled),
            clock: Arc::new(SystemClock),
        }
    }
}

impl Error {
    /// Encodes only defined Error fields in ascending tag order.
    pub fn fields(&self) -> Vec<Vec<u8>> {
        use crate::conn::field;
        let mut fields = vec![field(1, [self.code])];
        if let Some(detail) = &self.detail {
            let mut bytes = (detail.len() as u16).to_be_bytes().to_vec();
            bytes.extend(detail.as_bytes());
            fields.push(field(2, bytes))
        }
        if let Some(digest) = self.current_digest {
            fields.push(field(3, digest))
        }
        if let Some(session) = self.session {
            fields.push(field(4, session.to_be_bytes()))
        }
        if let Some(limit) = self.limit {
            fields.push(field(5, limit.to_be_bytes()))
        }
        if let Some(protocol) = self.protocol {
            fields.push(field(6, [protocol as u8]))
        }
        if let Some(oids) = &self.oids {
            let mut bytes = (oids.len() as u16).to_be_bytes().to_vec();
            for oid in oids {
                bytes.extend(oid)
            }
            fields.push(field(7, bytes))
        }
        fields
    }
}
