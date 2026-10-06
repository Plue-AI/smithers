//! Watcher-loop adapter. Calls are lock jobs supplied by the sole daemon
//! executor. This type is not a second daemon, RPC dispatcher or mutation lock.
use crate::{
    events::{Changes, Provider},
    ignore::Ignore,
    watch::{Event, Inotify},
};
use std::{collections::BTreeMap, io};
pub struct WatchLoop<I, A, B> {
    pub watch: Inotify<I>,
    pub changes: Changes<A, B>,
    moves: BTreeMap<u32, (String, u64)>,
}
impl<I: Ignore, A: Eq + Clone, B: Eq + Clone> WatchLoop<I, A, B> {
    pub fn new(watch: Inotify<I>, changes: Changes<A, B>) -> Self {
        Self {
            watch,
            changes,
            moves: BTreeMap::new(),
        }
    }
    /// Re-arm, scan, snapshot, durable delivery and moved-off precede writes.
    pub fn resync<P: Provider<A, Blob = B>>(&mut self, p: &mut P, now: u64) -> io::Result<()> {
        self.changes.begin_resync();
        self.moves.clear();
        let paths = self.watch.rearm()?;
        self.changes.resync(p, now, paths)
    }
    /// Dispatcher invokes this on the shared lock thread before every write;
    /// the daemon also schedules it regularly (<= 100 ms) while idle.
    pub fn drain<P: Provider<A, Blob = B>>(&mut self, p: &mut P, now: u64) -> io::Result<()> {
        if self.changes.needs_resync() {
            return self.resync(p, now);
        }
        for event in self.watch.drain()? {
            match event {
                Event::Overflow => return self.resync(p, now),
                Event::Metadata => self.changes.metadata(now),
                Event::File {
                    path,
                    cookie,
                    from,
                    to,
                } => {
                    if from && cookie != 0 {
                        self.moves.insert(cookie, (path.clone(), now));
                    }
                    if to && cookie != 0 {
                        if let Some((source, _)) = self.moves.remove(&cookie) {
                            self.changes.rename(&source, &path);
                        }
                    }
                    self.changes.outside(p, now, &path)?;
                }
            }
        }
        self.moves
            .retain(|_, (_, at)| now.saturating_sub(*at) < 1500);
        self.changes.tick(p, now)
    }
}
