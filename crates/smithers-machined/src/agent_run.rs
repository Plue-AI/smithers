//! One coding-agent command in its own local terminal (T-TRM-05, spec §8.11.2a).
//!
//! `smithers-machined client pty` opens the agent's PTY on the local socket with
//! this runner as its argv. The broker has already dropped to `agent` (19999)
//! and `session-exec` has applied the run's binding, so every byte below is
//! branch/model-sourced input consumed unprivileged. The runner:
//!
//! 1. waits for the broker's start newline (the host's Terminal card is
//!    attached by then, or the broker gave up waiting);
//! 2. prints the echo line, so the card shows the command before its output;
//! 3. replaces itself with the command, with the team's session environment
//!    (spec §8.8.1), never the coding host's private one.
//!
//! The session's exit is the command's exit: completion comes from the
//! broker's waitpid, never from parsing terminal output.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io;

/// The fixed installed runner path and verb.
pub const RUNNER: &str = "/opt/smithers/bin/smithers-machined";
pub const VERB: &str = "agent-run";
/// ADR 0004 `str` values are at most 4096 bytes.
const CHUNK: usize = 4096;
/// Leaves room for the open_session header fields inside one args6 body.
pub const MAX_SPEC_BYTES: usize = 60 * 1024;
/// The longest command shown on the echo line.
const MAX_ECHO_CHARS: usize = 2048;

/// What the coding host asks one terminal command to run.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    /// The program and its arguments, already planned by the Bash flow.
    pub argv: Vec<String>,
    /// Working directory, relative to `/workspace` unless absolute.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The caller's environment overrides.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Text for standard input; absent means `/dev/null`.
    #[serde(default)]
    pub stdin: Option<String>,
    /// The printable line the terminal shows first.
    pub echo: String,
}

fn invalid() -> io::Error {
    io::ErrorKind::InvalidInput.into()
}

fn env_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 256
        && k.bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i != 0 && c.is_ascii_digit()))
}

/// The echo line for a logical invocation: `$ ` and the command, with every
/// control character replaced so the line is one row of plain text.
pub fn echo_line(display: &str) -> String {
    let mut line = String::from("$ ");
    for (i, c) in display.chars().enumerate() {
        if i == MAX_ECHO_CHARS {
            line.push('…');
            break;
        }
        line.push(match c {
            '\n' => '⏎',
            '\t' => ' ',
            c if c.is_control() => '\u{FFFD}',
            c => c,
        });
    }
    line
}

impl Spec {
    /// Every value the runner consumes, checked before anything executes.
    pub fn validate(&self) -> io::Result<()> {
        let text = |s: &str| !s.contains('\0');
        if self.argv.is_empty()
            || self.argv[0].is_empty()
            || !self.argv.iter().all(|a| text(a))
            || self
                .cwd
                .as_deref()
                .is_some_and(|c| c.is_empty() || !text(c))
            || !self.env.iter().all(|(k, v)| env_key(k) && text(v))
            || self.stdin.as_deref().is_some_and(|s| !text(s))
            || !self.echo.starts_with("$ ")
            || self.echo.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        Ok(())
    }

    /// Decode the runner's argv tail (JSON split into `str`-sized chunks).
    pub fn from_args(args: &[String]) -> io::Result<Self> {
        let json: String = args.concat();
        if args.is_empty() || json.len() > MAX_SPEC_BYTES {
            return Err(invalid());
        }
        let spec: Self = serde_json::from_str(&json).map_err(|_| invalid())?;
        spec.validate()?;
        Ok(spec)
    }
}

/// The session argv for one command: the fixed runner, then the spec JSON in
/// UTF-8-safe chunks of at most one ADR 0004 string each.
pub fn session_argv(spec_json: &str) -> io::Result<Vec<String>> {
    if spec_json.is_empty() || spec_json.len() > MAX_SPEC_BYTES {
        return Err(invalid());
    }
    let mut argv = vec![RUNNER.to_owned(), VERB.to_owned()];
    let mut rest = spec_json;
    while !rest.is_empty() {
        let mut end = rest.len().min(CHUNK);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        argv.push(rest[..end].to_owned());
        rest = &rest[end..];
    }
    Ok(argv)
}

