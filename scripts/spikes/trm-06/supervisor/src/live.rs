//! Bounded live session pipe: processes stall at exhausted output credit.
//! Absolute byte offsets are authenticated attach-control inputs, not frame data.
use crate::protocol::{CREDIT, Frame};
use crate::registry::Kind;
use crate::runtime::{Process, signal_number};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
fn refused() -> io::Error {
    io::Error::other("invalid live session sequence")
}
struct Record {
    start: u64,
    end: u64,
    frame: Frame,
}
struct State {
    output: VecDeque<Record>,
    sent: u64,
    ack: u64,
    input: VecDeque<u8>,
    input_received: u64,
    input_written: u64,
    input_eof: bool,
    pty_eof_sent: bool,
    input_credit: u32,
    returned: u32,
    detached: Option<Instant>,
    closed: bool,
    events: usize,
    ended: bool,
    error: Option<String>,
}
pub struct Live {
    state: Arc<Mutex<State>>,
    first_alive: Arc<AtomicBool>,
    pid: u32,
    kind: Kind,
    input: Arc<Mutex<Option<std::fs::File>>>,
}
impl Live {
    pub fn start(mut process: Process, kind: Kind) -> io::Result<Self> {
        nonblocking(&process.output)?;
        if let Some(error) = &process.error {
            nonblocking(error)?;
        }
        if let Some(input) = process.input.lock().map_err(|_| refused())?.as_ref() {
            nonblocking(input)?;
        }
        let state = Arc::new(Mutex::new(State {
            output: VecDeque::new(),
            sent: 0,
            ack: 0,
            input: VecDeque::new(),
            input_received: 0,
            input_written: 0,
            input_eof: false,
            pty_eof_sent: false,
            input_credit: CREDIT,
            returned: 0,
            detached: None,
            closed: false,
            events: 0,
            ended: false,
            error: None,
        }));
        let alive = Arc::new(AtomicBool::new(true));
        let live = Self {
            state: state.clone(),
            first_alive: alive.clone(),
            pid: process.child.id(),
            kind,
            input: process.input.clone(),
        };
        std::thread::spawn(move || {
            // Inspect exit without reaping: keep the process-group identity
            // reserved until the session no longer accepts signals.
            let result = drive(&mut process, &state, kind);
            alive.store(false, Ordering::Release);
            if let Err(error) = result
                && let Ok(mut state) = state.lock()
            {
                state.error = Some(error.to_string());
                state.closed = true;
            }
            // A lingering first process is still owned by its cgroup. Wait in
            // this thread until it exits/revocation kills it; never kill on EOF.
            let _ = process.child.wait();
        });
        Ok(live)
    }
    pub fn receive(&self, frame: Frame) -> io::Result<()> {
        frame.validate()?;
        let mut state = self.state.lock().map_err(|_| refused())?;
        if state.error.is_some() {
            return Err(refused());
        }
        match frame {
            Frame::Data { stream: 0, bytes }
                if !state.input_eof
                    && !state.closed
                    && bytes.len() <= state.input_credit as usize =>
            {
                state.input_received = state
                    .input_received
                    .checked_add(bytes.len() as u64)
                    .ok_or_else(refused)?;
                state.input_credit -= bytes.len() as u32;
                state.input.extend(bytes);
            }
            Frame::Eof { stream: 0 } if !state.input_eof && !state.closed => state.input_eof = true,
            Frame::Window { bytes } if bytes as u64 <= state.sent - state.ack => {
                state.ack += bytes as u64;
                trim(&mut state);
            }
            Frame::Signal { name } if self.kind == Kind::Pty || self.kind == Kind::Exec => {
                if state.closed || state.ended || !self.first_alive.load(Ordering::Acquire) {
                    return Err(refused());
                }
                if unsafe { libc::kill(-(self.pid as i32), signal_number(&name)?) } != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Frame::Resize { cols, rows } if self.kind == Kind::Pty && !state.closed => {
                let input = self.input.lock().map_err(|_| refused())?;
                let fd = input.as_ref().ok_or_else(refused)?.as_raw_fd();
                let window = libc::winsize {
                    ws_col: cols,
                    ws_row: rows,
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &window) } != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Frame::Close {} => {
                drop(state);
                return self.close();
            }
            _ => return Err(refused()),
        }
        Ok(())
    }
    pub fn close(&self) -> io::Result<()> {
        let mut state = self.state.lock().map_err(|_| refused())?;
        if state.closed {
            return Ok(());
        }
        if self.kind == Kind::Pty
            && !state.ended
            && self.first_alive.load(Ordering::Acquire)
            && unsafe { libc::kill(-(self.pid as i32), libc::SIGHUP) } != 0
        {
            return Err(io::Error::last_os_error());
        }
        // Drain already accepted input then half-close; do not kill exec
        // children or remove ownership/replay on channel close.
        state.input_eof = true;
        state.closed = true;
        Ok(())
    }
    /// After a confirmed cgroup drain, release stalled pipe workers even when
    /// the disconnected peer exhausted its credit. Ownership lives in Kernel.
    pub fn terminated(&self) -> io::Result<()> {
        let mut state = self.state.lock().map_err(|_| refused())?;
        state.closed = true;
        state.input_eof = true;
        state.input.clear();
        *self.input.lock().map_err(|_| refused())? = None;
        Ok(())
    }
    pub fn detach(&self, now: Instant) -> io::Result<()> {
        self.state
            .lock()
            .map_err(|_| refused())?
            .detached
            .get_or_insert(now);
        Ok(())
    }
    pub fn attach(&self, received: u64, now: Instant) -> io::Result<u64> {
        let mut state = self.state.lock().map_err(|_| refused())?;
        if state.closed
            || state
                .detached
                .is_none_or(|at| now.saturating_duration_since(at) >= Duration::from_secs(30))
            || received < state.ack
            || received > state.sent
        {
            return Err(refused());
        }
        state.ack = received;
        trim(&mut state);
        state.detached = None;
        Ok(state.input_received)
    }
    /// Replay data from the exact byte offset, retaining stdout/stderr order.
    /// Returned frames are bounded by the same 256 KiB outstanding-data cap.
    pub fn replay(&self, received: u64) -> io::Result<Vec<Frame>> {
        let state = self.state.lock().map_err(|_| refused())?;
        if received < state.ack || received > state.sent {
            return Err(refused());
        }
        let mut frames = Vec::new();
        for record in &state.output {
            match &record.frame {
                Frame::Data { stream, bytes } if record.end > received => {
                    frames.push(Frame::Data {
                        stream: *stream,
                        bytes: bytes[(received.saturating_sub(record.start)) as usize..].to_vec(),
                    })
                }
                Frame::Data { .. } => {}
                Frame::Eof { stream } => frames.push(Frame::Eof { stream: *stream }),
                Frame::Exit { code } => frames.push(Frame::Exit { code: *code }),
                Frame::ExitSignal { name, core } => frames.push(Frame::ExitSignal {
                    name: name.clone(),
                    core: *core,
                }),
                _ => return Err(refused()),
            }
        }
        Ok(frames)
    }
    pub fn take_credit(&self) -> io::Result<Option<Frame>> {
        let mut state = self.state.lock().map_err(|_| refused())?;
        let bytes = state.returned;
        state.returned = 0;
        state.input_credit = state
            .input_credit
            .checked_add(bytes)
            .filter(|v| *v <= CREDIT)
            .ok_or_else(refused)?;
        Ok(if bytes == 0 {
            None
        } else {
            Some(Frame::Window { bytes })
        })
    }
    pub fn is_closed(&self) -> io::Result<bool> {
        Ok(self.state.lock().map_err(|_| refused())?.closed)
    }
    pub fn output_counts(&self) -> io::Result<(u64, u64)> {
        let state = self.state.lock().map_err(|_| refused())?;
        Ok((state.ack, state.sent))
    }
}
fn trim(state: &mut State) {
    state
        .output
        .retain(|r| r.end > state.ack || !matches!(r.frame, Frame::Data { .. }));
    if let Some(record) = state
        .output
        .iter_mut()
        .find(|r| matches!(r.frame, Frame::Data { .. }) && r.start < state.ack)
        && let Frame::Data { bytes, .. } = &mut record.frame
    {
        bytes.drain(..(state.ack - record.start) as usize);
        record.start = state.ack;
    }
}
fn nonblocking(file: &std::fs::File) -> io::Result<()> {
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn push(state: &mut State, frame: Frame) -> io::Result<()> {
    let start = state.sent;
    if let Frame::Data { bytes, .. } = &frame {
        state.sent = state
            .sent
            .checked_add(bytes.len() as u64)
            .ok_or_else(refused)?;
    } else {
        state.events += 1;
        if state.events > 3 {
            return Err(refused());
        }
    }
    state.output.push_back(Record {
        start,
        end: state.sent,
        frame,
    });
    Ok(())
}
fn drive(process: &mut Process, state: &Arc<Mutex<State>>, kind: Kind) -> io::Result<()> {
    let mut eof = [false, false];
    let mut status = None;
    loop {
        {
            let mut state = state.lock().map_err(|_| refused())?;
            if state.closed {
                *process.input.lock().map_err(|_| refused())? = None;
                return Ok(());
            }
            if state
                .detached
                .is_some_and(|at| at.elapsed() >= Duration::from_secs(30))
            {
                state.input_eof = true;
                state.closed = true;
                if kind == Kind::Pty && status.is_none() {
                    unsafe { libc::kill(-(process.child.id() as i32), libc::SIGHUP) };
                }
                state.detached = None;
            }
            let mut input = process.input.lock().map_err(|_| refused())?;
            if !state.input.is_empty() {
                if let Some(file) = input.as_mut() {
                    let bytes = state.input.make_contiguous();
                    match file.write(bytes) {
                        Ok(n) => {
                            state.input.drain(..n);
                            state.input_written += n as u64;
                            state.returned = state
                                .returned
                                .checked_add(n as u32)
                                .filter(|v| *v <= CREDIT)
                                .ok_or_else(refused)?;
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                            state.input.clear();
                            state.input_eof = true;
                        }
                        Err(error) => return Err(error),
                    }
                } else {
                    state.input.clear();
                }
            }
            if state.input_eof && state.input.is_empty() && !state.pty_eof_sent {
                if kind == Kind::Pty {
                    // A PTY has no pipe half-close. VEOF is the canonical-mode
                    // EOF operation; retain the master for resize and output.
                    if let Some(file) = input.as_mut() {
                        match file.write(&[4]) {
                            Ok(_) => state.pty_eof_sent = true,
                            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                            Err(e) => return Err(e),
                        }
                    }
                } else {
                    *input = None;
                }
            }
            let mut idle = [false, false];
            for (index, stream) in [(0, 1), (1, 2)] {
                if eof[index] {
                    idle[index] = true;
                    continue;
                }
                let file = if index == 0 {
                    Some(&mut process.output)
                } else {
                    process.error.as_mut()
                };
                if file.is_none() {
                    eof[index] = true;
                    idle[index] = true;
                    continue;
                }
                let available = CREDIT as u64 - (state.sent - state.ack);
                if available == 0 || state.output.len() >= 8192 {
                    continue;
                }
                let mut bytes = [0; 8192];
                match file
                    .unwrap()
                    .read(&mut bytes[..std::cmp::min(8192, available as usize)])
                {
                    Ok(0) => {
                        eof[index] = true;
                        idle[index] = true;
                        push(&mut state, Frame::Eof { stream })?;
                    }
                    Ok(n) => push(
                        &mut state,
                        Frame::Data {
                            stream,
                            bytes: bytes[..n].to_vec(),
                        },
                    )?,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        idle[index] = true;
                    }
                    Err(error) if kind == Kind::Pty && error.raw_os_error() == Some(libc::EIO) => {
                        eof[index] = true;
                        idle[index] = true;
                        push(&mut state, Frame::Eof { stream })?;
                    }
                    Err(error) => return Err(error),
                }
            }
            if status.is_none() {
                let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
                if unsafe {
                    libc::waitid(
                        libc::P_PID,
                        process.child.id(),
                        info.as_mut_ptr(),
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                } != 0
                {
                    return Err(io::Error::last_os_error());
                }
                let info = unsafe { info.assume_init() };
                if unsafe { info.si_pid() } != 0 {
                    status = Some(if info.si_code == libc::CLD_EXITED {
                        Frame::Exit {
                            code: unsafe { info.si_status() } as u8,
                        }
                    } else {
                        Frame::ExitSignal {
                            name: signal_name(unsafe { info.si_status() })?,
                            core: info.si_code == libc::CLD_DUMPED,
                        }
                    });
                }
            }
            if (eof.iter().all(|v| *v) || idle.iter().all(|v| *v)) && status.is_some() {
                for (index, stream) in [(0, 1), (1, 2)] {
                    if !eof[index] && (index == 0 || process.error.is_some()) {
                        push(&mut state, Frame::Eof { stream })?;
                    }
                }
                state.ended = true;
                push(&mut state, status.take().unwrap())?;
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn signal_name(signal: i32) -> io::Result<String> {
    // A process can die from more signals than the host may send.
    let name = match signal {
        libc::SIGINT => "INT",
        libc::SIGTERM => "TERM",
        libc::SIGHUP => "HUP",
        libc::SIGKILL => "KILL",
        libc::SIGQUIT => "QUIT",
        libc::SIGUSR1 => "USR1",
        libc::SIGUSR2 => "USR2",
        _ => return Err(refused()),
    };
    Ok(name.into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::OwnedFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    fn fixture(script: &str) -> Live {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        let input = Arc::new(Mutex::new(Some(std::fs::File::from(OwnedFd::from(
            child.stdin.take().unwrap(),
        )))));
        let output = std::fs::File::from(OwnedFd::from(child.stdout.take().unwrap()));
        let error = Some(std::fs::File::from(OwnedFd::from(
            child.stderr.take().unwrap(),
        )));
        Live::start(
            Process {
                child,
                input,
                output,
                error,
            },
            Kind::Exec,
        )
        .unwrap()
    }
    fn wait(live: &Live, predicate: impl Fn(&[Frame]) -> bool) -> Vec<Frame> {
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            let frames = live.replay(0).unwrap();
            if predicate(&frames) {
                return frames;
            }
            assert!(Instant::now() < until, "timed out: {frames:?}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn live_pipes_preserve_binary_eof_stderr_exit_and_credit() {
        let live = fixture("cat; printf err >&2; exit 7");
        live.receive(Frame::Data {
            stream: 0,
            bytes: vec![0, 255, 10],
        })
        .unwrap();
        live.receive(Frame::Eof { stream: 0 }).unwrap();
        let frames = wait(&live, |frames| {
            frames.iter().any(|f| matches!(f, Frame::Exit { code: 7 }))
        });
        let out: Vec<u8> = frames
            .iter()
            .filter_map(|f| {
                if let Frame::Data { stream: 1, bytes } = f {
                    Some(bytes.clone())
                } else {
                    None
                }
            })
            .flatten()
            .collect();
        assert_eq!(out, [0, 255, 10]);
        let err: Vec<u8> = frames
            .iter()
            .filter_map(|f| {
                if let Frame::Data { stream: 2, bytes } = f {
                    Some(bytes.clone())
                } else {
                    None
                }
            })
            .flatten()
            .collect();
        assert_eq!(err, b"err");
        assert!(matches!(
            live.take_credit().unwrap(),
            Some(Frame::Window { bytes: 3 })
        ));
        assert!(live.receive(Frame::Window { bytes: 7 }).is_err());
        live.receive(Frame::Window { bytes: 6 }).unwrap();
        assert!(live.replay(5).is_err());
        assert!(
            live.replay(6)
                .unwrap()
                .iter()
                .all(|f| !matches!(f, Frame::Data { .. }))
        );
    }
    #[test]
    fn live_output_stalls_at_credit_and_replays_from_offset() {
        let live = fixture("head -c 300000 /dev/zero");
        wait(&live, |_| live.output_counts().unwrap().1 == 262144);
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(live.output_counts().unwrap(), (0, 262144));
        let now = Instant::now();
        live.detach(now).unwrap();
        assert_eq!(
            live.attach(100000, now + Duration::from_secs(1)).unwrap(),
            0
        );
        let frames = live.replay(100000).unwrap();
        let bytes: usize = frames
            .iter()
            .map(|f| {
                if let Frame::Data { bytes, .. } = f {
                    bytes.len()
                } else {
                    0
                }
            })
            .sum();
        assert!(bytes >= 162144);
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            if live
                .replay(100000)
                .unwrap()
                .iter()
                .any(|f| matches!(f, Frame::Exit { code: 0 }))
            {
                break;
            }
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(live.output_counts().unwrap().1, 300000);
        live.receive(Frame::Window { bytes: 200000 }).unwrap();
    }
    #[test]
    fn first_process_exit_does_not_wait_for_background_pipe_eof() {
        let live = fixture("sleep 30 & printf ready; exit 7");
        let frames = wait(&live, |frames| {
            frames.iter().any(|f| matches!(f, Frame::Exit { code: 7 }))
        });
        assert!(
            frames
                .iter()
                .any(|f| matches!(f,Frame::Data {stream:1,bytes} if bytes==b"ready"))
        );
        // Only this fixture's own descendant process group is signaled.
        unsafe {
            libc::kill(-(live.pid as i32), libc::SIGKILL);
        }
        assert!(
            live.receive(Frame::Signal {
                name: "TERM".into()
            })
            .is_err()
        );
    }
    #[test]
    fn live_signal_reaches_process_group_and_reports_term() {
        let live = fixture("exec sleep 30");
        live.receive(Frame::Signal {
            name: "TERM".into(),
        })
        .unwrap();
        wait(&live, |frames| {
            frames
                .iter()
                .any(|f| matches!(f,Frame::ExitSignal {name,core:false} if name=="TERM"))
        });
    }
}
