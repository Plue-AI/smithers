#![cfg(target_os = "linux")]
use smithers_machined::{
    ignore::GitIgnore,
    watch::{Event, Inotify},
};
use std::{
    fs::{self, File},
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "machined-watch-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        assert!(Command::new("/usr/bin/git")
            .args(["init", "-q"])
            .arg(&p)
            .status()
            .unwrap()
            .success());
        fs::write(p.join(".gitignore"), "node_modules/\ntarget/\n*.tmp\n").unwrap();
        Self(p)
    }
    fn watcher(&self) -> Inotify<GitIgnore> {
        let ignore = GitIgnore::new(self.0.clone(), "/usr/bin/git".into(), vec![]).unwrap();
        Inotify::new(File::open(&self.0).unwrap(), ignore)
            .unwrap()
            .0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn paths(events: Vec<Event>) -> Vec<String> {
    events
        .into_iter()
        .filter_map(|e| match e {
            Event::File { path, .. } => Some(path),
            _ => None,
        })
        .collect()
}
#[test]
fn real_close_write_new_directory_scan_and_ignored_paths() {
    assert!(!rustix::process::geteuid().is_root());
    let f = Fixture::new();
    let mut w = f.watcher();
    fs::write(f.0.join("a"), b"literal bytes").unwrap();
    fs::create_dir(f.0.join("d")).unwrap();
    fs::write(f.0.join("d/x"), b"created before watch arm").unwrap();
    for dir in ["node_modules", "target"] {
        fs::create_dir(f.0.join(dir)).unwrap();
        fs::write(f.0.join(dir).join("hidden"), b"ignored").unwrap();
    }
    fs::write(f.0.join("save.tmp"), b"temporary").unwrap();
    let p = paths(w.drain().unwrap());
    assert!(p.contains(&"a".into()));
    assert!(p.contains(&"d/x".into()));
    assert!(!p
        .iter()
        .any(|p| p.contains("hidden") || p.ends_with(".tmp")));
    assert_eq!(
        w.read("d/x").unwrap(),
        Some(b"created before watch arm".to_vec())
    );
    fs::write(f.0.join("d/y"), b"later").unwrap();
    assert!(paths(w.drain().unwrap()).contains(&"d/y".into()));
}
#[test]
fn rename_cookie_metadata_and_invalid_utf8_are_separate() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new();
    fs::write(f.0.join("a"), b"before").unwrap();
    let mut w = f.watcher();
    fs::rename(f.0.join("a"), f.0.join("b")).unwrap();
    let events = w.drain().unwrap();
    let from = events
        .iter()
        .find_map(|e| match e {
            Event::File {
                path,
                cookie,
                from: true,
                ..
            } if path == "a" => Some(*cookie),
            _ => None,
        })
        .unwrap();
    assert_ne!(from, 0);
    assert!(events
        .iter()
        .any(|e| matches!(e,Event::File{path,cookie,to:true,..} if path=="b" && *cookie==from)));
    fs::write(f.0.join(".git/HEAD"), b"ref: refs/heads/test\n").unwrap();
    fs::write(f.0.join(".git/config"), b"[core]\n\tbare = false\n").unwrap();
    let bad = f.0.join(std::ffi::OsString::from_vec(vec![b'x', 255]));
    fs::write(&bad, b"preserved").unwrap();
    let events = w.drain().unwrap();
    assert!(events.contains(&Event::Metadata));
    assert!(paths(events).is_empty());
    assert_eq!(fs::read(bad).unwrap(), b"preserved");
    assert!(w.rearm().unwrap().contains(&"b".into()));
}
#[test]
fn descriptor_reads_refuse_traversal_symlink_and_nonregular() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let w = f.watcher();
    symlink("/etc/passwd", f.0.join("escape")).unwrap();
    symlink("/etc", f.0.join("dir")).unwrap();
    for path in [
        "../etc/passwd",
        "/etc/passwd",
        "escape",
        "dir/passwd",
        ".git",
    ] {
        assert!(w.read(path).is_err(), "{path}");
    }
}

