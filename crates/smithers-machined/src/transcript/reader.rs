//! Owner-only socketpair reader. The child never opens daemon state. Its parent
//! acknowledges events only after outbox fsync and checkpoints only after save.
//! Launch/identity/discovery remain the authenticated broker's responsibility.
use super::{wire::Source, Tail};
use rustix::fs::{Mode, OFlags, ResolveFlags};
use std::{
    fs::File,
    io::{self, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

const LIMIT: usize = 8 * 1024 * 1024;
const POLL: u8 = 1;
const EVENT: u8 = 2;
const CHECKPOINT: u8 = 3;
pub(super) const DONE: u8 = 4;
const ACK: u8 = 5;
pub(super) const ERROR: u8 = 6;
const BIND: u8 = 7;

#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Startup {
    pub uid: u32,
    pub gid: u32,
    pub groups: Vec<u32>,
    pub root: String,
    pub path: String,
    pub source: Source,
    pub checkpoint: Option<String>,
}

fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
pub(super) fn send(writer: &mut impl Write, tag: u8, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > LIMIT {
        return Err(invalid());
    }
    writer.write_all(&[tag])?;
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}
pub(super) fn receive(reader: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut header = [0; 5];
    reader.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    if size > LIMIT {
        return Err(invalid());
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes)?;
    Ok((header[0], bytes))
}
fn ack(reader: &mut impl Read) -> io::Result<()> {
    let (tag, bytes) = receive(reader)?;
    if tag != ACK || !bytes.is_empty() {
        return Err(invalid());
    }
    Ok(())
}

/// This process is exactly the registered owner: every uid and gid it holds,
/// and its supplementary groups, are the ones the broker named, and none is
/// root's. Checked before any home path is resolved; there is no fallback.
pub(super) fn require_owner(uid: u32, gid: u32, groups: &[u32], root: &str) -> io::Result<()> {
    let mut real = 0;
    let mut effective = 0;
    let mut saved = 0;
    // SAFETY: getresuid/getresgid write only these initialized stack values.
    if unsafe { libc::getresuid(&mut real, &mut effective, &mut saved) } != 0
        || [real, effective, saved] != [uid; 3]
        || unsafe { libc::getresgid(&mut real, &mut effective, &mut saved) } != 0
        || [real, effective, saved] != [gid; 3]
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut held: Vec<_> = rustix::process::getgroups()?
        .iter()
        .map(|g| g.as_raw())
        .collect();
    held.sort_unstable();
    let mut expected = groups.to_vec();
    expected.sort_unstable();
    if uid == 0
        || gid == 0
        || expected.len() > 64
        || expected.contains(&0)
        || expected.windows(2).any(|w| w[0] == w[1])
        || held != expected
        || rustix::process::getuid().as_raw() != uid
        || rustix::process::geteuid().as_raw() != uid
        || rustix::process::getgid().as_raw() != gid
        || rustix::process::getegid().as_raw() != gid
        || !root.starts_with('/')
        || root.len() > 4096
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

/// The owner's agent root, held open: every component beneath / is resolved
/// without following a link. The caller checks whose directory it is.
pub(super) fn open_root(root: &str) -> io::Result<File> {
    Ok(rustix::fs::openat2(
        File::open("/")?,
        root.trim_start_matches('/'),
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )?
    .into())
}

/// The broker's first and only message to a reader it starts: whose transcript
/// this child reads and under which source. It is written before the child's
/// socket is handed to the daemon, so what the daemon then asks for can only
/// be this. The broker never reads from the child.
pub fn bind(writer: &mut impl Write, startup: &Startup) -> io::Result<()> {
    if startup.checkpoint.is_some() {
        return Err(invalid());
    }
    send(
        writer,
        BIND,
        &serde_json::to_vec(startup).map_err(|_| invalid())?,
    )
}

/// A member cannot attach to or dump this process although it runs as them:
/// what it reads is theirs, but what it writes is trusted to be this code's.
pub(super) fn seal() -> io::Result<()> {
    Ok(rustix::process::set_dumpable_behavior(
        rustix::process::DumpableBehavior::NotDumpable,
    )?)
}

/// No privileged fallback. Identity is checked before opening even the root
/// directory. All root components are resolved beneath / without symlinks.
/// The broker's binding comes first; the daemon's startup must name the same
/// owner, root, path and source, and adds only the checkpoint to resume from.
pub fn serve(mut input: impl Read, mut output: impl Write) -> io::Result<()> {
    let (tag, bytes) = receive(&mut input)?;
    if tag != BIND {
        return Err(invalid());
    }
    let bound: Startup = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if bound.checkpoint.is_some() {
        return Err(invalid());
    }
    require_owner(bound.uid, bound.gid, &bound.groups, &bound.root)?;
    let (tag, bytes) = receive(&mut input)?;
    if tag != 0 {
        return Err(invalid());
    }
    let startup: Startup = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if (Startup {
        checkpoint: None,
        ..startup.clone()
    }) != bound
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    // Validate the immutable wire binding before any home reads.
    startup
        .source
        .event(&super::Record {
            generation: 1,
            start: 0,
            end: 2,
            text: "x".into(),
        })
        .map_err(|_| invalid())?;
    if let Some(bytes) = startup.checkpoint.as_ref() {
        super::linux::validate_reader_checkpoint(bytes.as_bytes(), &startup)?;
    }
    let root = open_root(&startup.root)?;
    let mut tail = match startup.checkpoint {
        Some(bytes) => Tail::resume(root, &startup.path, startup.uid, bytes.as_bytes())?,
        None => Tail::new(root, &startup.path, startup.uid)?,
    };
    send(&mut output, DONE, &[])?;
    loop {
        let (tag, bytes) = receive(&mut input)?;
        if tag != POLL || !bytes.is_empty() {
            return Err(invalid());
        }
        // Both callbacks share the same socket but execute sequentially.
        let input = std::cell::RefCell::new(&mut input);
        let output = std::cell::RefCell::new(&mut output);
        let result = tail.poll_durable(
            Instant::now(),
            &startup.source,
            |event| {
                send(*output.borrow_mut(), EVENT, event)?;
                ack(*input.borrow_mut())
            },
            |checkpoint| {
                send(*output.borrow_mut(), CHECKPOINT, checkpoint)?;
                ack(*input.borrow_mut())
            },
        );
        match result {
            Ok(count) => send(*output.borrow_mut(), DONE, &(count as u32).to_be_bytes())?,
            Err(_) => {
                send(*output.borrow_mut(), ERROR, &[])?;
                return Err(invalid());
            }
        }
    }
}

/// The installed executable is re-executed after the broker's permanent group,
/// GID and UID drop. stdin/stdout are two duplicates of its private socketpair.
pub fn run() -> io::Result<()> {
    seal()?;
    serve(io::stdin().lock(), io::stdout().lock())
}

// One wall-clock deadline for the whole IPC exchange. A per-syscall socket
// timeout alone lets a hostile peer retain the broker indefinitely by trickling
// one byte before each timeout, delaying registry revocation and reconciliation.
struct DeadlineSocket<'a> {
    socket: &'a mut UnixStream,
    deadline: Instant,
}
impl DeadlineSocket<'_> {
    fn remaining(&self) -> io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::ErrorKind::TimedOut.into())
    }
}
impl Read for DeadlineSocket<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.socket.set_read_timeout(Some(self.remaining()?))?;
        self.socket.read(bytes)
    }
}
impl Write for DeadlineSocket<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.socket.set_write_timeout(Some(self.remaining()?))?;
        self.socket.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.remaining()?;
        self.socket.flush()
    }
}

