//! Unprivileged executable refusal controls, not real-VM security receipts.
use std::{fs, process::Command};
#[test]
fn branch_executable_refuses_every_privileged_entrypoint_before_canary_use() {
    assert_ne!(unsafe { libc::geteuid() }, 0);
    let base = std::env::temp_dir().join(format!("trm06-entrypoint-{}", std::process::id()));
    fs::create_dir(&base).unwrap();
    let sentinel = base.join("outside");
    fs::write(&sentinel, b"outside-fixture\0").unwrap();
    let original = fs::metadata(&sentinel).unwrap();
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    for name in ["groupadd", "useradd", "sh", "supervisor"] {
        let path = base.join(name);
        fs::write(
            &path,
            format!("#!/bin/sh\nprintf canary >> '{}'\n", sentinel.display()),
        )
        .unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    for args in [
        vec![],
        vec!["--init"],
        vec!["--serve"],
        vec!["--tcp-worker", "3000"],
        vec!["--serve", "--uid=0"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_trm06-supervisor"))
            .args(args)
            .env_clear()
            .env("PATH", &base)
            .env("HOME", &base)
            .env("TRM06_ACCEPTED", "1")
            .current_dir(&base)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(78));
        assert!(output.stdout.is_empty());
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside-fixture\0");
        let after = fs::metadata(&sentinel).unwrap();
        assert_eq!(after.uid(), original.uid());
        assert_eq!(after.mode(), original.mode());
    }
    fs::remove_dir_all(base).unwrap();
}
