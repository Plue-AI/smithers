//! The coding host parses the helper's whole stdout as one JSON receipt
//! (flows/coding/native.ts), so a source import must print nothing else. Only
//! a trusted-process build reads a binding outside root-owned /etc/smithers.
#![cfg(all(unix, feature = "trusted-process-binding"))]

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn run(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Source Test")
        .env("GIT_AUTHOR_EMAIL", "source@example.invalid")
        .env("GIT_COMMITTER_NAME", "Source Test")
        .env("GIT_COMMITTER_EMAIL", "source@example.invalid")
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{program} {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// Serves `root` read-only over Git's dumb HTTP protocol. The built helper
/// fetches only over http(s); its unit tests alone may use a local path.
fn serve(root: PathBuf) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let mut header = String::new();
            while reader.read_line(&mut header).is_ok_and(|read| read > 2) {
                header.clear();
            }
            let path = line.split(' ').nth(1).unwrap_or("").split('?').next();
            let body = path
                .filter(|path| !path.contains(".."))
                .and_then(|path| fs::read(root.join(path.trim_start_matches('/'))).ok());
            let mut stream = &stream;
            let _ = match body {
                Some(body) => write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .and_then(|()| stream.write_all(&body)),
                None => stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                ),
            };
        }
    });
    port
}

#[test]
fn import_source_answers_only_its_json_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let owned = root.join("owned");
    let foreign = root.join("foreign");
    let served = root.join("served/local/mirror.git");
    run("jj", &["git", "init", text(&owned)]);
    run("git", &["init", "-q", text(&foreign)]);
    fs::write(foreign.join("code.txt"), "base\n").unwrap();
    run("git", &["-C", text(&foreign), "add", "code.txt"]);
    run("git", &["-C", text(&foreign), "commit", "-q", "-m", "base"]);
    let sha = run("git", &["-C", text(&foreign), "rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let workspace = "22222222-2222-4222-8222-222222222222";
    let reference = format!("refs/smithers/workspaces/{workspace}/sources/{sha}");
    run("git", &["init", "-q", "--bare", text(&served)]);
    let refspec = format!("{sha}:{reference}");
    run(
        "git",
        &["-C", text(&foreign), "push", "-q", text(&served), &refspec],
    );
    run("git", &["--git-dir", text(&served), "update-server-info"]);
    let origin = format!("http://127.0.0.1:{}", serve(root.join("served")));
    let binding = root.join("workspace-coding.json");
    let config = json!({"version":1, "workspaceId":workspace, "repositoryId":42, "actorId":42,
        "repositoryPath":owned, "repositorySlug":"local/mirror", "apiBaseUrl":format!("{origin}/api"),
        "gitUrl":format!("{origin}/local/mirror.git"), "credentialSocket":"/tmp/source-import-test-socket"});
    fs::write(&binding, config.to_string()).unwrap();
    fs::set_permissions(&binding, fs::Permissions::from_mode(0o600)).unwrap();
    let request = json!({"operation":"import_source", "repositoryPath":owned,
        "requestId":"11111111-1111-4111-8111-111111111111",
        "commits":[{"commitId":sha, "ref":reference}]});
    let mut child = Command::new(env!("CARGO_BIN_EXE_smithers-jj-export"))
        .arg("--local")
        .env("SMITHERS_WORKSPACE_CODING_CONFIG", &binding)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "stdout: {stdout} stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // One value and trailing whitespace: any other byte fails the host's parse.
    let receipt: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("stdout is not one JSON receipt ({error}): {stdout:?}"));
    assert_eq!(receipt["status"], "imported", "{receipt}");
    assert_eq!(receipt["revisions"][0]["commitId"], sha, "{receipt}");
}
