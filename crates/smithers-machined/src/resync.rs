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
    #[cfg(all(feature = "testing", debug_assertions))]
    delayed: DelayedWatcher,
}
impl<I: Ignore, A: Eq + Clone, B: Eq + Clone> WatchLoop<I, A, B> {
    pub fn new(watch: Inotify<I>, changes: Changes<A, B>) -> Self {
        Self {
            watch,
            changes,
            moves: BTreeMap::new(),
            #[cfg(all(feature = "testing", debug_assertions))]
            delayed: DelayedWatcher::configured(),
        }
    }
    /// Re-arm, scan, snapshot, durable delivery and moved-off precede writes.
    pub fn resync<P: Provider<A, Blob = B>>(&mut self, p: &mut P, now: u64) -> io::Result<()> {
        self.changes.begin_resync();
        self.moves.clear();
        #[cfg(all(feature = "testing", debug_assertions))]
        self.delayed.pending.clear();
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
        #[cfg(all(feature = "testing", debug_assertions))]
        let events = self.delayed.deliver(events, now);
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

// C-J3-04 qualification fault: delay only file notification delivery, never
// the mutation executor, metadata guards, overflow recovery or durable saves.
// Both feature and debug build are required; release binaries strip the hook.
#[cfg(all(feature = "testing", debug_assertions))]
struct DelayedWatcher {
    milliseconds: u64,
    pending: std::collections::VecDeque<(u64, Event)>,
}
#[cfg(all(feature = "testing", debug_assertions))]
impl DelayedWatcher {
    fn configured() -> Self {
        let milliseconds = std::env::var("SMITHERS_MACHINED_WATCH_DELAY_MS")
            .map(|value| {
                let value = value
                    .parse::<u64>()
                    .expect("invalid watcher qualification delay");
                assert!(value <= 2000, "watcher qualification delay exceeds 2000 ms");
                value
            })
            .unwrap_or(0);
        Self {
            milliseconds,
            pending: Default::default(),
        }
    }
    fn deliver(&mut self, events: Vec<Event>, now: u64) -> Vec<Event> {
        if self.milliseconds == 0 {
            return events;
        }
        let mut delivered = Vec::new();
        for event in events {
            if matches!(event, Event::File { .. }) {
                self.pending
                    .push_back((now.saturating_add(self.milliseconds), event));
                if self.pending.len() > 4096 {
                    self.pending.clear();
                    delivered.push(Event::Overflow);
                    break;
                }
            } else {
                delivered.push(event)
            }
        }
        while self.pending.front().is_some_and(|(due, _)| *due <= now) {
            delivered.push(self.pending.pop_front().unwrap().1);
        }
        delivered
    }
}
#[cfg(all(test, feature = "testing", debug_assertions))]
mod qualification_tests {
    use super::*;
    #[test]
    fn delayed_watcher_preserves_order_and_keeps_guards_immediate() {
        // Feed the qualification hook actual kernel CLOSE_WRITE events from
        // the production inotify reader, with its normal repository ignores.
        let root = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(root.path())
            .status()
            .unwrap()
            .success());
        let ignore =
            crate::ignore::GitIgnore::new(root.path().into(), "/usr/bin/git".into(), vec![])
                .unwrap();
        let (mut watch, _) =
            Inotify::new(std::fs::File::open(root.path()).unwrap(), ignore).unwrap();
        std::fs::write(root.path().join("retry.ts"), "outside bytes").unwrap();
        let actual = watch.drain().unwrap();
        assert!(actual
            .iter()
            .any(|event| matches!(event, Event::File{path,..} if path == "retry.ts")));
        let mut real_delay = DelayedWatcher {
            milliseconds: 2000,
            pending: Default::default(),
        };
        assert!(real_delay.deliver(actual.clone(), 0).is_empty());
        assert!(real_delay.deliver(vec![], 1999).is_empty());
        assert_eq!(real_delay.deliver(vec![], 2000), actual);
        assert_eq!(
            watch.read("retry.ts").unwrap(),
            Some(b"outside bytes".to_vec())
        );

        let first = Event::File {
            path: "retry.ts".into(),
            cookie: 1,
            from: true,
            to: false,
        };
        let second = Event::File {
            path: "renamed.ts".into(),
            cookie: 1,
            from: false,
            to: true,
        };
        let mut delay = DelayedWatcher {
            milliseconds: 2000,
            pending: Default::default(),
        };
        assert_eq!(
            delay.deliver(vec![first.clone(), Event::Metadata], 100),
            vec![Event::Metadata]
        );
        assert!(delay.deliver(vec![second.clone()], 101).is_empty());
        assert!(delay.deliver(vec![], 2099).is_empty());
        assert_eq!(delay.deliver(vec![], 2100), vec![first]);
        assert_eq!(delay.deliver(vec![], 2101), vec![second.clone()]);
        assert_eq!(
            delay.deliver(vec![Event::Overflow], 2102),
            vec![Event::Overflow]
        );
        assert_eq!(
            delay.deliver(vec![second; 4097], 2103),
            vec![Event::Overflow]
        );
        assert!(delay.pending.is_empty());
        delay.milliseconds = 0;
        assert_eq!(
            delay.deliver(vec![Event::Metadata], 2104),
            vec![Event::Metadata]
        );
    }
}
