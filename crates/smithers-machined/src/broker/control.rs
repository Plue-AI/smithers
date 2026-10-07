//! Bounded broker socketpair protocol. No operation selects a cgroup path.
//! Session commands validate typed identities before reaching the root provider;
//! argv remains data until that provider has dropped privileges.
use crate::{conn, hooks::Error};
use std::{io, time::Duration};
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
    fn freeze(&mut self, timeout: Duration) -> io::Result<Option<u32>>;
    fn thaw(&mut self) -> io::Result<()>;
    fn kill(&mut self) -> io::Result<u16>;
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
    if packet.len() >= 5 && matches!(packet[4], 17..=24) && packet.len() <= 65560 {
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
            2 | 3 => "empty",
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
);
#[cfg(target_os = "linux")]
#[derive(Default)]
struct Presence {
    // Display metadata only; live session identity always comes from the broker.
    paths: std::collections::BTreeMap<u32, String>,
    last: Option<Vec<u8>>,
    sent: Option<std::time::Instant>,
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
        ))
    }
    fn call(&self, variant: u8, fields: &[Vec<u8>]) -> crate::hooks::Result<Vec<u8>> {
        self.call_body(variant, &conn::structure_bytes(fields))
    }
    fn call_body(&self, variant: u8, body: &[u8]) -> crate::hooks::Result<Vec<u8>> {
        use rustix::net::{recv, send, RecvFlags, SendFlags};
        let mut connection = self.0.lock().map_err(|_| error(12))?;
        let (fd, id, failed) = &mut *connection;
        if *failed {
            return Err(error(12));
        }
        *id = id.checked_add(1).ok_or_else(|| error(12))?;
        let mut request = id.to_be_bytes().to_vec();
        request.push(variant);
        request.extend_from_slice(body);
        if request.len()
            > if matches!(variant, 17..=24) {
                65560
            } else {
                65536
            }
        {
            return Err(error(1));
        }
        let exchange = (|| -> io::Result<Vec<u8>> {
            if send(&*fd, &request, SendFlags::NOSIGNAL)? != request.len() {
                return Err(io::ErrorKind::WriteZero.into());
            }
            let mut bytes = vec![0; 65561];
            let (n, _) = recv(&*fd, &mut bytes, RecvFlags::empty())?;
            if n < 5 || n > 65560 || bytes[..4] != id.to_be_bytes() {
                return Err(io::ErrorKind::InvalidData.into());
            }
            bytes.truncate(n);
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
        Ok(bytes[5..].to_vec())
    }
}
#[cfg(target_os = "linux")]
impl crate::hooks::Broker for SocketpairBroker {
    fn ready(&self) -> crate::hooks::Result<()> {
        self.call_body(23, &[]).map(|_| ())
    }
    fn set_roster(&self, members: &[super::sessions::User]) -> crate::hooks::Result<()> {
        let body = super::request::roster_bytes(members).map_err(map_io)?;
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
        self.call(2, &[]).map(|_| ())
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
        if send(fd, &response, SendFlags::NOSIGNAL)? != response.len() {
            return Err(io::ErrorKind::WriteZero.into());
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
    fn poll(&self) -> crate::hooks::Result<Vec<conn::Frame>> {
        let mut frames = self.poll_stream(0)?;
        if let Some(frame) = self.poll_presence(std::time::Instant::now())? {
            frames.push(frame);
        }
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
    fn run_of_cgroup(&self, path: &str) -> Option<String> {
        String::from_utf8(self.call_body(20, path.as_bytes()).ok()?).ok()
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
        super::request::Request::decode(method, args).map_err(map_io)?;
        let body = self.call_body(method, args)?;
        conn::fields(&format!("result{method}"), &body).map_err(|_| error(12))?;
        Ok(body)
    }
}

#[cfg(target_os = "linux")]
impl SocketpairBroker {
    fn live_sessions(&self) -> crate::hooks::Result<Vec<u32>> {
        let bytes = self.call_body(21, &[])?;
        if bytes.len() % 4 != 0 || bytes.len() > 512 * 4 {
            return Err(error(12));
        }
        let mut ids = Vec::new();
        for b in bytes.chunks_exact(4) {
            let id = u32::from_be_bytes(b.try_into().unwrap());
            if id == 0 || id > 0x7fff_ffff || ids.contains(&id) {
                return Err(error(12));
            }
            ids.push(id);
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
            items.extend(conn::structure_bytes(&fields));
        }
        let payload = conn::tagged(1, &[conn::field(1, items)]);
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
