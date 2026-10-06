use smithers_machined::{hooks::*, lock::LockCx, rpc, wiring};
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

struct Provider(AtomicBool);
impl Provider {
    fn readiness(&self) -> Result<()> {
        if self.0.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(Error::unsupported())
        }
    }
}
macro_rules! provider {
    ($($service:ident),*) => { $(impl $service for Provider {
        fn ready(&self) -> Result<()> { self.readiness() }
    })* };
}
provider!(Watcher, Sessions, Broker, EventSink, Core);
impl Documents for Provider {
    fn ready(&self) -> Result<()> {
        self.readiness()
    }
    fn flush_all(&self, _: &mut LockCx) -> Result<u16> {
        Ok(3)
    }
    fn write_through(
        &self,
        _: &mut LockCx,
        path: &str,
        _: &Base,
        _: &[u8],
        _: &Actor,
    ) -> Option<Result<Digest>> {
        match path {
            "closed" => None,
            "refused" => Some(Err(Error::unsupported())),
            _ => Some(Ok([42; 32])),
        }
    }
    fn reconcile_all(&self, _: &mut LockCx, _: &Actor) -> Result<()> {
        Ok(())
    }
}
fn composed(provider: Arc<Provider>) -> Hooks {
    Hooks {
        watcher: provider.clone(),
        documents: provider.clone(),
        sessions: provider.clone(),
        broker: provider.clone(),
        events: provider.clone(),
        core: provider,
        ..Hooks::default()
    }
}
fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../packages/backend/internal/compose/testdata/cocontracts/{name}.bin",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}
fn assert_rpc_unsupported(hooks: Hooks, method: &str) {
    let mut output = vec![];
    rpc::serve_one(
        &mut Cursor::new(fixture(&format!("req_{method}"))),
        &mut output,
        &mut LockCx::new(hooks),
    )
    .unwrap();
    assert_eq!(output, fixture(&format!("res_unsupported_{method}")));
}

#[test]
fn each_lane_can_be_stubbed_and_prevents_startup() {
    for missing in [
        "watcher",
        "documents",
        "sessions",
        "broker",
        "events",
        "core",
    ] {
        let mut hooks = composed(Arc::new(Provider(AtomicBool::new(true))));
        match missing {
            "watcher" => hooks.watcher = Arc::new(Disabled),
            "documents" => hooks.documents = Arc::new(Disabled),
            "sessions" => hooks.sessions = Arc::new(Disabled),
            "broker" => hooks.broker = Arc::new(Disabled),
            "events" => hooks.events = Arc::new(Disabled),
            "core" => hooks.core = Arc::new(Disabled),
            _ => unreachable!(),
        }
        match wiring::start(hooks.clone()) {
            Err(wiring::StartError::NotReady { provider, source }) => {
                assert_eq!(provider, missing);
                assert_eq!(source, Error::unsupported());
            }
            _ => panic!("stubbed {missing} admitted startup"),
        }
        // Exercise the public framed dispatcher with the independently stubbed
        // composition too; it must retain the existing unsupported wire reply.
        assert_rpc_unsupported(
            hooks,
            match missing {
                "documents" => "close_doc",
                "sessions" | "broker" => "open_session",
                _ => "capture",
            },
        );
    }
}

#[test]
fn readiness_is_live_and_document_contract_runs_on_shared_lock() {
    let provider = Arc::new(Provider(AtomicBool::new(false)));
    let hooks = composed(provider.clone());
    assert!(wiring::ready(&hooks).is_err());
    provider.0.store(true, Ordering::SeqCst);
    let executor = wiring::start(hooks.clone()).unwrap();
    executor
        .lock
        .run_blocking("documents", |cx| {
            let documents = cx.hooks.documents.clone();
            assert_eq!(documents.flush_all(cx), Ok(3));
            assert_eq!(
                documents.write_through(cx, "closed", &Base::Absent, b"", &Actor::Outside),
                None
            );
            assert_eq!(
                documents.write_through(cx, "refused", &Base::Absent, b"", &Actor::Outside),
                Some(Err(Error::unsupported()))
            );
            assert_eq!(
                documents.write_through(cx, "open", &Base::Absent, b"", &Actor::Outside),
                Some(Ok([42; 32]))
            );
            assert_eq!(documents.reconcile_all(cx, &Actor::Outside), Ok(()));
        })
        .unwrap();
    executor.shutdown().unwrap();
    provider.0.store(false, Ordering::SeqCst);
    assert!(wiring::ready(&hooks).is_err());
}

#[test]
fn defaults_preserve_document_fallback_contract() {
    let mut cx = LockCx::new(Hooks::default());
    let docs = cx.hooks.documents.clone();
    assert_eq!(docs.flush_all(&mut cx), Err(Error::unsupported()));
    assert_eq!(
        docs.write_through(&mut cx, "file", &Base::Absent, b"", &Actor::Outside),
        None
    );
    assert_eq!(
        docs.reconcile_all(&mut cx, &Actor::Outside),
        Err(Error::unsupported())
    );
}

#[test]
fn uncomposed_binary_refuses_startup() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_smithers-machined"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(78));
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("watcher not ready"));
    assert!(output.stdout.is_empty());
}
