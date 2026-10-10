//! The session dispatcher owns one registry and the existing bounded credit pipe.
//! Kernel implementations never receive a path or PID chosen by the daemon.
use super::{
    control,
    request::Request,
    sessions::{self, Admission, Kind, Sessions, User},
};
use crate::{
    conn::{self, Frame},
    session_stream::{Exit, Input, Pipe},
};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{self, Read, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Installed providers validate account, credential and environment availability
/// before spawn. Test kernels are confined to tests; there is no host fallback.
pub trait Kernel: Send {
    /// Foreground command names from held PTYs only; no caller supplies a pid.
    fn terminal_commands(&mut self) -> io::Result<std::collections::BTreeMap<u32, String>> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn process_identity(&mut self, _id: u32) -> io::Result<Option<sessions::ProcessIdentity>> {
        Ok(None)
    }
    fn available(&mut self) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn recover(&mut self, deadline: Instant) -> io::Result<()>;
    fn ready(&mut self, user: &User) -> io::Result<()>;
    /// A local child inherits its authenticated caller's startup binding;
    /// it must not consume a new host admission for the agent UID.
    fn ready_local(&mut self, _user: &User, _caller: u32) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
    /// Failure may leave a child or cgroup. The supervisor retains ownership
    /// and calls kill before forgetting the reservation.
    fn spawn(
        &mut self,
        id: u32,
        user: &User,
        kind: Kind,
        argv: &[String],
        size: Option<(u16, u16)>,
        port: Option<u16>,
    ) -> io::Result<()>;
    fn read(&mut self, id: u32, fd: u8, bytes: &mut [u8]) -> io::Result<usize>;
    fn write(&mut self, id: u32, bytes: &[u8]) -> io::Result<usize>;
    fn eof(&mut self, id: u32) -> io::Result<()>;
    fn resize(&mut self, id: u32, rows: u16, cols: u16) -> io::Result<()>;
    fn signal(&mut self, id: u32, signal: u8) -> io::Result<()>;
    fn exited(&mut self, id: u32) -> io::Result<Option<Exit>>;
    fn close(&mut self, id: u32, kind: Kind) -> io::Result<()>;
    /// Also accepts a reserved ID whose spawn failed before creating a group.
    /// Return success only after no child or cgroup remains.
    fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()>;
    fn frozen(&mut self) -> io::Result<bool> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn freeze(&mut self, timeout: Duration) -> io::Result<Option<u32>>;
    fn thaw(&mut self) -> io::Result<()>;
    /// External transcript import (spec §9.6.6). `live` and `sessions` are the
    /// registry's own answer to whose terminal sessions these are; no request
    /// supplies a session, an owner, a pid or a path. A kernel without the
    /// import refuses it, and nothing is discovered or read.
    fn transcript_tick(&mut self, _live: &mut dyn FnMut(u32) -> bool, _now: Instant) {}
    fn transcript_pause(&mut self, _live: &mut dyn FnMut(u32) -> bool) {}
    fn transcript_sources(
        &mut self,
        _sessions: &[TranscriptSession],
        _now: Instant,
    ) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn transcript_presence(&mut self, _sessions: &[TranscriptSession]) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn transcript_reader(
        &mut self,
        _sessions: &[TranscriptSession],
        _lifetime: [u8; 16],
    ) -> io::Result<(Vec<u8>, std::os::fd::OwnedFd)> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn transcript_release(&mut self, _lifetime: [u8; 16], _stopped: bool) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
}
/// A roster member's own terminal session, as the registry holds it.
pub type TranscriptSession = (u32, User, sessions::ProcessIdentity);
fn invalid() -> io::Error {
    io::ErrorKind::InvalidInput.into()
}
struct Shared<K>(Arc<Mutex<K>>);
struct OpenSession {
    user: User,
    kind: Kind,
    argv: Vec<String>,
    size: Option<(u16, u16)>,
    port: Option<u16>,
    caller: Option<u32>,
    admission: Admission,
}

impl<K> Clone for Shared<K> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<K> Shared<K> {
    fn with<T>(&self, f: impl FnOnce(&mut K) -> io::Result<T>) -> io::Result<T> {
        f(&mut *self
            .0
            .lock()
            .map_err(|_| io::Error::other("session kernel poisoned"))?)
    }
}
impl<K: Kernel> sessions::Controls for Shared<K> {
    fn close(&mut self, id: u32, kind: Kind) -> io::Result<()> {
        self.with(|k| k.close(id, kind))
    }
    fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()> {
        self.with(|k| k.kill(id, deadline))
    }
}
struct Descriptor<K> {
    kernel: Shared<K>,
    id: u32,
    kind: Kind,
    fd: u8,
}
impl<K: Kernel> Write for Descriptor<K> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.kernel.with(|k| k.write(self.id, bytes))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl<K: Kernel> Read for Descriptor<K> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.kernel.with(|k| k.read(self.id, self.fd, bytes))
    }
}
impl<K: Kernel> Input for Descriptor<K> {
    fn eof(&mut self) -> io::Result<()> {
        self.kernel.with(|k| k.eof(self.id))
    }
    fn resize(&mut self, r: u16, c: u16) -> io::Result<()> {
        self.kernel.with(|k| k.resize(self.id, r, c))
    }
    fn signal(&mut self, s: u8) -> io::Result<()> {
        self.kernel.with(|k| k.signal(self.id, s))
    }
    fn close(&mut self) -> io::Result<()> {
        self.kernel.with(|k| k.close(self.id, self.kind))
    }
}
struct Stream<K> {
    pipe: Pipe<Descriptor<K>>,
    kind: Kind,
    local: bool,
    observer: Option<Pipe<Descriptor<K>>>,
    observed: VecDeque<Frame>,
    next_fd: u8,
    replay: VecDeque<Frame>,
    /// A local agent PTY starts paused (T-TRM-05): its runner waits for one
    /// newline on the terminal before it prints or executes anything. The
    /// broker writes that byte when the host attaches its observer, or after
    /// [`GATE_DEADLINE`] without one, so the Terminal card misses no output.
    gate: Option<Instant>,
    /// Released without a watcher: a later attach would show a partial command.
    unobserved: bool,
    /// The next time a closed local command session may be reaped.
    reap_after: Option<Instant>,
}
/// How long a local agent command waits for the host's observer.
pub const GATE_DEADLINE: Duration = Duration::from_secs(3);
/// How long a closed local command keeps undelivered observer frames.
pub const REAP_GRACE: Duration = Duration::from_secs(5);
pub struct Supervisor<K> {
    kernel: Shared<K>,
    registry: Sessions<Shared<K>>,
    streams: BTreeMap<u32, Stream<K>>,
    next: u32,
    cursor: u32,
    /// A transcript reader's socket, on its way to the daemon with the reply
    /// to the request that started the reader.
    descriptor: Option<std::os::fd::OwnedFd>,
    transcript_import: bool,
}
impl<K: Kernel> Supervisor<K> {
    pub fn new(kernel: K) -> Self {
        let kernel = Shared(Arc::new(Mutex::new(kernel)));
        Self {
            registry: Sessions::new(kernel.clone()),
            kernel,
            streams: BTreeMap::new(),
            next: 1,
            cursor: 0,
            descriptor: None,
            transcript_import: false,
        }
    }
    fn transcript_sessions(&self) -> Vec<TranscriptSession> {
        self.registry
            .entries()
            .filter_map(|entry| {
                let (user, process) = self.registry.transcript_owner(entry.id)?;
                Some((entry.id, user.clone(), process.clone()))
            })
            .collect()
    }
    pub fn entries(&self) -> impl Iterator<Item = &sessions::Entry> {
        self.registry.entries()
    }
    /// Documents and object streams reserve IDs through the same root-side
    /// allocator via the socketpair; no provider may invent a stream ID.
    pub fn allocate_stream(&mut self) -> io::Result<u32> {
        if self.next > 0x7fff_ffff {
            return Err(invalid());
        }
        let id = self.next;
        self.next += 1;
        Ok(id)
    }
    fn open(&mut self, request: OpenSession) -> io::Result<u32> {
        let OpenSession {
            user,
            kind,
            argv,
            size,
            port,
            caller,
            admission,
        } = request;
        self.registry.authorize(&user)?;
        admission.validate(&user, kind)?;
        if self.registry.entries().count() >= sessions::MAX_SESSIONS || self.next > 0x7fff_ffff {
            return Err(invalid());
        }
        if let Some(caller) = caller {
            self.registry.local_run(19999, caller)?;
        }
        self.kernel.with(|k| match caller {
            Some(caller) => k.ready_local(&user, caller),
            None => k.ready(&user),
        })?;
        let id = self.allocate_stream()?; // failed spawns never reuse IDs
        let input = Descriptor {
            kernel: self.kernel.clone(),
            id,
            kind,
            fd: 0,
        };
        let pipe = Pipe::new(id, input, matches!(kind, Kind::Exec | Kind::Sftp))?;
        if let Some(caller) = caller {
            self.registry.insert_local(id, 19999, caller)?;
        } else {
            self.registry.insert(id, user.clone(), kind, admission)?;
        }
        if let Err(error) = self
            .kernel
            .with(|k| k.spawn(id, &user, kind, &argv, size, port))
        {
            // Cleanup errors take precedence: the failed reservation remains
            // attributable and revocable, but cannot admit or attach traffic.
            self.registry.abort_spawn(id, Instant::now())?;
            return Err(error);
        }
        let binding = self.kernel.with(|k| k.process_identity(id));
        let bound = binding.and_then(|binding| match binding {
            Some(binding) => self.registry.bind_process(id, binding),
            None => Ok(()),
        });
        if let Err(error) = bound {
            self.registry.abort_spawn(id, Instant::now())?;
            return Err(error);
        }
        self.streams.insert(
            id,
            Stream {
                pipe,
                kind,
                local: caller.is_some(),
                // Do not send unsolicited session frames: the host admits its
                // observer with attach_session before the agent starts payload.
                observer: None,
                observed: VecDeque::new(),
                next_fd: 1,
                replay: VecDeque::new(),
                gate: caller.map(|_| Instant::now()),
                unobserved: false,
                reap_after: None,
            },
        );
        Ok(id)
    }
    /// Start a paused local command: one newline on its own terminal input.
    /// The byte is fixed here; no host or watcher chooses terminal input.
    fn release_gate(&mut self, id: u32) -> io::Result<()> {
        let stream = self.streams.get_mut(&id).ok_or_else(invalid)?;
        if stream.gate.is_none() {
            return Ok(());
        }
        let mut input = Descriptor {
            kernel: self.kernel.clone(),
            id,
            kind: stream.kind,
            fd: 0,
        };
        match input.write(b"\n") {
            Ok(1) => {
                stream.gate = None;
                Ok(())
            }
            // A full input queue retries on the next poll; the runner has not
            // started, so nothing is lost by waiting.
            Ok(_) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(()),
            Err(e) => Err(e),
        }
    }
    pub fn open_local(&mut self, caller: u32, args: &[u8]) -> io::Result<Vec<u8>> {
        match Request::decode(6, args)? {
            Request::Open {
                user,
                kind: Kind::Pty,
                argv,
                size,
                admission: None,
            } if user.uid == 19999 => {
                let admission = self.registry.local_admission(19999, caller)?;
                let id = self.open(OpenSession {
                    user,
                    kind: Kind::Pty,
                    argv,
                    size,
                    port: None,
                    caller: Some(caller),
                    admission,
                })?;
                Ok(conn::structure_bytes(&[conn::field(1, id.to_be_bytes())]))
            }
            _ => Err(invalid()),
        }
    }
    pub fn admission_of_cgroup(&self, path: &str) -> Option<Admission> {
        let name = path.strip_prefix("/smithers/sessions/")?;
        let id = sessions::cgroup_id(name).ok()?;
        self.registry.local_admission(19999, id).ok()
    }
    fn retain(&mut self) {
        let ids: std::collections::BTreeSet<_> = self.registry.entries().map(|e| e.id).collect();
        self.streams.retain(|id, _| ids.contains(id));
    }
    pub fn disconnected(&mut self, now: Instant) {
        self.transcript_import = false;
        let registry = &self.registry;
        let _ = self.kernel.with(|kernel| {
            kernel.transcript_pause(&mut |id| registry.transcript_owner(id).is_some());
            Ok(())
        });
        self.registry.disconnected(now);
    }
    pub fn frame(&mut self, frame: &Frame) -> io::Result<()> {
        let entry = self
            .registry
            .entries()
            .find(|e| e.id == frame.stream)
            .ok_or_else(invalid)?;
        self.registry.authorize(&entry.user)?;
        if entry.closed {
            return Err(invalid());
        }
        if let Some(stream) = self.streams.get_mut(&frame.stream).filter(|s| s.local) {
            // Host observers return output credit only. Resizing, signaling,
            // closing or typing would grant input authority to a watcher.
            if frame.payload.first() != Some(&6) {
                return Err(invalid());
            }
            return stream.observer.as_mut().ok_or_else(invalid)?.accept(frame);
        }
        self.owner_frame(frame)
    }
    pub fn frame_local(&mut self, frame: &Frame) -> io::Result<()> {
        if !self.streams.get(&frame.stream).is_some_and(|s| s.local) {
            return Err(invalid());
        }
        self.owner_frame(frame)
    }
    fn owner_frame(&mut self, frame: &Frame) -> io::Result<()> {
        frame.encode().map_err(|_| invalid())?;
        if frame.kind != 5 {
            return Err(invalid());
        }
        let entry = self
            .registry
            .entries()
            .find(|e| e.id == frame.stream)
            .ok_or_else(invalid)?;
        self.registry.authorize(&entry.user)?;
        if entry.closed {
            return Err(invalid());
        }
        if frame.payload == [7] {
            self.registry.close(frame.stream)?;
            self.streams
                .get_mut(&frame.stream)
                .ok_or_else(invalid)?
                .pipe
                .closed_by_owner();
            return Ok(());
        }
        self.streams
            .get_mut(&frame.stream)
            .ok_or_else(invalid)?
            .pipe
            .accept(frame)
    }
    fn observe(&mut self, now: Instant) -> io::Result<()> {
        self.registry.expire(now)?;
        let entries: Vec<_> = self.registry.entries().cloned().collect();
        for entry in entries {
            if self.registry.admission_fenced(entry.id) {
                continue; // retained for cleanup, never exposed as a stream
            }
            let stream = self.streams.get_mut(&entry.id).ok_or_else(invalid)?;
            if entry.closed {
                stream.pipe.closed_by_owner();
                stream.replay.clear();
                if let Some(mut observer) = stream.observer.take() {
                    observer.closed_by_owner();
                    // Output already copied for the watcher stays ahead of the
                    // close; it was read from the terminal and credited.
                    stream.observed.push_back(Frame {
                        kind: 5,
                        stream: entry.id,
                        payload: vec![7],
                    });
                }
                if stream.local && stream.reap_after.is_none() {
                    stream.reap_after = Some(now);
                }
            }
            if !entry.exited {
                if let Some(exit) = self.kernel.with(|k| k.exited(entry.id))? {
                    if !entry.closed {
                        stream.pipe.exited(exit)?;
                        if let Some(observer) = &mut stream.observer {
                            observer.exited(exit)?;
                        }
                    }
                    self.registry.exited(entry.id)?;
                }
            }
        }
        // A paused local command whose host never attached runs unobserved.
        let paused: Vec<u32> = self
            .streams
            .iter()
            .filter(|(_, s)| {
                s.gate
                    .is_some_and(|t| now.saturating_duration_since(t) >= GATE_DEADLINE)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in paused {
            if let Some(stream) = self.streams.get_mut(&id) {
                stream.unobserved = stream.observer.is_none();
            }
            self.release_gate(id)?;
        }
        self.reap(now);
        Ok(())
    }
    /// A closed local command is one tool call. Kill and forget its cgroup,
    /// including detached descendants, once its watcher has the close (or the
    /// watcher missed the grace), so finished commands never exhaust the
    /// machine's session table or write into a later command.
    fn reap(&mut self, now: Instant) {
        let due: Vec<u32> = self
            .streams
            .iter()
            .filter(|(_, s)| {
                s.local
                    && s.reap_after.is_some_and(|t| {
                        now >= t
                            && (s.observed.is_empty()
                                || now.saturating_duration_since(t) >= REAP_GRACE)
                    })
            })
            .map(|(id, _)| *id)
            .collect();
        if due.is_empty() {
            return;
        }
        for id in due {
            if self.registry.kill_session(id, now).is_err() {
                // Failed cleanup stays fenced and attributable; retry later.
                if let Some(stream) = self.streams.get_mut(&id) {
                    stream.reap_after = Some(now + Duration::from_secs(1));
                }
            }
        }
        self.retain();
    }
    /// At most one output frame per poll. Backpressure stays inside Pipe; no
    /// unbounded queue is interposed between the kernel and socketpair.
    pub fn poll_one(&mut self, local: Option<u32>, now: Instant) -> io::Result<Option<Frame>> {
        self.observe(now)?;
        let mut entries: Vec<_> = self.registry.entries().cloned().collect();
        entries.sort_by_key(|e| (e.id <= self.cursor, e.id));
        for entry in entries {
            let stream = self.streams.get_mut(&entry.id).ok_or_else(invalid)?;
            if let Some(id) = local {
                if !stream.local || id != entry.id {
                    continue;
                }
            } else if stream.local {
                if let Some(frame) = stream.observed.pop_front() {
                    self.cursor = entry.id;
                    return Ok(Some(frame));
                }
                continue;
            }
            if entry.closed {
                continue;
            }
            self.cursor = entry.id;
            if let Some(frame) = stream.replay.pop_front() {
                return Ok(Some(frame));
            }
            if let Some(frame) = stream.pipe.flush()? {
                return Ok(Some(frame));
            }
            let fds = if matches!(stream.kind, Kind::Exec | Kind::Sftp) {
                vec![stream.next_fd, 3 - stream.next_fd]
            } else {
                vec![1]
            };
            for fd in fds {
                let source = Descriptor {
                    kernel: self.kernel.clone(),
                    id: entry.id,
                    kind: stream.kind,
                    fd,
                };
                let available = stream.observer.as_ref().map_or(usize::MAX, Pipe::available);
                if available == 0 {
                    continue;
                }
                if let Some(frame) = stream.pipe.poll(fd, &mut source.take(available as u64))? {
                    if let Some(observer) = &mut stream.observer {
                        if let Some(copy) = observer.relay(&frame)? {
                            stream.observed.push_back(copy);
                        }
                    }
                    stream.next_fd = 3 - fd;
                    return Ok(Some(frame));
                }
            }
            if let Some(frame) = stream.pipe.poll_exit() {
                if let Some(observer) = &mut stream.observer {
                    if let Some(copy) = observer.relay(&frame)? {
                        stream.observed.push_back(copy);
                    }
                }
                return Ok(Some(frame));
            }
        }
        Ok(None)
    }
    pub fn before_restart(&mut self, now: Instant) -> io::Result<()> {
        let result = self.registry.before_restart(now);
        self.retain();
        result?;
        self.kernel
            .with(|k| k.recover(now + sessions::KILL_DEADLINE))
    }
}
impl<K: Kernel> control::Controls for Supervisor<K> {
    fn tick(&mut self) -> io::Result<()> {
        let now = Instant::now();
        self.observe(now)?;
        // A session that ended, or whose member left the roster, loses its
        // transcript readers here, before the next request is read.
        let registry = &self.registry;
        self.kernel.with(|kernel| {
            if self.transcript_import {
                kernel.transcript_tick(&mut |id| registry.transcript_owner(id).is_some(), now);
            } else {
                kernel.transcript_pause(&mut |id| registry.transcript_owner(id).is_some());
            }
            Ok(())
        })
    }
    fn descriptor(&mut self) -> Option<std::os::fd::OwnedFd> {
        self.descriptor.take()
    }
    fn stream(&mut self, op: u8, body: &[u8]) -> io::Result<Vec<u8>> {
        match op {
            17 => {
                let frame = Frame::decode(body).map_err(|_| invalid())?;
                self.frame(&frame)?;
                Ok(vec![])
            }
            29 => {
                let frame = Frame::decode(body).map_err(|_| invalid())?;
                self.frame_local(&frame)?;
                Ok(vec![])
            }
            18 if body.len() == 4 => {
                let id = u32::from_be_bytes(body.try_into().unwrap());
                match self.poll_one((id != 0).then_some(id), Instant::now())? {
                    Some(frame) => frame.encode().map_err(|_| invalid()),
                    None => Ok(vec![]),
                }
            }
            19 if body.len() > 4 => self.open_local(
                u32::from_be_bytes(body[..4].try_into().unwrap()),
                &body[4..],
            ),
            20 => {
                let path = std::str::from_utf8(body).map_err(|_| invalid())?;
                if path.len() > 4096 {
                    return Err(invalid());
                }
                serde_json::to_vec(&self.admission_of_cgroup(path).ok_or_else(invalid)?)
                    .map_err(io::Error::other)
            }
            21 if body.is_empty() => Ok(self
                .entries()
                .filter(|e| !e.closed && !e.exited)
                .flat_map(|e| e.id.to_be_bytes())
                .collect()),
            22 if body.is_empty() => {
                self.disconnected(Instant::now());
                Ok(vec![])
            }
            23 if body.is_empty() => {
                self.kernel.with(Kernel::available)?;
                Ok(vec![])
            }
            25 if body.is_empty() => {
                serde_json::to_vec(&self.entries().collect::<Vec<_>>()).map_err(io::Error::other)
            }
            24 if body.is_empty() => Ok(self.allocate_stream()?.to_be_bytes().to_vec()),
            26 if body.is_empty() => {
                if !self.transcript_import {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                let sessions = self.transcript_sessions();
                self.kernel
                    .with(|kernel| kernel.transcript_sources(&sessions, Instant::now()))
            }
            32 if body.is_empty() => {
                let live: std::collections::BTreeSet<_> = self
                    .entries()
                    .filter(|e| !e.closed && !e.exited && e.kind == Kind::Pty)
                    .map(|e| e.id)
                    .collect();
                let mut commands = self.kernel.with(Kernel::terminal_commands)?;
                commands.retain(|id, _| live.contains(id));
                serde_json::to_vec(&commands).map_err(io::Error::other)
            }
            30 if body.is_empty() => {
                if !self.transcript_import {
                    return Ok(vec![]);
                }
                let sessions = self.transcript_sessions();
                self.kernel
                    .with(|kernel| kernel.transcript_presence(&sessions))
            }
            27 if body.len() == 16 => {
                if !self.transcript_import {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                let sessions = self.transcript_sessions();
                let (startup, socket) = self
                    .kernel
                    .with(|kernel| kernel.transcript_reader(&sessions, body.try_into().unwrap()))?;
                self.descriptor = Some(socket);
                Ok(startup)
            }
            28 if body.len() == 17 && body[16] <= 1 => {
                self.kernel.with(|kernel| {
                    kernel.transcript_release(body[..16].try_into().unwrap(), body[16] == 1)
                })?;
                Ok(vec![])
            }
            _ => Err(invalid()),
        }
    }
    fn session(&mut self, request: Request) -> io::Result<Vec<u8>> {
        let now = Instant::now();
        let fields = match request {
            Request::Open {
                user,
                kind,
                argv,
                size,
                admission,
            } => vec![conn::field(
                1,
                self.open(OpenSession {
                    user,
                    kind,
                    argv,
                    size,
                    port: None,
                    caller: None,
                    admission: admission.ok_or_else(invalid)?,
                })?
                .to_be_bytes(),
            )],
            Request::Tcp(port, admission) => vec![conn::field(
                1,
                self.open(OpenSession {
                    user: User {
                        login: "agent".into(),
                        uid: 19999,
                    },
                    kind: Kind::Tcp,
                    argv: vec![],
                    size: None,
                    port: Some(port),
                    caller: None,
                    admission: admission.ok_or_else(invalid)?,
                })?
                .to_be_bytes(),
            )],
            Request::Close(id) => {
                self.registry.close(id)?;
                let stream = self.streams.get_mut(&id).ok_or_else(invalid)?;
                stream.pipe.closed_by_owner();
                stream.replay.clear();
                vec![]
            }
            Request::KillUser(user) => {
                let result = self.registry.kill_user(&user, now);
                self.retain();
                vec![conn::field(1, result?.to_be_bytes())]
            }
            Request::KillRun(run) => {
                let result = self.registry.kill_run(&run, now);
                self.retain();
                vec![conn::field(1, result?.to_be_bytes())]
            }
            Request::KillSession(id) => {
                let result = self.registry.kill_session(id, now);
                self.retain();
                vec![conn::field(1, result?.to_be_bytes())]
            }
            Request::Register { session, run } => {
                self.registry.register_run(session, &run)?;
                vec![]
            }
            Request::Roster(users, enabled) => {
                if !enabled {
                    self.transcript_import = false;
                    let registry = &self.registry;
                    self.kernel.with(|kernel| {
                        kernel.transcript_pause(&mut |id| registry.transcript_owner(id).is_some());
                        Ok(())
                    })?;
                }
                let result = self.registry.set_roster(&users, now);
                self.retain();
                if let Err(error) = result {
                    self.transcript_import = false;
                    let registry = &self.registry;
                    self.kernel.with(|kernel| {
                        kernel.transcript_pause(&mut |id| registry.transcript_owner(id).is_some());
                        Ok(())
                    })?;
                    return Err(error);
                }
                self.transcript_import = enabled;
                vec![]
            }
            Request::Attach { session, received } => {
                // Invalid replay offsets must not clear the grace timer.
                let entry = self
                    .registry
                    .entries()
                    .find(|e| e.id == session)
                    .ok_or_else(invalid)?;
                self.registry.authorize(&entry.user)?;
                self.registry.check_attach(session, now)?;
                let stream = self.streams.get_mut(&session).ok_or_else(invalid)?;
                if stream.local && stream.observer.is_none() {
                    if received != 0 || entry.exited || stream.unobserved {
                        return Err(invalid());
                    }
                    stream.observer = Some(Pipe::new(
                        session,
                        Descriptor {
                            kernel: self.kernel.clone(),
                            id: session,
                            kind: stream.kind,
                            fd: 0,
                        },
                        false,
                    )?);
                }
                if let Some(observer) = &mut stream.observer {
                    let (_, frames) = observer.attach(received)?;
                    self.registry.attach(session, now)?;
                    stream.observed = frames.into();
                    // The watcher now receives the command from its first byte.
                    self.release_gate(session)?;
                    return Ok(conn::structure_bytes(&[conn::field(1, 0u64.to_be_bytes())]));
                }
                let (received, frames) = stream.pipe.attach(received)?;
                self.registry.attach(session, now)?;
                stream.replay = frames.into();
                vec![conn::field(1, received.to_be_bytes())]
            }
        };
        Ok(conn::structure_bytes(&fields))
    }
    fn frozen(&mut self) -> io::Result<bool> {
        self.kernel.with(Kernel::frozen)
    }
    fn freeze(&mut self, t: Duration) -> io::Result<Option<u32>> {
        self.kernel.with(|k| k.freeze(t))
    }
    fn thaw(&mut self) -> io::Result<()> {
        self.kernel.with(Kernel::thaw)
    }
    fn kill(&mut self) -> io::Result<u16> {
        let n = self.registry.entries().count() as u16;
        self.before_restart(Instant::now())?;
        Ok(n)
    }
}
