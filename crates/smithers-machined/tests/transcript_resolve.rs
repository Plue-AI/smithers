//! Startup reconciliation through the install-shipped owner resolver. No
//! privilege drop is claimed here: this executable already runs as its owner.
#![cfg(target_os = "linux")]

use smithers_machined::transcript::{
    discovery::{Agent, Link},
    resolve::{self, Request, Resolved},
};
use std::{
    fs, io,
    os::unix::{fs::symlink, net::UnixStream},
    process::{Command, Stdio},
    time::Duration,
};

fn ask(request: &Request) -> io::Result<Option<Resolved>> {
    let (socket, child_socket) = UnixStream::pair()?;
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut child = Command::new(env!("CARGO_BIN_EXE_smithers-machined"))
        .arg("transcript-resolve")
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::from(std::os::fd::OwnedFd::from(
            child_socket.try_clone()?,
        )))
        .stdout(Stdio::from(std::os::fd::OwnedFd::from(child_socket)))
        .stderr(Stdio::null())
        .spawn()?;
    let answer = resolve::ask(&socket, request);
    // A refused or not-yet request intentionally exits unsuccessfully. Reap
    // it in every case, including a broken protocol, without leaving a child.
    drop(socket);
    let _ = child.kill();
    child.wait()?;
    answer
}

fn request(root: &std::path::Path, agent: Agent, link: Link) -> Request {
    Request {
        uid: rustix::process::geteuid().as_raw(),
        gid: rustix::process::getegid().as_raw(),
        groups: rustix::process::getgroups()
            .unwrap()
            .into_iter()
            .map(|group| group.as_raw())
            .collect(),
        root: root.to_str().unwrap().into(),
        agent,
        pid: 777,
        link,
    }
}

#[test]
fn claude_startup_waits_for_its_root_session_and_first_prompt() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".claude");
    let request = request(&root, Agent::ClaudeCode, Link::SessionFile);
    // All three are normal startup states, even after many reconciliations.
    // They must not drive the broker's exponential hard-failure backoff.
    for _ in 0..4 {
        assert_eq!(ask(&request).unwrap(), None);
    }
    fs::create_dir_all(root.join("sessions")).unwrap();
    assert_eq!(ask(&request).unwrap(), None);
    fs::write(root.join("sessions/777.json"), r#"{"pid":777,"sessionId":"889e416d-fda3-42c0-869a-56b3ced78a05","cwd":"/workspace","version":"2.1.291"}"#).unwrap();
    assert_eq!(ask(&request).unwrap(), None);
    let path = "projects/-workspace/889e416d-fda3-42c0-869a-56b3ced78a05.jsonl";
    fs::create_dir_all(root.join("projects/-workspace")).unwrap();
    fs::write(root.join(path), "{\"type\":\"mode\"}\n").unwrap();
    assert_eq!(
        ask(&request).unwrap(),
        Some(Resolved {
            path: path.into(),
            release: "2.1.291".into()
        })
    );
    // Missing and hostile inputs must remain distinct. The resolver does not
    // follow an existing symlink or treat malformed metadata as startup.
    fs::write(root.join("sessions/777.json"), "not json").unwrap();
    assert!(ask(&request).is_err());
    fs::remove_file(root.join("sessions/777.json")).unwrap();
    let sentinel = home.path().join("sentinel");
    fs::write(&sentinel, "outside sentinel\n").unwrap();
    symlink(&sentinel, root.join("sessions/777.json")).unwrap();
    assert!(ask(&request).is_err());
    assert_eq!(fs::read_to_string(sentinel).unwrap(), "outside sentinel\n");
}

#[test]
fn codex_startup_waits_for_the_linked_rollout_then_refuses_bad_metadata() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".codex");
    let path = "sessions/2026/10/09/rollout-startup.jsonl";
    let request = request(&root, Agent::Codex, Link::Rollout(path.into()));
    assert_eq!(ask(&request).unwrap(), None);
    fs::create_dir_all(root.join("sessions/2026/10/09")).unwrap();
    assert_eq!(ask(&request).unwrap(), None);
    fs::write(root.join(path), "{\"type\":\"session_meta\"").unwrap();
    assert_eq!(ask(&request).unwrap(), None);
    fs::write(
        root.join(path),
        "{\"type\":\"session_meta\",\"payload\":{\"cli_version\":\"0.160.1\"}}\n",
    )
    .unwrap();
    assert_eq!(
        ask(&request).unwrap(),
        Some(Resolved {
            path: path.into(),
            release: "0.160.1".into()
        })
    );
    fs::write(
        root.join(path),
        "{\"type\":\"turn_context\",\"payload\":{}}\n",
    )
    .unwrap();
    assert!(ask(&request).is_err());
}
