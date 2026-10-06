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
