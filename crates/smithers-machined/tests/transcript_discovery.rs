//! Root inputs of external transcript import on a real kernel (spec §9.6.6,
//! C-AGT-02 TestExternalTranscriptRootInputs): which processes the root broker
//! takes for a member's agent, and what the owner-uid resolver and reader may
//! open. Processes, uids, groups, procfs, cgroups and files are the kernel's.
//!
//! The agents are stand-ins: this test binary started under the executable
//! names discovery reads, holding the files a real Codex holds and writing the
//! session file a real Claude Code writes. Real agent sessions inside a
//! machine are the reference host's receipts.
//!
//! Every test but the stand-in needs root in a Linux host with a writable
//! cgroup v2 hierarchy, to create two members, drop to them and kill a
//! session. They are ignored in an ordinary run; run them with `--ignored`.
#![cfg(target_os = "linux")]
use smithers_machined::{
    broker::process_identity::start_ticks,
    transcript::{
        discovery::{self, Agent, Found, Link},
        launch::{self, Owner, Role},
        reader::{self, Reader, Startup},
        resolve::{self, Request, Resolved},
        wire::Source,
    },
};
use std::{
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::unix::{
        fs::{chown, symlink, MetadataExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const BEN: u32 = 20001;
const MAYA: u32 = 20002;
const TEAM: u32 = 20000;

/// Started under an agent's name with SMITHERS_FAKE_AGENT set, this test is
/// the agent process: it holds the named file open for appending, says it is
/// ready and stays until it is killed. In an ordinary run it does nothing.
#[test]
fn fake_agent() {
    let Ok(hold) = std::env::var("SMITHERS_FAKE_AGENT") else {
        return;
    };
    let _held = (!hold.is_empty()).then(|| OpenOptions::new().append(true).open(&hold).unwrap());
    println!("fake-agent-ready");
    io::stdout().flush().unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

const ROOT: &str = "requires Linux root and a writable cgroup v2 hierarchy";
fn require_root() {
    assert!(rustix::process::geteuid().is_root(), "{ROOT}");
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Running {
    fn pid(&self) -> u32 {
        self.0.id()
    }
}

/// One machine's worth of members: two homes under a private directory, each
/// 0700 and its member's own, as a branch machine provisions them.
struct Machine {
    dir: PathBuf,
}
impl Machine {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("smithers-agt-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let machine = Self { dir };
        for (login, uid) in [("ben", BEN), ("maya", MAYA)] {
            machine.directory(&format!("home/{login}"), uid, 0o700);
        }
        // The stand-in agent binary, where any member may execute it.
        fs::copy(std::env::current_exe().unwrap(), machine.dir.join("agent")).unwrap();
        fs::set_permissions(machine.dir.join("agent"), fs::Permissions::from_mode(0o755)).unwrap();
        machine
    }
    fn home(&self, login: &str) -> String {
        self.dir
            .join("home")
            .join(login)
            .to_str()
            .unwrap()
            .to_owned()
    }
    /// Create `relative` and every missing parent beneath the machine, owned by `uid`.
    fn directory(&self, relative: &str, uid: u32, mode: u32) -> PathBuf {
        let mut path = self.dir.clone();
        for part in relative.split('/') {
            path.push(part);
            if !path.exists() {
                fs::create_dir(&path).unwrap();
                fs::set_permissions(
                    &path,
                    fs::Permissions::from_mode(if part == "home" { 0o755 } else { mode }),
                )
                .unwrap();
                if part != "home" {
                    chown(&path, Some(uid), Some(uid)).unwrap();
                }
            }
        }
        path
    }
    fn file(&self, relative: &str, uid: u32, contents: &str) -> PathBuf {
        let (parent, _) = relative.rsplit_once('/').unwrap();
        let path = self
            .directory(parent, uid, 0o700)
            .join(relative.rsplit('/').next().unwrap());
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        chown(&path, Some(uid), Some(uid)).unwrap();
        path
    }
    /// The stand-in under the executable path `exe` (a hard link, so the
    /// kernel reports that path), run as `uid` with `environment`, holding
    /// `hold` open when it names a file.
    fn agent(
        &self,
        exe: &str,
        uid: u32,
        environment: &[(&str, &str)],
        hold: Option<&Path>,
    ) -> Running {
        let exe = self.dir.join(exe);
        if !exe.exists() {
            let parent = exe.parent().unwrap().strip_prefix(&self.dir).unwrap();
            self.directory(parent.to_str().unwrap(), uid, 0o755);
            fs::hard_link(self.dir.join("agent"), &exe).unwrap();
        }
        let mut command = Command::new(&exe);
        command
            .args([
                "--exact",
                "fake_agent",
                "--nocapture",
                "--test-threads",
                "1",
            ])
            .env_clear()
            .env(
                "SMITHERS_FAKE_AGENT",
                hold.map(|p| p.to_str().unwrap()).unwrap_or(""),
            )
            .envs(environment.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: syscalls only, between fork and exec.
        unsafe {
            command.pre_exec(move || {
                let groups = [TEAM];
                if libc::setgroups(1, groups.as_ptr()) != 0
                    || libc::setresgid(uid, uid, uid) != 0
                    || libc::setresuid(uid, uid, uid) != 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        // The harness writes "test fake_agent ... " before the test's own line.
        assert!(
            lines
                .by_ref()
                .any(|line| line.unwrap().ends_with("fake-agent-ready")),
            "the stand-in agent did not start"
        );
        Running(child)
    }
    fn listed(&self, pids: &[u32]) -> PathBuf {
        let path = self.dir.join("cgroup.procs");
        fs::write(
            &path,
            pids.iter()
                .map(|pid| format!("{pid}\n"))
                .collect::<String>(),
        )
        .unwrap();
        path
    }
}
impl Drop for Machine {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn ben() -> Owner {
    Owner {
        uid: BEN,
        gid: BEN,
        groups: vec![TEAM],
    }
}
fn machined() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_smithers-machined"))
}
/// The four uids, four gids, supplementary groups and no-new-privileges flag
/// the kernel reports for a live process.
fn identity(pid: u32) -> (Vec<u32>, Vec<u32>, Vec<u32>, bool) {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let field = |name: &str| -> Vec<u32> {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .unwrap()
            .split_whitespace()
            .map(|value| value.parse().unwrap())
            .collect()
    };
    (
        field("Uid:"),
        field("Gid:"),
        field("Groups:"),
        field("NoNewPrivs:") == [1],
    )
}
fn wait_for(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(
            Instant::now() < deadline,
            "condition did not hold within 5 s"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

const ROLLOUT: &str = ".codex/sessions/2026/10/08/rollout-2026-10-08T05-05-52-01a119e7-51a2-7c83-86d2-3f125158d08b.jsonl";
const META: &str = "{\"timestamp\":\"2026-10-08T05:05:52.563Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"01a119e7-51a2-7c83-86d2-3f125158d08b\",\"cwd\":\"/workspace\",\"cli_version\":\"0.160.1\"}}\n";
const CLAUDE_SESSION: &str = "889e416d-fda3-42c0-869a-56b3ced78a05";

#[test]
#[ignore = "requires Linux root and a writable cgroup v2 hierarchy"]
fn discovery_takes_only_the_owners_agents_linked_to_one_transcript() {
    require_root();
    let machine = Machine::new("discover");
    let home = machine.home("ben");
    let rollout = machine.file(&format!("home/ben/{ROLLOUT}"), BEN, META);
    let moved = machine.file(
        "home/ben/work/agent-home/sessions/2026/10/07/rollout-moved.jsonl",
        BEN,
        META,
    );
    let maya_rollout = machine.file(&format!("home/maya/{ROLLOUT}"), MAYA, META);
    machine.directory("home/ben/.codex-empty", BEN, 0o700);

    // Ben's terminal session: Codex, Claude Code, a second Codex whose home he
    // moved, his shell, a Codex that has written no rollout yet, and one he
    // pointed at Maya's home. Maya's own Codex is in her session, not his.
    let codex = machine.agent(
        "home/ben/tools/codex",
        BEN,
        &[("HOME", &home)],
        Some(&rollout),
    );
    let claude = machine.agent(
        "home/ben/.local/share/claude/versions/2.1.291",
        BEN,
        &[("HOME", &home)],
        None,
    );
    let moved_home = format!("{home}/work/agent-home");
    let moved_codex = machine.agent(
        "home/ben/tools/codex",
        BEN,
        &[("CODEX_HOME", &moved_home)],
        Some(&moved),
    );
    let shell = machine.agent("home/ben/tools/bash", BEN, &[], Some(&rollout));
    let idle_codex = machine.agent(
        "home/ben/tools/codex",
        BEN,
        &[("CODEX_HOME", &format!("{home}/.codex-empty"))],
        None,
    );
    let maya_home = machine.home("maya");
    let aimed_at_maya = machine.agent(
        "home/ben/tools/codex",
        BEN,
        &[("CODEX_HOME", &format!("{maya_home}/.codex"))],
        Some(&rollout),
    );
    let mayas = machine.agent(
        "home/maya/tools/codex",
        MAYA,
        &[("HOME", &maya_home)],
        Some(&maya_rollout),
    );

    let all = [
        &codex,
        &claude,
        &moved_codex,
        &shell,
        &idle_codex,
        &aimed_at_maya,
        &mayas,
    ];
    let procs = machine.listed(&all.map(Running::pid));
    let found = discovery::scan(&procs, BEN, &home).unwrap();
    assert_eq!(
        found,
        vec![
            Found {
                pid: codex.pid(),
                start_ticks: start_ticks(codex.pid()).unwrap(),
                agent: Agent::Codex,
                root: format!("{home}/.codex"),
                link: Link::Rollout(ROLLOUT.trim_start_matches(".codex/").into()),
            },
            Found {
                pid: claude.pid(),
                start_ticks: start_ticks(claude.pid()).unwrap(),
                agent: Agent::ClaudeCode,
                root: format!("{home}/.claude"),
                link: Link::SessionFile,
            },
            Found {
                pid: moved_codex.pid(),
                start_ticks: start_ticks(moved_codex.pid()).unwrap(),
                agent: Agent::Codex,
                root: moved_home.clone(),
                link: Link::Rollout("sessions/2026/10/07/rollout-moved.jsonl".into()),
            },
        ]
    );
    // The same list read for Maya's session takes her process and none of Ben's.
    let hers = discovery::scan(&procs, MAYA, &maya_home).unwrap();
    assert_eq!(
        hers.iter().map(|agent| agent.pid).collect::<Vec<_>>(),
        vec![mayas.pid()]
    );
    assert_eq!(hers[0].root, format!("{maya_home}/.codex"));
    // Read against another home, none of Ben's Codex processes is linked: the
    // rollouts they hold are not beneath it.
    assert!(discovery::scan(&procs, BEN, &maya_home)
        .unwrap()
        .iter()
        .all(|agent| agent.agent != Agent::Codex));

    // An agent that exits is gone from the next scan, with no error.
    let gone = codex.pid();
    drop(codex);
    let after = discovery::scan(&procs, BEN, &home).unwrap();
    assert!(after.iter().all(|agent| agent.pid != gone));
    assert_eq!(after.len(), 2);
}

#[test]
#[ignore = "requires Linux root and a writable cgroup v2 hierarchy"]
fn the_resolver_answers_as_the_owner_from_the_agents_own_files() {
    require_root();
    let machine = Machine::new("resolve");
    let home = machine.home("ben");
    let rollout = machine.file(&format!("home/ben/{ROLLOUT}"), BEN, META);
    let ask = |request: &Request| -> io::Result<Option<Resolved>> {
        let (mut child, socket) = launch::spawn(machined(), Role::Resolve, &ben())?;
        let answer = resolve::ask(&socket, request);
        let _ = child.kill();
        child.wait()?;
        answer
    };
    let codex = Request {
        uid: BEN,
        gid: BEN,
        groups: vec![TEAM],
        root: format!("{home}/.codex"),
        agent: Agent::Codex,
        pid: 4242,
        link: Link::Rollout(ROLLOUT.trim_start_matches(".codex/").into()),
    };
    let resolved = ask(&codex).unwrap().unwrap();
    assert_eq!(
        resolved,
        Resolved {
            path: ROLLOUT.trim_start_matches(".codex/").into(),
            release: "0.160.1".into()
        }
    );
    assert_eq!(
        resolve::profile(Agent::Codex, &resolved.release).as_deref(),
        Some("codex-rollout/0.160")
    );

    // Claude Code: the session file names the session, where it ran and its release.
    let claude = Request {
        root: format!("{home}/.claude"),
        agent: Agent::ClaudeCode,
        pid: 777,
        link: Link::SessionFile,
        ..codex.clone()
    };
    let session = |pid: u32, cwd: &str| {
        format!("{{\"pid\":{pid},\"sessionId\":\"{CLAUDE_SESSION}\",\"cwd\":\"{cwd}\",\"startedAt\":1791435951451,\"version\":\"2.1.291\",\"kind\":\"interactive\"}}")
    };
    machine.file(
        "home/ben/.claude/sessions/777.json",
        BEN,
        &session(777, "/workspace/agt-capture/work.qL7V"),
    );
    // Before the first prompt there is no transcript: not yet, not an error.
    assert_eq!(ask(&claude).unwrap(), None);
    let transcript = format!("projects/-workspace-agt-capture-work-qL7V/{CLAUDE_SESSION}.jsonl");
    machine.file(
        &format!("home/ben/.claude/{transcript}"),
        BEN,
        "{\"type\":\"mode\"}\n",
    );
    let resolved = ask(&claude).unwrap().unwrap();
    assert_eq!(
        resolved,
        Resolved {
            path: transcript.clone(),
            release: "2.1.291".into()
        }
    );
    assert_eq!(
        resolve::profile(Agent::ClaudeCode, &resolved.release).as_deref(),
        Some("claude-code/2.1")
    );
    // A directory Claude Code named another way is found by the session's own id.
    machine.file(
        "home/ben/.claude/sessions/778.json",
        BEN,
        &session(778, "/somewhere/else"),
    );
    assert_eq!(
        ask(&Request {
            pid: 778,
            ..claude.clone()
        })
        .unwrap()
        .unwrap()
        .path,
        transcript
    );

    // A Codex rollout whose first record is still being written: not yet.
    let partial = machine.file(
        "home/ben/.codex/sessions/2026/10/08/rollout-partial.jsonl",
        BEN,
        "{\"type\":\"session_meta\",\"payl",
    );
    let waiting = Request {
        link: Link::Rollout("sessions/2026/10/08/rollout-partial.jsonl".into()),
        ..codex.clone()
    };
    assert_eq!(ask(&waiting).unwrap(), None);
    fs::write(&partial, "{\"type\":\"turn_context\",\"payload\":{}}\n").unwrap();
    assert!(
        ask(&waiting).is_err(),
        "a rollout that does not open with its session record names no release"
    );

    // What the owner's resolver refuses, each before it answers anything.
    let maya_home = machine.home("maya");
    let secret = machine.file(
        "home/maya/.claude/sessions/777.json",
        MAYA,
        &session(777, "/workspace"),
    );
    machine.file(&format!("home/maya/{ROLLOUT}"), MAYA, META);
    let refused =
        |name: &str, request: Request| assert!(ask(&request).is_err(), "{name} was answered");
    refused(
        "another member's agent root",
        Request {
            root: format!("{maya_home}/.codex"),
            ..codex.clone()
        },
    );
    refused(
        "another member's uid in the request",
        Request {
            uid: MAYA,
            gid: MAYA,
            ..codex.clone()
        },
    );
    refused(
        "root's uid in the request",
        Request {
            uid: 0,
            gid: 0,
            ..codex.clone()
        },
    );
    refused(
        "more groups than the owner holds",
        Request {
            groups: vec![TEAM, 27],
            ..codex.clone()
        },
    );
    refused(
        "a rollout outside the sessions tree",
        Request {
            link: Link::Rollout("../../maya/.codex/sessions/2026/10/08/x.jsonl".into()),
            ..codex.clone()
        },
    );
    refused(
        "an agent and link that do not belong together",
        Request {
            link: Link::SessionFile,
            ..codex.clone()
        },
    );
    refused(
        "a session file for another pid",
        Request {
            pid: 779,
            ..claude.clone()
        },
    );
    machine.file(
        "home/ben/.claude/sessions/779.json",
        BEN,
        &session(777, "/workspace"),
    );
    refused(
        "a session file that names another process",
        Request {
            pid: 779,
            ..claude.clone()
        },
    );
    // A link in the owner's own tree to another member's file is not followed.
    symlink(
        &secret,
        machine.dir.join("home/ben/.claude/sessions/780.json"),
    )
    .unwrap();
    refused(
        "a session file that is a link",
        Request {
            pid: 780,
            ..claude.clone()
        },
    );
    fs::remove_file(&rollout).unwrap();
    symlink(machine.dir.join(format!("home/maya/{ROLLOUT}")), &rollout).unwrap();
    refused("a rollout that is a link", codex.clone());
    fs::remove_file(&rollout).unwrap();
    fs::create_dir(&rollout).unwrap();
    refused("a rollout that is a directory", codex.clone());
    // A root-owned file placed in the owner's tree is not the owner's to read here.
    fs::remove_dir(&rollout).unwrap();
    fs::write(&rollout, META).unwrap();
    refused("a rollout the owner does not own", codex.clone());
    // Maya's files were never changed by any of it.
    assert_eq!(
        fs::read_to_string(&secret).unwrap(),
        session(777, "/workspace")
    );
    assert_eq!(
        fs::metadata(&secret).unwrap().permissions().mode() & 0o7777,
        0o600
    );
}

#[test]
#[ignore = "requires Linux root and a writable cgroup v2 hierarchy"]
fn a_launched_child_is_exactly_the_owner_and_reads_only_the_owners_transcript() {
    require_root();
    let machine = Machine::new("launch");
    let home = machine.home("ben");
    let rollout = machine.file(&format!("home/ben/{ROLLOUT}"), BEN, META);
    machine.file(&format!("home/maya/{ROLLOUT}"), MAYA, META);

    let (child, mut socket) = launch::spawn(machined(), Role::Read, &ben()).unwrap();
    let child = Running(child);
    // Before it has been told anything, the child already holds only Ben's
    // ids, the team group, and can never gain a privilege again.
    wait_for(|| identity(child.pid()).3);
    assert_eq!(
        identity(child.pid()),
        (vec![BEN; 4], vec![BEN; 4], vec![TEAM], true)
    );
    let executable = fs::read_link(format!("/proc/{}/exe", child.pid())).unwrap();
    assert_eq!(executable.file_name().unwrap(), "smithers-machined");
    assert_eq!(
        fs::read(format!("/proc/{}/environ", child.pid())).unwrap(),
        b""
    );
    assert_eq!(
        fs::read_link(format!("/proc/{}/cwd", child.pid())).unwrap(),
        Path::new("/")
    );
    let descriptors = fs::read_dir(format!("/proc/{}/fd", child.pid()))
        .unwrap()
        .count();
    assert_eq!(
        descriptors, 3,
        "the child holds its socketpair and the null stderr, nothing of the broker's"
    );

    let source = Source {
        session: 1,
        participant: [7; 16],
        lifetime: [9; 16],
        profile: "codex-rollout/0.160".into(),
    };
    let startup = Startup {
        uid: BEN,
        gid: BEN,
        groups: vec![TEAM],
        root: format!("{home}/.codex"),
        path: ROLLOUT.trim_start_matches(".codex/").into(),
        source: source.clone(),
        checkpoint: None,
    };
    reader::bind(&mut socket, &startup).unwrap();
    let mut reader = Reader::connect(socket, &startup).unwrap();
    // It runs as Ben, but Ben cannot attach to it, read its memory or dump
    // it: the kernel gives a sealed process's own files to root.
    for file in ["mem", "environ", "fd"] {
        let owner = fs::metadata(format!("/proc/{}/{file}", child.pid())).unwrap();
        assert_eq!(owner.uid(), 0, "{file}");
    }
    let mut records = Vec::new();
    let poll = |reader: &mut Reader, records: &mut Vec<String>| {
        reader.poll(
            || Ok(()),
            |event| {
                let (from, record) = Source::decode(event).unwrap();
                assert_eq!(from, source);
                records.push(record.text);
                Ok(())
            },
            |_| Ok(()),
        )
    };
    assert_eq!(poll(&mut reader, &mut records).unwrap(), 1);
    assert_eq!(records, vec![META.trim_end().to_owned()]);
    // The agent appends; the owner's reader frames the new record.
    let line = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}";
    let mut file = OpenOptions::new().append(true).open(&rollout).unwrap();
    writeln!(file, "{line}").unwrap();
    wait_for(|| {
        poll(&mut reader, &mut records).unwrap();
        records.len() == 2
    });
    assert_eq!(records[1], line);

    // The same owner-uid child cannot be pointed at another member's files,
    // told it is someone else, or given root's identity.
    let maya_home = machine.home("maya");
    for (name, forged) in [
        (
            "another member's agent root",
            Startup {
                root: format!("{maya_home}/.codex"),
                ..startup.clone()
            },
        ),
        (
            "another member's uid",
            Startup {
                uid: MAYA,
                gid: MAYA,
                ..startup.clone()
            },
        ),
        (
            "root's uid",
            Startup {
                uid: 0,
                gid: 0,
                ..startup.clone()
            },
        ),
        (
            "an extra group",
            Startup {
                groups: vec![TEAM, 27],
                ..startup.clone()
            },
        ),
        (
            "a path that climbs out of the root",
            Startup {
                path: format!("../../maya/{ROLLOUT}"),
                ..startup.clone()
            },
        ),
    ] {
        // Bound to it by a broker that was wrong, then asked for it by a
        // daemon although the broker bound the honest source.
        for binding in [&forged, &startup] {
            let (other, mut socket) = launch::spawn(machined(), Role::Read, &ben()).unwrap();
            let mut other = Running(other);
            reader::bind(&mut socket, binding).unwrap();
            assert!(
                Reader::connect(socket, &forged).is_err(),
                "{name} was accepted"
            );
            // A refused child exits on its own; it is not left running.
            wait_for(|| other.0.try_wait().unwrap().is_some());
        }
    }
    // A broker asked to start a child as root, or with root's group, forks nothing.
    for owner in [
        Owner { uid: 0, ..ben() },
        Owner { gid: 0, ..ben() },
        Owner {
            groups: vec![0],
            ..ben()
        },
    ] {
        assert!(launch::spawn(machined(), Role::Read, &owner).is_err());
    }
    // Maya's transcript is as it was.
    assert_eq!(
        fs::read_to_string(machine.dir.join(format!("home/maya/{ROLLOUT}"))).unwrap(),
        META
    );
}

#[test]
#[ignore = "requires Linux root and a writable cgroup v2 hierarchy"]
fn discovery_resolution_and_reading_agree_on_one_live_agent_of_a_kernel_cgroup() {
    require_root();
    let machine = Machine::new("slice");
    let home = machine.home("ben");
    let rollout = machine.file(&format!("home/ben/{ROLLOUT}"), BEN, META);
    let codex = machine.agent(
        "home/ben/tools/codex",
        BEN,
        &[("HOME", &home)],
        Some(&rollout),
    );

    // A session cgroup of the kernel's own: the list discovery reads is the
    // kernel's, and killing the cgroup is how a session ends.
    let cgroup =
        Path::new("/sys/fs/cgroup").join(format!("smithers-agt-test-{}", std::process::id()));
    fs::create_dir(&cgroup).expect(ROOT);
    let procs = cgroup.join("cgroup.procs");
    fs::write(&procs, codex.pid().to_string()).expect(ROOT);

    let found = discovery::scan(&procs, BEN, &home).unwrap();
    assert_eq!(found.len(), 1);
    let agent = &found[0];
    assert_eq!((agent.pid, agent.agent), (codex.pid(), Agent::Codex));
    let request = Request {
        uid: BEN,
        gid: BEN,
        groups: vec![TEAM],
        root: agent.root.clone(),
        agent: agent.agent,
        pid: agent.pid,
        link: agent.link.clone(),
    };
    let (mut resolver, socket) = launch::spawn(machined(), Role::Resolve, &ben()).unwrap();
    let resolved = resolve::ask(&socket, &request).unwrap().unwrap();
    resolver.wait().unwrap();
    let source = Source {
        session: 1,
        participant: [7; 16],
        lifetime: [9; 16],
        profile: resolve::profile(agent.agent, &resolved.release).unwrap(),
    };
    assert_eq!(source.profile, "codex-rollout/0.160");

    let (reader_child, mut socket) = launch::spawn(machined(), Role::Read, &ben()).unwrap();
    let reader_child = Running(reader_child);
    let startup = Startup {
        uid: BEN,
        gid: BEN,
        groups: vec![TEAM],
        root: agent.root.clone(),
        path: resolved.path.clone(),
        source: source.clone(),
        checkpoint: None,
    };
    reader::bind(&mut socket, &startup).unwrap();
    let mut reader = Reader::connect(socket, &startup).unwrap();
    let mut texts = Vec::new();
    reader
        .poll(
            || Ok(()),
            |event| {
                texts.push(Source::decode(event).unwrap().1.text);
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();
    assert_eq!(texts, vec![META.trim_end().to_owned()]);
    // The reader runs as Ben and never joins his session's cgroup: its CPU
    // there would read as the session's own activity (spec §9.3). The session
    // still holds exactly the one agent.
    assert_eq!(
        fs::read_to_string(&procs).unwrap().trim(),
        codex.pid().to_string()
    );
    assert_eq!(discovery::scan(&procs, BEN, &home).unwrap(), found);
    // The session ends: its agent is gone from the next scan. The reader is
    // the broker's to stop, with the handle it kept.
    fs::write(cgroup.join("cgroup.kill"), "1").unwrap();
    drop(codex);
    wait_for(|| fs::read_to_string(&procs).unwrap().trim().is_empty());
    assert_eq!(discovery::scan(&procs, BEN, &home).unwrap(), vec![]);
    assert!(fs::metadata(format!("/proc/{}", reader_child.pid())).is_ok());
    drop(reader_child);
    assert!(
        reader.poll(|| Ok(()), |_| Ok(()), |_| Ok(())).is_err(),
        "a killed reader read again"
    );
    fs::remove_dir(&cgroup).unwrap();
}