/// The command's environment: the run's base, the team's session secrets
/// (spec §8.8.1), then the caller's overrides. The coding host's own
/// credentials (its API key, model keys) are not part of any of these.
pub fn environment(
    current: impl Fn(&str) -> Option<String>,
    team: BTreeMap<String, String>,
    overrides: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for key in ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"] {
        if let Some(value) = current(key) {
            env.insert(key.to_owned(), value);
        }
    }
    env.entry("LANG".into()).or_insert_with(|| "C.UTF-8".into());
    env.extend(team);
    // Interactive programs hang a terminal where a pipe would have closed.
    for (key, value) in [
        ("TERM", "xterm-256color"),
        ("PAGER", "cat"),
        ("GIT_PAGER", "cat"),
        ("CI", "1"),
    ] {
        env.insert(key.into(), value.into());
    }
    env.extend(overrides.iter().map(|(k, v)| (k.clone(), v.clone())));
    env
}

#[cfg(target_os = "linux")]
pub fn run(args: &[String]) -> io::Result<()> {
    use std::io::{Read, Write};
    use std::os::fd::{AsFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    // Only ever after a permanent identity drop: never root, never setuid.
    let uid = rustix::process::geteuid();
    if uid.is_root() || rustix::process::getuid() != uid {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let spec = Spec::from_args(args)?;
    let stdin = io::stdin();
    // The broker already disabled echo on this terminal; keep it off even if a
    // future broker does not, so the start byte never reaches the output.
    if let Ok(mut termios) = rustix::termios::tcgetattr(stdin.as_fd()) {
        termios
            .local_modes
            .remove(rustix::termios::LocalModes::ECHO | rustix::termios::LocalModes::ECHONL);
        let _ = rustix::termios::tcsetattr(
            stdin.as_fd(),
            rustix::termios::OptionalActions::Now,
            &termios,
        );
    }
    // Wait for the broker's start newline. Nothing is printed before it.
    let mut gate = [0u8; 1];
    loop {
        match stdin.lock().read(&mut gate) {
            Ok(1) if gate[0] == b'\n' => break,
            Ok(1) => continue,
            Ok(_) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    let team = crate::session_environment::team_environment().unwrap_or_default();
    let env = environment(|k| std::env::var(k).ok(), team, &spec.env);
    let mut out = io::stdout().lock();
    writeln!(out, "{}", spec.echo)?;
    out.flush()?;
    drop(out);
    fn fail(status: i32, what: &str, error: io::Error) -> ! {
        let _ = writeln!(io::stderr(), "smithers: {what}: {error}");
        std::process::exit(status)
    }
    if let Some(cwd) = &spec.cwd {
        if let Err(error) = std::env::set_current_dir(cwd) {
            fail(1, cwd, error);
        }
    }
    let input: std::process::Stdio = match &spec.stdin {
        None => std::fs::File::open("/dev/null")?.into(),
        Some(text) => {
            let mut fds = [0; 2];
            if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
                return Err(io::Error::last_os_error());
            }
            let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
            let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
            // The whole text must fit before exec: grow the pipe to hold it.
            if text.len() > 32 * 1024 {
                unsafe { libc::fcntl(fds[1], libc::F_SETPIPE_SZ, 1 << 20) };
            }
            let mut writer = std::fs::File::from(write);
            writer.write_all(text.as_bytes())?;
            drop(writer);
            read.into()
        }
    };
    let error = std::process::Command::new(&spec.argv[0])
        .args(&spec.argv[1..])
        .env_clear()
        .envs(&env)
        .stdin(input)
        .exec();
    let status = if error.kind() == io::ErrorKind::NotFound {
        127
    } else {
        126
    };
    fail(status, &spec.argv[0], error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(json: &str) -> io::Result<Spec> {
        Spec::from_args(&session_argv(json)?[2..])
    }

    #[test]
    fn echo_line_is_one_printable_row() {
        assert_eq!(echo_line("pnpm test"), "$ pnpm test");
        assert_eq!(
            echo_line("a\nb\tc\x1b[31m\u{9b}d"),
            "$ a⏎b c\u{FFFD}[31m\u{FFFD}d"
        );
        let long = "x".repeat(MAX_ECHO_CHARS + 5);
        let line = echo_line(&long);
        assert!(line.ends_with('…'));
        assert_eq!(line.chars().count(), 2 + MAX_ECHO_CHARS + 1);
        assert!(!line.chars().any(char::is_control));
    }

    #[test]
    fn spec_round_trips_through_utf8_safe_chunks() {
        let command = "é".repeat(5000);
        let json =
            serde_json::json!({"argv": ["/bin/sh", "-c", command], "echo": echo_line(&command)})
                .to_string();
        let argv = session_argv(&json).unwrap();
        assert_eq!(&argv[..2], [RUNNER, VERB]);
        assert!(argv[2..].iter().all(|a| a.len() <= CHUNK && !a.is_empty()));
        assert!(argv.len() > 4);
        let decoded = Spec::from_args(&argv[2..]).unwrap();
        assert_eq!(decoded.argv[2], command);
        assert_eq!(decoded.stdin, None);
        assert!(decoded.env.is_empty());
    }

    #[test]
    fn spec_refuses_unusable_values_before_anything_runs() {
        for bad in [
            r#"{"argv":[],"echo":"$ x"}"#,
            r#"{"argv":[""],"echo":"$ x"}"#,
            r#"{"argv":["a\u0000b"],"echo":"$ x"}"#,
            r#"{"argv":["sh"],"cwd":"","echo":"$ x"}"#,
            r#"{"argv":["sh"],"cwd":"a\u0000","echo":"$ x"}"#,
            r#"{"argv":["sh"],"env":{"1A":"x"},"echo":"$ x"}"#,
            r#"{"argv":["sh"],"env":{"A-B":"x"},"echo":"$ x"}"#,
            r#"{"argv":["sh"],"env":{"A":"x\u0000"},"echo":"$ x"}"#,
            r#"{"argv":["sh"],"stdin":"\u0000","echo":"$ x"}"#,
            r#"{"argv":["sh"],"echo":"x"}"#,
            r#"{"argv":["sh"],"echo":"$ a\nb"}"#,
            r#"{"argv":["sh"],"echo":"$ x","actor":"run"}"#,
            r#"not json"#,
        ] {
            assert!(spec(bad).is_err(), "{bad}");
        }
        assert!(Spec::from_args(&[]).is_err());
        assert!(session_argv("").is_err());
        assert!(session_argv(&"x".repeat(MAX_SPEC_BYTES + 1)).is_err());
        let ok = spec(r#"{"argv":["python3","-"],"cwd":"src","env":{"A_1":"v"},"stdin":"print(1)","echo":"$ python3 -"}"#)
            .unwrap();
        assert_eq!(ok.cwd.as_deref(), Some("src"));
        assert_eq!(ok.stdin.as_deref(), Some("print(1)"));
    }

    #[test]
    fn environment_keeps_team_and_caller_values_but_not_the_host_private_ones() {
        let current = |k: &str| match k {
            "PATH" => Some("/opt/smithers/bundle/bin/linux-arm64:/usr/bin".to_owned()),
            "HOME" => Some("/home/agent".to_owned()),
            "SMITHERS_API_KEY" => Some("host-secret".to_owned()),
            "SMITHERS_MODEL_ROLE_IMPLEMENTER_KEY" => Some("model-secret".to_owned()),
            _ => None,
        };
        let team = BTreeMap::from([
            ("NPM_TOKEN".to_owned(), "team".to_owned()),
            ("CI".to_owned(), "0".to_owned()),
        ]);
        let overrides = BTreeMap::from([
            ("FOO".to_owned(), "bar".to_owned()),
            ("PAGER".to_owned(), "less".to_owned()),
        ]);
        let env = environment(current, team, &overrides);
        assert_eq!(env["PATH"], "/opt/smithers/bundle/bin/linux-arm64:/usr/bin");
        assert_eq!(env["HOME"], "/home/agent");
        assert_eq!(env["LANG"], "C.UTF-8");
        assert_eq!(env["NPM_TOKEN"], "team");
        assert_eq!(
            env["CI"], "1",
            "the session's non-interactive defaults win over team values"
        );
        assert_eq!(env["GIT_PAGER"], "cat");
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["PAGER"], "less", "the caller's explicit override wins");
        assert_eq!(env["FOO"], "bar");
        assert!(!env.contains_key("SMITHERS_API_KEY"));
        assert!(!env.contains_key("SMITHERS_MODEL_ROLE_IMPLEMENTER_KEY"));
        assert!(!env.contains_key("USER"));
    }
}
