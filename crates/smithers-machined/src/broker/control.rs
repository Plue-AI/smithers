//! Bounded broker socketpair protocol. No operation selects a cgroup path.
//! Session commands validate typed identities before reaching the root provider;
//! argv remains data until that provider has dropped privileges.
use crate::{conn, hooks::Error};
use std::{io, time::Duration};
const REGISTRY_LIMIT: usize = 16 * 1024 * 1024;
pub trait Controls {
    fn tick(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn stream(&mut self, _op: u8, _body: &[u8]) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::Unsupported.into())
    }
    /// Implementations must bind users to trusted accounts and the synchronized
    /// roster, and drop privileges before resolving any branch argv or home.
    fn session(&mut self, _request: super::request::Request) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::Unsupported.into())
    }
    /// Reads only the broker-owned parent cgroup; no request supplies a path.
    fn frozen(&mut self) -> io::Result<bool> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn freeze(&mut self, timeout: Duration) -> io::Result<Option<u32>>;
    fn thaw(&mut self) -> io::Result<()>;
    fn kill(&mut self) -> io::Result<u16>;
    /// A descriptor to hand to the daemon with the reply to the request just
    /// handled, taken once. Only a started transcript reader's socket is one.
    fn descriptor(&mut self) -> Option<std::os::fd::OwnedFd> {
        None
    }
}
/// Operations with a raw body: session streams, the registry, and transcript
/// sources (26 list, 27 start a reader, 28 release), admitted local input (29),
/// and the process census (30).
fn raw(op: u8) -> bool {
    (17..=30).contains(&op) || op == 32
}
fn error(code: u8) -> Error {
    Error {
        code,
        ..Error::unsupported()
    }
}
fn map_io(e: io::Error) -> Error {
    error(match e.kind() {
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => 1,
        io::ErrorKind::Unsupported => 2,
        io::ErrorKind::NotFound => 5,
        io::ErrorKind::TimedOut => 9,
        io::ErrorKind::PermissionDenied => 11,
        _ => 12,
    })
}
fn response(id: &[u8], variant: u8, fields: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = id.to_vec();
    bytes.extend(conn::tagged(variant, fields));
    bytes
}
pub fn handle(packet: &[u8], controls: &mut impl Controls) -> io::Result<Vec<u8>> {
    if packet.len() >= 5 && raw(packet[4]) && packet.len() <= 65560 {
        let mut reply = packet[..5].to_vec();
        match controls.stream(packet[4], &packet[5..]) {
            Ok(body) => reply.extend(body),
            Err(e) => {
                reply.truncate(4);
                reply.extend(conn::tagged(255, &map_io(e).fields()));
            }
        }
        return Ok(reply);
    }
    if packet.len() < 9 || packet.len() > 65536 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let id = &packet[..4];
    let request = (|| {
        if matches!(packet[4], 6..=10 | 15 | 16) {
            let request =
                super::request::Request::decode(packet[4], &packet[5..]).map_err(|_| error(1))?;
            let body = controls.session(request).map_err(map_io)?;
            let fields =
                conn::fields(&format!("result{}", packet[4]), &body).map_err(|_| error(12))?;
            return Ok(fields
                .into_iter()
                .map(|(tag, value)| conn::field(tag, value))
                .collect());
        }
        let name = match packet[4] {
            1 => "broker_freeze",
            2 | 3 | 31 => "empty",
            _ => return Err(error(2)),
        };
        let fields = conn::fields(name, &packet[5..]).map_err(|_| error(1))?;
        let result = match packet[4] {
            1 => {
                let ms = u32::from_be_bytes(fields[0].1.try_into().map_err(|_| error(1))?);
                if !(1..=1000).contains(&ms) {
                    return Err(error(1));
                }
                controls
                    .freeze(Duration::from_millis(u64::from(ms)))
                    .map(|blocking| {
                        let mut fields = vec![conn::field(1, [u8::from(blocking.is_none())])];
                        if let Some(id) = blocking {
                            fields.push(conn::field(2, id.to_be_bytes()));
                        }
                        fields
                    })
            }
            31 => controls
                .frozen()
                .map(|frozen| vec![conn::field(1, [u8::from(frozen)])]),
            2 => controls.thaw().map(|_| vec![]),
            3 => controls
                .kill()
                .map(|count| vec![conn::field(1, count.to_be_bytes())]),
            _ => unreachable!(),
        };
        result.map_err(map_io)
    })();
    Ok(match request {
        Ok(fields) => response(id, packet[4], &fields),
        Err(e) => response(id, 255, &e.fields()),
    })
}
#[cfg(target_os = "linux")]
pub struct SocketpairBroker(
    std::sync::Mutex<(std::os::fd::OwnedFd, u32, bool)>,
    std::sync::Mutex<Presence>,
    std::sync::atomic::AtomicU8,
    #[cfg(all(feature = "testing", debug_assertions))] bool,
);
#[cfg(target_os = "linux")]
#[derive(Default)]
struct Presence {
    // Display metadata only; live session identity always comes from the broker.
    paths: std::collections::BTreeMap<u32, String>,
    last: Option<Vec<u8>>,
    sent: Option<std::time::Instant>,
    /// When the daemon last polled sessions, which it does only on an
    /// authenticated link whose reconciliation and roster are complete.
    polled: Option<std::time::Instant>,
}
#[cfg(target_os = "linux")]
impl SocketpairBroker {
    pub fn new(fd: std::os::fd::OwnedFd) -> io::Result<Self> {
        use rustix::net::sockopt::{self, Timeout};
        for timeout in [Timeout::Recv, Timeout::Send] {
            sockopt::set_socket_timeout(&fd, timeout, Some(Duration::from_secs(6)))?;
        }
        Ok(Self(
            std::sync::Mutex::new((fd, 0, false)),
            std::sync::Mutex::new(Presence::default()),
            std::sync::atomic::AtomicU8::new(0),
            #[cfg(all(feature = "testing", debug_assertions))]
            false,
        ))
    }
    #[cfg(all(feature = "testing", debug_assertions))]
    pub(crate) fn with_installed_input_validation(mut self) -> Self {
        self.3 = true;
        self
    }
    /// Acceptance images only: a bounded fixed packet ends this private
    /// channel. The installed supervisor must drain sessions before restarting.
    #[cfg(any(test, all(feature = "testing", debug_assertions)))]
    pub(super) fn acceptance_fatal(&self, length: usize) -> crate::hooks::Result<()> {
        use rustix::net::{recv, send, RecvFlags, SendFlags};
        if !matches!(length, 1 | 4 | 8 | 65537 | 65561 | 70000) {
            return Err(error(1));
        }
        let mut connection = self.0.lock().map_err(|_| error(12))?;
        let (fd, _, failed) = &mut *connection;
        let mut packet = vec![0; length];
        if length > 4 {
            packet[4] = 6;
        }
        send(&*fd, &packet, SendFlags::NOSIGNAL).map_err(|e| map_io(e.into()))?;
        let mut response = [0; 8];
        let result = recv(&*fd, &mut response, RecvFlags::empty());
        *failed = true;
        match result {
            Ok((0, _)) => Ok(()),
            _ => Err(error(12)),
        }
    }
    #[cfg(any(test, all(feature = "testing", debug_assertions)))]
    pub(super) fn acceptance_body(
        &self,
        variant: u8,
        body: &[u8],
    ) -> crate::hooks::Result<Vec<u8>> {
        self.call_body(variant, body)
    }
    fn call(&self, variant: u8, fields: &[Vec<u8>]) -> crate::hooks::Result<Vec<u8>> {
        self.call_body(variant, &conn::structure_bytes(fields))
    }
    fn call_body(&self, variant: u8, body: &[u8]) -> crate::hooks::Result<Vec<u8>> {
        self.call_passing(variant, body).map(|(bytes, _)| bytes)
    }
    /// One exchange, with the descriptor the broker passed alongside its
    /// reply when it passed one. A caller that expects none drops it.
    fn call_passing(
        &self,
        variant: u8,
        body: &[u8],
    ) -> crate::hooks::Result<(Vec<u8>, Option<std::os::fd::OwnedFd>)> {
        use rustix::net::{send, RecvFlags, SendFlags};
        let mut passed = None;
        let mut connection = self.0.lock().map_err(|_| error(12))?;
        let (fd, id, failed) = &mut *connection;
        if *failed {
            return Err(error(12));
        }
        *id = id.checked_add(1).ok_or_else(|| error(12))?;
        let mut request = id.to_be_bytes().to_vec();
        request.push(variant);
        request.extend_from_slice(body);
        if request.len() > if raw(variant) { 65560 } else { 65536 } {
            return Err(error(1));
        }
        let exchange = (|| -> io::Result<Vec<u8>> {
            if send(&*fd, &request, SendFlags::NOSIGNAL)? != request.len() {
                return Err(io::ErrorKind::WriteZero.into());
            }
            let mut receive = || -> io::Result<Vec<u8>> {
                let mut bytes = vec![0; 65561];
                let mut space =
                    [std::mem::MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
                let mut ancillary = rustix::net::RecvAncillaryBuffer::new(&mut space);
                let n = rustix::net::recvmsg(
                    &*fd,
                    &mut [io::IoSliceMut::new(&mut bytes)],
                    &mut ancillary,
                    RecvFlags::CMSG_CLOEXEC,
                )?
                .bytes;
                for message in ancillary.drain() {
                    if let rustix::net::RecvAncillaryMessage::ScmRights(descriptors) = message {
                        passed = descriptors.last();
                    }
                }
                if !(5..=65560).contains(&n) || bytes[..4] != id.to_be_bytes() {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                bytes.truncate(n);
                Ok(bytes)
            };
            let first = receive()?;
            if variant != 25 || first[4] != 25 {
                return Ok(first);
            }
            // The sole registry is bounded independently of individual private
            // packets. Owner/process bindings must not make valid large rosters
            // fail or force an unbounded seqpacket allocation.
            if first.len() < 9 {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let total = u32::from_be_bytes(first[5..9].try_into().unwrap()) as usize;
            if total > REGISTRY_LIMIT {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let mut bytes = first[..5].to_vec();
            bytes.extend_from_slice(&first[9..]);
            while bytes.len() - 5 < total {
                let next = receive()?;
                if next[4] != 25 || next.len() == 5 {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                bytes.extend_from_slice(&next[5..]);
            }
            if bytes.len() - 5 != total {
                return Err(io::ErrorKind::InvalidData.into());
            }
            Ok(bytes)
        })();
        let bytes = match exchange {
            Ok(b) => b,
            Err(_) => {
                *failed = true;
                return Err(error(12));
            }
        };
        if bytes[4] == 255 {
            let fields = conn::fields("error", &bytes[5..]).map_err(|_| error(12))?;
            return Err(error(fields[0].1[0]));
        }
        if bytes[4] != variant {
            *failed = true;
            return Err(error(12));
        }
        // Store under the same packet lock as the exchange. A concurrent
        // readiness read must never overwrite a newer freeze/thaw reply.
        let observed = match variant {
            1 => {
                let fields = conn::fields("broker_frozen", &bytes[5..]).map_err(|_| error(12))?;
                if fields[0].1 == [1] {
                    Some(2)
                } else {
                    None
                }
            }
            2 => {
                conn::fields("empty", &bytes[5..]).map_err(|_| error(12))?;
                Some(1)
            }
            31 => {
                let fields = conn::fields("freeze_state", &bytes[5..]).map_err(|_| error(12))?;
                Some(if fields[0].1 == [1] { 2 } else { 1 })
            }
            _ => None,
        };
        if let Some(observed) = observed {
            self.2.store(observed, std::sync::atomic::Ordering::Release);
        }
        Ok((bytes[5..].to_vec(), passed))
    }
}
#[cfg(target_os = "linux")]
impl crate::hooks::Broker for SocketpairBroker {
    fn frozen(&self) -> Option<bool> {
        match self.2.load(std::sync::atomic::Ordering::Acquire) {
            1 => Some(false),
            2 => Some(true),
            _ => None,
        }
    }
    fn ready(&self) -> crate::hooks::Result<()> {
        self.call_body(23, &[])?;
        // Read the initial kernel state rather than treating readiness as thaw.
        // The packet lock serializes this with freeze/thaw replies.
        match self.call(31, &[]) {
            Ok(_) => {}
            Err(error) if error.code == 2 => {} // no observation from an unavailable provider
            Err(error) => return Err(error),
        }
        Ok(())
    }
    fn set_roster(&self, members: &[super::sessions::User]) -> crate::hooks::Result<()> {
        self.set_roster_for_import(members, false)
    }
    fn set_roster_for_import(
        &self,
        members: &[super::sessions::User],
        enabled: bool,
    ) -> crate::hooks::Result<()> {
        let body = super::request::roster_bytes_for_import(members, enabled).map_err(map_io)?;
        let result = self.call_body(16, &body)?;
        conn::fields("result16", &result).map_err(|_| error(12))?;
        Ok(())
    }
    fn freeze(&self, timeout: Duration) -> crate::hooks::Result<Option<u32>> {
        if timeout.is_zero() || timeout > Duration::from_secs(1) {
            return Err(error(1));
        }
        let body = self.call(
            1,
            &[conn::field(
                1,
                (timeout.as_millis().max(1) as u32).to_be_bytes(),
            )],
        )?;
        let fields = conn::fields("broker_frozen", &body).map_err(|_| error(12))?;
        if fields[0].1 == [1] {
            Ok(None)
        } else {
            fields
                .get(1)
                .map(|(_, b)| u32::from_be_bytes((*b).try_into().unwrap()))
                .map(Some)
                .ok_or_else(|| error(9))
        }
    }
    fn thaw(&self) -> crate::hooks::Result<()> {
        self.call(2, &[])?;
        Ok(())
    }
    fn kill_sessions(&self, sessions: Option<&[u32]>) -> crate::hooks::Result<u16> {
        if sessions.is_some() {
            return Err(error(2));
        }
        let body = self.call(3, &[])?;
        let fields = conn::fields("broker_killed", &body).map_err(|_| error(12))?;
        Ok(u16::from_be_bytes(fields[0].1.try_into().unwrap()))
    }
}
#[cfg(target_os = "linux")]
pub fn serve(fd: &std::os::fd::OwnedFd, controls: &mut impl Controls) -> io::Result<()> {
    use rustix::net::{recv, send, RecvFlags, SendFlags};
    rustix::net::sockopt::set_socket_timeout(
        fd,
        rustix::net::sockopt::Timeout::Recv,
        Some(Duration::from_millis(100)),
    )?;
    loop {
        controls.tick()?;
        let mut packet = vec![0; 65561];
        let (n, _) = match recv(fd, &mut packet, RecvFlags::empty()) {
            Ok(result) => result,
            Err(rustix::io::Errno::AGAIN) => continue,
            Err(error) => return Err(error.into()),
        };
        if n == 0 {
            return Ok(());
        }
        let response = handle(&packet[..n], controls)?;
        let descriptor = controls.descriptor();
        if response.get(4) == Some(&25) {
            let body = &response[5..];
            if body.len() > REGISTRY_LIMIT {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let mut framed = (body.len() as u32).to_be_bytes().to_vec();
            framed.extend_from_slice(body);
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            for chunk in framed.chunks(65555) {
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .ok_or(io::ErrorKind::TimedOut)?;
                // Keep timeval microseconds below one million. Rounding a
                // duration just below one second upward would produce EDOM.
                let micros = remaining.as_micros() as u64;
                if micros == 0 {
                    return Err(io::ErrorKind::TimedOut.into());
                }
                rustix::net::sockopt::set_socket_timeout(
                    fd,
                    rustix::net::sockopt::Timeout::Send,
                    Some(Duration::from_micros(micros)),
                )?;
                let mut packet = response[..5].to_vec();
                packet.extend_from_slice(chunk);
                if send(fd, &packet, SendFlags::NOSIGNAL)? != packet.len() {
                    return Err(io::ErrorKind::WriteZero.into());
                }
            }
        } else {
            rustix::net::sockopt::set_socket_timeout(
                fd,
                rustix::net::sockopt::Timeout::Send,
                Some(Duration::from_secs(1)),
            )?;
            let sent = match &descriptor {
                // The broker keeps no copy: its end closes when this returns.
                Some(descriptor) => {
                    use std::os::fd::AsFd;
                    let mut space =
                        [std::mem::MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
                    let mut ancillary = rustix::net::SendAncillaryBuffer::new(&mut space);
                    let passing = [descriptor.as_fd()];
                    if !ancillary.push(rustix::net::SendAncillaryMessage::ScmRights(&passing)) {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    rustix::net::sendmsg(
                        fd,
                        &[io::IoSlice::new(&response)],
                        &mut ancillary,
                        SendFlags::NOSIGNAL,
                    )?
                }
                None => send(fd, &response, SendFlags::NOSIGNAL)?,
            };
            if sent != response.len() {
                return Err(io::ErrorKind::WriteZero.into());
            }
        }
    }
    // The process owner kills descendants after EOF. Never thaw a rewrite whose
    // daemon died before reporting settlement.
}

#[cfg(target_os = "linux")]
impl crate::hooks::Sessions for SocketpairBroker {
    fn reset_presence(&self) -> crate::hooks::Result<()> {
        let mut presence = self.1.lock().map_err(|_| error(12))?;
        presence.last = None;
        presence.sent = None;
        presence.polled = None;
        Ok(())
    }
    fn ready(&self) -> crate::hooks::Result<()> {
        self.call_body(23, &[]).map(|_| ())
    }
    fn frame(&self, frame: &conn::Frame) -> crate::hooks::Result<Option<conn::Frame>> {
        if frame.kind != 5 {
            return Err(error(1));
        }
        self.call_body(17, &frame.encode().map_err(|_| error(1))?)?;
        Ok(None)
    }
    fn frame_local(&self, frame: &conn::Frame) -> crate::hooks::Result<Option<conn::Frame>> {
        if frame.kind != 5 {
            return Err(error(1));
        }
        self.call_body(29, &frame.encode().map_err(|_| error(1))?)?;
        Ok(None)
    }
    fn poll(&self) -> crate::hooks::Result<Vec<conn::Frame>> {
        let mut frames = self.poll_stream(0)?;
        let now = std::time::Instant::now();
        if let Some(frame) = self.poll_presence(now)? {
            frames.push(frame);
        }
        self.1.lock().map_err(|_| error(12))?.polled = Some(now);
        Ok(frames)
    }
    fn poll_local(&self, id: u32) -> crate::hooks::Result<Vec<conn::Frame>> {
        if id == 0 {
            return Err(error(1));
        }
        self.poll_stream(id)
    }
    fn open_local(&self, path: &str, args: &[u8]) -> crate::hooks::Result<Vec<u8>> {
        crate::local::validate_open(args)?;
        let id = path
            .strip_prefix("/smithers/sessions/")
            .ok_or_else(|| error(11))?;
        let id = super::sessions::cgroup_id(id).map_err(map_io)?;
        self.call_body(19, &[id.to_be_bytes().as_slice(), args].concat())
    }
    fn admission_of_cgroup(&self, path: &str) -> Option<super::sessions::Admission> {
        serde_json::from_slice(&self.call_body(20, path.as_bytes()).ok()?).ok()
    }
    fn live(&self) -> Vec<u32> {
        self.live_sessions().unwrap_or_default()
    }
    fn last_path(&self, session: u32) -> Option<String> {
        self.1.lock().ok()?.paths.get(&session).cloned()
    }
    fn where_file(&self, session: u32, path: &str) -> crate::hooks::Result<()> {
        if !crate::ignore::relative(std::path::Path::new(path))
            || path.contains('\0')
            || path.len() > 4096
        {
            return Err(error(1));
        }
        // An outside write, stale session or forged id cannot move anyone.
        if !self.live_sessions()?.contains(&session) {
            return Err(error(11));
        }
        self.1
            .lock()
            .map_err(|_| error(12))?
            .paths
            .insert(session, path.into());
        Ok(())
    }
    fn disconnected(&self) -> crate::hooks::Result<()> {
        self.call_body(22, &[])?;
        self.reset_presence()
    }
    fn call(&self, method: u8, args: &[u8]) -> crate::hooks::Result<Vec<u8>> {
        if !matches!(method, 6..=10 | 15) {
            return Err(error(2));
        }
        let request = super::request::Request::decode(method, args).map_err(map_io)?;
        #[cfg(not(all(feature = "testing", debug_assertions)))]
        let _ = request;
        let body = self.call_body(method, args)?;
        conn::fields(&format!("result{method}"), &body).map_err(|_| error(12))?;
        #[cfg(all(feature = "testing", debug_assertions))]
        if method == 6 && self.3 {
            let fields = conn::fields("result6", &body).map_err(|_| error(12))?;
            let id = u32::from_be_bytes(fields[0].1.try_into().map_err(|_| error(12))?);
            if let Err(failure) = super::ssh_acceptance::installed(self, id) {
                // A refused acceptance reply must not hide an already-started
                // member process. Use the existing session-specific kill.
                let target = conn::tagged(3, &[conn::field(1, id.to_be_bytes())]);
                self.call(9, &[conn::field(1, target)])?;
                return Err(failure);
            }
            if let super::request::Request::Open { argv, user, .. } = request {
                if let Some(length) =
                    super::ssh_acceptance::fatal_profile(&argv).filter(|_| user.uid >= 20000)
                {
                    self.acceptance_fatal(length)?;
                    return Err(error(12));
                }
            }
        }
        Ok(body)
    }
}

#[cfg(target_os = "linux")]
impl SocketpairBroker {
    /// Read-only projection of the sole broker-owned registry. No daemon field
    /// can update a user, run, cgroup or session ownership through this operation.
    pub fn registry(&self) -> crate::hooks::Result<Vec<super::sessions::Entry>> {
        let bytes = self.call_body(25, &[])?;
        let entries: Vec<super::sessions::Entry> =
            serde_json::from_slice(&bytes).map_err(|_| error(12))?;
        if entries.len() > 512 {
            return Err(error(12));
        }
        for entry in &entries {
            entry.user.validate().map_err(map_io)?;
            if let Some(process) = &entry.process {
                process.validate(&entry.user).map_err(map_io)?;
            }
            if entry.id == 0 || entry.id > 0x7fff_ffff {
                return Err(error(12));
            }
        }
        Ok(entries)
    }
    /// Whether the daemon is serving sessions to the host right now: it polled
    /// them within the last two seconds. Work that must not run without an
    /// authenticated, reconciled link with a synchronized roster waits on this.
    pub fn serving(&self, now: std::time::Instant) -> bool {
        self.1.lock().is_ok_and(|presence| {
            presence
                .polled
                .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(2))
        })
    }
    /// Members' own agent sessions there are to read (spec §9.6.6). Asking is
    /// what makes the broker look; a broker without the import refuses.
    pub fn transcript_sources(&self) -> crate::hooks::Result<Vec<super::transcripts::Listed>> {
        super::transcripts::Listed::decode(&self.call_body(26, &[])?).map_err(|_| error(12))
    }
    /// Have the broker start the owner's reader for one listed source. The
    /// startup names what the broker bound the reader to; the socket is the
    /// reader's, and nothing else ever held it.
    pub fn transcript_reader(
        &self,
        lifetime: [u8; 16],
    ) -> crate::hooks::Result<(
        crate::transcript::reader::Startup,
        std::os::unix::net::UnixStream,
    )> {
        let (bytes, socket) = self.call_passing(27, &lifetime)?;
        let startup: crate::transcript::reader::Startup =
            serde_json::from_slice(&bytes).map_err(|_| error(12))?;
        if startup.source.lifetime != lifetime || startup.checkpoint.is_some() {
            return Err(error(12));
        }
        Ok((startup, socket.ok_or_else(|| error(12))?.into()))
    }
    /// Give a source back: read to its end, or refused by the host (`stopped`).
    pub fn transcript_release(
        &self,
        lifetime: [u8; 16],
        stopped: bool,
    ) -> crate::hooks::Result<()> {
        self.call_body(28, &[lifetime.as_slice(), &[u8::from(stopped)]].concat())
            .map(|_| ())
    }
    fn live_sessions(&self) -> crate::hooks::Result<Vec<u32>> {
        let entries = self.registry()?;
        let mut ids = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for entry in entries {
            if !seen.insert(entry.id) {
                return Err(error(12));
            }
            // Forwarded TCP streams are transport, not working actors. An agent
            // gains presence only after the host registers its broker run.
            if entry.closed
                || entry.exited
                || entry.kind == super::sessions::Kind::Tcp
                || entry.user.login == "agent" && entry.run.is_none()
            {
                continue;
            }
            ids.push(entry.id);
        }
        ids.sort_unstable();
        Ok(ids)
    }
    /// Poll runs only after the daemon's authenticated roster and reconciliation
    /// gates. Reconnect resets emission so the new host immediately gets a full
    /// snapshot. Failed broker reads never become an empty presence snapshot.
    pub fn poll_presence(
        &self,
        now: std::time::Instant,
    ) -> crate::hooks::Result<Option<conn::Frame>> {
        let ids = self.live_sessions()?;
        // A broker without transcript support still publishes ordinary sessions.
        // Any other refusal must not turn an unavailable census into departures.
        let agents = match self.call_body(30, &[]) {
            Ok(bytes) => super::transcripts::Listed::decode(&bytes).map_err(|_| error(12))?,
            Err(e) if e.code == 2 => Vec::new(),
            Err(e) => return Err(e),
        };
        if agents.len() > super::transcripts::MAX_AGENTS {
            return Err(error(12));
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut census = (agents.len() as u16).to_be_bytes().to_vec();
        for agent in agents {
            if agent.ended
                || agent.lifetime != agent.participant
                || !ids.contains(&agent.session)
                || !seen.insert(agent.participant)
            {
                return Err(error(12));
            }
            census.extend(conn::structure_bytes(&[
                conn::field(1, agent.session.to_be_bytes()),
                conn::field(2, agent.participant),
                conn::field(
                    3,
                    [match agent.agent {
                        crate::transcript::discovery::Agent::Codex => 1,
                        crate::transcript::discovery::Agent::ClaudeCode => 2,
                    }],
                ),
            ]));
        }
        let commands: std::collections::BTreeMap<u32, String> = match self.call_body(32, &[]) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| error(12))?,
            Err(e) if e.code == 2 => std::collections::BTreeMap::new(),
            Err(e) => return Err(e),
        };
        if commands.len() > super::sessions::MAX_SESSIONS
            || commands.iter().any(|(id, command)| {
                !ids.contains(id)
                    || command.is_empty()
                    || command.len() > 64
                    || command.chars().any(char::is_control)
            })
        {
            return Err(error(12));
        }
        let mut presence = self.1.lock().map_err(|_| error(12))?;
        presence.paths.retain(|id, _| ids.contains(id));
        let mut items = (ids.len() as u16).to_be_bytes().to_vec();
        for id in ids {
            let mut fields = vec![conn::field(1, id.to_be_bytes())];
            if let Some(path) = presence.paths.get(&id) {
                let mut value = (path.len() as u16).to_be_bytes().to_vec();
                value.extend(path.as_bytes());
                fields.push(conn::field(2, value));
            }
            if let Some(command) = commands.get(&id) {
                let mut value = (command.len() as u16).to_be_bytes().to_vec();
                value.extend(command.as_bytes());
                fields.push(conn::field(3, value));
            }
            items.extend(conn::structure_bytes(&fields));
        }
        let mut fields = vec![conn::field(1, items)];
        if census.len() > 2 {
            fields.push(conn::field(2, census));
        }
        let payload = conn::tagged(1, &fields);
        if presence
            .sent
            .is_some_and(|sent| now.saturating_duration_since(sent) < Duration::from_millis(250))
        {
            return Ok(None);
        }
        if presence.last.as_ref() == Some(&payload)
            && presence
                .sent
                .is_some_and(|sent| now.saturating_duration_since(sent) < Duration::from_secs(10))
        {
            return Ok(None);
        }
        let frame = conn::Frame {
            kind: 3,
            stream: 0,
            payload,
        };
        frame.encode().map_err(|_| error(12))?;
        presence.last = Some(frame.payload.clone());
        presence.sent = Some(now);
        Ok(Some(frame))
    }
    /// Shared stream allocator for document/object provider composition.
    pub fn allocate_stream(&self) -> crate::hooks::Result<u32> {
        let bytes = self.call_body(24, &[])?;
        let id = u32::from_be_bytes(bytes.try_into().map_err(|_| error(12))?);
        if id == 0 || id > 0x7fff_ffff {
            return Err(error(12));
        }
        Ok(id)
    }
    fn poll_stream(&self, id: u32) -> crate::hooks::Result<Vec<conn::Frame>> {
        let bytes = self.call_body(18, &id.to_be_bytes())?;
        if bytes.is_empty() {
            return Ok(vec![]);
        }
        let frame = conn::Frame::decode(&bytes).map_err(|_| error(12))?;
        if frame.kind != 5 || (id != 0 && id != frame.stream) {
            return Err(error(12));
        }
        Ok(vec![frame])
    }
}
