use smithers_machined::{
    hooks::*,
    lock::LockCx,
    reconcile::{self, Outcome, Repository},
};
struct Repo {
    old: Option<Oid>,
    dirty: bool,
    conflict: bool,
    fail: bool,
    calls: Vec<&'static str>,
    event: Option<Vec<u8>>,
}
impl Repository for Repo {
    fn contains_commit(&mut self, h: Oid) -> Result<bool> {
        Ok(h != [9; 20])
    }
    fn acknowledged(&mut self) -> Result<Option<Oid>> {
        Ok(self.old)
    }
    fn snapshot(&mut self) -> Result<Oid> {
        self.calls.push("snapshot");
        Ok([2; 20])
    }
    fn tree(&mut self, h: Oid) -> Result<Oid> {
        Ok(if self.dirty { h } else { [0; 20] })
    }
    fn move_to(&mut self, _: Oid, _: Oid, _: Oid) -> Result<Oid> {
        self.calls.push("move");
        Ok([3; 20])
    }
    fn rebase_delta(&mut self, _: Oid, _: Oid, _: Oid) -> Result<Outcome> {
        self.calls.push("rebase");
        Ok(if self.conflict {
            Outcome::Conflict(vec!["a.rs".into()])
        } else {
            Outcome::Moved([4; 20])
        })
    }
    fn settle(&mut self, _: Oid, event: Option<&[u8]>) -> Result<()> {
        self.calls.push("settle");
        if self.fail {
            return Err(Error::unsupported());
        }
        self.event = event.map(Vec::from);
        Ok(())
    }
}
fn repo() -> Repo {
    Repo {
        old: Some([1; 20]),
        dirty: false,
        conflict: false,
        fail: false,
        calls: vec![],
        event: None,
    }
}
#[test]
fn wake_decision_matrix_and_durable_event() {
    for (old, dirty, conflict, expected) in [
        (None, false, false, Outcome::Unchanged),
        (Some([3; 20]), true, false, Outcome::Unchanged),
        (Some([1; 20]), false, false, Outcome::Moved([3; 20])),
        (Some([1; 20]), true, false, Outcome::Moved([4; 20])),
        (
            Some([1; 20]),
            true,
            true,
            Outcome::Conflict(vec!["a.rs".into()]),
        ),
    ] {
        let mut r = Repo {
            old,
            dirty,
            conflict,
            ..repo()
        };
        let mut cx = LockCx::new(Hooks::default());
        assert_eq!(reconcile::wake(&mut cx, &mut r, [3; 20]).unwrap(), expected);
        assert!(!cx.rewrite_pending);
        assert_eq!(r.calls.last(), Some(&"settle"));
        assert_eq!(r.event.is_some(), expected != Outcome::Unchanged);
        if let Some(event) = r.event {
            smithers_machined::conn::Durable {
                seq: 1,
                id: [1; 16],
                event,
            }
            .frame()
            .encode()
            .unwrap();
        }
    }
}
#[test]
fn missing_head_and_failed_settlement_never_admit_sessions() {
    let mut r = repo();
    let mut cx = LockCx::new(Hooks::default());
    assert_eq!(
        reconcile::wake(&mut cx, &mut r, [9; 20]).unwrap_err().oids,
        Some(vec![[9; 20]])
    );
    assert!(r.calls.is_empty());
    r.fail = true;
    assert!(reconcile::wake(&mut cx, &mut r, [3; 20]).is_err());
    assert!(cx.rewrite_pending);
    let before = r.calls.len();
    assert!(reconcile::wake(&mut cx, &mut r, [3; 20]).is_err());
    assert_eq!(r.calls.len(), before);
}

#[test]
fn failed_wake_retains_restart_barrier_and_success_removes_it() {
    use smithers_machined::rewrite_journal::Journal;
    use std::os::unix::fs::PermissionsExt;
    let mut random = [0; 16];
    getrandom::fill(&mut random).unwrap();
    let state = std::env::temp_dir().join(format!("w2-wake-{random:x?}"));
    std::fs::create_dir(&state).unwrap();
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    for dirty in [false, true] {
        let mut cx = LockCx::recovering(Hooks::default(), Journal::open(&state).unwrap()).unwrap();
        let mut r = Repo {
            dirty,
            fail: true,
            ..repo()
        };
        assert!(reconcile::wake(&mut cx, &mut r, [3; 20]).is_err());
        drop(cx);
        let mut restarted =
            LockCx::recovering(Hooks::default(), Journal::open(&state).unwrap()).unwrap();
        assert!(restarted.rewrite_pending);
        let mut next = repo();
        assert!(reconcile::wake(&mut restarted, &mut next, [3; 20]).is_err());
        assert!(next.calls.is_empty());
        // The native restore owner settles the retained checkpoint.
        restarted.settle_rewrite().unwrap();
        Journal::open(&state).unwrap().settled().unwrap();
        let mut successful =
            LockCx::recovering(Hooks::default(), Journal::open(&state).unwrap()).unwrap();
        assert!(reconcile::wake(&mut successful, &mut next, [3; 20]).is_ok());
        assert!(!Journal::open(&state).unwrap().pending().unwrap());
    }
    std::fs::remove_dir_all(state).unwrap();
}
