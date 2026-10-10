//! The agent CLI uses ADR 0004 on the broker's local socket, not another codec.
use crate::conn::{self, Frame};
use std::io::{self, Read, Write};
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid client request")
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(value: &str, n: usize) -> io::Result<Vec<u8>> {
    if value.len() != n * 2 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    (0..n)
        .map(|i| u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| invalid()))
        .collect()
}
fn string(value: &str) -> io::Result<Vec<u8>> {
    if value.len() > 4096 || !crate::doc::disk::valid_path(value) {
        return Err(invalid());
    }
    let mut b = (value.len() as u16).to_be_bytes().to_vec();
    b.extend(value.as_bytes());
    Ok(b)
}
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for group in bytes.chunks(3) {
        let n = (u32::from(group[0]) << 16)
            | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
            | u32::from(*group.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if group.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if group.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
pub fn request(args: &[String], input: &mut impl Read) -> io::Result<Frame> {
    if args == ["write-files"] {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Change {
            path: String,
            base_digest: String,
            content: Option<Vec<u8>>,
        }
        let mut bytes = Vec::new();
        input.take((8 << 20) + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 8 << 20 {
            return Err(invalid());
        }
        let changes: Vec<Change> = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if changes.is_empty() || changes.len() > 256 {
            return Err(invalid());
        }
        let mut paths = std::collections::BTreeSet::new();
        let mut total = 0;
        let mut list = (changes.len() as u16).to_be_bytes().to_vec();
        for change in changes {
            if !paths.insert(change.path.clone()) {
                return Err(invalid());
            }
            if change.base_digest != "absent"
                && !change
                    .base_digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(invalid());
            }
            let base = if change.base_digest == "absent" {
                conn::tagged(2, &[])
            } else {
                conn::tagged(1, &[conn::field(1, unhex(&change.base_digest, 32)?)])
            };
            let mut fields = vec![conn::field(1, string(&change.path)?), conn::field(2, base)];
            if let Some(content) = change.content {
                total += content.len();
                if total > conn::MAX_FILE_BYTES {
                    return Err(invalid());
                }
                let mut bytes = (content.len() as u32).to_be_bytes().to_vec();
                bytes.extend(content);
                fields.push(conn::field(3, bytes));
            }
            list.extend(conn::structure_bytes(&fields));
        }
        for path in &paths {
            for (at, _) in path.match_indices('/') {
                if paths.contains(&path[..at]) {
                    return Err(invalid());
                }
            }
        }
        return Ok(Frame {
            kind: 1,
            stream: 0,
            payload: conn::tagged(
                1,
                &[
                    conn::field(1, 1u32.to_be_bytes()),
                    conn::field(2, conn::tagged(17, &[conn::field(1, list)])),
                ],
            ),
        });
    }
    if args.len() < 2 {
        return Err(invalid());
    }
    let mut fields = vec![conn::field(1, string(&args[1])?)];
    let method = match args[0].as_str() {
        "read-file" => {
            if args.len() == 4 && args[2] == "--at" {
                fields.push(conn::field(2, unhex(&args[3], 20)?));
            } else if args.len() != 2 {
                return Err(invalid());
            }
            2
        }
        "write-file" => {
            if args.len() != 4 || args[2] != "--base" {
                return Err(invalid());
            }
            let base = if args[3] == "absent" {
                conn::tagged(2, &[])
            } else {
                conn::tagged(1, &[conn::field(1, unhex(&args[3], 32)?)])
            };
            fields.push(conn::field(2, base));
            let mut bytes = Vec::new();
            input
                .take(conn::MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > conn::MAX_FILE_BYTES {
                return Err(invalid());
            }
            let mut content = (bytes.len() as u32).to_be_bytes().to_vec();
            content.extend(bytes);
            fields.push(conn::field(3, content));
            3
        }
        _ => return Err(invalid()),
    };
    Ok(Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 1u32.to_be_bytes()),
                conn::field(2, conn::tagged(method, &fields)),
            ],
        ),
    })
}
/// Returns false for a typed refusal, true for a successful read/write.
pub fn exchange(
    stream: &mut (impl Read + Write),
    request: &Frame,
    output: &mut impl Write,
) -> io::Result<bool> {
    stream.write_all(&request.encode_local().map_err(|_| invalid())?)?;
    let response = Frame::read(stream).map_err(|_| invalid())?;
    if response.kind != 1 || response.payload[0] != 2 {
        return Err(invalid());
    }
    let fields = conn::fields("response", &response.payload[1..]).map_err(|_| invalid())?;
    if fields[0].1 != 1u32.to_be_bytes() {
        return Err(invalid());
    }
    let result = fields[1].1;
    if result[0] == 255 {
        let fields = conn::fields("error", &result[1..]).map_err(|_| invalid())?;
        let code = fields[0].1[0] as usize;
        write!(
            output,
            "{{\"error\":{{\"code\":\"{}\"",
            ERROR_NAMES.get(code).ok_or_else(invalid)?
        )?;
        if code == 4 {
            if let Some((_, digest)) = fields.iter().find(|(tag, _)| *tag == 3) {
                write!(output, ",\"current_digest\":\"{}\"", hex(digest))?;
            }
        }
        writeln!(output, "}}}}")?;
        return Ok(false);
    }
    if result[0] != request.request().map_err(|_| invalid())?.1 {
        return Err(invalid());
    }
    match result[0] {
        2 => {
            let f = conn::fields("result2", &result[1..]).map_err(|_| invalid())?;
            writeln!(
                output,
                "{{\"digest\":\"{}\",\"mode\":{},\"content_b64\":\"{}\"}}",
                hex(f[1].1),
                u32::from_be_bytes(f[2].1.try_into().map_err(|_| invalid())?),
                base64(&f[0].1[4..])
            )?;
        }
        3 => {
            let f = conn::fields("result3", &result[1..]).map_err(|_| invalid())?;
            writeln!(output, "{{\"post_digest\":\"{}\"}}", hex(f[0].1))?;
        }
        17 => {
            let request_fields =
                conn::fields("local_batch", request.request().map_err(|_| invalid())?.2)
                    .map_err(|_| invalid())?;
            let changes =
                conn::list("local_mutation", request_fields[0].1).map_err(|_| invalid())?;
            let f = conn::fields("result17", &result[1..]).map_err(|_| invalid())?;
            let results = conn::list("mutation_result", f[0].1).map_err(|_| invalid())?;
            if results.len() > changes.len() {
                return Err(invalid());
            }
            let mut writes = Vec::new();
            for (change, receipt) in changes.iter().zip(&results) {
                let change = conn::fields("local_mutation", change).map_err(|_| invalid())?;
                let receipt = conn::fields("mutation_result", receipt).map_err(|_| invalid())?;
                let path = std::str::from_utf8(&change[0].1[2..]).map_err(|_| invalid())?;
                let post = receipt[0].1;
                let content = change.iter().find(|(tag, _)| *tag == 3);
                let digest = if let Some((_, content)) = content {
                    use sha2::{Digest, Sha256};
                    let expected = Sha256::digest(&content[4..]);
                    if post[0] != 1 || &post[6..] != expected.as_slice() {
                        return Err(invalid());
                    }
                    hex(&expected)
                } else {
                    if post[0] != 2 {
                        return Err(invalid());
                    }
                    "absent".to_owned()
                };
                let mut write = serde_json::json!({"path": path, "post_digest": digest});
                if let Some((_, raced)) = receipt.iter().find(|(tag, _)| *tag == 2) {
                    let raced = conn::fields("raced", raced).map_err(|_| invalid())?;
                    if &raced[0].1[2..] != path.as_bytes() {
                        return Err(invalid());
                    }
                    write["raced"] = serde_json::json!(hex(raced[1].1));
                }
                writes.push(write);
            }
            let mut reply = serde_json::json!({"writes": writes});
            let mut success = true;
            if let Some((_, failure)) = f.iter().find(|(tag, _)| *tag == 2) {
                let failure = conn::fields("batch_failure", failure).map_err(|_| invalid())?;
                let index =
                    u16::from_be_bytes(failure[0].1.try_into().map_err(|_| invalid())?) as usize;
                let preflight = failure[1].1 == [1];
                if index >= changes.len()
                    || (preflight && !results.is_empty())
                    || (!preflight && index != results.len())
                {
                    return Err(invalid());
                }
                let error = conn::fields("error", failure[2].1).map_err(|_| invalid())?;
                let current = error
                    .iter()
                    .find(|(tag, _)| *tag == 3)
                    .map(|(_, d)| hex(d))
                    .unwrap_or_else(|| "absent".to_owned());
                reply["failure"] = serde_json::json!({"index": index, "preflight": preflight, "code": error[0].1[0], "current_digest": current});
                success = false;
            } else if results.len() != changes.len() {
                return Err(invalid());
            }
            writeln!(output, "{reply}")?;
            return Ok(success);
        }
        _ => return Err(invalid()),
    }
    Ok(true)
}
/// What the coding host's Bash binding sends `client pty` on stdin.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PtyInput {
    argv: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    stdin: Option<String>,
    /// The logical invocation the terminal shows on its echo line.
    display: String,
}

