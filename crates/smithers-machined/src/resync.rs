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
        let mut paths: std::collections::BTreeSet<_> = self.watch.rearm()?.into_iter().collect();
        paths.extend(self.changes.state.recorded.keys().cloned());
        for burst in self.changes.state.bursts.pending() {
            paths.extend(burst.files.keys().cloned());
        }
        let paths = self.watch.tracked_paths(paths.into_iter().collect())?;
        self.changes.retain_paths(&paths.iter().cloned().collect());
        self.changes.resync(p, now, paths)
    }
    /// Dispatcher invokes this on the shared lock thread before every write;
    /// the daemon also schedules it regularly (<= 100 ms) while idle.
    pub fn drain<P: Provider<A, Blob = B>>(&mut self, p: &mut P, now: u64) -> io::Result<()> {
        if self.changes.needs_resync() {
            return self.resync(p, now);
        }
        let events = match self.watch.drain() {
            Ok(events) => events,
            Err(e) => {
                self.changes.begin_resync();
                return Err(e);
            }
        };
        for event in events {
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
                    if let Err(e) = self.changes.outside(p, now, &path) {
                        self.changes.begin_resync();
                        return Err(e);
                    }
                }
            }
        }
        self.moves
            .retain(|_, (_, at)| now.saturating_sub(*at) < 1500);
        self.changes.tick(p, now)
    }
}
