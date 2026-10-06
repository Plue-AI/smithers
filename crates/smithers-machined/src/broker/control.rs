//! Bounded broker socketpair protocol. No accepted operation takes a path,
//! executable, identity, environment, token, or caller-selected cgroup.
use crate::{conn, hooks::Error};
use std::{io, time::Duration};
pub trait Controls {
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
fn response(id: &[u8], variant: u8, fields: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = id.to_vec();
    bytes.extend(conn::tagged(variant, fields));
    bytes
}
pub fn handle(packet: &[u8], controls: &mut impl Controls) -> io::Result<Vec<u8>> {
    if packet.len() < 9 || packet.len() > 65536 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let id = &packet[..4];
    let request = (|| {
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
        result.map_err(|e| {
            error(if e.kind() == io::ErrorKind::TimedOut {
                9
            } else {
                12
            })
        })
    })();
    Ok(match request {
        Ok(fields) => response(id, packet[4], &fields),
        Err(e) => response(id, 255, &e.fields()),
    })
}
#[cfg(target_os = "linux")]
pub struct SocketpairBroker(std::sync::Mutex<(std::os::fd::OwnedFd, u32, bool)>);
#[cfg(target_os = "linux")]
impl SocketpairBroker {
    pub fn new(fd: std::os::fd::OwnedFd) -> io::Result<Self> {
        use rustix::net::sockopt::{self, Timeout};
        for timeout in [Timeout::Recv, Timeout::Send] {
            sockopt::set_socket_timeout(&fd, timeout, Some(Duration::from_secs(6)))?;
        }
        Ok(Self(std::sync::Mutex::new((fd, 0, false))))
    }
    fn call(&self, variant: u8, fields: &[Vec<u8>]) -> crate::hooks::Result<Vec<u8>> {
        use rustix::net::{recv, send, RecvFlags, SendFlags};
        let mut connection = self.0.lock().map_err(|_| error(12))?;
        let (fd, id, failed) = &mut *connection;
        if *failed {
            return Err(error(12));
        }
        *id = id.checked_add(1).ok_or_else(|| error(12))?;
        let request = response(&id.to_be_bytes(), variant, fields);
        let exchange = (|| -> io::Result<Vec<u8>> {
            if send(&*fd, &request, SendFlags::NOSIGNAL)? != request.len() {
                return Err(io::ErrorKind::WriteZero.into());
            }
            let mut bytes = vec![0; 65537];
            let (n, _) = recv(&*fd, &mut bytes, RecvFlags::empty())?;
            if n < 9 || n > 65536 || bytes[..4] != id.to_be_bytes() {
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
    loop {
        let mut packet = vec![0; 65537];
        let (n, _) = recv(fd, &mut packet, RecvFlags::empty())?;
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
