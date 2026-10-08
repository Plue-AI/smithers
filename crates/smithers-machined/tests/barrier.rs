//! Framed dispatcher regression evidence; real broker/VM proof belongs to W1 wiring.
use smithers_machined::{conn::Frame, freeze, hooks::*, lock::LockCx, rpc};
use std::{
    io::Cursor,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct Machine {
    calls: Mutex<Vec<&'static str>>,
    restore_ok: Mutex<bool>,
}
impl Machine {
    fn call(&self, s: &'static str) {
        self.calls.lock().unwrap().push(s);
    }
}
impl Broker for Machine {
    fn set_roster(&self, members: &[smithers_machined::broker::sessions::User]) -> Result<()> {
        assert!(members.is_empty());
        self.call("revoke roster");
        Ok(())
    }
    fn freeze(&self, _: std::time::Duration) -> Result<Option<u32>> {
        self.call("freeze");
        Ok(None)
    }
    fn thaw(&self) -> Result<()> {
        self.call("thaw");
        Ok(())
    }
}
impl Watcher for Machine {
    fn drain(&self, _: &mut LockCx) -> Result<()> {
        Ok(())
    }
    fn close_bursts(&self, _: &mut LockCx) -> Result<()> {
        Ok(())
    }
}
impl Documents for Machine {
    fn flush_all(&self, _: &mut LockCx) -> Result<u16> {
        Ok(0)
    }
    fn reconcile_all(&self, _: &mut LockCx, _: &Actor) -> Result<()> {
        self.call("reconcile");
        Ok(())
    }
}
impl Core for Machine {
    fn validate_rebase(&self, _: Oid) -> Result<()> {
        Ok(())
    }
    fn capture_local(&self, _: &mut LockCx) -> Result<()> {
        self.call("capture");
        Ok(())
    }
    fn rebase(&self, _: &mut LockCx, _: Oid) -> Result<Oid> {
        self.call("partial rewrite");
        Err(Error::unsupported())
    }
    fn restore_rewrite(&self, _: &mut LockCx) -> Result<()> {
        self.call("restore");
        if *self.restore_ok.lock().unwrap() {
            Ok(())
        } else {
            Err(Error::unsupported())
        }
    }
}
#[test]
fn failed_rewrite_refuses_next_rpc_until_restore_settles_ten_times() {
    for _ in 0..10 {
        let m = Arc::new(Machine::default());
        let mut cx = LockCx::new(Hooks {
            broker: m.clone(),
            core: m.clone(),
            watcher: m.clone(),
            documents: m.clone(),
            ..Hooks::default()
        });
        let request = include_bytes!(
            "../../../packages/backend/internal/compose/testdata/cocontracts/req_rebase.bin"
        );
        for _ in 0..2 {
            let mut output = vec![];
            rpc::serve_one(&mut Cursor::new(request), &mut output, &mut cx).unwrap();
            assert_eq!(Frame::decode(&output).unwrap().payload[11], 255);
        }
        assert!(cx.rewrite_pending);
        assert_eq!(
            *m.calls.lock().unwrap(),
            ["freeze", "capture", "partial rewrite", "restore"]
        );
        assert!(freeze::restore(&mut cx, &Actor::Outside).is_err());
        assert!(cx.rewrite_pending);
        *m.restore_ok.lock().unwrap() = true;
        freeze::restore(&mut cx, &Actor::Outside).unwrap();
        assert!(!cx.rewrite_pending);
        assert_eq!(
            *m.calls.lock().unwrap(),
            [
                "freeze",
                "capture",
                "partial rewrite",
                "restore",
                "restore",
                "restore",
                "reconcile",
                "thaw"
            ]
        );
    }
}

#[test]
fn pending_rewrite_does_not_block_roster_revocation() {
    use smithers_machined::conn::{field, tagged};
    let m = Arc::new(Machine::default());
    let mut cx = LockCx::new(Hooks {
        broker: m.clone(),
        ..Hooks::default()
    });
    cx.rewrite_pending = true;
    let request = Frame {
        kind: 1,
        stream: 0,
        payload: tagged(
            1,
            &[
                field(1, 42u32.to_be_bytes()),
                field(2, tagged(16, &[field(1, 0u16.to_be_bytes())])),
            ],
        ),
    };
    let mut output = vec![];
    rpc::serve_one(
        &mut Cursor::new(request.encode().unwrap()),
        &mut output,
        &mut cx,
    )
    .unwrap();
    assert_eq!(Frame::decode(&output).unwrap().payload[11], 16);
    assert_eq!(*m.calls.lock().unwrap(), ["revoke roster"]);
    assert!(cx.rewrite_pending);
}

fn journal_hooks(machine: Arc<Machine>) -> Hooks {
    Hooks {
        broker: machine.clone(),
        core: machine.clone(),
        watcher: machine.clone(),
        documents: machine,
        ..Hooks::default()
    }
}

#[test]
fn interrupted_rewrite_child() {
    use std::io::Write;
    let Some(state) = std::env::var_os("W2_REWRITE_CRASH_STATE") else {
        return;
    };
    let journal =
        smithers_machined::rewrite_journal::Journal::open(std::path::Path::new(&state)).unwrap();
    let mut cx = LockCx::recovering(journal_hooks(Arc::new(Machine::default())), journal).unwrap();
    let request = include_bytes!(
        "../../../packages/backend/internal/compose/testdata/cocontracts/req_rebase.bin"
    );
    rpc::serve_one(&mut Cursor::new(request), &mut vec![], &mut cx).unwrap();
    assert!(cx.rewrite_pending);
    println!("W2_REWRITE_READY");
    std::io::stdout().flush().unwrap();
    // Parent owns and kills this process after seeing the production RPC reply.
    std::io::stdin().read_line(&mut String::new()).unwrap();
    panic!("parent must kill the interrupted rewrite process");
}

#[test]
fn killed_rewrite_retains_admission_barrier_until_restore_ten_times() {
    use std::{
        io::{BufRead, BufReader},
        os::unix::fs::PermissionsExt,
        process::{Command, Stdio},
    };
    for _ in 0..10 {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let state = std::env::temp_dir().join(format!("w2-barrier-{random:x?}"));
        std::fs::create_dir(&state).unwrap();
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "interrupted_rewrite_child", "--nocapture"])
            .env("W2_REWRITE_CRASH_STATE", &state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "child stopped before checkpoint: {line}"
            );
            if line.contains("W2_REWRITE_READY") {
                break;
            }
            line.clear();
        }
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        let m = Arc::new(Machine::default());
        let journal = smithers_machined::rewrite_journal::Journal::open(&state).unwrap();
        let mut cx = LockCx::recovering(journal_hooks(m.clone()), journal).unwrap();
        assert!(cx.rewrite_pending);
        assert!(freeze::freeze_then(&mut cx, &Actor::Outside, |_| Ok(())).is_err());
        assert!(m.calls.lock().unwrap().is_empty());
        assert!(freeze::restore(&mut cx, &Actor::Outside).is_err());
        assert!(cx.rewrite_pending);
        *m.restore_ok.lock().unwrap() = true;
        freeze::restore(&mut cx, &Actor::Outside).unwrap();
        assert_eq!(
            *m.calls.lock().unwrap(),
            ["restore", "restore", "reconcile", "thaw"]
        );
        let journal = smithers_machined::rewrite_journal::Journal::open(&state).unwrap();
        assert!(
            !LockCx::recovering(journal_hooks(m), journal)
                .unwrap()
                .rewrite_pending
        );
        std::fs::remove_dir_all(state).unwrap();
    }
}

