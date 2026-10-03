// Oracles: spec.md §9.2.2: 200 ms after last update, 1 s maximum; fsync + rename preserves exact text.
use super::{Debounce, apply, persist, seed, seeded_doc, snapshot};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use yrs::{ReadTxn, Text, Transact};

#[test]
fn fixture_seeds_the_exact_utf8_document() {
    let fixture = seed();
    assert!(
        fixture.len() >= 4096,
        "fixture must exercise a multi-kilobyte file"
    );
    let (doc, _) = seeded_doc();
    assert_eq!(snapshot(&doc), fixture);
}

#[test]
fn real_yrs_edit_update_converges_and_duplicate_delivery_is_idempotent() {
    let (source, text) = seeded_doc();
    let (target, _) = seeded_doc();
    let baseline = source.transact().state_vector();
    {
        let mut txn = source.transact_mut();
        text.insert(&mut txn, 0, "雪🙂 café\n");
    }
    let update = STANDARD.encode(source.transact().encode_state_as_update_v1(&baseline));
    apply(&target, &update).expect("valid V1 update");
    assert_eq!(snapshot(&target), format!("雪🙂 café\n{}", seed()));
    assert_eq!(snapshot(&target), snapshot(&source));
    apply(&target, &update).expect("duplicate valid update");
    assert_eq!(snapshot(&target), snapshot(&source));
}

#[test]
fn invalid_base64_and_invalid_yrs_updates_leave_document_unchanged() {
    let (doc, _) = seeded_doc();
    let before = snapshot(&doc);
    for update in [
        "%%%".to_owned(),
        "".to_owned(),
        STANDARD.encode([255, 255, 255]),
    ] {
        assert!(
            apply(&doc, &update).is_err(),
            "accepted malformed update {update:?}"
        );
        assert_eq!(snapshot(&doc), before);
    }
}

#[test]
fn persistence_replaces_the_file_with_exact_utf8_and_preserves_mode() {
    let dir = TempDir::new();
    let path = dir.0.join("source.ts");
    fs::write(&path, "old\n").unwrap();
    #[cfg(unix)]
    let original_inode = {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        fs::set_permissions(&path, fs::Permissions::from_mode(0o751)).unwrap();
        fs::metadata(&path).unwrap().ino()
    };
    let (doc, text) = seeded_doc();
    {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, "雪🙂 café\n");
    }
    persist(&path, &doc, &text).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), snapshot(&doc));
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::metadata(&path).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o751);
        assert_ne!(
            metadata.ino(),
            original_inode,
            "must atomically replace the old file"
        );
    }
    let entries: Vec<_> = fs::read_dir(&dir.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        entries,
        vec![path.file_name().unwrap().to_owned()],
        "save left a temporary file"
    );
}

#[test]
fn persistence_reports_io_failure() {
    let dir = TempDir::new();
    let path = dir.0.join("absent-parent").join("source.ts");
    let (doc, text) = seeded_doc();
    assert!(persist(&path, &doc, &text).is_err());
    assert!(!path.exists());
}

#[test]
fn debounce_has_exact_idle_boundary_and_reset() {
    let start = Instant::now();
    let mut debounce = Debounce::new();
    assert_eq!(debounce.deadline(), None);
    debounce.update(start);
    assert_eq!(
        debounce.deadline(),
        Some(start + Duration::from_millis(200))
    );
    debounce.update(start + Duration::from_millis(199));
    assert_eq!(
        debounce.deadline(),
        Some(start + Duration::from_millis(399))
    );
    debounce.saved();
    assert_eq!(debounce.deadline(), None);
    debounce.update(start + Duration::from_millis(500));
    assert_eq!(
        debounce.deadline(),
        Some(start + Duration::from_millis(700))
    );
}

#[test]
fn debounce_cannot_starve_under_continuous_edits() {
    let start = Instant::now();
    let mut debounce = Debounce::new();
    debounce.update(start);
    for elapsed in [199, 398, 597, 796, 995, 1194] {
        debounce.update(start + Duration::from_millis(elapsed));
        let expected = (elapsed + 200).min(1000);
        assert_eq!(
            debounce.deadline(),
            Some(start + Duration::from_millis(expected))
        );
    }
    debounce.saved();
    debounce.update(start + Duration::from_millis(2000));
    assert_eq!(
        debounce.deadline(),
        Some(start + Duration::from_millis(2200))
    );
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "col01-dochost-tests-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
