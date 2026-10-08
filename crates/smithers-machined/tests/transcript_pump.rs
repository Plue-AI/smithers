//! The daemon's transcript pump (spec §9.6.6) against real reader children,
//! real files and the real checkpoint store. The broker and the outbox are
//! this test's: the broker starts the installed reader as the test's own user
//! and binds it as the root broker would; the outbox is a list in memory.
//! Root-side discovery and the privilege drop are tests/transcript_discovery.rs
//! and tests/transcript_broker.rs.
#![cfg(target_os = "linux")]
use smithers_machined::{
    broker::transcripts::Listed,
    transcript::{
        discovery::Agent,
        pump::{Broker, Outbox, Pump, QUEUED},
        reader::{self, Startup},
        wire::Source,
    },
};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const CODEX: [u8; 16] = [1; 16];
const CLAUDE: [u8; 16] = [2; 16];

#[derive(Default)]
struct BrokerState {
    listed: Vec<Listed>,
    bound: BTreeMap<[u8; 16], Startup>,
    children: Vec<([u8; 16], Child)>,
    started: Vec<[u8; 16]>,
    released: Vec<([u8; 16], bool)>,
    /// Bind and answer with a source other than the one asked for.
    forge: Option<fn(&mut Startup)>,
    unavailable: bool,
    /// Releases arrive but change nothing: the source stays listed.
    deaf: bool,
}
#[derive(Clone, Default)]
struct TestBroker(Arc<Mutex<BrokerState>>);
impl TestBroker {
    fn alive(&self, lifetime: [u8; 16]) -> usize {
        let mut state = self.0.lock().unwrap();
        let mut alive = 0;
        for (of, child) in &mut state.children {
            if *of == lifetime && child.try_wait().unwrap().is_none() {
                alive += 1;
            }
        }
        alive
    }
    fn kill(&self, lifetime: [u8; 16]) {
        for (of, child) in &mut self.0.lock().unwrap().children {
            if *of == lifetime {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    fn released(&self) -> Vec<([u8; 16], bool)> {
        self.0.lock().unwrap().released.clone()
    }
    fn started(&self) -> Vec<[u8; 16]> {
        self.0.lock().unwrap().started.clone()
    }
    fn list(&self, lifetime: [u8; 16], ended: bool) {
        let mut state = self.0.lock().unwrap();
        state.listed.retain(|source| source.lifetime != lifetime);
        let source = state.bound[&lifetime].source.clone();
        state.listed.push(Listed {
            lifetime,
            participant: source.participant,
            session: source.session,
            agent: if lifetime == CODEX {
                Agent::Codex
            } else {
                Agent::ClaudeCode
            },
            ended,
        });
    }
    fn unlist(&self, lifetime: [u8; 16]) {
        self.0
            .lock()
            .unwrap()
            .listed
            .retain(|source| source.lifetime != lifetime);
    }
}
impl Drop for BrokerState {
    fn drop(&mut self) {
        for (_, child) in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Broker for TestBroker {
    fn sources(&self) -> io::Result<Vec<Listed>> {
        let state = self.0.lock().unwrap();
        if state.unavailable {
            return Err(io::ErrorKind::Unsupported.into());
        }
        Ok(state.listed.clone())
    }
    fn reader(&self, lifetime: [u8; 16]) -> io::Result<(Startup, UnixStream)> {
        let mut state = self.0.lock().unwrap();
        let mut startup = state
            .bound
            .get(&lifetime)
            .cloned()
            .ok_or(io::ErrorKind::NotFound)?;
        if let Some(forge) = state.forge {
            forge(&mut startup);
        }
        let (mut socket, child_socket) = UnixStream::pair()?;
        let input: std::os::fd::OwnedFd = child_socket.try_clone()?.into();
        let output: std::os::fd::OwnedFd = child_socket.into();
        let child = Command::new(env!("CARGO_BIN_EXE_smithers-machined"))
            .arg("transcript-reader")
            .env_clear()
            .stdin(Stdio::from(input))
            .stdout(Stdio::from(output))
            .stderr(Stdio::null())
            .spawn()?;
        reader::bind(&mut socket, &startup)?;
        state.children.push((lifetime, child));
        state.started.push(lifetime);
        Ok((startup, socket))
    }
    fn release(&self, lifetime: [u8; 16], stopped: bool) -> io::Result<()> {
        let mut state = self.0.lock().unwrap();
        state.released.push((lifetime, stopped));
        if state.deaf {
            return Err(io::Error::other("broker did not answer"));
        }
        // The root broker stops listing a released source.
        state.listed.retain(|source| source.lifetime != lifetime);
        Ok(())
    }
}

#[derive(Default)]
struct OutboxState {
    events: Mutex<Vec<Vec<u8>>>,
    /// Events of other kinds already queued ahead.
    queued: AtomicU32,
    refused: Mutex<Vec<[u8; 16]>>,
    failing: AtomicBool,
}
#[derive(Clone, Default)]
struct TestOutbox(Arc<OutboxState>);
impl TestOutbox {
    /// What was appended, as (source lifetime, generation, start, end, text).
    fn records(&self) -> Vec<([u8; 16], u64, u64, u64, String)> {
        self.0
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|event| {
                let (source, record) = Source::decode(event).unwrap();
                (
                    source.lifetime,
                    record.generation,
                    record.start,
                    record.end,
                    record.text,
                )
            })
            .collect()
    }
    fn texts(&self, lifetime: [u8; 16]) -> Vec<String> {
        self.records()
            .into_iter()
            .filter(|record| record.0 == lifetime)
            .map(|record| record.4)
            .collect()
    }
}
impl Outbox for TestOutbox {
    fn depth(&self) -> io::Result<u32> {
        Ok(self.0.queued.load(Ordering::SeqCst))
    }
    fn append(&self, event: &[u8]) -> io::Result<()> {
        if self.0.failing.load(Ordering::SeqCst) {
            return Err(io::Error::other("disk full"));
        }
        self.0.events.lock().unwrap().push(event.to_vec());
        Ok(())
    }
    fn refused(&self) -> io::Result<Vec<[u8; 16]>> {
        Ok(std::mem::take(&mut self.0.refused.lock().unwrap()))
    }
}

struct Fixture {
    dir: PathBuf,
    broker: TestBroker,
    outbox: TestOutbox,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "smithers-pump-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        for name in ["", "checkpoints", "codex", "claude"] {
            let path = dir.join(name);
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let fixture = Self {
            dir,
            broker: TestBroker::default(),
            outbox: TestOutbox::default(),
        };
        for (lifetime, root, session, profile) in [
            (CODEX, "codex", 7, "codex-rollout/0.160"),
            (CLAUDE, "claude", 8, "claude-code/2.1"),
        ] {
            fs::write(fixture.dir.join(root).join("session.jsonl"), b"").unwrap();
            fixture.broker.0.lock().unwrap().bound.insert(
                lifetime,
                Startup {
                    uid: rustix::process::getuid().as_raw(),
                    gid: rustix::process::getgid().as_raw(),
                    groups: rustix::process::getgroups()
                        .unwrap()
                        .iter()
                        .map(|group| group.as_raw())
                        .collect(),
                    root: fixture.dir.join(root).to_str().unwrap().into(),
                    path: "session.jsonl".into(),
                    source: Source {
                        session,
                        participant: [lifetime[0] + 100; 16],
                        lifetime,
                        profile: profile.into(),
                    },
                    checkpoint: None,
                },
            );
        }
        fixture
    }
    fn pump(&self) -> Pump<TestBroker, TestOutbox> {
        Pump::new(
            self.broker.clone(),
            self.outbox.clone(),
            File::open(self.dir.join("checkpoints")).unwrap(),
        )
        .unwrap()
    }
    fn append(&self, lifetime: [u8; 16], bytes: &[u8]) {
        let root = if lifetime == CODEX { "codex" } else { "claude" };
        OpenOptions::new()
            .append(true)
            .open(self.dir.join(root).join("session.jsonl"))
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }
    fn checkpoints(&self) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(self.dir.join("checkpoints"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn name(lifetime: [u8; 16]) -> String {
    lifetime
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        + ".tail"
}
/// Passes until `done`, each at the pump's own cadence. The tail reads again
/// on inotify readiness or after its one second reconciliation.
fn until(pump: &mut Pump<TestBroker, TestOutbox>, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        pump.pass(Instant::now()).unwrap();
        if done() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the pump did not get there in 8 s"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
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

#[test]
fn records_reach_the_outbox_once_and_a_restart_resumes_at_the_checkpoint() {
    let fixture = Fixture::new();
    fixture.append(CODEX, b"{\"n\":1}\n{\"n\":2}\n{\"par");
    fixture.append(CLAUDE, b"{\"c\":1}\n");
    fixture.broker.list(CODEX, false);
    fixture.broker.list(CLAUDE, false);
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 3);
    assert_eq!(
        fixture.outbox.records(),
        vec![
            (CODEX, 1, 0, 8, "{\"n\":1}".to_owned()),
            (CODEX, 1, 8, 16, "{\"n\":2}".to_owned()),
            (CLAUDE, 1, 0, 8, "{\"c\":1}".to_owned()),
        ]
    );
    assert_eq!(pump.reading(), 2);
    assert_eq!(fixture.checkpoints(), [name(CODEX), name(CLAUDE)]);
    // The partial record waits; its completion arrives as one record.
    pump.pass(Instant::now()).unwrap();
    assert_eq!(fixture.outbox.records().len(), 3);
    fixture.append(CODEX, b"tial\":3}\n");
    until(&mut pump, || fixture.outbox.records().len() == 4);
    assert_eq!(
        fixture.outbox.records()[3],
        (CODEX, 1, 16, 30, "{\"partial\":3}".to_owned())
    );
    // One reader per source for all of it.
    assert_eq!(fixture.broker.started(), [CODEX, CLAUDE]);

    // The daemon restarts: a new pump over the same checkpoints reads only
    // what was written since, with the offsets that follow.
    drop(pump);
    wait_for(|| fixture.broker.alive(CODEX) + fixture.broker.alive(CLAUDE) == 0);
    fixture.append(CODEX, b"{\"n\":4}\n");
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 5);
    assert_eq!(
        fixture.outbox.records()[4],
        (CODEX, 1, 30, 38, "{\"n\":4}".to_owned())
    );
    pump.pass(Instant::now()).unwrap();
    assert_eq!(fixture.outbox.records().len(), 5);
    assert_eq!(fixture.broker.released(), Vec::<([u8; 16], bool)>::new());
}

#[test]
fn nothing_is_read_while_the_outbox_is_deep_or_cannot_take_a_record() {
    let fixture = Fixture::new();
    fixture.append(CODEX, b"{\"n\":1}\n");
    fixture.broker.list(CODEX, false);
    let mut pump = fixture.pump();
    // Other events are queued up to the bound: no reader is even started.
    fixture.outbox.0.queued.store(QUEUED, Ordering::SeqCst);
    for _ in 0..3 {
        pump.pass(Instant::now()).unwrap();
    }
    assert_eq!(fixture.broker.started(), Vec::<[u8; 16]>::new());
    assert!(fixture.outbox.records().is_empty());
    // One below the bound: the record is read.
    fixture.outbox.0.queued.store(QUEUED - 1, Ordering::SeqCst);
    until(&mut pump, || fixture.outbox.records().len() == 1);

    // The outbox refuses an append: the record is not lost. It is read again
    // with the same identity once the outbox takes it.
    fixture.outbox.0.failing.store(true, Ordering::SeqCst);
    fixture.append(CODEX, b"{\"n\":2}\n");
    let failed = Instant::now();
    pump.pass(failed + Duration::from_secs(2)).unwrap();
    assert_eq!(fixture.outbox.records().len(), 1);
    fixture.outbox.0.failing.store(false, Ordering::SeqCst);
    let mut later = failed + Duration::from_secs(60);
    let deadline = Instant::now() + Duration::from_secs(8);
    while fixture.outbox.records().len() < 2 {
        assert!(Instant::now() < deadline);
        later += Duration::from_secs(60);
        pump.pass(later).unwrap();
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        fixture.outbox.records(),
        vec![
            (CODEX, 1, 0, 8, "{\"n\":1}".to_owned()),
            (CODEX, 1, 8, 16, "{\"n\":2}".to_owned()),
        ]
    );
}

#[test]
fn a_source_the_host_refused_is_stopped_and_never_read_again() {
    let fixture = Fixture::new();
    fixture.append(CODEX, b"{\"n\":1}\n");
    fixture.append(CLAUDE, b"{\"c\":1}\n");
    fixture.broker.list(CODEX, false);
    fixture.broker.list(CLAUDE, false);
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 2);
    // The host refuses the Codex source (an unsupported release, say), at a
    // moment the broker does not take the release: the source stays listed.
    fixture.broker.0.lock().unwrap().deaf = true;
    fixture.outbox.0.refused.lock().unwrap().push(CODEX);
    fixture.append(CODEX, b"{\"n\":2}\n");
    fixture.append(CLAUDE, b"{\"c\":2}\n");
    until(&mut pump, || fixture.outbox.texts(CLAUDE).len() == 2);
    assert_eq!(fixture.broker.released()[0], (CODEX, true));
    assert_eq!(fixture.checkpoints(), [name(CLAUDE)]);
    wait_for(|| fixture.broker.alive(CODEX) == 0);
    assert_eq!(pump.reading(), 1);
    // Listed or not, it is not read again, and the release is repeated until
    // the broker takes it.
    for _ in 0..3 {
        pump.pass(Instant::now() + Duration::from_secs(120))
            .unwrap();
    }
    assert_eq!(fixture.outbox.texts(CODEX), ["{\"n\":1}"]);
    assert_eq!(fixture.broker.started(), [CODEX, CLAUDE]);
    let repeated = fixture.broker.released();
    assert!(repeated.len() >= 4 && repeated.iter().all(|release| *release == (CODEX, true)));
    fixture.broker.0.lock().unwrap().deaf = false;
    pump.pass(Instant::now() + Duration::from_secs(240))
        .unwrap();
    pump.pass(Instant::now() + Duration::from_secs(360))
        .unwrap();
    assert_eq!(fixture.broker.released().len(), repeated.len() + 1);
    assert_eq!(fixture.outbox.texts(CODEX), ["{\"n\":1}"]);
    // The other member's source was untouched by any of it.
    assert_eq!(fixture.outbox.texts(CLAUDE), ["{\"c\":1}", "{\"c\":2}"]);
}

#[test]
fn an_ended_source_is_read_to_its_end_then_released() {
    let fixture = Fixture::new();
    fixture.append(CODEX, b"{\"n\":1}\n");
    fixture.broker.list(CODEX, false);
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 1);
    // The agent wrote its last records and exited before they were read.
    fixture.append(CODEX, b"{\"n\":2}\n{\"n\":3}\n{\"never finis");
    fixture.broker.list(CODEX, true);
    until(&mut pump, || !fixture.broker.released().is_empty());
    assert_eq!(
        fixture.outbox.texts(CODEX),
        ["{\"n\":1}", "{\"n\":2}", "{\"n\":3}"]
    );
    assert_eq!(fixture.broker.released(), [(CODEX, false)]);
    assert_eq!(fixture.checkpoints(), Vec::<String>::new());
    assert_eq!(pump.reading(), 0);
    wait_for(|| fixture.broker.alive(CODEX) == 0);
    // An ended source nobody read before the daemon restarted is still read.
    let fixture = Fixture::new();
    fixture.append(CLAUDE, b"{\"c\":1}\n");
    fixture.broker.list(CLAUDE, true);
    let mut pump = fixture.pump();
    until(&mut pump, || !fixture.broker.released().is_empty());
    assert_eq!(fixture.outbox.texts(CLAUDE), ["{\"c\":1}"]);
}

#[test]
fn a_source_no_longer_listed_loses_its_reader_and_stale_checkpoints_are_swept() {
    let fixture = Fixture::new();
    // What an earlier boot and an interrupted save left behind.
    for stale in [name([9; 16]), "deadbeef.tail.tmp".to_owned()] {
        fs::write(fixture.dir.join("checkpoints").join(stale), b"{}").unwrap();
    }
    fs::write(fixture.dir.join("checkpoints/notes.txt"), b"not ours").unwrap();
    fixture.append(CODEX, b"{\"n\":1}\n");
    fixture.broker.list(CODEX, false);
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 1);
    assert_eq!(fixture.checkpoints(), [name(CODEX), "notes.txt".to_owned()]);
    // The member was removed: the broker killed the reader and lists nothing.
    fixture.broker.kill(CODEX);
    fixture.broker.unlist(CODEX);
    fixture.append(CODEX, b"{\"n\":2}\n");
    pump.pass(Instant::now()).unwrap();
    assert_eq!(pump.reading(), 0);
    assert_eq!(fixture.checkpoints(), ["notes.txt"]);
    for _ in 0..3 {
        pump.pass(Instant::now() + Duration::from_secs(120))
            .unwrap();
    }
    assert_eq!(fixture.outbox.texts(CODEX), ["{\"n\":1}"]);
    assert_eq!(fixture.broker.started(), [CODEX]);
    assert_eq!(fixture.broker.released(), Vec::<([u8; 16], bool)>::new());
}

#[test]
fn lines_with_bytes_that_cannot_cross_the_wire_reach_the_outbox_and_the_source_goes_on() {
    let fixture = Fixture::new();
    // What an agent can write that is not a clean JSON line: a byte that is
    // not UTF-8, a NUL, an empty line. None of them ends the session's import.
    fixture.append(
        CODEX,
        b"{\"n\":1}\n{\"text\":\"caf\xe9 \0\"}\n\n{\"n\":3}\n",
    );
    fixture.broker.list(CODEX, false);
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 3);
    assert_eq!(
        fixture.outbox.records(),
        vec![
            (CODEX, 1, 0, 8, "{\"n\":1}".to_owned()),
            // Each unsendable byte is one `?`: the record is as long as its line.
            (CODEX, 1, 8, 26, "{\"text\":\"caf? ?\"}".to_owned()),
            // The empty line is the leading space of the record after it.
            (CODEX, 1, 26, 35, " {\"n\":3}".to_owned()),
        ]
    );
    // The agent keeps writing and is read as before, by the same reader.
    fixture.append(CODEX, b"{\"n\":4}\n");
    until(&mut pump, || fixture.outbox.records().len() == 4);
    assert_eq!(
        fixture.outbox.records()[3],
        (CODEX, 1, 35, 43, "{\"n\":4}".to_owned())
    );
    assert_eq!(fixture.broker.started(), [CODEX]);
    assert_eq!(fixture.broker.released(), Vec::<([u8; 16], bool)>::new());
    assert_eq!(pump.reading(), 1);
}

#[test]
fn oversized_lines_emit_one_skip_and_resume_after_restart() {
    for size in [1024 * 1024 + 1, 5 * 1024 * 1024] {
        let fixture = Fixture::new();
        fixture.append(CODEX, b"{}\n");
        fixture.append(CODEX, &vec![b'x'; size]);
        fixture.broker.list(CODEX, false);
        let mut pump = fixture.pump();
        for _ in 0..size / 65536 + 2 {
            pump.pass(Instant::now()).unwrap();
        }
        assert_eq!(fixture.outbox.texts(CODEX), ["{}"]);
        drop(pump);
        wait_for(|| fixture.broker.alive(CODEX) == 0);
        fixture.append(CODEX, b"\n{\"later\":true}\n");
        fixture.broker.list(CODEX, true);
        let mut pump = fixture.pump();
        until(&mut pump, || fixture.outbox.records().len() == 3);
        let events = fixture.outbox.0.events.lock().unwrap();
        let (_, skipped) = Source::decode(&events[1]).unwrap();
        assert_eq!(skipped.skipped, Some(size as u64));
        assert_eq!((skipped.start, skipped.end), (3, size as u64 + 4));
        let (_, later) = Source::decode(&events[2]).unwrap();
        assert_eq!(later.start, skipped.end);
        assert_eq!(later.text, "{\"later\":true}");
        drop(events);
        assert!(fixture.broker.released().is_empty());
        pump.pass(Instant::now()).unwrap();
        assert_eq!(fixture.outbox.records().len(), 3);
        assert_eq!(fixture.broker.released(), [(CODEX, false)]);
    }
}

#[test]
fn a_truncated_or_replaced_transcript_is_a_new_generation_read_from_its_start() {
    let fixture = Fixture::new();
    let path = fixture.dir.join("codex/session.jsonl");
    fixture.append(CODEX, b"{\"n\":1}\n{\"n\":2}\n");
    fixture.broker.list(CODEX, false);
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 2);
    // The agent truncates its file and writes again, shorter than before.
    fs::write(&path, b"{\"t\":1}\n").unwrap();
    until(&mut pump, || fixture.outbox.records().len() == 3);
    assert_eq!(
        fixture.outbox.records()[2],
        (CODEX, 2, 0, 8, "{\"t\":1}".to_owned())
    );
    // Then replaces it: another file under the same name.
    let replacement = fixture.dir.join("codex/next.jsonl");
    fs::write(&replacement, b"{\"r\":1}\n{\"r\":2}\n").unwrap();
    fs::rename(&replacement, &path).unwrap();
    until(&mut pump, || fixture.outbox.records().len() == 5);
    assert_eq!(
        fixture.outbox.records()[3..],
        [
            (CODEX, 3, 0, 8, "{\"r\":1}".to_owned()),
            (CODEX, 3, 8, 16, "{\"r\":2}".to_owned()),
        ]
    );
    // A daemon restart continues the third generation where it stopped.
    drop(pump);
    wait_for(|| fixture.broker.alive(CODEX) == 0);
    fixture.append(CODEX, b"{\"r\":3}\n");
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 6);
    assert_eq!(
        fixture.outbox.records()[5],
        (CODEX, 3, 16, 24, "{\"r\":3}".to_owned())
    );
    // One source throughout: the same lifetime, never a second reader at once.
    assert_eq!(fixture.broker.started(), [CODEX, CODEX]);
    assert_eq!(fixture.broker.released(), Vec::<([u8; 16], bool)>::new());
}

