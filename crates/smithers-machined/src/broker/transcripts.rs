//! The root broker's record of members' own agent sessions (spec §9.6.6).
//!
//! For each terminal session a roster member owns, it knows which of the
//! session's processes are that member's Codex or Claude Code (`discovery`),
//! asks a one-shot owner-uid child which file is each one's transcript
//! (`resolve`), and starts an owner-uid reader for it (`launch`), bound to that
//! file before the daemon may ask it anything.
//!
//! What root does here: read kernel facts about processes, fork and drop
//! privileges, write one small frame to a new socket, keep child handles, kill
//! and reap them. It opens no home path and reads no transcript byte. It never
//! waits for a member's process: a resolver's answer is peeked without
//! blocking and given up after a deadline, and a reader's socket goes to the
//! daemon unread.
//!
//! Nothing is discovered until the daemon asks (`sources`), which it does only
//! while its link to the host is authenticated and ready. Every tick only
//! stops what must stop: a session that ended, or whose member left the
//! roster, loses its children at once.
use crate::transcript::{
    discovery::{self, Agent, Link},
    launch::{self, Owner, Role},
    reader::{self, Startup},
    resolve::{self, Request, Resolved},
    wire::Source,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    os::{fd::OwnedFd, unix::net::UnixStream},
    path::{Path, PathBuf},
    process::Child,
    time::{Duration, Instant},
};

/// The only program a transcript child is: this install's own daemon binary.
pub const EXECUTABLE: &str = "/opt/smithers/bin/smithers-machined";
/// Agent processes tracked on one machine. Past it, new ones wait for a slot.
pub const MAX_AGENTS: usize = 64;
/// Files remembered for one agent process, read or refused. An agent that
/// switches files faster than they are read loses the oldest.
const MAX_SOURCES: usize = 8;
/// How often the daemon's question reads the kernel again.
const SCAN: Duration = Duration::from_secs(1);
/// How often a Claude Code process is asked again which file is its session:
/// `/clear` starts a new one in the same process.
const RECHECK: Duration = Duration::from_secs(2);
/// How long a resolver may take to answer before it is killed.
const ANSWER: Duration = Duration::from_secs(2);
/// How long an ended source waits for the daemon's last read.
const DRAIN: Duration = Duration::from_secs(30);

/// One member terminal session, from the registry and the held cgroup. No
/// request supplies any field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub id: u32,
    pub owner: Owner,
    pub home: String,
    pub procs: PathBuf,
}

/// One transcript source as the daemon sees it: ids to name it by, and whose
/// it is. No path, home, uid or executable is in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Listed {
    pub lifetime: [u8; 16],
    pub participant: [u8; 16],
    pub session: u32,
    pub agent: Agent,
    /// The process is gone or moved to another file: read what is left, then
    /// release the source.
    pub ended: bool,
}
impl Listed {
    pub const BYTES: usize = 38;
    fn encode(&self, bytes: &mut Vec<u8>) {
        bytes.extend(self.lifetime);
        bytes.extend(self.participant);
        bytes.extend(self.session.to_be_bytes());
        bytes.push(match self.agent {
            Agent::Codex => 1,
            Agent::ClaudeCode => 2,
        });
        bytes.push(if self.ended { 2 } else { 1 });
    }
    /// The daemon's read of the broker's list. Anything this module would not
    /// have written refuses the whole list.
    pub fn decode(bytes: &[u8]) -> io::Result<Vec<Self>> {
        if !bytes.len().is_multiple_of(Self::BYTES)
            || bytes.len() > Self::BYTES * MAX_AGENTS * MAX_SOURCES
        {
            return Err(invalid());
        }
        let mut seen = BTreeSet::new();
        bytes
            .chunks(Self::BYTES)
            .map(|entry| {
                let listed = Self {
                    lifetime: entry[..16].try_into().unwrap(),
                    participant: entry[16..32].try_into().unwrap(),
                    session: u32::from_be_bytes(entry[32..36].try_into().unwrap()),
                    agent: match entry[36] {
                        1 => Agent::Codex,
                        2 => Agent::ClaudeCode,
                        _ => return Err(invalid()),
                    },
                    ended: match entry[37] {
                        1 => false,
                        2 => true,
                        _ => return Err(invalid()),
                    },
                };
                if listed.lifetime == [0; 16]
                    || listed.participant == [0; 16]
                    || listed.session == 0
                    || listed.session > 0x7fff_ffff
                    || !seen.insert(listed.lifetime)
                {
                    return Err(invalid());
                }
                Ok(listed)
            })
            .collect()
    }
}

fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
fn stop(child: &mut Child) {
    // The handle is unreaped, so the pid is still this child's.
    let _ = child.kill();
    let _ = child.wait();
}
fn fresh() -> io::Result<[u8; 16]> {
    let mut id = [0; 16];
    while id == [0; 16] {
        getrandom::fill(&mut id).map_err(|error| io::Error::other(error.to_string()))?;
    }
    Ok(id)
}

struct Resolving {
    child: Child,
    socket: UnixStream,
    request: Request,
    since: Instant,
}

/// One transcript file of one agent process.
struct Tracked {
    lifetime: [u8; 16],
    root: String,
    path: String,
    profile: String,
    /// The owner-uid reader whose socket the daemon holds.
    reader: Option<Child>,
    ended: Option<Instant>,
    /// The host refused this source. It is never read again; it is remembered
    /// so the same file is not offered under a new name.
    stopped: bool,
}

/// One agent process lifetime: (session, pid, start time) names it.
struct Process {
    pid: u32,
    owner: Owner,
    participant: [u8; 16],
    agent: Agent,
    root: String,
    link: Link,
    gone: bool,
    sources: Vec<Tracked>,
    resolving: Option<Resolving>,
    /// When to ask next which file is the transcript; none while not needed.
    due: Option<Instant>,
    failures: u32,
}
impl Process {
    fn end(&mut self, now: Instant) {
        for source in &mut self.sources {
            if !source.stopped && source.ended.is_none() {
                source.ended = Some(now);
            }
        }
    }
    fn shutdown(&mut self) {
        if let Some(mut resolving) = self.resolving.take() {
            stop(&mut resolving.child);
        }
        for source in &mut self.sources {
            if let Some(mut reader) = source.reader.take() {
                stop(&mut reader);
            }
        }
    }
    /// The resolver named this file. The same file as the one being read, or
    /// as one the host refused, changes nothing. Another file ends the one
    /// being read and becomes a new source.
    fn resolved(&mut self, resolved: Resolved, now: Instant) -> io::Result<()> {
        let profile = resolve::profile(self.agent, &resolved.release).ok_or_else(invalid)?;
        if self.sources.iter().any(|source| {
            source.root == self.root
                && source.path == resolved.path
                && (source.stopped || source.ended.is_none())
        }) {
            return Ok(());
        }
        let lifetime = fresh()?;
        self.end(now);
        if self.sources.len() == MAX_SOURCES {
            if let Some(mut reader) = self.sources.remove(0).reader {
                stop(&mut reader);
            }
        }
        self.sources.push(Tracked {
            lifetime,
            root: self.root.clone(),
            path: resolved.path,
            profile,
            reader: None,
            ended: None,
            stopped: false,
        });
        Ok(())
    }
    fn failed(&mut self, now: Instant) {
        self.failures = (self.failures + 1).min(6);
        self.due = Some(now + Duration::from_secs(1 << self.failures));
    }
    /// One step of the resolver exchange. It reads only what has already
    /// arrived and never waits.
    fn progress(&mut self, executable: &Path, now: Instant) {
        if let Some(resolving) = &mut self.resolving {
            let mut peeked = vec![0; 5 + resolve::MAX_ANSWER];
            let arrived = rustix::net::recv(
                &resolving.socket,
                &mut peeked,
                rustix::net::RecvFlags::PEEK | rustix::net::RecvFlags::DONTWAIT,
            );
            let outcome = match arrived {
                Ok((0, _)) => Err(invalid()),
                Ok((count, _)) => match resolve::frame(&peeked[..count]) {
                    Ok(Some((tag, body))) => resolve::answer(tag, body, &resolving.request),
                    Ok(None) if now.saturating_duration_since(resolving.since) < ANSWER => return,
                    Ok(None) => Err(io::ErrorKind::TimedOut.into()),
                    Err(error) => Err(error),
                },
                Err(rustix::io::Errno::AGAIN)
                    if now.saturating_duration_since(resolving.since) < ANSWER =>
                {
                    return
                }
                Err(_) => Err(io::ErrorKind::TimedOut.into()),
            };
            let mut finished = self.resolving.take().unwrap();
            stop(&mut finished.child);
            // An answer for a file the process has since left is not used.
            if finished.request.root != self.root || finished.request.link != self.link || self.gone
            {
                return;
            }
            match outcome.and_then(|answer| match answer {
                Some(resolved) => self.resolved(resolved, now).map(|()| true),
                None => Ok(false),
            }) {
                Ok(found) => {
                    self.failures = 0;
                    self.due = match (found, self.agent) {
                        // Not written yet: ask again soon.
                        (false, _) => Some(now + SCAN),
                        (true, Agent::ClaudeCode) => Some(now + RECHECK),
                        // Codex: the kernel shows a change of file.
                        (true, Agent::Codex) => None,
                    };
                }
                Err(_) => self.failed(now),
            }
            return;
        }
        if self.gone || self.due.is_none_or(|due| now < due) {
            return;
        }
        self.due = None;
        let request = Request {
            uid: self.owner.uid,
            gid: self.owner.gid,
            groups: self.owner.groups.clone(),
            root: self.root.clone(),
            agent: self.agent,
            pid: self.pid,
            link: self.link.clone(),
        };
        let started = launch::spawn(executable, Role::Resolve, &self.owner).and_then(
            |(mut child, mut socket)| {
                let sent = socket
                    .set_nonblocking(true)
                    .and_then(|()| resolve::request(&mut socket, &request));
                match sent {
                    Ok(()) => Ok((child, socket)),
                    Err(error) => {
                        stop(&mut child);
                        Err(error)
                    }
                }
            },
        );
        match started {
            Ok((child, socket)) => {
                self.resolving = Some(Resolving {
                    child,
                    socket,
                    request,
                    since: now,
                })
            }
            Err(_) => self.failed(now),
        }
    }
}

