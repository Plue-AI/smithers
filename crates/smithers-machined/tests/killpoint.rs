//! Design §9: fault hooks abort only in an explicitly enabled build.
#[test]
fn killpoint_requires_feature_and_exact_name() {
    if std::env::var_os("MACHINED_KILLPOINT_FIXTURE_CHILD").is_some() {
        smithers_machined::killpoint!("fixture");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    for name in ["other", "fixture"] {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "killpoint_requires_feature_and_exact_name"])
            .env("MACHINED_KILLPOINT_FIXTURE_CHILD", "1")
            .env("SMITHERS_MACHINED_KILL_AT", name)
            .current_dir(dir.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert_eq!(
            status.success(),
            name != "fixture" || !cfg!(feature = "killpoints")
        );
        #[cfg(unix)]
        if name == "fixture" && cfg!(feature = "killpoints") {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(6));
        }
    }
}
