//! Lock-thread burst planning (§9.3.4). The head poller has no per-file
//! boundaries. Generic keys reuse the wire Actor without defining another one.
//! Remove a closed burst only after its caller durably appends the event.
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Key<A> {
    Smithers(A),
    Outside,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct File<V> {
    pub before: Option<V>,
    pub after: Option<V>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Burst<A, V> {
    pub key: Key<A>,
    pub opened_ms: u64,
    pub last_ms: u64,
    pub files: BTreeMap<String, File<V>>,
    pub last_path: String,
}
pub struct Bursts<A, V> {
    open: Vec<Burst<A, V>>,
    now_ms: u64,
}
impl<A: Eq + Clone, V: Clone> Default for Bursts<A, V> {
    fn default() -> Self {
        Self {
            open: vec![],
            now_ms: 0,
        }
    }
}
impl<A: Eq + Clone, V: Clone> Bursts<A, V> {
    pub fn is_open(&self) -> bool {
        !self.open.is_empty()
    }
    /// Call under the mutation lock before each write. The close callback must
    /// record outside files and append a durable event before returning success.
    /// On error, the failed burst remains and the new write must not proceed.
    pub fn before<E>(
        &mut self,
        now_ms: u64,
        next: Option<(&Key<A>, &str)>,
        mut close: impl FnMut(&Burst<A, V>) -> Result<(), E>,
    ) -> Result<(), E> {
        self.now_ms = self.now_ms.max(now_ms);
        let mut i = 0;
        while i < self.open.len() {
            let b = &self.open[i];
            let expired = self.now_ms.saturating_sub(b.last_ms) >= 1_500
                || self.now_ms.saturating_sub(b.opened_ms) >= 10_000;
            let crossed =
                next.is_some_and(|(key, path)| key != &b.key && b.files.contains_key(path));
            if expired || crossed {
                close(b)?;
                self.open.remove(i);
            } else {
                i += 1;
            }
        }
        Ok(())
    }
    /// Follows a successful `before` in the same lock job. V is the shared
    /// versions store's blob/digest record; no git object model lives here.
    pub fn record(&mut self, key: Key<A>, path: String, before: Option<V>, after: Option<V>) {
        let i = self
            .open
            .iter()
            .position(|b| b.key == key)
            .unwrap_or_else(|| {
                self.open.push(Burst {
                    key: key.clone(),
                    opened_ms: self.now_ms,
                    last_ms: self.now_ms,
                    files: BTreeMap::new(),
                    last_path: path.clone(),
                });
                self.open.len() - 1
            });
        let b = &mut self.open[i];
        b.last_ms = self.now_ms;
        b.last_path = path.clone();
        b.files
            .entry(path)
            .and_modify(|f| f.after = after.clone())
            .or_insert(File { before, after });
    }
    pub fn close_all<E>(
        &mut self,
        mut close: impl FnMut(&Burst<A, V>) -> Result<(), E>,
    ) -> Result<(), E> {
        while let Some(b) = self.open.first() {
            close(b)?;
            self.open.remove(0);
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    type Planner = Bursts<u64, u64>;
    fn write(
        p: &mut Planner,
        t: u64,
        key: Key<u64>,
        path: &str,
        before: Option<u64>,
        after: Option<u64>,
        closed: &mut Vec<Burst<u64, u64>>,
    ) {
        p.before(t, Some((&key, path)), |b| {
            closed.push(b.clone());
            Ok::<_, ()>(())
        })
        .unwrap();
        p.record(key, path.into(), before, after);
    }
    #[test]
    fn quiet_and_maximum_boundaries() {
        let mut p = Planner::default();
        let mut done = vec![];
        write(&mut p, 0, Key::Outside, "a", None, Some(1), &mut done);
        p.before(1499, None, |_| -> Result<(), ()> { panic!("too early") })
            .unwrap();
        p.before(1500, None, |b| {
            done.push(b.clone());
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(done.len(), 1);
        assert!(!p.is_open());
        for t in (2000..=12000).step_by(1000) {
            write(&mut p, t, Key::Outside, "a", Some(1), Some(2), &mut done);
        }
        assert_eq!(done.len(), 2);
        assert_eq!(done[1].opened_ms, 2000);
        assert_eq!(done[1].last_ms, 11000);
    }
    #[test]
    fn overlapping_keys_and_actor_switch_preserve_versions() {
        let mut p = Planner::default();
        let mut done = vec![];
        write(
            &mut p,
            0,
            Key::Smithers(1),
            "a",
            Some(0),
            Some(1),
            &mut done,
        );
        write(
            &mut p,
            1,
            Key::Smithers(1),
            "a",
            Some(1),
            Some(2),
            &mut done,
        );
        write(&mut p, 2, Key::Outside, "b", None, Some(3), &mut done);
        assert!(done.is_empty());
        write(&mut p, 3, Key::Outside, "a", Some(2), None, &mut done);
        assert_eq!(
            done[0].files["a"],
            File {
                before: Some(0),
                after: Some(2)
            }
        );
        p.close_all(|b| {
            done.push(b.clone());
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(done.len(), 2);
        assert_eq!(done[1].files.len(), 2);
        assert_eq!(
            done[1].files["a"],
            File {
                before: Some(2),
                after: None
            }
        );
        assert_eq!(done[1].last_path, "a");
    }
    #[test]
    fn failed_close_remains_retryable() {
        let mut p = Planner::default();
        let mut done = vec![];
        write(&mut p, 0, Key::Outside, "a", None, Some(1), &mut done);
        assert_eq!(
            p.before(1, Some((&Key::Smithers(2), "a")), |_| Err("outbox")),
            Err("outbox")
        );
        assert_eq!(p.close_all(|_| Err("pin")), Err("pin"));
        assert!(p.is_open());
        p.close_all(|b| {
            done.push(b.clone());
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(done.len(), 1);
        assert!(!p.is_open());
    }
    #[test]
    fn random_stream_admits_each_write_once() {
        let mut seed = 0x3627_u64;
        let mut p = Planner::default();
        let mut total = 0;
        let mut time = 0;
        for n in 0..10_000 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            time += seed % 500;
            let key = if seed & 1 == 0 {
                Key::Outside
            } else {
                Key::Smithers(seed % 3)
            };
            let path = n.to_string();
            p.before(time, Some((&key, &path)), |b| {
                assert!(b.last_ms - b.opened_ms < 10_000);
                total += b.files.len();
                Ok::<_, ()>(())
            })
            .unwrap();
            p.record(key, path, None, Some(n));
        }
        p.close_all(|b| {
            total += b.files.len();
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(total, 10_000);
    }
}