#[test]
fn a_killed_reader_is_replaced_and_no_record_is_lost_or_repeated() {
    let fixture = Fixture::new();
    fixture.append(CODEX, b"{\"n\":1}\n");
    fixture.broker.list(CODEX, false);
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 1);
    // The member kills the reader that runs as them.
    fixture.broker.kill(CODEX);
    fixture.append(CODEX, b"{\"n\":2}\n");
    let began = Instant::now();
    pump.pass(began).unwrap();
    assert_eq!(pump.reading(), 0);
    // It is not asked for again at once, then it is.
    pump.pass(began + Duration::from_millis(500)).unwrap();
    assert_eq!(fixture.broker.started(), [CODEX]);
    let mut later = began + Duration::from_secs(3);
    let deadline = Instant::now() + Duration::from_secs(8);
    while fixture.outbox.records().len() < 2 {
        assert!(Instant::now() < deadline);
        pump.pass(later).unwrap();
        later += Duration::from_millis(50);
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(fixture.broker.started(), [CODEX, CODEX]);
    assert_eq!(
        fixture.outbox.records(),
        vec![
            (CODEX, 1, 0, 8, "{\"n\":1}".to_owned()),
            (CODEX, 1, 8, 16, "{\"n\":2}".to_owned()),
        ]
    );
}

