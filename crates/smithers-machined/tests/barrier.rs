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