/// One agent command: the local `open_session(pty)` request whose argv is the
/// fixed runner and its spec, plus the exact echo line the runner prints first.
pub fn pty_request(input: &mut impl Read) -> io::Result<(Frame, Vec<u8>)> {
    let mut bytes = Vec::new();
    input
        .take(crate::agent_run::MAX_SPEC_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > crate::agent_run::MAX_SPEC_BYTES {
        return Err(invalid());
    }
    let input: PtyInput = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let echo = crate::agent_run::echo_line(&input.display);
    let spec = serde_json::json!({
        "argv": input.argv,
        "cwd": input.cwd,
        "env": input.env,
        "stdin": input.stdin,
        "echo": echo,
    })
    .to_string();
    // The runner re-validates; refusing here keeps a bad call off the socket.
    crate::agent_run::Spec::from_args(std::slice::from_ref(&spec))?;
    let argv = crate::agent_run::session_argv(&spec)?;
    let mut list = (argv.len() as u16).to_be_bytes().to_vec();
    for arg in &argv {
        list.extend((arg.len() as u16).to_be_bytes());
        list.extend(arg.as_bytes());
    }
    let mut login = 5u16.to_be_bytes().to_vec();
    login.extend(b"agent");
    let fields = [
        conn::field(
            1,
            conn::structure_bytes(&[
                conn::field(1, login),
                conn::field(2, 19999u32.to_be_bytes()),
            ]),
        ),
        conn::field(2, [1]),
        conn::field(3, list),
    ];
    // The same decoder the broker applies: identity, kind and argv bounds.
    crate::broker::request::Request::decode(6, &conn::structure_bytes(&fields))
        .map_err(|_| invalid())?;
    let frame = Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 1u32.to_be_bytes()),
                conn::field(2, conn::tagged(6, &fields)),
            ],
        ),
    };
    frame.encode_local().map_err(|_| invalid())?;
    Ok((frame, echo.into_bytes()))
}