#[test]
fn corrupt_or_symlinked_checkpoint_refuses_restart() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let mut random = [0; 16];
    getrandom::fill(&mut random).unwrap();
    let state = std::env::temp_dir().join(format!("w2-barrier-{random:x?}"));
    std::fs::create_dir(&state).unwrap();
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = state.join("rewrite.pending");
    for bytes in [b"".as_slice(), b"0", b"11"] {
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(smithers_machined::rewrite_journal::Journal::open(&state)
            .unwrap()
            .pending()
            .is_err());
    }
    std::fs::remove_file(&path).unwrap();
    symlink("/dev/null", &path).unwrap();
    assert!(smithers_machined::rewrite_journal::Journal::open(&state)
        .unwrap()
        .pending()
        .is_err());
    std::fs::remove_dir_all(state).unwrap();
}

#[derive(Default)]
struct InspectionBarrier {
    busy: bool,
    calls: Mutex<Vec<&'static str>>,
}
impl Broker for InspectionBarrier {
    fn freeze(&self, deadline: std::time::Duration) -> Result<Option<u32>> {
        assert_eq!(deadline, std::time::Duration::from_secs(1));
        self.calls.lock().unwrap().push("freeze");
        Ok(self.busy.then_some(17))
    }
    fn thaw(&self) -> Result<()> {
        self.calls.lock().unwrap().push("thaw");
        Ok(())
    }
}
impl Documents for InspectionBarrier {
    fn flush_all(&self, _: &mut LockCx) -> Result<u16> {
        self.calls.lock().unwrap().push("flush");
        Ok(0)
    }
}
#[test]
fn conflict_inspection_thaws_success_failure_panic_and_busy_without_rewrite() {
    for outcome in 0..4 {
        let barrier = Arc::new(InspectionBarrier {
            busy: outcome == 3,
            ..Default::default()
        });
        let mut cx = LockCx::new(Hooks {
            broker: barrier.clone(),
            documents: barrier.clone(),
            ..Hooks::default()
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            freeze::inspect_then(&mut cx, |_| {
                barrier.calls.lock().unwrap().push("inspect");
                match outcome {
                    0 => Ok(()),
                    1 => Err(Error::unsupported()),
                    2 => panic!("inspection failed"),
                    _ => unreachable!(),
                }
            })
        }));
        match outcome {
            0 => assert!(result.unwrap().is_ok()),
            1 => assert!(result.unwrap().is_err()),
            2 => assert!(result.is_err()),
            _ => {
                let err = result.unwrap().unwrap_err();
                assert_eq!(err.code, 9);
                assert_eq!(err.session, Some(17));
            }
        }
        assert!(!cx.rewrite_pending);
        assert_eq!(
            *barrier.calls.lock().unwrap(),
            if outcome == 3 {
                vec!["freeze", "thaw"]
            } else {
                vec!["freeze", "flush", "inspect", "thaw"]
            }
        );
    }
}