type Key = (u32, u32, u64);

pub struct Transcripts {
    executable: PathBuf,
    agents: BTreeMap<Key, Process>,
    scanned: Option<Instant>,
}
impl Default for Transcripts {
    fn default() -> Self {
        Self {
            executable: EXECUTABLE.into(),
            agents: BTreeMap::new(),
            scanned: None,
        }
    }
}
impl Drop for Transcripts {
    fn drop(&mut self) {
        for process in self.agents.values_mut() {
            process.shutdown();
        }
    }
}
impl Transcripts {
    /// Stop what must stop, and move resolver exchanges along. `live` answers
    /// from the registry whether a session is still a roster member's own.
    /// Nothing here can fail the broker: a transcript is never worth a machine.
    pub fn tick(&mut self, live: &mut dyn FnMut(u32) -> bool, now: Instant) {
        let executable = &self.executable;
        self.agents.retain(|key, process| {
            if !live(key.0) {
                process.shutdown();
                return false;
            }
            for source in &mut process.sources {
                // A reader that exited (its socket closed, or its member killed
                // it) is reaped; the daemon may ask for another.
                if let Some(reader) = &mut source.reader {
                    if !matches!(reader.try_wait(), Ok(None)) {
                        source.reader = None;
                    }
                }
            }
            process.sources.retain_mut(|source| {
                let over = !source.stopped
                    && source
                        .ended
                        .is_some_and(|at| now.saturating_duration_since(at) >= DRAIN);
                if over {
                    if let Some(mut reader) = source.reader.take() {
                        stop(&mut reader);
                    }
                }
                !over
            });
            process.progress(executable, now);
            let finished = process.gone
                && process.resolving.is_none()
                && process.sources.iter().all(|source| source.stopped);
            if finished {
                process.shutdown();
            }
            !finished
        });
    }