const ERROR_NAMES: [&str; 13] = [
    "",
    "malformed",
    "unsupported",
    "not_ready",
    "stale",
    "not_found",
    "invalid_path",
    "not_regular",
    "too_large",
    "busy",
    "moved_off",
    "unauthorized",
    "internal",
];

/// Send the open and read its answer: the new session, or the typed refusal.
pub fn pty_open(
    stream: &mut (impl Read + Write),
    request: &Frame,
) -> io::Result<Result<u32, &'static str>> {
    stream.write_all(&request.encode_local().map_err(|_| invalid())?)?;
    let response = Frame::read(stream).map_err(|_| invalid())?;
    if response.kind != 1 || response.payload[0] != 2 {
        return Err(invalid());
    }
    let fields = conn::fields("response", &response.payload[1..]).map_err(|_| invalid())?;
    if fields[0].1 != 1u32.to_be_bytes() {
        return Err(invalid());
    }
    let result = fields[1].1;
    match result[0] {
        255 => {
            let fields = conn::fields("error", &result[1..]).map_err(|_| invalid())?;
            Ok(Err(ERROR_NAMES
                .get(fields[0].1[0] as usize)
                .copied()
                .filter(|n| !n.is_empty())
                .ok_or_else(invalid)?))
        }
        6 => {
            let fields = conn::fields("result6", &result[1..]).map_err(|_| invalid())?;
            let id = u32::from_be_bytes(fields[0].1.try_into().map_err(|_| invalid())?);
            if id == 0 || id > 0x7fff_ffff {
                return Err(invalid());
            }
            Ok(Ok(id))
        }
        _ => Err(invalid()),
    }
}

