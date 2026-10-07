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
const DONE: u8 = 4;
const ACK: u8 = 5;
const ERROR: u8 = 6;

#[derive(serde::Serialize, serde::Deserialize)]
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
fn send(writer: &mut impl Write, tag: u8, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > LIMIT {
        return Err(invalid());
    }
    writer.write_all(&[tag])?;
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}
fn receive(reader: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
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

/// No privileged fallback. Identity is checked before opening even the root
/// directory. All root components are resolved beneath / without symlinks.
pub fn serve(mut input: impl Read, mut output: impl Write) -> io::Result<()> {
    let (tag, bytes) = receive(&mut input)?;
    if tag != 0 {
        return Err(invalid());
    }
    let startup: Startup = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let mut real = 0;
    let mut effective = 0;
    let mut saved = 0;
    // SAFETY: getresuid/getresgid write only these initialized stack values.
    if unsafe { libc::getresuid(&mut real, &mut effective, &mut saved) } != 0
        || [real, effective, saved] != [startup.uid; 3]
        || unsafe { libc::getresgid(&mut real, &mut effective, &mut saved) } != 0
        || [real, effective, saved] != [startup.gid; 3]
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut groups: Vec<_> = rustix::process::getgroups()?
        .iter()
        .map(|g| g.as_raw())
        .collect();
    groups.sort_unstable();
    let mut expected = startup.groups.clone();
    expected.sort_unstable();
    if startup.uid == 0
        || startup.gid == 0
        || expected.len() > 64
        || expected.contains(&0)
        || expected.windows(2).any(|w| w[0] == w[1])
        || groups != expected
        || rustix::process::getuid().as_raw() != startup.uid
        || rustix::process::geteuid().as_raw() != startup.uid
        || rustix::process::getgid().as_raw() != startup.gid
        || rustix::process::getegid().as_raw() != startup.gid
        || !startup.root.starts_with('/')
        || startup.root.len() > 4096
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
    let root: File = rustix::fs::openat2(
        File::open("/")?,
        startup.root.trim_start_matches('/'),
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )?
    .into();
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
    source: Source,
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
            source: startup.source.clone(),
            failed: false,
        })
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
                    if source != self.source {
                        return Err(invalid());
                    }
                    record_bytes += record.end - record.start;
                    if events >= super::READ_BYTES / 2
                        || record_bytes > (super::MAX_RECORD_BYTES + super::READ_BYTES) as u64
                    {
                        return Err(invalid());
                    }
                    persist(&bytes)?;
                    events += 1;
                    send(&mut connection, ACK, &[])?;
                }
                CHECKPOINT if !checkpoint => {
                    if bytes.is_empty() {
                        return Err(invalid());
                    }
                    save(&bytes)?;
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