    fn scan(&mut self, session: &Session, now: Instant) {
        // A list that cannot be read now is read again at the next scan; what
        // is tracked stays as it is until then.
        let Ok(found) = discovery::scan(&session.procs, session.owner.uid, &session.home) else {
            return;
        };
        let mut seen = BTreeSet::new();
        for agent in found {
            let key = (session.id, agent.pid, agent.start_ticks);
            seen.insert(key);
            if let Some(process) = self.agents.get_mut(&key) {
                if process.root != agent.root || process.link != agent.link {
                    process.end(now);
                    process.root = agent.root;
                    process.link = agent.link;
                    process.due = Some(now);
                }
                continue;
            }
            if self.agents.len() == MAX_AGENTS {
                continue;
            }
            let Ok(participant) = fresh() else {
                continue;
            };
            self.agents.insert(
                key,
                Process {
                    pid: key.1,
                    owner: session.owner.clone(),
                    participant,
                    agent: agent.agent,
                    root: agent.root,
                    link: agent.link,
                    gone: false,
                    sources: Vec::new(),
                    resolving: None,
                    due: Some(now),
                    failures: 0,
                },
            );
        }
        for (key, process) in self
            .agents
            .range_mut((session.id, 0, 0)..=(session.id, u32::MAX, u64::MAX))
        {
            if !seen.contains(key) && !process.gone {
                process.gone = true;
                process.due = None;
                process.end(now);
            }
        }
    }

    /// The daemon's question: which sources are there to read. Reads the
    /// kernel again when the last scan is old enough.
    pub fn sources(&mut self, sessions: &[Session], now: Instant) -> Vec<u8> {
        if self
            .scanned
            .is_none_or(|at| now.saturating_duration_since(at) >= SCAN)
        {
            self.scanned = Some(now);
            for session in sessions {
                self.scan(session, now);
            }
        }
        let mut listing = Vec::new();
        for (key, process) in &mut self.agents {
            process.progress(&self.executable, now);
            for source in &process.sources {
                if !source.stopped {
                    Listed {
                        lifetime: source.lifetime,
                        participant: process.participant,
                        session: key.0,
                        agent: process.agent,
                        ended: source.ended.is_some(),
                    }
                    .encode(&mut listing);
                }
            }
        }
        listing
    }

    /// Census of live process participants, independent of transcript setup or
    /// draining older files. Reads only the broker's discovered process state.
    pub fn presence(&self, sessions: &[Session]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (key, process) in &self.agents {
            if !process.gone && sessions.iter().any(|session| session.id == key.0) {
                // Reuse the bounded broker list codec; the participant is the
                // process identity, rather than any one file's source lifetime.
                Listed {
                    lifetime: process.participant,
                    participant: process.participant,
                    session: key.0,
                    agent: process.agent,
                    ended: false,
                }
                .encode(&mut bytes);
            }
        }
        bytes
    }

