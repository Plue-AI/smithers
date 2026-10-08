//! External transcript import through the real root broker and the daemon's
//! real pump, in the processes and with the identities they have in a machine
//! (spec §9.6.6; C-AGT-02 lifecycle and TestExternalTranscriptRootInputs).
//!
//! - This test process is root and is the broker: the production session
//!   kernel (`Processes`), registry and supervisor, serving the production
//!   socketpair protocol. It opens members' sessions in real cgroups after a
//!   real privilege drop.
//! - A child of it is the daemon: uid 19998, holding the other end of the
//!   socketpair as descriptor 3, running the production `SocketpairBroker`
//!   client, `Pump`, checkpoint store and durable outbox. It also plays the
//!   host for the outbox: it prints each durable event it would send and
//!   settles it, refusing a record that says so.
//! - Members' agents are stand-ins: this binary under the executable names
//!   discovery reads, holding the files a real Codex holds. Real agent
//!   sessions in a microVM are the reference host's receipts.
//!
//! It needs a disposable Linux root: it adds accounts, homes, cgroups and
//! `/opt/smithers/bin/smithers-machined`. It is ignored in an ordinary run and
//! refuses to start unless SMITHERS_DISPOSABLE_ROOT=1 says the machine is one.
#![cfg(target_os = "linux")]
use smithers_machined::{
    broker::{
        cgroups::Cgroups,
        control::{self, SocketpairBroker},
        sessions::User,
        spawn::{Admission, Processes},
        supervisor::Supervisor,
        transcripts::EXECUTABLE,
    },
    conn::{self, Frame},
    event_service::Events,
    hooks::{self, EventSink, Oid},
    objects::Bundles,
    outbox::{Outbox, Refs},
    outbox_store::Store,
    transcript::{pump::Pump, wire::Source},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            fs::{chown, MetadataExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

const BEN: u32 = 20001;
const MAYA: u32 = 20002;
const DAEMON: u32 = 19998;
const TEAM: u32 = 20000;
const STATE: &str = "/var/lib/smithers-transcript-test";
const DISPOSABLE: &str = "requires a disposable Linux root (SMITHERS_DISPOSABLE_ROOT=1)";

// ---------------------------------------------------------------- stand-ins

fn marked(marker: &str) -> Option<Vec<String>> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|arg| arg == marker)?;
    Some(args[at + 1..].to_vec())
}

