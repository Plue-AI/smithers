#![cfg(target_os = "linux")]
//! Real kernel overflow without changing the shared host's inotify sysctl.
//! Resync attribution/versions/lock ordering are exercised by versions.rs;
//! this boundary proves the kernel signal and recursive watch recovery.
use smithers_machined::{
    ignore::GitIgnore,
    watch::{Event, Inotify},
};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    process::Command,
};

#[test]
fn kernel_overflow_rearms_every_new_directory_and_preserves_bytes() {
    assert!(!rustix::process::geteuid().is_root());
    let root = tempfile::tempdir().unwrap();
    assert!(Command::new("/usr/bin/git")
        .args(["init", "-q"])
        .arg(root.path())
        .status()
        .unwrap()
        .success());
    fs::write(root.path().join(".gitignore"), "node_modules/\nchurn\n").unwrap();
    for i in 0..200 {
        fs::write(root.path().join(format!("tracked-{i:03}.ts")), "before\n").unwrap();
    }
    let ignore = GitIgnore::new(root.path().into(), "/usr/bin/git".into(), vec![]).unwrap();
    let (mut watcher, _) = Inotify::new(File::open(root.path()).unwrap(), ignore).unwrap();
    let limit: usize = fs::read_to_string("/proc/sys/fs/inotify/max_queued_events")
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        limit <= 1_048_576,
        "queue limit too large for bounded qualification: {limit}"
    );
    // Alternating CREATE/CLOSE_WRITE/DELETE cannot coalesce into one event.
    // Ignored paths still fill the kernel queue but must not become activity.
    for _ in 0..=limit / 3 + 1 {
        fs::write(root.path().join("churn"), "ignored\n").unwrap();
        fs::remove_file(root.path().join("churn")).unwrap();
    }
    fs::create_dir(root.path().join("newdir")).unwrap();
    fs::create_dir(root.path().join("node_modules")).unwrap();
    fs::write(root.path().join("node_modules/hidden"), "ignored\n").unwrap();
    let mut expected = BTreeSet::from([".gitignore".to_string()]);
    for i in 0..200 {
        let path = format!("tracked-{i:03}.ts");
        fs::write(root.path().join(&path), format!("after {i}\n")).unwrap();
        expected.insert(path);
    }
    for i in 0..50 {
        let path = format!("newdir/file-{i:02}.ts");
        fs::write(root.path().join(&path), format!("new {i}\n")).unwrap();
        expected.insert(path);
    }
    let events = watcher.drain().unwrap();
    assert!(
        events.contains(&Event::Overflow),
        "real IN_Q_OVERFLOW was not delivered"
    );
    assert!(!events.iter().any(|e| matches!(e, Event::File { path, .. } if path == "churn" || path.starts_with("node_modules/"))));
    assert_eq!(
        watcher
            .rearm()
            .unwrap()
            .into_iter()
            .collect::<BTreeSet<_>>(),
        expected
    );
    for i in 0..200 {
        assert_eq!(
            watcher
                .read(&format!("tracked-{i:03}.ts"))
                .unwrap()
                .unwrap(),
            format!("after {i}\n").as_bytes()
        );
    }
    for i in 0..50 {
        assert_eq!(
            watcher
                .read(&format!("newdir/file-{i:02}.ts"))
                .unwrap()
                .unwrap(),
            format!("new {i}\n").as_bytes()
        );
    }
    fs::write(root.path().join("newdir/late.ts"), "late\n").unwrap();
    assert!(watcher
        .drain()
        .unwrap()
        .iter()
        .any(|e| matches!(e, Event::File { path, .. } if path == "newdir/late.ts")));
    assert_eq!(watcher.read("newdir/late.ts").unwrap().unwrap(), b"late\n");
}