    /// Start the owner's reader for one listed source and bind it. Returns the
    /// startup the daemon must repeat (with its checkpoint) and the reader's
    /// socket. `sessions` is the registry's current answer: a source whose
    /// session is no longer its member's own starts nothing.
    pub fn reader(
        &mut self,
        sessions: &[Session],
        lifetime: [u8; 16],
    ) -> io::Result<(Vec<u8>, OwnedFd)> {
        let (key, process) = self
            .agents
            .iter_mut()
            .find(|(_, process)| process.sources.iter().any(|s| s.lifetime == lifetime))
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        if !sessions
            .iter()
            .any(|session| session.id == key.0 && session.owner == process.owner)
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let source = process
            .sources
            .iter_mut()
            .find(|source| source.lifetime == lifetime)
            .unwrap();
        if source.stopped {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        // One reader per source: the daemon asking again has lost its socket.
        if let Some(mut reader) = source.reader.take() {
            stop(&mut reader);
        }
        let startup = Startup {
            uid: process.owner.uid,
            gid: process.owner.gid,
            groups: process.owner.groups.clone(),
            root: source.root.clone(),
            path: source.path.clone(),
            source: Source {
                session: key.0,
                participant: process.participant,
                lifetime,
                profile: source.profile.clone(),
            },
            checkpoint: None,
        };
        let bytes = serde_json::to_vec(&startup).map_err(|_| invalid())?;
        let (mut child, mut socket) = launch::spawn(&self.executable, Role::Read, &process.owner)?;
        // Small, into a new socket's empty buffer: this write does not wait.
        if let Err(error) = reader::bind(&mut socket, &startup) {
            stop(&mut child);
            return Err(error);
        }
        source.reader = Some(child);
        Ok((bytes, socket.into()))
    }

    /// The daemon is done with a source: it read an ended one to its end, or
    /// the host refused it (`stopped`), which holds for as long as the process
    /// lives. A name this broker no longer knows is already released.
    pub fn release(&mut self, lifetime: [u8; 16], stopped: bool) {
        for process in self.agents.values_mut() {
            let Some(index) = process.sources.iter().position(|s| s.lifetime == lifetime) else {
                continue;
            };
            let source = &mut process.sources[index];
            if let Some(mut reader) = source.reader.take() {
                stop(&mut reader);
            }
            if stopped {
                source.stopped = true;
            } else if source.ended.is_some() {
                process.sources.remove(index);
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(tag: u8, session: u32, agent: Agent, ended: bool) -> Listed {
        Listed {
            lifetime: [tag; 16],
            participant: [tag + 100; 16],
            session,
            agent,
            ended,
        }
    }

    #[test]
    fn the_list_round_trips_and_refuses_what_the_broker_would_not_write() {
        let entries = vec![
            listed(1, 7, Agent::Codex, false),
            listed(2, 0x7fff_ffff, Agent::ClaudeCode, true),
        ];
        let mut bytes = Vec::new();
        for entry in &entries {
            entry.encode(&mut bytes);
        }
        assert_eq!(bytes.len(), 2 * Listed::BYTES);
        assert_eq!(Listed::decode(&bytes).unwrap(), entries);
        assert_eq!(Listed::decode(&[]).unwrap(), vec![]);
        let change = |at: usize, value: u8| {
            let mut changed = bytes.clone();
            changed[at] = value;
            changed
        };
        for (name, bad) in [
            ("a cut entry", bytes[..bytes.len() - 1].to_vec()),
            ("an unknown agent", change(36, 3)),
            ("an unknown state", change(37, 0)),
            ("session zero", {
                let mut zero = bytes.clone();
                zero[32..36].fill(0);
                zero
            }),
            ("a session past the registry's ids", change(32, 0x80)),
            ("a zero lifetime", {
                let mut zero = bytes.clone();
                zero[..16].fill(0);
                zero
            }),
            ("a zero participant", {
                let mut zero = bytes.clone();
                zero[16..32].fill(0);
                zero
            }),
            ("one lifetime twice", [&bytes[..38], &bytes[..38]].concat()),
            (
                "more than a machine holds",
                bytes[..38].repeat(MAX_AGENTS * MAX_SOURCES + 1),
            ),
        ] {
            assert!(Listed::decode(&bad).is_err(), "{name}");
        }
    }

    fn process(agent: Agent) -> Process {
        Process {
            pid: 4242,
            owner: Owner {
                uid: 20001,
                gid: 20001,
                groups: vec![20000],
            },
            participant: [7; 16],
            agent,
            root: "/home/ben/.claude".into(),
            link: Link::SessionFile,
            gone: false,
            sources: Vec::new(),
            resolving: None,
            due: None,
            failures: 0,
        }
    }
    #[test]
    fn process_census_precedes_files_and_ends_before_drain() {
        let mut transcripts = Transcripts::default();
        transcripts
            .agents
            .insert((1, 4242, 10), process(Agent::Codex));
        let mut second = process(Agent::ClaudeCode);
        second.participant = [8; 16];
        transcripts.agents.insert((1, 4243, 11), second);
        let session = Session {
            id: 1,
            owner: Owner {
                uid: 20001,
                gid: 20001,
                groups: vec![20000],
            },
            home: "/home/ben".into(),
            procs: "/unused".into(),
        };
        let rows = Listed::decode(&transcripts.presence(&[session.clone()])).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].participant, [7; 16]);
        assert_eq!(rows[1].participant, [8; 16]);
        assert!(transcripts.presence(&[]).is_empty());
        let first = transcripts.agents.get_mut(&(1, 4242, 10)).unwrap();
        first
            .resolved(
                Resolved {
                    path: "sessions/test.jsonl".into(),
                    release: "0.160.0".into(),
                },
                Instant::now(),
            )
            .unwrap();
        first.gone = true;
        first.end(Instant::now());
        assert_eq!(first.sources.len(), 1);
        let rows = Listed::decode(&transcripts.presence(&[session])).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].participant, [8; 16]);
    }