/// Started under an agent's name with the marker argument, this test is the
/// agent process: it holds the named file open for appending and stays until
/// it is killed. In an ordinary run it does nothing.
#[test]
fn fake_agent() {
    let Some(rest) = marked("smithers-fake-agent") else {
        return;
    };
    let _held = rest
        .first()
        .filter(|path| path.starts_with('/'))
        .map(|path| OpenOptions::new().append(true).open(path).unwrap());
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

struct NoPins;
impl Refs for NoPins {
    fn pin_and_sync(&mut self, _: [u8; 16], _: Oid) -> io::Result<()> {
        Err(io::Error::other("a transcript record has no pin"))
    }
    fn acknowledge_and_sync(&mut self, _: Oid) -> io::Result<()> {
        Ok(())
    }
    fn unpin(&mut self, _: [u8; 16]) -> io::Result<()> {
        Ok(())
    }
    fn pending(&mut self) -> io::Result<Vec<[u8; 16]>> {
        Ok(vec![])
    }
}
struct NoBundles;
impl Bundles for NoBundles {
    type Source = io::Cursor<Vec<u8>>;
    fn export(&mut self, _: &conn::Durable, _: &[Oid]) -> io::Result<Self::Source> {
        Err(io::Error::other("a transcript record has no bundle"))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}
fn string(text: &str) -> Vec<u8> {
    [
        (text.len() as u16).to_be_bytes().as_slice(),
        text.as_bytes(),
    ]
    .concat()
}

/// Started with the marker argument, this test is the machine daemon: uid
/// 19998 with the broker's socketpair as descriptor 3. It takes one command a
/// line and answers with lines ending in ".".
#[test]
fn daemon() {
    if marked("smithers-transcript-daemon").is_none() {
        return;
    }
    assert_eq!(rustix::process::geteuid().as_raw(), DAEMON);
    // SAFETY: the root test installed the socketpair's end as descriptor 3.
    let broker = Arc::new(SocketpairBroker::new(unsafe { OwnedFd::from_raw_fd(3) }).unwrap());
    let outbox = Outbox::open(
        Store::open(&Path::new(STATE).join("outbox"), DAEMON).unwrap(),
        DAEMON,
        NoPins,
    )
    .unwrap();
    let events = Arc::new(Events::new(outbox, NoBundles, || Ok(1)).unwrap());
    let mut pump = Pump::new(
        broker.clone(),
        events.clone(),
        File::open(Path::new(STATE).join("transcripts")).unwrap(),
    )
    .unwrap();
    let stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let words: Vec<&str> = line.split(' ').collect();
        let mut out = stdout.lock();
        match words[0] {
            "roster" => {
                let members: Vec<User> = words[1..]
                    .iter()
                    .map(|member| {
                        let (login, uid) = member.split_once(':').unwrap();
                        User {
                            login: login.into(),
                            uid: uid.parse().unwrap(),
                        }
                    })
                    .collect();
                match hooks::Broker::set_roster(&*broker, &members) {
                    Ok(()) => writeln!(out, "ok").unwrap(),
                    Err(error) => writeln!(out, "error {}", error.code).unwrap(),
                }
            }
            "open" => {
                let mut argv = ((words.len() - 3) as u16).to_be_bytes().to_vec();
                for word in &words[3..] {
                    argv.extend(string(word));
                }
                let args = conn::structure_bytes(&[
                    conn::field(
                        1,
                        conn::structure_bytes(&[
                            conn::field(1, string(words[1])),
                            conn::field(2, words[2].parse::<u32>().unwrap().to_be_bytes()),
                        ]),
                    ),
                    conn::field(2, [2]),
                    conn::field(3, argv),
                    conn::field(5, [7; 16]),
                ]);
                match hooks::Sessions::call(&*broker, 6, &args) {
                    Ok(body) => {
                        let id = conn::fields("result6", &body).unwrap()[0].1;
                        writeln!(
                            out,
                            "session {}",
                            u32::from_be_bytes(id.try_into().unwrap())
                        )
                        .unwrap()
                    }
                    Err(error) => writeln!(out, "error {}", error.code).unwrap(),
                }
            }
            "kill-session" => {
                let id: u32 = words[1].parse().unwrap();
                let args = conn::structure_bytes(&[conn::field(
                    1,
                    conn::tagged(3, &[conn::field(1, id.to_be_bytes())]),
                )]);
                match hooks::Sessions::call(&*broker, 9, &args) {
                    Ok(_) => writeln!(out, "ok").unwrap(),
                    Err(error) => writeln!(out, "error {}", error.code).unwrap(),
                }
            }
            "serving" => {
                writeln!(out, "serving {}", broker.serving(Instant::now())).unwrap();
            }
            "sources" => match broker.transcript_sources() {
                Ok(sources) => {
                    for source in sources {
                        writeln!(
                            out,
                            "source {} {} {} {:?} {}",
                            hex(&source.lifetime),
                            hex(&source.participant),
                            source.session,
                            source.agent,
                            source.ended
                        )
                        .unwrap();
                    }
                }
                Err(error) => writeln!(out, "error {}", error.code).unwrap(),
            },
            // A daemon asking the broker for a reader by a name of its choosing.
            "reader" => match broker.transcript_reader(unhex(words[1]).try_into().unwrap()) {
                Ok((startup, _socket)) => {
                    writeln!(out, "reader {} {}", startup.root, startup.path).unwrap()
                }
                Err(error) => writeln!(out, "error {}", error.code).unwrap(),
            },
            "idle" => {
                pump.idle();
                writeln!(out, "ok").unwrap();
            }
            // One turn of the daemon: serve sessions, pump transcripts, then
            // play the host for the outbox.
            "pass" => {
                let began = Instant::now();
                hooks::Sessions::poll(&*broker).unwrap();
                match pump.pass(Instant::now()) {
                    Ok(()) => (),
                    Err(error) => writeln!(out, "pass-error {:?}", error.kind()).unwrap(),
                }
                writeln!(out, "took {}", began.elapsed().as_millis()).unwrap();
                loop {
                    let frames = events.poll().unwrap();
                    let Some(frame) = frames.first() else {
                        break;
                    };
                    let frame = Frame::decode(&frame.encode().unwrap()).unwrap();
                    assert_eq!(frames.len(), 1);
                    assert_eq!((frame.kind, frame.stream), (2, 0), "a record travels alone");
                    let event = conn::Durable::decode(&frame.payload).unwrap();
                    let (source, record) = Source::decode(&event.event).unwrap();
                    let refuse = record.text.contains("\"refuse\"");
                    writeln!(
                        out,
                        "event {} {} {} {} {} {} {} {}",
                        source.session,
                        hex(&source.participant),
                        hex(&source.lifetime),
                        source.profile,
                        record.generation,
                        record.start,
                        record.end,
                        hex(record.text.as_bytes())
                    )
                    .unwrap();
                    events
                        .frame(&Frame {
                            kind: 2,
                            stream: 0,
                            payload: conn::tagged(
                                3,
                                &[
                                    conn::field(1, event.seq.to_be_bytes()),
                                    conn::field(2, [if refuse { 4 } else { 1 }]),
                                ],
                            ),
                        })
                        .unwrap();
                }
                writeln!(out, "reading {}", pump.reading()).unwrap();
            }
            other => panic!("unknown command {other}"),
        }
        writeln!(out, ".").unwrap();
        out.flush().unwrap();
    }
}

// -------------------------------------------------------------- the machine

struct Open;
impl Admission for Open {
    fn available(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn environment(&mut self, _: &User) -> io::Result<Vec<(String, String)>> {
        Ok(vec![])
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Event {
    session: u32,
    participant: String,
    lifetime: String,
    profile: String,
    generation: u64,
    start: u64,
    end: u64,
    text: String,
}

struct Machine {
    daemon: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    broker: Option<std::thread::JoinHandle<io::Result<()>>>,
    events: Vec<Event>,
    slowest: u128,
    _one: std::sync::MutexGuard<'static, ()>,
}

fn directory(path: &str, uid: u32, mode: u32) {
    fs::create_dir_all(path).unwrap();
    chown(path, Some(uid), Some(uid)).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}
/// A member's file, with every missing directory above it theirs too.
fn member_file(path: &str, uid: u32, contents: &str) {
    let mut directories = vec![];
    let mut parent = Path::new(path).parent().unwrap();
    while !parent.exists() {
        directories.push(parent.to_owned());
        parent = parent.parent().unwrap();
    }
    for missing in directories.iter().rev() {
        directory(missing.to_str().unwrap(), uid, 0o700);
    }
    fs::write(path, contents).unwrap();
    chown(path, Some(uid), Some(uid)).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn append(path: &str, line: &str) {
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    writeln!(file, "{line}").unwrap();
}
/// Processes that are this install's daemon binary started as `role` for
/// `uid`: the owner-uid transcript children the broker launched.
fn children(role: &str, uid: u32) -> Vec<u32> {
    let mut found = vec![];
    for entry in fs::read_dir("/proc").unwrap() {
        let entry = entry.unwrap();
        let Ok(pid) = entry.file_name().to_str().unwrap_or("").parse::<u32>() else {
            continue;
        };
        let Ok(command) = fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let expected = [EXECUTABLE.as_bytes(), b"\0", role.as_bytes(), b"\0"].concat();
        if command != expected {
            continue;
        }
        if identity(pid).is_some_and(|identity| identity.0 == [uid; 4]) {
            found.push(pid);
        }
    }
    found
}
/// The four uids, four gids, supplementary groups and no-new-privileges flag
/// the kernel reports for a live process.
type Identity = (Vec<u32>, Vec<u32>, Vec<u32>, bool);
fn identity(pid: u32) -> Option<Identity> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let field = |name: &str| -> Option<Vec<u32>> {
        Some(
            status
                .lines()
                .find_map(|line| line.strip_prefix(name))?
                .split_whitespace()
                .map(|value| value.parse().unwrap())
                .collect(),
        )
    };
    Some((
        field("Uid:")?,
        field("Gid:")?,
        field("Groups:")?,
        field("NoNewPrivs:")? == [1],
    ))
}
fn session_processes(session: u32) -> Vec<u32> {
    fs::read_to_string(format!(
        "/sys/fs/cgroup/smithers/sessions/s{session}/cgroup.procs"
    ))
    .unwrap_or_default()
    .lines()
    .map(|pid| pid.parse().unwrap())
    .collect()
}
fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what}: not within 5 s");
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Machine {
    /// Provision what a machine image and a boot provide, then start the
    /// broker here and the daemon as uid 19998. There is one machine: its
    /// accounts, cgroups and state are this root's, so one test at a time.
    fn boot() -> Self {
        static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let one = ONE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(rustix::process::geteuid().is_root(), "{DISPOSABLE}");
        assert_eq!(
            std::env::var("SMITHERS_DISPOSABLE_ROOT").as_deref(),
            Ok("1"),
            "{DISPOSABLE}"
        );
        let mut passwd = fs::read_to_string("/etc/passwd").unwrap();
        let mut group = fs::read_to_string("/etc/group").unwrap();
        if !group.contains("team:x:20000:") {
            group.push_str("team:x:20000:ben,maya\n");
            for (login, uid) in [("ben", BEN), ("maya", MAYA)] {
                passwd.push_str(&format!("{login}:x:{uid}:{uid}::/home/{login}:/bin/bash\n"));
                group.push_str(&format!("{login}:x:{uid}:\n"));
            }
            fs::write("/etc/passwd", passwd).unwrap();
            fs::write("/etc/group", group).unwrap();
        }
        directory("/home/ben", BEN, 0o700);
        directory("/home/maya", MAYA, 0o700);
        directory("/workspace", 0, 0o777);
        directory("/opt/smithers/bin", 0, 0o755);
        if !Path::new(EXECUTABLE).exists() {
            fs::copy(env!("CARGO_BIN_EXE_smithers-machined"), EXECUTABLE).unwrap();
            fs::set_permissions(EXECUTABLE, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::create_dir_all("/sys/fs/cgroup/smithers/sessions").expect(DISPOSABLE);
        let _ = fs::remove_dir_all(STATE);
        for path in [
            STATE.to_owned(),
            format!("{STATE}/outbox"),
            format!("{STATE}/transcripts"),
        ] {
            directory(&path, DAEMON, 0o700);
        }
        // The stand-in agent, where a member's own install would be.
        for (path, uid) in [
            ("/home/ben/tools/codex", BEN),
            ("/home/maya/.local/share/claude/versions/2.1.291", MAYA),
        ] {
            if !Path::new(path).exists() {
                let parent = Path::new(path).parent().unwrap();
                fs::create_dir_all(parent).unwrap();
                fs::copy(std::env::current_exe().unwrap(), path).unwrap();
                fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
                let mut owned = PathBuf::from(path);
                while owned.starts_with("/home/") && owned.components().count() > 3 {
                    chown(&owned, Some(uid), Some(uid)).unwrap();
                    owned.pop();
                }
            }
        }

        let (parent, child) = rustix::net::socketpair(
            rustix::net::AddressFamily::UNIX,
            rustix::net::SocketType::SEQPACKET,
            rustix::net::SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let kernel = Processes::new(Cgroups::open().expect(DISPOSABLE), Open);
        let broker =
            std::thread::spawn(move || control::serve(&parent, &mut Supervisor::new(kernel)));
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "daemon", "--nocapture", "--test-threads", "1"])
            .arg("smithers-transcript-daemon")
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        // SAFETY: syscalls only, between fork and exec; the order the real
        // broker drops its daemon in.
        unsafe {
            command.pre_exec(move || {
                let groups = [TEAM];
                if libc::dup2(child.as_raw_fd(), 3) < 0
                    || libc::setgroups(1, groups.as_ptr()) != 0
                    || libc::setresgid(DAEMON, DAEMON, DAEMON) != 0
                    || libc::setresuid(DAEMON, DAEMON, DAEMON) != 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut daemon = command.spawn().unwrap();
        drop(command);
        Self {
            input: daemon.stdin.take().unwrap(),
            output: BufReader::new(daemon.stdout.take().unwrap()),
            daemon,
            broker: Some(broker),
            events: vec![],
            slowest: 0,
            _one: one,
        }
    }
    fn ask(&mut self, command: &str) -> Vec<String> {
        writeln!(self.input, "{command}").unwrap();
        let mut lines = vec![];
        loop {
            let mut line = String::new();
            assert_ne!(
                self.output.read_line(&mut line).unwrap(),
                0,
                "the daemon died during `{command}`: {lines:?}"
            );
            // The harness prints its own line before the first answer.
            let line = line.trim_end().rsplit("... ").next().unwrap().to_owned();
            if line == "." {
                return lines;
            }
            if !line.is_empty() && !line.starts_with("running ") {
                lines.push(line);
            }
        }
    }
    fn open(&mut self, login: &str, uid: u32, argv: &str) -> u32 {
        let answer = self.ask(&format!("open {login} {uid} {argv}"));
        answer[0]
            .strip_prefix("session ")
            .unwrap_or_else(|| panic!("open {login}: {answer:?}"))
            .parse()
            .unwrap()
    }
    /// One turn of the daemon. Returns how many readers it holds after it.
    fn pass(&mut self) -> usize {
        let mut reading = 0;
        for line in self.ask("pass") {
            let words: Vec<&str> = line.split(' ').collect();
            match words[0] {
                "event" => self.events.push(Event {
                    session: words[1].parse().unwrap(),
                    participant: words[2].into(),
                    lifetime: words[3].into(),
                    profile: words[4].into(),
                    generation: words[5].parse().unwrap(),
                    start: words[6].parse().unwrap(),
                    end: words[7].parse().unwrap(),
                    text: String::from_utf8(unhex(words[8])).unwrap(),
                }),
                "took" => self.slowest = self.slowest.max(words[1].parse().unwrap()),
                "reading" => reading = words[1].parse().unwrap(),
                _ => panic!("pass: {line}"),
            }
        }
        reading
    }
    /// Turns at the daemon's own cadence until `done`, at most `within`.
    fn pass_until(&mut self, what: &str, within: Duration, done: impl Fn(&[Event]) -> bool) {
        let deadline = Instant::now() + within;
        loop {
            self.pass();
            if done(&self.events) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{what}: not within {within:?}; events: {:#?}",
                self.events
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn texts(&self, session: u32) -> Vec<&str> {
        self.events
            .iter()
            .filter(|event| event.session == session)
            .map(|event| event.text.as_str())
            .collect()
    }
    fn sources(&mut self) -> Vec<Vec<String>> {
        self.ask("sources")
            .iter()
            .map(|line| line.split(' ').skip(1).map(str::to_owned).collect())
            .collect()
    }
    /// The daemon goes away as it does at a machine's shutdown; the broker's
    /// serve loop ends with it. Every session must be over before this.
    fn shutdown(mut self) {
        assert_eq!(self.ask("roster"), ["ok"]);
        drop(self.input);
        self.daemon.wait().unwrap();
        self.broker.take().unwrap().join().unwrap().unwrap();
        // Nothing of the import outlives the broker.
        for uid in [BEN, MAYA] {
            for role in ["transcript-reader", "transcript-resolve"] {
                wait_for("children reaped at shutdown", || {
                    children(role, uid).is_empty()
                });
            }
        }
        assert_eq!(
            fs::read_dir("/sys/fs/cgroup/smithers/sessions")
                .unwrap()
                .filter(|entry| entry.as_ref().unwrap().file_type().unwrap().is_dir())
                .count(),
            0
        );
    }
}

const META: &str = r#"{"timestamp":"2026-10-08T05:05:52.563Z","type":"session_meta","payload":{"id":"01a119e7-51a2-7c83-86d2-3f125158d08b","cwd":"/workspace","cli_version":"0.160.1"}}"#;
const AGENT: &str = "--exact fake_agent --nocapture --test-threads 1 smithers-fake-agent";

fn claude_session(pid: u32, session: &str) -> String {
    format!(
        r#"{{"pid":{pid},"sessionId":"{session}","cwd":"/workspace","startedAt":1791435951451,"version":"2.1.291","kind":"interactive"}}"#
    )
}

#[test]
#[ignore = "requires a disposable Linux root (SMITHERS_DISPOSABLE_ROOT=1)"]
fn members_agent_sessions_are_imported_through_the_broker_and_the_daemon() {
    let mut machine = Machine::boot();
    let rollout = "/home/ben/.codex/sessions/2026/10/08/rollout-2026-10-08T05-05-52-01a119e7.jsonl";
    let second = "/home/ben/.codex/sessions/2026/10/08/rollout-2026-10-08T06-00-00-02b229f8.jsonl";
    let history = "/home/ben/.codex/sessions/2026/10/01/rollout-2026-10-01T09-00-00-00c0ffee.jsonl";
    member_file(rollout, BEN, &format!("{META}\n"));
    member_file(second, BEN, &format!("{META}\n"));
    member_file(
        history,
        BEN,
        &format!("{META}\n{{\"unrelated\":\"history\"}}\n"),
    );

    // Before the roster is synchronized there is no member, so no session,
    // nothing to look for and nothing started.
    assert_eq!(machine.ask("serving"), ["serving false"]);
    assert_eq!(machine.sources(), Vec::<Vec<String>>::new());
    assert_eq!(machine.ask("roster ben:20001 maya:20002"), ["ok"]);
    assert_eq!(machine.pass(), 0);
    assert_eq!(machine.ask("serving"), ["serving true"]);

    // Ben runs Codex in his terminal; Maya runs Claude Code in hers.
    let ben = machine.open(
        "ben",
        BEN,
        &format!("/home/ben/tools/codex {AGENT} {rollout}"),
    );
    let maya = machine.open(
        "maya",
        MAYA,
        &format!("/home/maya/.local/share/claude/versions/2.1.291 {AGENT}"),
    );
    let claude_pid = session_processes(maya)[0];
    let first_session = "889e416d-fda3-42c0-869a-56b3ced78a05";
    let transcript =
        |session: &str| format!("/home/maya/.claude/projects/-workspace/{session}.jsonl");
    member_file(
        &format!("/home/maya/.claude/sessions/{claude_pid}.json"),
        MAYA,
        &claude_session(claude_pid, first_session),
    );
    member_file(&transcript(first_session), MAYA, "{\"type\":\"mode\"}\n");

    machine.pass_until(
        "both agents' first records",
        Duration::from_secs(5),
        |events| events.len() == 2,
    );
    let codex = machine
        .events
        .iter()
        .find(|e| e.session == ben)
        .unwrap()
        .clone();
    let claude = machine
        .events
        .iter()
        .find(|e| e.session == maya)
        .unwrap()
        .clone();
    assert_eq!(
        (
            codex.profile.as_str(),
            codex.generation,
            codex.start,
            codex.text.as_str()
        ),
        ("codex-rollout/0.160", 1, 0, META)
    );
    assert_eq!(codex.end, META.len() as u64 + 1);
    assert_eq!(
        (
            claude.profile.as_str(),
            claude.start,
            claude.end,
            claude.text.as_str()
        ),
        ("claude-code/2.1", 0, 16, "{\"type\":\"mode\"}")
    );
    // Each agent process is its own participant with its own source.
    assert_ne!(codex.participant, claude.participant);
    assert_ne!(codex.lifetime, claude.lifetime);

    // Each member's transcript is read by exactly one process, which is that
    // member and nothing more, and is not in their session's cgroup: its CPU
    // there would read as the session's activity (spec §9.3).
    for (uid, session) in [(BEN, ben), (MAYA, maya)] {
        let readers = children("transcript-reader", uid);
        assert_eq!(readers.len(), 1, "{uid}");
        assert_eq!(
            identity(readers[0]).unwrap(),
            (vec![uid; 4], vec![uid; 4], vec![TEAM], true)
        );
        assert!(!session_processes(session).contains(&readers[0]));
        assert_eq!(session_processes(session).len(), 1);
        // Its two ends of the socketpair, a null stderr, and what it opened
        // itself: the member's agent root and a watch. Nothing of the
        // broker's, no session's terminal, no other member's reader.
        let mut descriptors: Vec<String> = fs::read_dir(format!("/proc/{}/fd", readers[0]))
            .unwrap()
            .map(|entry| {
                let target = fs::read_link(entry.unwrap().path()).unwrap();
                let target = target.to_str().unwrap();
                if target.starts_with("socket:") {
                    "socket"
                } else {
                    target
                }
                .to_owned()
            })
            .collect();
        descriptors.sort();
        let root = if uid == BEN {
            "/home/ben/.codex"
        } else {
            "/home/maya/.claude"
        };
        assert_eq!(
            descriptors,
            ["/dev/null", root, "anon_inode:inotify", "socket", "socket"]
        );
        // The member cannot attach to or dump the process that runs as them.
        assert_eq!(
            fs::metadata(format!("/proc/{}/mem", readers[0]))
                .unwrap()
                .uid(),
            0
        );
        wait_for("resolver exits", || {
            children("transcript-resolve", uid).is_empty()
        });
    }

    // A complete record is in the outbox well inside the 5 s bound, in order,
    // once; a partial one waits.
    let written = Instant::now();
    append(
        rollout,
        r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
    );
    append(&transcript(first_session), r#"{"type":"user","n":1}"#);
    machine.pass_until("appended records", Duration::from_secs(5), |events| {
        events.len() == 4
    });
    assert!(written.elapsed() < Duration::from_secs(5));
    assert_eq!(
        machine.texts(ben),
        [
            META,
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#
        ]
    );
    assert_eq!(
        machine.texts(maya),
        ["{\"type\":\"mode\"}", r#"{"type":"user","n":1}"#]
    );
    let record = machine
        .events
        .iter()
        .rev()
        .find(|e| e.session == ben)
        .unwrap();
    assert_eq!(
        (record.generation, record.start),
        (1, META.len() as u64 + 1)
    );
    assert_eq!(
        (&record.participant, &record.lifetime),
        (&codex.participant, &codex.lifetime)
    );

    // A daemon cannot name what to read: an unknown source starts no reader.
    assert_eq!(
        machine.ask(&format!("reader {}", "ab".repeat(16))),
        ["error 5"]
    );
    assert_eq!(children("transcript-reader", BEN).len(), 1);

    // Ben starts a second Codex in another terminal: another participant of
    // the same member, with its own file.
    let ben_second = machine.open(
        "ben",
        BEN,
        &format!("/home/ben/tools/codex {AGENT} {second}"),
    );
    machine.pass_until("second Codex", Duration::from_secs(5), |events| {
        events.iter().any(|e| e.session == ben_second)
    });
    let other = machine
        .events
        .iter()
        .find(|e| e.session == ben_second)
        .unwrap()
        .clone();
    assert_ne!(other.participant, codex.participant);
    assert_ne!(other.lifetime, codex.lifetime);
    assert_eq!(children("transcript-reader", BEN).len(), 2);

    // The link to the host drops: no reader stays. What is written meanwhile
    // is read once when the link is back, from where the checkpoint says.
    assert_eq!(machine.ask("idle"), ["ok"]);
    wait_for("readers exit when the link drops", || {
        children("transcript-reader", BEN).is_empty()
            && children("transcript-reader", MAYA).is_empty()
    });
    append(
        rollout,
        r#"{"type":"event_msg","payload":{"type":"while_down"}}"#,
    );
    let before = machine.events.len();
    machine.pass_until(
        "record written while the link was down",
        Duration::from_secs(5),
        |events| events.len() == before + 1,
    );
    let resumed = machine.events.last().unwrap().clone();
    assert_eq!(
        resumed.text,
        r#"{"type":"event_msg","payload":{"type":"while_down"}}"#
    );
    assert_eq!(
        (&resumed.lifetime, resumed.generation),
        (&codex.lifetime, 1)
    );
    assert_eq!(resumed.start, record_end(&machine.events, ben, 1));

    // Claude Code `/clear`: the same process starts another session file. It
    // is a new source of the same participant; the old one is read out.
    let cleared = "5b2c9e10-0000-4000-8000-00000000c1de";
    member_file(
        &transcript(cleared),
        MAYA,
        "{\"type\":\"mode\",\"after\":\"clear\"}\n",
    );
    fs::write(
        format!("/home/maya/.claude/sessions/{claude_pid}.json"),
        claude_session(claude_pid, cleared),
    )
    .unwrap();
    machine.pass_until(
        "the session after /clear",
        Duration::from_secs(8),
        |events| {
            events
                .iter()
                .any(|e| e.text.contains("\"after\":\"clear\""))
        },
    );
    let after_clear = machine.events.last().unwrap().clone();
    assert_eq!(after_clear.session, maya);
    assert_eq!(after_clear.participant, claude.participant);
    assert_ne!(after_clear.lifetime, claude.lifetime);
    assert_eq!((after_clear.generation, after_clear.start), (1, 0));
    wait_for("the old Claude source is read out and released", || {
        machine.pass();
        children("transcript-reader", MAYA).len() == 1
            && machine
                .sources()
                .iter()
                .all(|source| source[0] != claude.lifetime)
    });

    // The host refuses a record of Ben's first source: that source stops for
    // as long as the process lives. His other Codex and Maya's Claude Code
    // are untouched.
    append(
        rollout,
        r#"{"type":"event_msg","payload":{"type":"refuse"}}"#,
    );
    machine.pass_until(
        "the refused record is sent",
        Duration::from_secs(5),
        |events| events.iter().any(|e| e.text.contains("\"refuse\"")),
    );
    machine.pass();
    wait_for("the refused source's reader is stopped", || {
        children("transcript-reader", BEN).len() == 1
    });
    append(
        rollout,
        r#"{"type":"event_msg","payload":{"type":"after_refusal"}}"#,
    );
    append(
        second,
        r#"{"type":"event_msg","payload":{"type":"second_continues"}}"#,
    );
    append(&transcript(cleared), r#"{"type":"user","n":2}"#);
    machine.pass_until(
        "the other sources continue",
        Duration::from_secs(5),
        |events| {
            events.iter().any(|e| e.text.contains("second_continues"))
                && events.iter().any(|e| e.text == r#"{"type":"user","n":2}"#)
        },
    );
    for _ in 0..15 {
        machine.pass();
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!machine
        .events
        .iter()
        .any(|e| e.text.contains("after_refusal")));
    assert!(machine
        .sources()
        .iter()
        .all(|source| source[0] != codex.lifetime));

    // Ben's second Codex writes its last record and exits. The record still
    // arrives; then its source is released and its reader is gone.
    append(
        second,
        r#"{"type":"event_msg","payload":{"type":"last_words"}}"#,
    );
    let second_pid = session_processes(ben_second)[0] as i32;
    // SAFETY: a pid read from the session's own cgroup a moment ago.
    assert_eq!(unsafe { libc::kill(second_pid, libc::SIGKILL) }, 0);
    machine.pass_until(
        "the exited agent's last record",
        Duration::from_secs(5),
        |events| events.iter().any(|e| e.text.contains("last_words")),
    );
    wait_for("the exited agent's source is released", || {
        machine.pass();
        children("transcript-reader", BEN).is_empty()
    });
    assert!(machine
        .sources()
        .iter()
        .all(|source| source[0] != other.lifetime));

    // Maya is removed from the team. Her session is killed and her reader
    // with it, inside the 5 s revocation bound. What she already shared stays
    // in the outbox's history; nothing more of hers is read.
    let maya_reader = children("transcript-reader", MAYA)[0];
    let removed = Instant::now();
    assert_eq!(machine.ask("roster ben:20001"), ["ok"]);
    wait_for("the removed member's reader is killed", || {
        fs::metadata(format!("/proc/{maya_reader}")).is_err()
    });
    assert!(removed.elapsed() < Duration::from_secs(5));
    assert!(session_processes(maya).is_empty());
    let shared = machine.texts(maya).len();
    append(&transcript(cleared), r#"{"type":"user","after":"removal"}"#);
    for _ in 0..15 {
        assert_eq!(machine.pass(), 0);
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(machine.texts(maya).len(), shared);
    assert!(children("transcript-reader", MAYA).is_empty());
    assert!(children("transcript-resolve", MAYA).is_empty());

    // Only the linked sessions were shared. The rollout nobody holds open was
    // never read, and every record of a source is contiguous from its start.
    assert!(!machine.events.iter().any(|e| e.text.contains("unrelated")));
    let mut next = std::collections::BTreeMap::new();
    for event in &machine.events {
        let expected = next.entry(event.lifetime.clone()).or_insert(0);
        assert_eq!(event.start, *expected, "{event:?}");
        assert_eq!(event.end, event.start + event.text.len() as u64 + 1);
        *expected = event.end;
    }
    // The broker answered every question promptly: it waited on no member.
    assert!(
        machine.slowest < 1000,
        "a daemon turn took {} ms",
        machine.slowest
    );
    // Members' files are as they were written.
    assert_eq!(fs::metadata(rollout).unwrap().uid(), BEN);
    assert_eq!(
        fs::metadata(rollout).unwrap().permissions().mode() & 0o7777,
        0o600
    );
    assert_eq!(
        fs::read_to_string(history).unwrap(),
        format!("{META}\n{{\"unrelated\":\"history\"}}\n")
    );
    machine.shutdown();
}

/// The end of the `nth` record (from 0) of a session's first source.
fn record_end(events: &[Event], session: u32, nth: usize) -> u64 {
    events
        .iter()
        .filter(|e| e.session == session)
        .nth(nth)
        .unwrap()
        .end
}

#[test]
#[ignore = "requires a disposable Linux root (SMITHERS_DISPOSABLE_ROOT=1)"]
fn an_owner_child_that_never_answers_cannot_hold_the_broker() {
    let mut machine = Machine::boot();
    let rollout = "/home/ben/.codex/sessions/2026/10/09/rollout-2026-10-09T05-05-52-01a119e7.jsonl";
    member_file(rollout, BEN, &format!("{META}\n"));
    assert_eq!(machine.ask("roster ben:20001 maya:20002"), ["ok"]);
    // The install's binary is replaced by one that never answers and never
    // exits, as a member who stopped their own child would have it.
    let real = format!("{EXECUTABLE}.real");
    fs::rename(EXECUTABLE, &real).unwrap();
    fs::write(EXECUTABLE, "#!/bin/sh\nexec sleep 60\n").unwrap();
    fs::set_permissions(EXECUTABLE, fs::Permissions::from_mode(0o755)).unwrap();
    let sleepers = || {
        fs::read_dir("/proc")
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                let command = fs::read(path.join("cmdline")).ok()?;
                (command.starts_with(b"sleep\x0060\x00") && fs::metadata(&path).ok()?.uid() == BEN)
                    .then_some(())
            })
            .count()
    };

    let ben = machine.open(
        "ben",
        BEN,
        &format!("/home/ben/tools/codex {AGENT} {rollout}"),
    );
    let began = Instant::now();
    let mut most = 0;
    while began.elapsed() < Duration::from_millis(3500) {
        machine.pass();
        most = most.max(sleepers());
        std::thread::sleep(Duration::from_millis(50));
    }
    // The broker asked, did not wait, and killed the child at its deadline.
    // It asks again later, not at once, and never holds two.
    assert_eq!(most, 1);
    assert!(
        machine.slowest < 500,
        "a daemon turn took {} ms",
        machine.slowest
    );
    assert_eq!(machine.sources(), Vec::<Vec<String>>::new());
    assert!(machine.events.is_empty());
    wait_for("the unanswering child is killed", || {
        machine.pass();
        sleepers() == 0
    });

    // With the real binary back, the same agent is resolved and read at the
    // broker's next attempt.
    fs::rename(&real, EXECUTABLE).unwrap();
    machine.pass_until(
        "the agent is read once its resolver answers",
        Duration::from_secs(12),
        |events| events.len() == 1,
    );
    assert_eq!(machine.texts(ben), [META]);
    assert_eq!(machine.ask(&format!("kill-session {ben}")), ["ok"]);
    wait_for("the killed session's reader is stopped", || {
        children("transcript-reader", BEN).is_empty()
    });
    machine.shutdown();
}
