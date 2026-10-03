//! Component seams fixed by machined design §8. Hooks execute on the lock thread.
use crate::{lock::LockCx, msg::*, stream::FrameTx};
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
pub struct Hooks {
    pub watcher: Arc<dyn Watcher>,
    pub documents: Arc<dyn Documents>,
    pub sessions: Arc<dyn Sessions>,
    pub broker: Arc<dyn Broker>,
}
pub trait Watcher: Send + Sync {
    fn drain(&self, cx: &mut LockCx<'_>) -> Result<(), Error>;
    fn before_write(&self, cx: &mut LockCx<'_>, path: &str, actor: &Actor) -> Result<(), Error>;
    fn after_write(&self, cx: &mut LockCx<'_>, w: &WriteRecord) -> Result<(), Error>;
    fn close_bursts(&self, cx: &mut LockCx<'_>) -> Result<(), Error>;
    fn resync(&self, cx: &mut LockCx<'_>) -> Result<(), Error>;
    fn burst_open(&self) -> bool;
}
pub struct WriteRecord {
    pub path: String,
    pub actor: Actor,
    pub before: Option<Oid>,
    pub after: Oid,
    pub post_digest: Digest,
}
pub trait Documents: Send + Sync {
    fn flush_all(&self, cx: &mut LockCx<'_>) -> Result<u16, Error>;
    fn write_through(
        &self,
        cx: &mut LockCx<'_>,
        path: &str,
        base: &Base,
        content: &[u8],
        actor: &Actor,
    ) -> Option<Result<Digest, Error>>;
    fn reconcile_all(&self, cx: &mut LockCx<'_>, actor: &Actor) -> Result<(), Error>;
    fn open(&self, path: &str) -> Result<u32, Error>;
    fn close(&self, stream: u32) -> Result<(), Error>;
    fn frame(&self, stream: u32, msg: u8, body: &[u8], out: &FrameTx);
    fn all_flushed(&self) -> bool;
}
pub trait Sessions: Send + Sync {
    fn open(&self, req: OpenSession, out: &FrameTx) -> Result<u32, Error>;
    fn tcp_connect(&self, port: u16, out: &FrameTx) -> Result<u32, Error>;
    fn close(&self, session: u32) -> Result<(), Error>;
    fn kill(&self, target: &KillTarget) -> Result<u16, Error>;
    fn register_run(&self, run: &str, session: u32) -> Result<(), Error>;
    fn attach(&self, session: u32, received: u64, out: &FrameTx) -> Result<u64, Error>;
    fn frame(&self, session: u32, frame: StreamFrame);
    fn run_of_cgroup(&self, cgroup: &str) -> Option<String>;
    fn active_since(&self, since: Instant) -> Vec<u32>;
    fn live(&self) -> Vec<u32>;
    fn last_path(&self, session: u32) -> Option<String>;
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frozen {
    Yes,
    TimedOut { blocking: u32 },
}
pub trait Broker: Send + Sync {
    fn freeze(&self, timeout: Duration) -> Result<Frozen, Error>;
    fn thaw(&self) -> Result<(), Error>;
    fn kill_sessions(&self, sessions: Option<&[u32]>) -> Result<u16, Error>;
}
pub trait EventSink: Send + Sync {
    fn append(&self, event: Event, pin: Option<Oid>) -> Result<(u64, Id128), Error>;
    fn hint(&self, hint: Hint);
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
pub mod none {
    use super::*;
    pub struct NoWatcher;
    impl Watcher for NoWatcher {
        fn drain(&self, _: &mut LockCx<'_>) -> Result<(), Error> {
            Ok(())
        }
        fn before_write(&self, _: &mut LockCx<'_>, _: &str, _: &Actor) -> Result<(), Error> {
            Ok(())
        }
        fn after_write(&self, _: &mut LockCx<'_>, _: &WriteRecord) -> Result<(), Error> {
            Ok(())
        }
        fn close_bursts(&self, _: &mut LockCx<'_>) -> Result<(), Error> {
            Ok(())
        }
        fn resync(&self, _: &mut LockCx<'_>) -> Result<(), Error> {
            Ok(())
        }
        fn burst_open(&self) -> bool {
            false
        }
    }
    pub struct NoDocuments;
    impl Documents for NoDocuments {
        fn flush_all(&self, _: &mut LockCx<'_>) -> Result<u16, Error> {
            Ok(0)
        }
        fn write_through(
            &self,
            _: &mut LockCx<'_>,
            _: &str,
            _: &Base,
            _: &[u8],
            _: &Actor,
        ) -> Option<Result<Digest, Error>> {
            None
        }
        fn reconcile_all(&self, _: &mut LockCx<'_>, _: &Actor) -> Result<(), Error> {
            Ok(())
        }
        fn open(&self, _: &str) -> Result<u32, Error> {
            Err(Error::unsupported())
        }
        fn close(&self, _: u32) -> Result<(), Error> {
            Err(Error::unsupported())
        }
        fn frame(&self, stream: u32, _: u8, _: &[u8], out: &FrameTx) {
            out.refuse(crate::conn::Kind::Documents, stream);
        }
        fn all_flushed(&self) -> bool {
            true
        }
    }
    pub struct NoSessions {
        pub out: FrameTx,
    }
    impl Sessions for NoSessions {
        fn open(&self, _: OpenSession, _: &FrameTx) -> Result<u32, Error> {
            Err(Error::unsupported())
        }
        fn tcp_connect(&self, _: u16, _: &FrameTx) -> Result<u32, Error> {
            Err(Error::unsupported())
        }
        fn close(&self, _: u32) -> Result<(), Error> {
            Err(Error::unsupported())
        }
        fn kill(&self, _: &KillTarget) -> Result<u16, Error> {
            Err(Error::unsupported())
        }
        fn register_run(&self, _: &str, _: u32) -> Result<(), Error> {
            Err(Error::unsupported())
        }
        fn attach(&self, _: u32, _: u64, _: &FrameTx) -> Result<u64, Error> {
            Err(Error::unsupported())
        }
        fn frame(&self, session: u32, _: StreamFrame) {
            self.out.refuse(crate::conn::Kind::Sessions, session);
        }
        fn run_of_cgroup(&self, _: &str) -> Option<String> {
            None
        }
        fn active_since(&self, _: Instant) -> Vec<u32> {
            vec![]
        }
        fn live(&self) -> Vec<u32> {
            vec![]
        }
        fn last_path(&self, _: u32) -> Option<String> {
            None
        }
    }
    pub struct NoBroker;
    impl Broker for NoBroker {
        fn freeze(&self, _: Duration) -> Result<Frozen, Error> {
            Err(Error::unsupported())
        }
        fn thaw(&self) -> Result<(), Error> {
            Err(Error::unsupported())
        }
        fn kill_sessions(&self, _: Option<&[u32]>) -> Result<u16, Error> {
            Err(Error::unsupported())
        }
    }
    pub struct NoEvents;
    impl EventSink for NoEvents {
        fn append(&self, _: Event, _: Option<Oid>) -> Result<(u64, Id128), Error> {
            Err(Error::unsupported())
        }
        fn hint(&self, _: Hint) {}
    }
}
