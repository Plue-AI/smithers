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
}
impl Repository for Repo {
    fn last_run(&mut self) -> Result<Option<SystemTime>> {
        Ok(self.last)
    }
    fn operations(&mut self) -> Result<Vec<Operation>> {
        Ok(vec![
            Operation {
                id: "oldest".into(),
                ended: self.now - RETENTION - Duration::from_secs(10),
            },
            Operation {
                id: "cutoff".into(),
                ended: self.now - RETENTION,
            },
            Operation {
                id: "newest-old".into(),
                ended: self.now - RETENTION - Duration::from_secs(1),
            },
        ])
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
fn retention_selects_newest_strictly_old_operation_and_runs_weekly() {
    let now = SystemTime::UNIX_EPOCH + RETENTION * 3;
    let mut r = Repo {
        now,
        last: None,
        calls: vec![],
        fail: false,
    };
    assert!(oplog::run(&mut r, now).unwrap());
    assert_eq!(r.calls, ["newest-old", "gc", "persist"]);
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
    };
    assert!(oplog::run(&mut r, now).is_err());
    assert_eq!(r.last, None);
    assert_eq!(r.calls, ["newest-old", "gc"]);
}
