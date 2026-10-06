//! Production framed RPC and mutation queue with scripted native hooks. These
//! cover the contract while native capture/core and the root broker land; they
//! are not real cgroup, jj, authenticated transport or timing receipts.
use smithers_machined::{
    conn::Frame,
    hooks::{Actor, Broker, Core, Documents, Error, Hooks, Oid, Result, Watcher},
    lock::{Executor, LockCx, LockError},
    rpc,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Fixture {
    calls: Mutex<Vec<&'static str>>,
    fail: &'static str,
}
impl Fixture {
    fn step(&self, name: &'static str) -> Result<()> {
        self.calls.lock().unwrap().push(name);
        if self.fail == name {
            return Err(Error {
                code: 12,
                detail: Some(name.into()),
                ..Error::unsupported()
            });
        }
        Ok(())
    }
    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}
impl Broker for Fixture {
    fn freeze(&self, timeout: Duration) -> Result<Option<u32>> {
        assert_eq!(timeout, Duration::from_secs(1));
        self.step("freeze")?;
        Ok((self.fail == "busy").then_some(17))
    }
    fn thaw(&self) -> Result<()> {
        self.step("thaw")
    }
}
impl Watcher for Fixture {
    fn drain(&self, _: &mut LockCx) -> Result<()> {
        self.step("drain")
    }
    fn close_bursts(&self, _: &mut LockCx) -> Result<()> {
        self.step("close")
    }
}
impl Core for Fixture {
    fn validate_rebase(&self, onto: Oid) -> Result<()> {
        assert_eq!(onto, [0x11; 20]);
        self.step("validate")
    }

    fn capture_local(&self, _: &mut LockCx) -> Result<()> {
        self.step("capture")
    }
    fn rebase(&self, _: &mut LockCx, onto: Oid) -> Result<Oid> {
        assert_eq!(onto, [0x11; 20]);
        self.step("rebase")?;
        assert_ne!(self.fail, "panic", "native provider panic");
        Ok([0x22; 20])
    }
}
impl Documents for Fixture {
    fn reconcile_all(&self, _: &mut LockCx, actor: &Actor) -> Result<()> {
        assert_eq!(actor, &Actor::Principal(b"principal".to_vec()));
        self.step("reconcile")
    }
}
fn fixture(fail: &'static str) -> (Arc<Fixture>, Executor) {
    let f = Arc::new(Fixture {
        calls: Mutex::new(vec![]),
        fail,
    });
    let executor = Executor::start(Hooks {
        broker: f.clone(),
        watcher: f.clone(),
        core: f.clone(),
        documents: f.clone(),
        ..Hooks::default()
    })
    .unwrap();
    (f, executor)
}
fn request() -> Frame {
    Frame::decode(include_bytes!(
        "../../../packages/backend/internal/compose/testdata/cocontracts/req_rebase.bin"
    ))
    .unwrap()
}
#[test]
fn rebase_captures_before_rewrite_and_thaws_before_next_writer() {
    let (f, executor) = fixture("");
    let first = executor
        .lock
        .enqueue("rebase", |cx| rpc::dispatch(&request(), cx))
        .unwrap();
    let next = f.clone();
    let second = executor
        .lock
        .enqueue("write_file", move |_| next.step("next writer"))
        .unwrap();
    let response = first.wait().unwrap().unwrap();
    // Literal response: request 42, rebase result 11, new head 0x22 * 20.
    let mut expected = vec![2, 0, 0, 0, 32, 1, 0, 0, 0, 42, 2, 11, 0, 0, 0, 21, 1];
    expected.extend([0x22; 20]);
    assert_eq!(response.payload, expected);
    second.wait().unwrap().unwrap();
    assert_eq!(
        f.calls(),
        [
            "validate",
            "freeze",
            "drain",
            "close",
            "capture",
            "rebase",
            "reconcile",
            "thaw",
            "next writer"
        ]
    );
    executor.shutdown().unwrap();
}
#[test]
fn rebase_thaws_on_each_failure_and_preserves_busy_session() {
    for fail in [
        "freeze",
        "busy",
        "drain",
        "close",
        "capture",
        "rebase",
        "reconcile",
        "thaw",
    ] {
        let (f, executor) = fixture(fail);
        let response = executor
            .lock
            .run_blocking("rebase", |cx| rpc::dispatch(&request(), cx))
            .unwrap()
            .unwrap();
        assert_eq!(response.payload[11], 255, "{fail}");
        assert_eq!(f.calls().last(), Some(&"thaw"), "{fail}");
        if fail == "busy" {
            assert_eq!(
                response.payload,
                [2, 0, 0, 0, 18, 1, 0, 0, 0, 42, 2, 255, 0, 0, 0, 7, 1, 9, 4, 0, 0, 0, 17]
            );
            assert_eq!(f.calls(), ["validate", "freeze", "thaw"]);
        }
        if ["freeze", "busy", "drain", "close", "capture"].contains(&fail) {
            assert!(!f.calls().contains(&"rebase"), "{fail}");
        }
        executor.shutdown().unwrap();
    }
}
#[test]
fn provider_panic_thaws_before_queue_resumes() {
    let (f, executor) = fixture("panic");
    assert_eq!(
        executor
            .lock
            .run_blocking("rebase", |cx| rpc::dispatch(&request(), cx)),
        Err(LockError::Panicked)
    );
    let next = f.clone();
    executor
        .lock
        .run_blocking("write_file", move |_| next.step("next writer"))
        .unwrap()
        .unwrap();
    assert_eq!(
        f.calls(),
        [
            "validate",
            "freeze",
            "drain",
            "close",
            "capture",
            "rebase",
            "thaw",
            "next writer"
        ]
    );
    executor.shutdown().unwrap();
}
#[test]
fn malformed_rebase_never_reaches_broker() {
    let (f, executor) = fixture("");
    let mut invalid = request();
    invalid.payload.pop();
    assert!(executor
        .lock
        .run_blocking("rebase", move |cx| rpc::dispatch(&invalid, cx))
        .unwrap()
        .is_err());
    assert!(f.calls().is_empty());
    executor.shutdown().unwrap();
}

#[test]
fn unavailable_native_core_refuses_before_freeze() {
    let (f, executor) = fixture("validate");
    let response = executor
        .lock
        .run_blocking("rebase", |cx| rpc::dispatch(&request(), cx))
        .unwrap()
        .unwrap();
    assert_eq!(response.payload[11], 255);
    assert_eq!(f.calls(), ["validate"]);
    executor.shutdown().unwrap();
    let hooks = Hooks {
        broker: f.clone(),
        ..Hooks::default()
    };
    let executor = Executor::start(hooks).unwrap();
    let response = executor
        .lock
        .run_blocking("rebase", |cx| rpc::dispatch(&request(), cx))
        .unwrap()
        .unwrap();
    assert_eq!(response.payload[17], 2);
    assert_eq!(f.calls(), ["validate"]);
    executor.shutdown().unwrap();
}
