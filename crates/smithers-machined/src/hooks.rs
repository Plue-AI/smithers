//! Injectable lock-thread services. Defaults never touch a workspace or broker.
use crate::{conn::Frame, lock::LockCx};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
pub type Oid = [u8; 20];
pub type Digest = [u8; 32];
#[derive(Debug, Clone, PartialEq, Eq)]
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
pub struct WriteRecord {
    pub path: String,
    pub actor: Actor,
    pub before: Option<Oid>,
    pub after: Oid,
    pub post_digest: Digest,
}
pub trait Watcher: Send + Sync {
    /// Report readiness only after this provider's real dependencies are ready.
    /// Implementing an operation alone must not activate a partial daemon.
    fn ready(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    fn before_write(&self, _cx: &mut LockCx, _path: &str, _actor: &Actor) -> Result<()> {
        Err(Error::unsupported())
    }
    fn drain(&self, _cx: &mut LockCx) -> Result<()> {
        Err(Error::unsupported())
    }
    fn close_bursts(&self, _cx: &mut LockCx) -> Result<()> {
        Err(Error::unsupported())
    }
    fn after_write(&self, _cx: &mut LockCx, _write: &WriteRecord) -> Result<()> {
        Err(Error::unsupported())
    }
    fn resync(&self, _cx: &mut LockCx) -> Result<()> {
        Err(Error::unsupported())
    }
    fn burst_open(&self) -> bool {
        false
    }
}
pub trait Documents: Send + Sync {
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
    ) -> Option<Result<Digest>> {
        None
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
    /// Report readiness only after this provider's real dependencies are ready.
    /// Implementing an operation alone must not activate a partial daemon.
    fn ready(&self) -> Result<()> {
        Err(Error::unsupported())
    }
    fn call(&self, _method: u8, _arguments: &[u8]) -> Result<Vec<u8>> {
        Err(Error::unsupported())
    }
    fn frame(&self, _frame: &Frame) -> Result<Frame> {
        Err(Error::unsupported())
    }
    fn run_of_cgroup(&self, _cgroup: &str) -> Option<String> {
        None
    }
    fn live(&self) -> Vec<u32> {
        vec![]
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
