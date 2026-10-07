use smithers_machined::{
    hooks::*,
    oplog::{self, Operation, Repository, RETENTION},
};
use std::time::{Duration, SystemTime};
struct Repo {
    now: SystemTime,
    last: Option<SystemTime>,
    calls: Vec<String>,
    fail: bool,
    size: u64,
    count: usize,
}
impl Repository for Repo {
    fn last_run(&mut self) -> Result<Option<SystemTime>> {
        Ok(self.last)
    }
    fn size_bytes(&mut self) -> Result<u64> {
        Ok(self.size)
    }
    fn operations(&mut self) -> Result<Vec<Operation>> {
        Ok((0..self.count)
            .map(|i| Operation {
                id: format!("op-{i}"),
                ended: self.now - RETENTION - Duration::from_secs(i as u64),
            })
            .collect())
    }
    fn abandon_ancestors(&mut self, id: &str) -> Result<()> {
        self.calls.push(id.into());
        Ok(())
    }
    fn gc(&mut self) -> Result<()> {
        self.calls.push("gc".into());
        if self.fail {
            Err(Error::unsupported())
        } else {
            Ok(())
        }
    }
    fn record_run(&mut self, now: SystemTime) -> Result<()> {
        self.calls.push("persist".into());
        self.last = Some(now);
        Ok(())
    }
}
#[test]
fn retention_preserves_newest_hundred_and_runs_daily() {
    let now = SystemTime::UNIX_EPOCH + RETENTION * 3;
    let mut r = Repo {
        now,
        last: None,
        calls: vec![],
        fail: false,
        size: 0,
        count: 105,
    };
    assert!(oplog::run(&mut r, now).unwrap());
    assert_eq!(r.calls, ["op-100", "gc", "persist"]);
    assert!(!oplog::run(&mut r, now + RETENTION - Duration::from_secs(1)).unwrap());
    assert!(!oplog::run(&mut r, now - Duration::from_secs(1)).unwrap());
    assert!(oplog::run(&mut r, now + RETENTION).unwrap());
}
#[test]
fn failed_gc_does_not_advance_durable_clock() {
    let now = SystemTime::UNIX_EPOCH + RETENTION * 3;
    let mut r = Repo {
        now,
        last: None,
        calls: vec![],
        fail: true,
        size: 0,
        count: 105,
    };
    assert!(oplog::run(&mut r, now).is_err());
    assert_eq!(r.last, None);
    assert_eq!(r.calls, ["op-100", "gc"]);
}

#[test]
fn size_triggers_early_cleanup_and_small_history_is_preserved() {
    let now = SystemTime::UNIX_EPOCH + RETENTION * 3;
    let mut r = Repo {
        now,
        last: Some(now),
        calls: vec![],
        fail: false,
        size: oplog::SIZE_LIMIT - 1,
        count: 100,
    };
    assert!(!oplog::run(&mut r, now).unwrap());
    r.size += 1;
    assert!(oplog::run(&mut r, now).unwrap());
    assert_eq!(r.calls, ["gc", "persist"]);
}