/// How one command's terminal stream ended.
#[derive(Debug, PartialEq, Eq)]
pub enum PtyEnd {
    /// The command's own exit status, from the broker's waitpid.
    Exit(i32),
    /// The command died from this POSIX signal.
    Signal(i32),
    /// The stream closed before an exit status (cancelled or revoked).
    Closed,
    /// The first bytes were not the runner's echo line: the runner itself
    /// failed, so nothing here is the command's output.
    Runner(Option<i32>),
}

/// ADR 0004's session signal enum, as POSIX numbers.
fn posix_signal(wire: u8) -> io::Result<i32> {
    Ok(match wire {
        1 => 2,
        2 => 15,
        3 => 1,
        4 => 9,
        5 => 3,
        6 => 10,
        7 => 12,
        _ => return Err(invalid()),
    })
}

/// Copy the command's output to `output`, without the runner's echo line, and
/// return each byte's credit only after it was written. The echo is identified
/// by position: it is the runner's first write, before the command exists.
pub fn pty_stream(
    reader: &mut impl Read,
    writer: &std::sync::Mutex<impl Write>,
    session: u32,
    echo: &[u8],
    output: &mut impl Write,
) -> io::Result<PtyEnd> {
    let credit = |n: usize| -> io::Result<()> {
        let frame = Frame {
            kind: 5,
            stream: session,
            payload: [&[6u8], (n as u32).to_be_bytes().as_slice()].concat(),
        };
        let mut writer = writer.lock().map_err(|_| invalid())?;
        frame.write(&mut *writer)?;
        writer.flush()
    };
    let mut prefix: Option<Vec<u8>> = Some(Vec::new());
    let mut runner = false;
    let mut exit = None;
    loop {
        let frame = match Frame::read(reader) {
            Ok(frame) => frame,
            // The daemon closes the socket after the exit or close frame.
            Err(conn::ProtocolError::Truncated) => break,
            Err(_) => return Err(invalid()),
        };
        if frame.kind != 5 || frame.stream != session {
            return Err(invalid());
        }
        match frame.payload.as_slice() {
            [1, 1, bytes @ ..] => {
                let mut data = bytes;
                let mut owned = Vec::new();
                if let Some(seen) = &mut prefix {
                    seen.extend_from_slice(data);
                    let crlf = [echo, b"\r\n"].concat();
                    let lf = [echo, b"\n"].concat();
                    let matched = [crlf, lf].into_iter().find(|line| seen.starts_with(line));
                    if let Some(line) = matched {
                        owned = seen.split_off(line.len());
                        prefix = None;
                    } else if !crlf_prefix(seen, echo) {
                        // Not the echo line: report the runner's own failure.
                        runner = true;
                        owned = std::mem::take(seen);
                        prefix = None;
                    }
                    data = &owned;
                }
                if prefix.is_none() && !runner {
                    output.write_all(data)?;
                    output.flush()?;
                }
                credit(bytes.len())?;
            }
            [2, 1] | [6, ..] => {}
            [5, 0, code @ ..] => {
                exit = Some(PtyEnd::Exit(i32::from_be_bytes(
                    code.try_into().map_err(|_| invalid())?,
                )))
            }
            [5, 1, signal, _] => exit = Some(PtyEnd::Signal(posix_signal(*signal)?)),
            [7] => break,
            [255, ..] => return Err(io::ErrorKind::PermissionDenied.into()),
            _ => return Err(invalid()),
        }
    }
    let status = match exit {
        Some(PtyEnd::Exit(code)) => Some(code),
        Some(PtyEnd::Signal(signal)) => Some(128 + signal),
        _ => None,
    };
    if runner || (prefix.is_some() && exit.is_some()) {
        return Ok(PtyEnd::Runner(status));
    }
    Ok(exit.unwrap_or(PtyEnd::Closed))
}

/// Could `seen` still become the echo line followed by a newline?
fn crlf_prefix(seen: &[u8], echo: &[u8]) -> bool {
    let crlf = [echo, b"\r\n"].concat();
    let lf = [echo, b"\n"].concat();
    [crlf, lf]
        .iter()
        .any(|line| line.starts_with(seen) || seen.starts_with(line))
}