#[test]
fn a_reader_bound_to_something_other_than_was_listed_is_not_read() {
    for forge in [
        (|startup: &mut Startup| startup.source.session += 1) as fn(&mut Startup),
        |startup| startup.source.participant = [77; 16],
        |startup| startup.source.lifetime = [78; 16],
        |startup| startup.checkpoint = Some("{}".into()),
    ] {
        let fixture = Fixture::new();
        fixture.append(CODEX, b"{\"n\":1}\n");
        fixture.broker.list(CODEX, false);
        fixture.broker.0.lock().unwrap().forge = Some(forge);
        let mut pump = fixture.pump();
        for step in 0..4 {
            pump.pass(Instant::now() + Duration::from_secs(120 * step))
                .unwrap();
        }
        assert!(fixture.outbox.records().is_empty());
        assert_eq!(pump.reading(), 0);
        assert_eq!(fixture.checkpoints(), Vec::<String>::new());
    }
}

#[test]
fn idle_lets_go_of_every_reader_and_keeps_what_was_read() {
    let fixture = Fixture::new();
    fixture.append(CODEX, b"{\"n\":1}\n");
    fixture.append(CLAUDE, b"{\"c\":1}\n");
    fixture.broker.list(CODEX, false);
    fixture.broker.list(CLAUDE, false);
    let mut pump = fixture.pump();
    until(&mut pump, || fixture.outbox.records().len() == 2);
    // The link to the host is gone: no reader stays, in under a second.
    pump.idle();
    assert_eq!(pump.reading(), 0);
    wait_for(|| fixture.broker.alive(CODEX) + fixture.broker.alive(CLAUDE) == 0);
    assert_eq!(fixture.checkpoints(), [name(CODEX), name(CLAUDE)]);
    // Written while the link was down, read when it is back, once.
    fixture.append(CODEX, b"{\"n\":2}\n");
    until(&mut pump, || fixture.outbox.records().len() == 3);
    assert_eq!(fixture.outbox.texts(CODEX), ["{\"n\":1}", "{\"n\":2}"]);
    // A broker with no import at all is an error the caller stops on.
    fixture.broker.0.lock().unwrap().unavailable = true;
    assert_eq!(
        pump.pass(Instant::now()).unwrap_err().kind(),
        io::ErrorKind::Unsupported
    );
}

#[test]
fn an_ended_source_drains_a_long_line_before_release() {
    let fixture = Fixture::new();
    fixture.append(CODEX, &vec![b'x'; 5 * 1024 * 1024]);
    fixture.append(CODEX, b"\n{}\n");
    fixture.broker.list(CODEX, true);
    let mut pump = fixture.pump();
    // One 64 KiB read per pass, followed by the EOF pass. No wall-clock
    // timeout: checkpoint fsync time varies on a shared host.
    for _ in 0..82 {
        pump.pass(Instant::now()).unwrap();
    }
    assert_eq!(fixture.broker.released(), [(CODEX, false)]);
    assert_eq!(
        fixture.outbox.texts(CODEX),
        ["Skipped oversized transcript line.", "{}"]
    );
}
