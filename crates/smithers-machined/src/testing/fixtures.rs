//! Injectable fixtures substitute missing guest privileges, never wire codecs.
pub use crate::hooks::none::{
    NoDocuments as FakeDocuments, NoSessions as FakeSessions, NoWatcher as FakeWatcher,
};
use crate::{confine::Workspace, hooks::*, jj::Vcs, lock::Resources, msg::*, stream::FrameTx};
use std::sync::{Arc, Mutex};
pub struct FakeBroker {
    pub frozen: Frozen,
    pub calls: Mutex<Vec<&'static str>>,
}
impl Default for FakeBroker {
    fn default() -> Self {
        Self {
            frozen: Frozen::Yes,
            calls: Mutex::new(vec![]),
        }
    }
}
impl Broker for FakeBroker {
    fn freeze(&self, _: std::time::Duration) -> Result<Frozen, Error> {
        self.calls.lock().unwrap().push("freeze");
        Ok(self.frozen.clone())
    }
    fn thaw(&self) -> Result<(), Error> {
        self.calls.lock().unwrap().push("thaw");
        Ok(())
    }
    fn kill_sessions(&self, _: Option<&[u32]>) -> Result<u16, Error> {
        self.calls.lock().unwrap().push("kill");
        Ok(0)
    }
}
#[derive(Default)]
pub struct FakeEvents {
    pub events: Mutex<Vec<Event>>,
    pub hints: Mutex<Vec<Hint>>,
}
impl EventSink for FakeEvents {
    fn append(&self, event: Event, _: Option<Oid>) -> Result<(u64, Id128), Error> {
        let mut events = self.events.lock().unwrap();
        events.push(event);
        let seq = events.len() as u64;
        let mut id = [0; 16];
        id[8..].copy_from_slice(&seq.to_be_bytes());
        Ok((seq, id))
    }
    fn hint(&self, hint: Hint) {
        self.hints.lock().unwrap().push(hint);
    }
}
pub struct FakeClock {
    pub now: std::time::SystemTime,
    pub mono: std::time::Instant,
}
impl Clock for FakeClock {
    fn now(&self) -> std::time::SystemTime {
        self.now
    }
    fn mono(&self) -> std::time::Instant {
        self.mono
    }
}
pub fn hooks(out: FrameTx) -> Hooks {
    Hooks {
        watcher: Arc::new(FakeWatcher),
        documents: Arc::new(FakeDocuments),
        sessions: Arc::new(FakeSessions { out }),
        broker: Arc::new(FakeBroker::default()),
    }
}
pub fn resources(root: std::path::PathBuf) -> Resources {
    let (out, _) = FrameTx::channel();
    Resources {
        ws: Workspace::fixture(root.clone()),
        vcs: Vcs { root },
        events: Arc::new(FakeEvents::default()),
        hooks: hooks(out),
        clock: Arc::new(SystemClock),
    }
}