/// After a cancellation, wait until this command's session cgroup holds no
/// process, killing what remains: every process there runs as `agent`, as
/// this client does. The broker reaps the session itself once it is closed.
#[cfg(target_os = "linux")]
pub fn pty_empty(session: u32, deadline: std::time::Instant) -> bool {
    let group = std::path::PathBuf::from(format!("/sys/fs/cgroup/smithers/sessions/s{session}"));
    loop {
        match std::fs::read_to_string(group.join("cgroup.events")) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => return false,
            Ok(events) if events.lines().any(|l| l == "populated 0") => return true,
            Ok(_) => {}
        }
        if let Ok(procs) = std::fs::read_to_string(group.join("cgroup.procs")) {
            for pid in procs.lines().filter_map(|l| l.trim().parse::<i32>().ok()) {
                if pid > 1 {
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// `smithers-machined client pty`: run one command in the agent's own
/// terminal. stdout carries the command's output; stderr ends with one JSON
/// status line. SIGTERM/SIGINT/SIGHUP cancel: KILL to the command's process
/// group, close, then confirmation that its cgroup is empty.
#[cfg(target_os = "linux")]
fn run_pty() -> io::Result<bool> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    let mut set = unsafe { std::mem::zeroed::<libc::sigset_t>() };
    unsafe {
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, signal);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let status = |line: serde_json::Value| -> io::Result<()> {
        let mut err = io::stderr().lock();
        writeln!(err, "{line}")?;
        err.flush()
    };
    let (request, echo) = match pty_request(&mut io::stdin().lock()) {
        Ok(request) => request,
        Err(_) => {
            status(serde_json::json!({"error": {"code": "malformed"}}))?;
            return Ok(false);
        }
    };
    let mut socket = std::os::unix::net::UnixStream::connect("/run/smithers/machined.sock")?;
    socket.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    socket.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;
    let session = match pty_open(&mut socket, &request)? {
        Ok(session) => session,
        Err(code) => {
            status(serde_json::json!({"error": {"code": code}}))?;
            return Ok(false);
        }
    };
    socket.set_read_timeout(None)?;
    let writer = Arc::new(Mutex::new(socket.try_clone()?));
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel = {
        let writer = writer.clone();
        let cancelled = cancelled.clone();
        move || {
            if cancelled.swap(true, Ordering::AcqRel) {
                return;
            }
            if let Ok(mut socket) = writer.lock() {
                for payload in [vec![4, 4], vec![7]] {
                    let _ = Frame {
                        kind: 5,
                        stream: session,
                        payload,
                    }
                    .write(&mut *socket);
                }
            }
        }
    };
    {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            let mut signal = 0;
            if unsafe { libc::sigwait(&set, &mut signal) } == 0 {
                cancel();
            }
        });
    }
    let mut stdout = io::stdout().lock();
    let end = pty_stream(&mut socket, &*writer, session, &echo, &mut stdout);
    if end.is_err() {
        // A broken stdout or transport ends the command like a cancellation.
        cancel();
    }
    if cancelled.load(Ordering::Acquire) {
        let clean = pty_empty(
            session,
            std::time::Instant::now() + std::time::Duration::from_secs(10),
        );
        status(serde_json::json!({"cancelled": true, "clean": clean}))?;
        return Ok(clean);
    }
    match end? {
        PtyEnd::Exit(code) => status(serde_json::json!({"exit": code}))?,
        PtyEnd::Signal(signal) => status(serde_json::json!({"signal": signal}))?,
        PtyEnd::Closed => {
            status(serde_json::json!({"error": {"code": "closed"}}))?;
            return Ok(false);
        }
        PtyEnd::Runner(exit) => {
            status(serde_json::json!({"error": {"code": "runner", "exit": exit}}))?;
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn run(args: &[String]) -> io::Result<bool> {
    #[cfg(target_os = "linux")]
    if args == ["pty"] {
        return run_pty();
    }
    let request = request(args, &mut io::stdin().lock())?;
    let mut socket = std::os::unix::net::UnixStream::connect("/run/smithers/machined.sock")?;
    socket.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    socket.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;
    exchange(&mut socket, &request, &mut io::stdout().lock())
}