#[test]
fn metadata_created_after_startup_and_replaced_directories_stay_watched() {
    let f = Fixture::new();
    let mut w = f.watcher();
    fs::create_dir_all(f.0.join(".jj/repo/op_heads/heads")).unwrap();
    fs::write(f.0.join(".jj/repo/op_heads/heads/op1"), b"operation").unwrap();
    let events = w.drain().unwrap();
    assert!(events.contains(&Event::Metadata));
    assert!(paths(events).is_empty());
    fs::write(f.0.join(".jj/repo/op_heads/heads/op2"), b"next operation").unwrap();
    let events = w.drain().unwrap();
    assert!(!events.is_empty());
    assert!(events.iter().all(|e| *e == Event::Metadata));
    // Shallow ancestor watches must not turn jj's store into metadata traffic.
    fs::create_dir_all(f.0.join(".jj/repo/store")).unwrap();
    fs::write(f.0.join(".jj/repo/store/object"), b"internal").unwrap();
    assert!(w.drain().unwrap().is_empty());
    for dir in [".git/refs", ".jj/repo/op_heads/heads"] {
        fs::rename(f.0.join(dir), f.0.join(format!("{dir}-old"))).unwrap();
        fs::create_dir_all(f.0.join(dir)).unwrap();
        let events = w.drain().unwrap();
        assert!(events.contains(&Event::Metadata), "{dir}");
        assert!(paths(events).is_empty());
        fs::write(f.0.join(dir).join("next"), b"new head").unwrap();
        let events = w.drain().unwrap();
        assert!(!events.is_empty(), "{dir}");
        assert!(events.iter().all(|e| *e == Event::Metadata), "{dir}");
        fs::remove_dir_all(f.0.join(dir)).unwrap();
        let events = w.drain().unwrap();
        assert!(events.contains(&Event::Metadata), "removed {dir}");
        assert!(paths(events).is_empty());
        fs::create_dir_all(f.0.join(dir)).unwrap();
        assert!(w.drain().unwrap().contains(&Event::Metadata));
        fs::write(f.0.join(dir).join("recreated"), b"head after deletion").unwrap();
        let events = w.drain().unwrap();
        assert!(!events.is_empty(), "recreated {dir}");
        assert!(events.iter().all(|e| *e == Event::Metadata), "{dir}");
    }
}

#[test]
fn daemon_checkpoint_refs_do_not_look_like_branch_moves() {
    let f = Fixture::new();
    let mut watcher = f.watcher();
    fs::create_dir_all(f.0.join(".git/refs/smithers/watcher")).unwrap();
    fs::write(
        f.0.join(".git/refs/smithers/watcher/current"),
        "a".repeat(40),
    )
    .unwrap();
    assert!(!watcher.drain().unwrap().contains(&Event::Metadata));
    // Re-arming after overflow must not start watching our private subtree.
    watcher.rearm().unwrap();
    fs::write(
        f.0.join(".git/refs/smithers/watcher/current"),
        "b".repeat(40),
    )
    .unwrap();
    assert!(!watcher.drain().unwrap().contains(&Event::Metadata));
    fs::write(f.0.join(".git/refs/heads/topic"), "c".repeat(40)).unwrap();
    assert!(watcher.drain().unwrap().contains(&Event::Metadata));
}

#[test]
fn retained_document_save_inodes_are_not_file_activity() {
    let f = Fixture::new();
    let mut watcher = f.watcher();
    let saved = format!(".smithers-doc-{}-{}", "a".repeat(64), "b".repeat(32));
    let ordinary = format!("{saved}-notes");
    for name in [&saved, &ordinary] {
        fs::write(f.0.join(name), b"bytes").unwrap();
    }
    let changed = paths(watcher.drain().unwrap());
    assert!(!changed.contains(&saved));
    assert!(changed.contains(&ordinary));
    let scan = watcher.rearm().unwrap();
    assert!(!scan.contains(&saved));
    assert!(scan.contains(&ordinary));
}

#[test]
fn ignore_batch_excludes_replaced_symlink_parent_without_hiding_regular_paths() {
    use smithers_machined::ignore::Ignore;
    let f = Fixture::new();
    std::os::unix::fs::symlink("/etc", f.0.join("replaced")).unwrap();
    fs::write(f.0.join("ordinary"), b"visible").unwrap();
    let mut ignore = GitIgnore::new(f.0.clone(), "/usr/bin/git".into(), vec![]).unwrap();
    assert_eq!(
        ignore
            .batch(&[
                ("replaced/".into(), true),
                ("ordinary".into(), false),
                ("node_modules/hidden".into(), false),
            ])
            .unwrap(),
        vec![true, false, true]
    );
    fs::remove_file(f.0.join("replaced")).unwrap();
    fs::create_dir(f.0.join("replaced")).unwrap();
    fs::write(f.0.join("replaced/file"), b"returned").unwrap();
    assert_eq!(
        ignore.batch(&[("replaced/file".into(), false)]).unwrap(),
        vec![false]
    );
    let mut watcher = f.watcher();
    assert_eq!(
        watcher.read("replaced/file").unwrap(),
        Some(b"returned".to_vec())
    );
    fs::rename(f.0.join("replaced"), f.0.join("held")).unwrap();
    std::os::unix::fs::symlink("/etc", f.0.join("replaced")).unwrap();
    assert!(watcher.read("replaced/passwd").is_err());
    watcher.rearm().unwrap();
}
