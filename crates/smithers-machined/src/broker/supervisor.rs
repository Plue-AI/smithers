//! The session dispatcher owns one registry and the existing bounded credit pipe.
//! Kernel implementations never receive a path or PID chosen by the daemon.
use super::{
    control,
    request::Request,
    sessions::{self, Kind, Sessions, User},
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
    fn available(&mut self) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn recover(&mut self, deadline: Instant) -> io::Result<()>;
    fn ready(&mut self, user: &User) -> io::Result<()>;
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
    fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()>;
    fn freeze(&mut self, timeout: Duration) -> io::Result<Option<u32>>;
    fn thaw(&mut self) -> io::Result<()>;
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidInput.into()
}
struct Shared<K>(Arc<Mutex<K>>);
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
    next_fd: u8,
    replay: VecDeque<Frame>,
}
pub struct Supervisor<K> {
    kernel: Shared<K>,
    registry: Sessions<Shared<K>>,
    streams: BTreeMap<u32, Stream<K>>,
    next: u32,
    cursor: u32,
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
        }
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
    fn open(
        &mut self,
        user: User,
        kind: Kind,
        argv: Vec<String>,
        size: Option<(u16, u16)>,
        port: Option<u16>,
        caller: Option<u32>,
    ) -> io::Result<u32> {
        self.registry.authorize(&user)?;
        if self.streams.len() >= sessions::MAX_SESSIONS || self.next > 0x7fff_ffff {
            return Err(invalid());
        }
        if let Some(caller) = caller {
            self.registry.local_run(19999, caller)?;
        }
        self.kernel.with(|k| k.ready(&user))?;
        let id = self.allocate_stream()?; // failed spawns never reuse IDs
        self.kernel
            .with(|k| k.spawn(id, &user, kind, &argv, size, port))?;
        let inserted = if let Some(caller) = caller {
            self.registry.insert_local(id, 19999, caller)
        } else {
            self.registry.insert(id, user, kind)
        };
        if let Err(error) = inserted {
            self.kernel
                .with(|k| k.kill(id, Instant::now() + sessions::KILL_DEADLINE))?;
            return Err(error);
        }
        let input = Descriptor {
            kernel: self.kernel.clone(),
            id,
            kind,
            fd: 0,
        };
        self.streams.insert(
            id,
            Stream {
                pipe: Pipe::new(id, input, matches!(kind, Kind::Exec | Kind::Sftp))?,
                kind,
                local: caller.is_some(),
                next_fd: 1,
                replay: VecDeque::new(),
            },
        );
        Ok(id)
    }
    pub fn open_local(&mut self, caller: u32, args: &[u8]) -> io::Result<Vec<u8>> {
        match Request::decode(6, args)? {
            Request::Open {
                user,
                kind: Kind::Pty,
                argv,
                size,
            } if user.uid == 19999 => {
                let id = self.open(user, Kind::Pty, argv, size, None, Some(caller))?;
                Ok(conn::structure_bytes(&[conn::field(1, id.to_be_bytes())]))
            }
            _ => Err(invalid()),
        }
    }
    pub fn run_of_cgroup(&self, path: &str) -> Option<String> {
        let name = path.strip_prefix("/smithers/sessions/")?;
        let id = sessions::cgroup_id(name).ok()?;
        self.registry.local_run(19999, id).ok().map(str::to_owned)
    }
    fn retain(&mut self) {
        let ids: std::collections::BTreeSet<_> = self.registry.entries().map(|e| e.id).collect();
        self.streams.retain(|id, _| ids.contains(id));
    }
    pub fn disconnected(&mut self, now: Instant) {
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
            let stream = self.streams.get_mut(&entry.id).ok_or_else(invalid)?;
            if entry.closed {
                stream.pipe.closed_by_owner();
                stream.replay.clear();
            }
            if !entry.exited {
                if let Some(exit) = self.kernel.with(|k| k.exited(entry.id))? {
                    if !entry.closed {
                        stream.pipe.exited(exit)?;
                    }
                    self.registry.exited(entry.id)?;
                }
            }
        }
        Ok(())
    }
    /// At most one output frame per poll. Backpressure stays inside Pipe; no
    /// unbounded queue is interposed between the kernel and socketpair.
    pub fn poll_one(&mut self, local: Option<u32>, now: Instant) -> io::Result<Option<Frame>> {
        self.observe(now)?;
        let mut entries: Vec<_> = self.registry.entries().cloned().collect();
        entries.sort_by_key(|e| (e.id <= self.cursor, e.id));
        for entry in entries {
            let stream = self.streams.get_mut(&entry.id).ok_or_else(invalid)?;
            if entry.closed
                || match local {
                    Some(id) => !stream.local || id != entry.id,
                    None => stream.local,
                }
            {
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
                let mut source = Descriptor {
                    kernel: self.kernel.clone(),
                    id: entry.id,
                    kind: stream.kind,
                    fd,
                };
                if let Some(frame) = stream.pipe.poll(fd, &mut source)? {
                    stream.next_fd = 3 - fd;
                    return Ok(Some(frame));
                }
            }
            if let Some(frame) = stream.pipe.poll_exit() {
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
        self.observe(Instant::now())
    }
    fn stream(&mut self, op: u8, body: &[u8]) -> io::Result<Vec<u8>> {
        match op {
            17 => {
                let frame = Frame::decode(body).map_err(|_| invalid())?;
                self.frame(&frame)?;
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
                self.run_of_cgroup(path)
                    .map(String::into_bytes)
                    .ok_or_else(invalid)
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
            } => vec![conn::field(
                1,
                self.open(user, kind, argv, size, None, None)?.to_be_bytes(),
            )],
            Request::Tcp(port) => vec![conn::field(
                1,
                self.open(
                    User {
                        login: "agent".into(),
                        uid: 19999,
                    },
                    Kind::Tcp,
                    vec![],
                    None,
                    Some(port),
                    None,
                )?
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
            Request::Register { session, run } => {
                self.registry.register_run(session, &run)?;
                vec![]
            }
            Request::Roster(users) => {
                let result = self.registry.set_roster(&users, now);
                self.retain();
                result?;
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
                if stream.local {
                    return Err(invalid());
                }
                let (received, frames) = stream.pipe.attach(received)?;
                self.registry.attach(session, now)?;
                stream.replay = frames.into();
                vec![conn::field(1, received.to_be_bytes())]
            }
        };
        Ok(conn::structure_bytes(&fields))
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