    fn named(path: &str) -> Resolved {
        Resolved {
            path: path.into(),
            release: "2.1.291".into(),
        }
    }

    #[test]
    fn a_new_file_ends_the_one_being_read_and_a_refused_file_stays_refused() {
        let now = Instant::now();
        let mut process = process(Agent::ClaudeCode);
        let first = "projects/-workspace/11111111-1111-4111-8111-111111111111.jsonl";
        let second = "projects/-workspace/22222222-2222-4222-8222-222222222222.jsonl";
        process.resolved(named(first), now).unwrap();
        assert_eq!(process.sources.len(), 1);
        assert_eq!(process.sources[0].profile, "claude-code/2.1");
        let lifetime = process.sources[0].lifetime;
        assert_ne!(lifetime, [0; 16]);
        // Asked again, the same file is the same source.
        process.resolved(named(first), now).unwrap();
        assert_eq!(process.sources.len(), 1);
        assert_eq!(process.sources[0].lifetime, lifetime);
        assert_eq!(process.sources[0].ended, None);
        // `/clear`: another file. The first ends, the second is new.
        process.resolved(named(second), now).unwrap();
        assert_eq!(process.sources.len(), 2);
        assert_eq!(process.sources[0].ended, Some(now));
        assert_eq!(process.sources[1].ended, None);
        assert_ne!(process.sources[1].lifetime, lifetime);
        // The host refuses the second. It is not offered again under a new name.
        process.sources[1].stopped = true;
        process.resolved(named(second), now).unwrap();
        assert_eq!(process.sources.len(), 2);
        // A release this module cannot read a line from names no source.
        assert!(process
            .resolved(
                Resolved {
                    path: second.replace('2', "3"),
                    release: "latest".into()
                },
                now
            )
            .is_err());
        assert_eq!(process.sources.len(), 2);
        // An agent that keeps switching loses its oldest file, not its newest.
        for index in 0..MAX_SOURCES {
            let path = format!("projects/-workspace/{index:08}-0000-4000-8000-000000000000.jsonl");
            process.resolved(named(&path), now).unwrap();
        }
        assert_eq!(process.sources.len(), MAX_SOURCES);
        assert!(process.sources.last().unwrap().path.contains("00000007-"));
        assert_eq!(
            process
                .sources
                .iter()
                .filter(|s| s.ended.is_none() && !s.stopped)
                .count(),
            1
        );
    }

    #[test]
    fn a_failed_resolver_is_asked_again_later_each_time_up_to_a_bound() {
        let now = Instant::now();
        let mut process = process(Agent::Codex);
        let mut waits = Vec::new();
        for _ in 0..8 {
            process.failed(now);
            waits.push(process.due.unwrap().duration_since(now).as_secs());
        }
        assert_eq!(waits, [2, 4, 8, 16, 32, 64, 64, 64]);
    }
}
