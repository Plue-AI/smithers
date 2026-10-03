#![cfg(feature = "testing")]
//! Design §3 ordering, cancellation and failure recovery.
use smithers_machined::{lock::Lock, testing::fixtures};
use std::sync::{Arc, Mutex};
#[tokio::test(flavor = "current_thread")]
async fn fifo_single_thread_and_cancelled_waiter_does_not_cancel_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let lock = Lock::start(fixtures::resources(dir.path().into())).unwrap();
    let order = Arc::new(Mutex::new(Vec::new()));
    let (entered, wait) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let first = tokio::spawn({
        let lock = lock.clone();
        let order = order.clone();
        async move {
            lock.run("first", move |_| {
                entered.send(()).unwrap();
                blocked.recv().unwrap();
                order.lock().unwrap().push(1);
                std::thread::current().name().unwrap().to_owned()
            })
            .await
        }
    });
    wait.await.unwrap();
    let second = tokio::spawn({
        let lock = lock.clone();
        let order = order.clone();
        async move {
            lock.run("second", move |_| {
                order.lock().unwrap().push(2);
            })
            .await
        }
    });
    tokio::task::yield_now().await;
    second.abort();
    let _ = second.await;
    release.send(()).unwrap();
    assert_eq!(first.await.unwrap(), "machined-lock");
    let third = order.clone();
    lock.run("third", move |_| third.lock().unwrap().push(3))
        .await;
    assert_eq!(*order.lock().unwrap(), vec![1, 2, 3]);
    // Synchronize after measurement is recorded, not only after the result is delivered.
    lock.run("barrier", |_| ()).await;
    let times = lock.hold_times();
    assert_eq!(times["first"].len(), 1);
    assert_eq!(times["second"].len(), 1);
}
#[tokio::test(flavor = "current_thread")]
async fn panic_does_not_strand_following_jobs_and_hold_history_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let lock = Lock::start(fixtures::resources(dir.path().into())).unwrap();
    let worker = lock.clone();
    assert!(
        tokio::spawn(async move { worker.run("panic", |_| panic!("fixture")).await })
            .await
            .unwrap_err()
            .is_panic()
    );
    for n in 0..1002 {
        assert_eq!(lock.run("bounded", move |_| n).await, n);
    }
    lock.run("barrier", |_| ()).await;
    assert_eq!(lock.hold_times()["bounded"].len(), 1000);
}

#[tokio::test(flavor = "current_thread")]
async fn fixture_hooks_compile_and_dark_core_never_calls_them() {
    use smithers_machined::{hooks::none::*, hooks::*, msg::*, stream::FrameTx};
    let dir = tempfile::tempdir().unwrap();
    let lock = Lock::start(fixtures::resources(dir.path().into())).unwrap();
    lock.run("hooks", |cx| {
        let actor = Actor::Run(RunActor {
            run: "coding-1".into(),
        });
        let base = Base::Absent(Empty {});
        cx.hooks.watcher.drain(cx).unwrap();
        cx.hooks.watcher.before_write(cx, "a", &actor).unwrap();
        cx.hooks
            .watcher
            .after_write(
                cx,
                &WriteRecord {
                    path: "a".into(),
                    actor: actor.clone(),
                    before: None,
                    after: [1; 20],
                    post_digest: [2; 32],
                },
            )
            .unwrap();
        cx.hooks.watcher.close_bursts(cx).unwrap();
        cx.hooks.watcher.resync(cx).unwrap();
        assert!(!cx.hooks.watcher.burst_open());
        assert_eq!(cx.hooks.documents.flush_all(cx).unwrap(), 0);
        assert!(cx
            .hooks
            .documents
            .write_through(cx, "a", &base, b"x", &actor)
            .is_none());
        cx.hooks.documents.reconcile_all(cx, &actor).unwrap();
        assert!(cx.hooks.documents.all_flushed());
        let (out, rx) = FrameTx::channel();
        cx.hooks.documents.frame(7, 1, b"x", &out);
        assert_eq!(rx.recv().unwrap().payload, vec![255, 0, 0, 0, 2, 1, 2]);
        assert_eq!(cx.hooks.documents.open("a").unwrap_err().code, 2);
        assert_eq!(cx.hooks.documents.close(7).unwrap_err().code, 2);
        assert!(cx.hooks.sessions.run_of_cgroup("/unregistered").is_none());
        assert!(cx
            .hooks
            .sessions
            .active_since(std::time::Instant::now())
            .is_empty());
        assert!(cx.hooks.sessions.live().is_empty());
        assert!(cx.hooks.sessions.last_path(7).is_none());
        let none = NoBroker;
        assert_eq!(none.freeze(std::time::Duration::ZERO).unwrap_err().code, 2);
        assert_eq!(none.thaw().unwrap_err().code, 2);
        assert_eq!(none.kill_sessions(None).unwrap_err().code, 2);
        assert_eq!(
            smithers_machined::files::read_file(
                cx,
                &ReadFile {
                    path: "a".into(),
                    at: None
                }
            )
            .unwrap_err()
            .code,
            2
        );
        assert_eq!(
            smithers_machined::files::write_file(
                cx,
                &WriteFile {
                    path: "a".into(),
                    base,
                    content: smithers_machined::conn::Bytes(vec![1]),
                    actor: actor.clone()
                }
            )
            .unwrap_err()
            .code,
            2
        );
        assert_eq!(
            smithers_machined::capture::capture_local(cx)
                .unwrap_err()
                .code,
            2
        );
        assert_eq!(
            smithers_machined::objects::import(cx, b"not a bundle")
                .unwrap_err()
                .code,
            2
        );
        assert_eq!(
            smithers_machined::freeze::freeze_then::<()>(cx, &actor, |_| panic!(
                "rewrite must never run"
            ))
            .unwrap_err()
            .code,
            2
        );
        assert_eq!(
            smithers_machined::reconcile::wake_reconcile(cx, [1; 20])
                .unwrap_err()
                .code,
            2
        );
        assert_eq!(smithers_machined::oplog::run(cx).unwrap_err().code, 2);
        assert_eq!(cx.vcs.run("git", &["status"]).unwrap_err().code, 2);
    })
    .await;
}
