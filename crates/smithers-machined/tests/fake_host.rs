use smithers_machined::{
    conn::Frame,
    hooks::*,
    lock::{Executor, LockCx, LockError},
    rpc,
};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
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

struct AuthenticatedDocuments {
    opens: Mutex<Vec<(String, Vec<u8>)>>,
}
impl Documents for AuthenticatedDocuments {
    fn open_authenticated(&self, path: &str, actor: &[u8]) -> Result<u32> {
        self.opens.lock().unwrap().push((path.into(), actor.into()));
        Ok(9)
    }
}
#[test]
fn document_dispatch_requires_and_preserves_host_principal() {
    let documents = Arc::new(AuthenticatedDocuments {
        opens: Mutex::new(vec![]),
    });
    let mut cx = LockCx::new(Hooks {
        documents: documents.clone(),
        ..Hooks::default()
    });
    // Independent ADR request: id 1, method 13, path a.rs, principal bytes Be.
    let request = [
        0, 0, 0, 36, 1, 0, 0, 0, 0, 1, 0, 0, 0, 31, 1, 0, 0, 0, 1, 2, 13, 0, 0, 0, 20, 1, 0, 4,
        b'a', b'.', b'r', b's', 2, 1, 0, 0, 0, 7, 1, 0, 0, 0, 2, b'B', b'e',
    ];
    let mut out = vec![];
    rpc::serve_one(&mut Cursor::new(request), &mut out, &mut cx).unwrap();
    assert_eq!(
        *documents.opens.lock().unwrap(),
        vec![("a.rs".into(), b"Be".to_vec())]
    );
    assert_eq!(
        out,
        [
            0, 0, 0, 21, 1, 0, 0, 0, 0, 2, 0, 0, 0, 16, 1, 0, 0, 0, 1, 2, 13, 0, 0, 0, 5, 1, 0, 0,
            0, 9
        ]
    );
    let mut out = vec![];
    rpc::serve_one(&mut Cursor::new(fixture("req_open_doc")), &mut out, &mut cx).unwrap();
    assert_eq!(out, fixture("res_unsupported_open_doc"));
    assert_eq!(documents.opens.lock().unwrap().len(), 1);
    // A canonical principal with an empty blob is not an authenticated actor.
    let empty = [
        0, 0, 0, 34, 1, 0, 0, 0, 0, 1, 0, 0, 0, 29, 1, 0, 0, 0, 1, 2, 13, 0, 0, 0, 18, 1, 0, 4,
        b'a', b'.', b'r', b's', 2, 1, 0, 0, 0, 5, 1, 0, 0, 0, 0,
    ];
    assert_eq!(
        rpc::serve_one(&mut Cursor::new(empty), &mut vec![], &mut cx),
        Err(smithers_machined::conn::ProtocolError::BadValue)
    );
    assert_eq!(documents.opens.lock().unwrap().len(), 1);
}

#[test]
fn document_dispatch_rejects_untrusted_envelopes_before_provider() {
    struct Recording(Mutex<Vec<Frame>>);
    impl Documents for Recording {
        fn frame(&self, frame: &Frame) -> Result<Frame> {
            self.0.lock().unwrap().push(frame.clone());
            Err(Error::unsupported())
        }
    }
    let provider = Arc::new(Recording(Mutex::new(vec![])));
    let mut cx = LockCx::new(Hooks {
        documents: provider.clone(),
        ..Hooks::default()
    });
    // Literal payloads: missing actor, zero-length actor, truncated actor,
    // server sync, epoch and saved messages cannot enter the provider.
    for payload in [
        vec![1],
        vec![1, 1, 0, 0, 0, 5, 1, 0, 0, 0, 0],
        vec![1, 1, 0, 0, 0, 7, 1, 0, 0, 0, 2, b'B'],
        vec![3, 0, 0, 1, 0],
        vec![
            5, 0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255, 0, 0, 0, 42,
        ],
        vec![6, 0, 0, 0, 0, 0, 0, 0, 1, 0],
    ] {
        let mut wire = (payload.len() as u32).to_be_bytes().to_vec();
        wire.extend([4, 0, 0, 0, 9]);
        wire.extend(payload);
        let mut output = vec![];
        rpc::serve_one(&mut Cursor::new(wire), &mut output, &mut cx).unwrap();
        assert_eq!(output, [0, 0, 0, 7, 4, 0, 0, 0, 9, 255, 0, 0, 0, 2, 1, 2]);
    }
    assert!(provider.0.lock().unwrap().is_empty());
    // Retained v1 records still decode, but cannot enter a live v2 provider.
    let legacy = fixture("doc-input");
    Frame::decode(&legacy).unwrap();
    let mut output = vec![];
    rpc::serve_one(&mut Cursor::new(legacy), &mut output, &mut cx).unwrap();
    assert_eq!(output, [0, 0, 0, 7, 4, 0, 0, 0, 9, 255, 0, 0, 0, 2, 1, 2]);
    assert!(provider.0.lock().unwrap().is_empty());
    for name in ["doc-input-v2", "doc-awareness-input"] {
        let mut output = vec![];
        rpc::serve_one(&mut Cursor::new(fixture(name)), &mut output, &mut cx).unwrap();
    }
    let seen = provider.0.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0], Frame::decode(&fixture("doc-input-v2")).unwrap());
    assert_eq!(
        seen[1],
        Frame::decode(&fixture("doc-awareness-input")).unwrap()
    );
}
