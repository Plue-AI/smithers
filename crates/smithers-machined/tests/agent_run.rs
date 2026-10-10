//! The agent command runner in a real Linux PTY (T-TRM-05). Production runs it
//! as `agent` (19999) under the broker; here it runs as the test user, which
//! exercises the same unprivileged code path. The broker's start byte is
//! written by this harness.
#![cfg(target_os = "linux")]
use rustix::pty::{grantpt, openpt, ptsname, unlockpt, OpenptFlags};
use smithers_machined::agent_run::{echo_line, session_argv};
use std::{
    fs::File,
    io::{Read, Write},
    os::fd::AsFd,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

struct Ran {
    output: String,
    status: std::process::ExitStatus,
}

fn run(spec: serde_json::Value, start: bool) -> Ran {
    let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY).unwrap();
    grantpt(&master).unwrap();
    unlockpt(&master).unwrap();
    let name = ptsname(&master, Vec::new()).unwrap();
    let slave = File::options()
        .read(true)
        .write(true)
        .open(name.to_str().unwrap())
        .unwrap();
    // As the broker does for the agent's terminal: no keyboard echo.
    let mut termios = rustix::termios::tcgetattr(slave.as_fd()).unwrap();
    termios
        .local_modes
        .remove(rustix::termios::LocalModes::ECHO | rustix::termios::LocalModes::ECHONL);
    rustix::termios::tcsetattr(
        slave.as_fd(),
        rustix::termios::OptionalActions::Now,
        &termios,
    )
    .unwrap();
    let argv = session_argv(&spec.to_string()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_smithers-machined"))
        .args(&argv[1..])
        .env("SMITHERS_API_KEY", "host-secret")
        .env("SMITHERS_MODEL_ROLE_IMPLEMENTER_KEY", "model-secret")
        .stdin(Stdio::from(slave.try_clone().unwrap()))
        .stdout(Stdio::from(slave.try_clone().unwrap()))
        .stderr(Stdio::from(slave))
        .spawn()
        .unwrap();
    let mut master = File::from(master);
    let mut output = Vec::new();
    if start {
        std::thread::sleep(Duration::from_millis(100));
        // Nothing reaches the terminal before the start byte.
        rustix::fs::fcntl_setfl(&master, rustix::fs::OFlags::NONBLOCK).unwrap();
        let mut early = [0u8; 64];
        assert!(
            master.read(&mut early).is_err(),
            "runner printed before its start byte"
        );
        rustix::fs::fcntl_setfl(&master, rustix::fs::OFlags::empty()).unwrap();
        master.write_all(b"\n").unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        let mut buf = [0u8; 4096];
        rustix::fs::fcntl_setfl(&master, rustix::fs::OFlags::NONBLOCK).unwrap();
        match master.read(&mut buf) {
            Ok(n) if n > 0 => output.extend_from_slice(&buf[..n]),
            _ => {
                if let Some(status) = child.try_wait().unwrap() {
                    // Drain what the child wrote before it exited.
                    while let Ok(n) = master.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        output.extend_from_slice(&buf[..n]);
                    }
                    break status;
                }
                assert!(Instant::now() < deadline, "runner did not finish");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    };
    Ran {
        output: String::from_utf8_lossy(&output).into_owned(),
        status,
    }
}

#[test]
fn runner_waits_for_its_start_byte_then_echoes_and_becomes_the_command() {
    let ran = run(
        serde_json::json!({
            "argv": ["/bin/sh", "-c", "printf 'out\\n'; printf 'err\\n' >&2; exit 7"],
            "echo": echo_line("printf out; printf err; exit 7"),
        }),
        true,
    );
    assert_eq!(
        ran.output,
        "$ printf out; printf err; exit 7\r\nout\r\nerr\r\n"
    );
    assert_eq!(ran.status.code(), Some(7));
}

#[test]
fn command_gets_team_style_environment_not_the_coding_host_secrets() {
    let ran = run(
        serde_json::json!({
            "argv": ["/bin/sh", "-c", "echo \"key=${SMITHERS_API_KEY-unset} model=${SMITHERS_MODEL_ROLE_IMPLEMENTER_KEY-unset} pager=$PAGER git=$GIT_PAGER ci=$CI foo=$FOO tty=$(test -t 0 && echo yes || echo no)\""],
            "env": {"FOO": "bar"},
            "echo": "$ env",
        }),
        true,
    );
    assert_eq!(
        ran.output,
        "$ env\r\nkey=unset model=unset pager=cat git=cat ci=1 foo=bar tty=no\r\n"
    );
    assert!(ran.status.success());
}

#[test]
fn stdin_text_cwd_and_missing_programs_behave_like_a_shell() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("marker"), "here").unwrap();
    let script = "import sys\nprint(sys.stdin.read().strip()[::-1])\n";
    let python = ["python3", "/usr/bin/python3"].into_iter().find(|p| {
        Command::new(p)
            .arg("-c")
            .arg("0")
            .status()
            .is_ok_and(|s| s.success())
    });
    if let Some(python) = python {
        let ran = run(
            serde_json::json!({"argv": [python, "-c", "import sys; print(sys.stdin.read()[::-1])"], "stdin": "abc", "echo": "$ python3 -"}),
            true,
        );
        assert_eq!(ran.output, "$ python3 -\r\ncba\r\n");
    }
    let large = "x".repeat(50_000);
    let ran = run(
        serde_json::json!({"argv": ["/bin/sh", "-c", "wc -c"], "stdin": large, "echo": "$ wc -c"}),
        true,
    );
    assert_eq!(ran.output.trim_end(), "$ wc -c\r\n50000");
    let _ = script;
    let ran = run(
        serde_json::json!({"argv": ["/bin/sh", "-c", "cat marker; pwd"], "cwd": dir.path(), "echo": "$ cat marker"}),
        true,
    );
    assert_eq!(
        ran.output,
        format!("$ cat marker\r\nhere{}\r\n", dir.path().display())
    );
    let ran = run(
        serde_json::json!({"argv": ["/bin/sh"], "cwd": dir.path().join("missing"), "echo": "$ sh"}),
        true,
    );
    assert!(
        ran.output.starts_with("$ sh\r\nsmithers: "),
        "{}",
        ran.output
    );
    assert_eq!(ran.status.code(), Some(1));
    let ran = run(
        serde_json::json!({"argv": ["definitely-not-a-program-t-trm-05"], "echo": "$ nope"}),
        true,
    );
    assert!(
        ran.output
            .starts_with("$ nope\r\nsmithers: definitely-not-a-program-t-trm-05"),
        "{}",
        ran.output
    );
    assert_eq!(ran.status.code(), Some(127));
}

#[test]
fn malformed_spec_prints_no_echo_and_runs_nothing() {
    let master_spec = serde_json::json!({"argv": ["/bin/sh", "-c", "touch should-not-exist"], "echo": "no dollar"});
    let ran = run(master_spec, false);
    assert!(!ran.output.contains("no dollar"));
    assert!(!ran.status.success());
    assert!(!std::path::Path::new("should-not-exist").exists());
}
