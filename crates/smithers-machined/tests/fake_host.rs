use smithers_machined::{
    conn::Frame,
    hooks::*,
    lock::{Executor, LockCx, LockError},
    rpc,
};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/backend/internal/compose/testdata/cocontracts")
            .join(format!("{name}.bin")),
    )
    .unwrap()
}
#[test]
fn reserved_document_unsupported() {
    let mut cx = LockCx::new(Hooks::default());
    for (name, response) in [
        ("doc_reserved_sync", "doc_refused_unsupported"),
        ("req_open_doc", "res_unsupported_open_doc"),
        ("req_close_doc", "res_unsupported_close_doc"),
    ] {
        let mut out = vec![];
        rpc::serve_one(&mut Cursor::new(fixture(name)), &mut out, &mut cx).unwrap();
        assert_eq!(out, fixture(response));
        assert_eq!(cx.completed, 0)
    }
}
#[test]
fn unimplemented_hook_unsupported() {
    let mut cx = LockCx::new(Hooks::default());
    for method in [
        "status",
        "read_file",
        "write_file",
        "capture",
        "wake_reconcile",
        "open_session",
        "tcp_connect",
        "close_session",
        "kill_sessions",
        "register_run",
        "rebase",
        "return_to_item",
        "attach_session",
    ] {
        let mut out = vec![];
        rpc::serve_one(
            &mut Cursor::new(fixture(&format!("req_{method}"))),
            &mut out,
            &mut cx,
        )
        .unwrap();
        assert_eq!(
            out,
            fixture(&format!("res_unsupported_{method}")),
            "{method}"
        )
    }
    for method in [
        "sess_data_in",
        "sess_data_out",
        "sess_data_err",
        "sess_resize",
        "sess_signal_int",
    ] {
        let mut out = vec![];
        rpc::serve_one(&mut Cursor::new(fixture(method)), &mut out, &mut cx).unwrap();
        assert_eq!(out, fixture("sess_refused_unsupported"))
    }
}
struct Fixture;
impl Watcher for Fixture {}
impl Documents for Fixture {}
impl Sessions for Fixture {}
impl Broker for Fixture {}
impl EventSink for Fixture {}
impl Core for Fixture {}
#[test]
fn fifo_executor_hooks_and_abandoned_receipt() {
    let hooks = Hooks {
        watcher: Arc::new(Fixture),
        documents: Arc::new(Fixture),
        sessions: Arc::new(Fixture),
        broker: Arc::new(Fixture),
        events: Arc::new(Fixture),
        ..Hooks::default()
    };
    let executor = Executor::start(hooks).unwrap();
    let order = Arc::new(Mutex::new(vec![]));
    let (tx, rx) = mpsc::channel();
    let first = executor
        .lock
        .enqueue("first", move |_| rx.recv().unwrap())
        .unwrap();
    let mut receipts = vec![];
    for i in 0..100 {
        let o = order.clone();
        let r = executor
            .lock
            .enqueue("fixture", move |cx| {
                let h = cx.hooks.clone();
                assert_eq!(h.watcher.drain(cx), Err(Error::unsupported()));
                assert_eq!(h.documents.flush_all(cx), Err(Error::unsupported()));
                o.lock().unwrap().push(i);
                i
            })
            .unwrap();
        if i == 50 {
            drop(r)
        } else {
            receipts.push((i, r))
        }
    }
    assert!(order.lock().unwrap().is_empty());
    tx.send(()).unwrap();
    first.wait().unwrap();
    for (i, r) in receipts {
        assert_eq!(r.wait().unwrap(), i)
    }
    executor.shutdown().unwrap();
    assert_eq!(*order.lock().unwrap(), (0..100).collect::<Vec<_>>())
}
#[test]
fn panic_does_not_lose_later_mutations() {
    let executor = Executor::start(Hooks::default()).unwrap();
    let bad = executor.lock.enqueue("bad", |_| panic!("fixture")).unwrap();
    let good = executor.lock.enqueue("good", |cx| cx.completed).unwrap();
    assert_eq!(bad.wait(), Err(LockError::Panicked));
    assert_eq!(good.wait(), Ok(1));
    executor.shutdown().unwrap()
}
#[test]
fn disabled_executable_has_no_connection_or_hook_side_effect() {
    let dir = std::env::temp_dir().join(format!("machined-disabled-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_smithers-machined"))
        .arg("daemon")
        .env(
            "SMITHERS_MACHINED_HOST",
            listener.local_addr().unwrap().to_string(),
        )
        .current_dir(&dir)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(78));
    assert!(listener.accept().is_err());
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    std::fs::remove_dir(dir).unwrap()
}
#[test]
fn fake_host_replays_sequences_through_stream_decoder() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/backend/internal/compose/testdata/cocontracts/MANIFEST.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for (_, sequence) in manifest["sequences"].as_object().unwrap() {
        let mut bytes = vec![];
        let mut frames = vec![];
        for name in sequence.as_array().unwrap() {
            let b = fixture(name.as_str().unwrap());
            frames.push(Frame::decode(&b).unwrap());
            bytes.extend(b)
        }
        let mut host = Cursor::new(bytes);
        for frame in frames {
            assert_eq!(Frame::read(&mut host).unwrap(), frame)
        }
        assert_eq!(host.position() as usize, host.get_ref().len())
    }
}
#[test]
fn malformed_control_preserves_correlation_without_invoking_hooks() {
    let mut cx = LockCx::new(Hooks::default());
    for name in ["bad_unknown_field_uid", "bad_actor_names_branch"] {
        let mut out = vec![];
        rpc::serve_one(&mut Cursor::new(fixture(name)), &mut out, &mut cx).unwrap();
        assert_eq!(out, fixture("err_malformed_unknown_field"));
    }
    assert_eq!(cx.completed, 0);
}
#[tokio::test(flavor = "current_thread")]
async fn waiting_for_fifo_does_not_block_io_runtime() {
    let executor = Executor::start(Hooks::default()).unwrap();
    let (tx, rx) = mpsc::channel();
    let first = executor
        .lock
        .enqueue("blocked", move |_| rx.recv().unwrap())
        .unwrap();
    let lock = executor.lock.clone();
    let queued = tokio::spawn(async move { lock.run("next", |cx| cx.completed).await });
    tokio::task::yield_now().await;
    assert!(!queued.is_finished());
    tx.send(()).unwrap();
    // async receipt completes while the same runtime remains usable
    assert_eq!(queued.await.unwrap(), Ok(1));
    drop(first);
    executor.shutdown().unwrap();
}
