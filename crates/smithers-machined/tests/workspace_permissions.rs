//! Guest filesystem contract, exercised through real jj init and snapshots.
#![cfg(target_os = "linux")]
use jj_lib::{config::StackedConfig, settings::UserSettings, workspace::Workspace};
use pollster::FutureExt;
use std::{
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    process::Command,
};

#[test]
fn workspace_publication_is_group_shared_and_confined() {
    let executable = std::env::current_exe().unwrap();
    let result = Command::new("bwrap")
        .args([
            "--tmpfs",
            "/",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind",
            "/lib64",
            "/lib64",
            "--symlink",
            "usr/bin",
            "/bin",
            "--ro-bind",
            "/etc",
            "/etc",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--unshare-user",
            "--uid",
            "0",
            "--gid",
            "20000",
            "--die-with-parent",
            "--tmpfs",
            "/workspace",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            "/workspace-escape",
            "--ro-bind",
        ])
        .arg(&executable)
        .arg(&executable)
        .arg("--")
        .arg(&executable)
        .args([
            "--exact",
            "workspace_permissions_child",
            "--ignored",
            "--nocapture",
        ])
        .output()
        .expect("bubblewrap is required for the guest permission regression");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

fn publish(parent: &Path, content_addressed: bool) -> fs::File {
    let mut temporary = tempfile::NamedTempFile::new_in(parent).unwrap();
    assert_eq!(
        temporary.as_file().metadata().unwrap().mode() & 0o777,
        0o600
    );
    temporary.write_all(b"repository state").unwrap();
    if content_addressed {
        jj_lib::file_util::persist_content_addressed_temp_file(temporary, parent.join("published"))
            .unwrap()
    } else {
        jj_lib::file_util::persist_temp_file(temporary, parent.join("published")).unwrap()
    }
}

fn shared(path: &Path) {
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        let meta = fs::symlink_metadata(&path).unwrap();
        if meta.is_dir() {
            assert_eq!(meta.gid(), 20000, "{}", path.display());
            assert_eq!(meta.mode() & 0o2070, 0o2070, "{}", path.display());
            shared(&path);
        } else if meta.is_file() {
            assert_eq!(meta.gid(), 20000, "{}", path.display());
            assert_ne!(meta.mode() & 0o040, 0, "unreadable: {}", path.display());
            if path.starts_with("/workspace/.jj") || path.starts_with("/workspace/.git") {
                assert_ne!(
                    meta.mode() & 0o020,
                    0,
                    "not group writable: {}",
                    path.display()
                );
            }
            fs::read(&path).unwrap();
        }
    }
}

#[test]
#[ignore = "child in an isolated user/mount namespace; not real two-UID evidence"]
fn workspace_permissions_child() {
    let workspace = Path::new("/workspace");
    fs::set_permissions(workspace, fs::Permissions::from_mode(0o2775)).unwrap();
    rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o077));
    // Startup sets the mask before composing any providers; this namespace
    // deliberately lacks the production daemon identity and broker.
    assert!(smithers_machined::installed::run().is_err());
    let mask = rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o002));
    assert_eq!(mask.as_raw_mode(), 0o002);
    let settings = UserSettings::from_config(StackedConfig::with_defaults()).unwrap();
    Workspace::init_colocated_git(&settings, workspace, gix::hash::Kind::Sha1)
        .block_on()
        .unwrap();
    shared(workspace);
    assert_eq!(
        fs::metadata(workspace.join(".git/config")).unwrap().mode() & 0o660,
        0o660,
        "Git configuration must remain writable by the shared team"
    );
    for body in ["first", "second"] {
        fs::write(workspace.join("file"), body).unwrap();
        flows_jj::ops::snapshot(workspace, None).unwrap();
        shared(workspace);
        for name in ["tree_state", "checkout"] {
            assert_eq!(
                fs::metadata(workspace.join(".jj/working_copy").join(name))
                    .unwrap()
                    .mode()
                    & 0o660,
                0o660
            );
        }
    }
    fs::write(workspace.join("executable"), "#!/bin/sh\n").unwrap();
    fs::set_permissions(
        workspace.join("executable"),
        fs::Permissions::from_mode(0o775),
    )
    .unwrap();
    let saved = flows_jj::ops::snapshot(workspace, None).unwrap();
    fs::remove_file(workspace.join("executable")).unwrap();
    fs::write(workspace.join("file"), "changed").unwrap();
    flows_jj::ops::snapshot(workspace, None).unwrap();
    flows_jj::ops::restore(workspace, &saved.commit_id).unwrap();
    shared(workspace);
    assert_eq!(
        fs::read_to_string(workspace.join("file")).unwrap(),
        "second"
    );
    assert_eq!(
        fs::metadata(workspace.join("file")).unwrap().mode() & 0o777,
        0o664
    );
    assert_eq!(
        fs::metadata(workspace.join("executable")).unwrap().mode() & 0o777,
        0o775
    );
    for content_addressed in [false, true] {
        for parent in [workspace.join(".jj"), workspace.join(".git")] {
            let file = publish(&parent, content_addressed);
            assert_eq!(file.metadata().unwrap().mode() & 0o777, 0o660);
        }
        // Neither similarly prefixed directories nor a workspace symlink may
        // make private files outside the shared root group-readable.
        let outside = Path::new("/workspace-escape");
        assert_eq!(
            publish(outside, content_addressed)
                .metadata()
                .unwrap()
                .mode()
                & 0o777,
            0o600
        );
        let link = workspace.join("outside");
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(outside, &link).unwrap();
        assert_eq!(
            publish(&link, content_addressed).metadata().unwrap().mode() & 0o777,
            0o600
        );
    }
    // The Git-object grant must not affect another repository, even when its
    // name starts with /workspace. gix's original immutable mode stays intact.
    let outside = Path::new("/workspace-escape");
    Workspace::init_colocated_git(&settings, outside, gix::hash::Kind::Sha1)
        .block_on()
        .unwrap();
    fs::write(outside.join("file"), "outside blob").unwrap();
    flows_jj::ops::snapshot(outside, None).unwrap();
    let mut objects = 0;
    for dir in fs::read_dir(outside.join(".git/objects")).unwrap() {
        let dir = dir.unwrap();
        if dir.file_name().len() != 2 {
            continue;
        }
        for file in fs::read_dir(dir.path()).unwrap() {
            let file = file.unwrap();
            assert_eq!(file.metadata().unwrap().mode() & 0o777, 0o444);
            objects += 1;
        }
    }
    assert!(objects > 0);

    // A temporary inode with a second name cannot widen an existing file's
    // access. The rejection leaves both the private mode and target intact.
    let temporary = tempfile::NamedTempFile::new_in(workspace).unwrap();
    fs::hard_link(temporary.path(), workspace.join("alias")).unwrap();
    let error =
        jj_lib::file_util::persist_temp_file(temporary, workspace.join("denied")).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(
        fs::metadata(workspace.join("alias")).unwrap().mode() & 0o777,
        0o600
    );
    assert!(!workspace.join("denied").exists());

    // No workspace grant when the root loses the provisioned setgid contract.
    fs::set_permissions(workspace, fs::Permissions::from_mode(0o775)).unwrap();
    assert_eq!(
        publish(workspace, false).metadata().unwrap().mode() & 0o777,
        0o600
    );
}