pub struct Reader {
    socket: UnixStream,
    startup: Startup,
    failed: bool,
}
impl Reader {
    pub fn connect(mut socket: UnixStream, startup: &Startup) -> io::Result<Self> {
        let bytes = serde_json::to_vec(startup).map_err(|_| invalid())?;
        let mut connection = DeadlineSocket {
            socket: &mut socket,
            deadline: Instant::now() + Duration::from_secs(2),
        };
        send(&mut connection, 0, &bytes)?;
        let (tag, bytes) = receive(&mut connection)?;
        if tag != DONE || !bytes.is_empty() {
            return Err(invalid());
        }
        Ok(Self {
            socket,
            startup: startup.clone(),
            failed: false,
        })
    }
    /// Whether the checkpoint this reader last saved, or a stored one, says the
    /// source is stopped for good. Reading it again can only fail.
    pub fn stopped(checkpoint: &[u8]) -> bool {
        super::linux::checkpoint_stopped(checkpoint)
    }
    pub fn source_stopped(&self) -> bool {
        self.startup
            .checkpoint
            .as_ref()
            .is_some_and(|saved| Self::stopped(saved.as_bytes()))
    }
    /// `live` checks the current broker session/process lifetime and revocation
    /// before poll and each persistence action. The transport must have a bounded
    /// read/write deadline. Any failure poisons this reader; drop its socket and
    /// reap only its own child, then recover from the last durable checkpoint.
    pub fn poll(
        &mut self,
        live: impl FnMut() -> io::Result<()>,
        persist: impl FnMut(&[u8]) -> io::Result<()>,
        save: impl FnMut(&[u8]) -> io::Result<()>,
    ) -> io::Result<usize> {
        let result = self.poll_inner(live, persist, save);
        if result.is_err() {
            let _ = self.socket.shutdown(Shutdown::Both);
        }
        result
    }
    fn poll_inner(
        &mut self,
        mut live: impl FnMut() -> io::Result<()>,
        mut persist: impl FnMut(&[u8]) -> io::Result<()>,
        mut save: impl FnMut(&[u8]) -> io::Result<()>,
    ) -> io::Result<usize> {
        if self.failed {
            return Err(invalid());
        }
        self.failed = true;
        let mut connection = DeadlineSocket {
            socket: &mut self.socket,
            deadline: Instant::now() + Duration::from_secs(2),
        };
        live()?;
        send(&mut connection, POLL, &[])?;
        let mut events = 0;
        let mut record_bytes = 0u64;
        let mut checkpoint = false;
        loop {
            let (tag, bytes) = receive(&mut connection)?;
            live()?;
            match tag {
                EVENT if !checkpoint => {
                    let (source, record) = Source::decode(&bytes).map_err(|_| invalid())?;
                    if source != self.startup.source {
                        return Err(invalid());
                    }
                    record_bytes += record.end - record.start;
                    if events >= super::READ_BYTES / 2
                        || record_bytes > (super::MAX_RECORD_BYTES + super::READ_BYTES) as u64
                    {
                        return Err(invalid());
                    }
                    // The deadline bounds the peer, not this side's disk.
                    let began = Instant::now();
                    persist(&bytes)?;
                    connection.deadline += began.elapsed();
                    events += 1;
                    send(&mut connection, ACK, &[])?;
                }
                CHECKPOINT if !checkpoint => {
                    super::linux::validate_reader_checkpoint(&bytes, &self.startup)?;
                    let began = Instant::now();
                    save(&bytes)?;
                    connection.deadline += began.elapsed();
                    self.startup.checkpoint =
                        Some(String::from_utf8(bytes).map_err(|_| invalid())?);
                    checkpoint = true;
                    send(&mut connection, ACK, &[])?;
                }
                DONE if checkpoint && bytes.len() == 4 => {
                    if u32::from_be_bytes(bytes.try_into().unwrap()) as usize != events {
                        return Err(invalid());
                    }
                    self.failed = false;
                    return Ok(events);
                }
                _ => return Err(invalid()),
            }
        }
    }
}
