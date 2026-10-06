//! Bounded socketpair protocol. No request contains paths, argv, environment,
//! identities or descriptors: root operations use broker-owned state only.
use crate::hooks::{Broker, Error, Result};
use std::{
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    sync::Mutex,
    time::Duration,
};

pub trait Controls {
    /// Timeout includes kernel state polling; implementations thaw on timeout.
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
struct Connection {
    socket: UnixStream,
    failed: bool,
}
pub struct SocketpairBroker(Mutex<Connection>);
impl SocketpairBroker {
    pub fn new(socket: UnixStream) -> io::Result<Self> {
        socket.set_read_timeout(Some(Duration::from_secs(2)))?;
        socket.set_write_timeout(Some(Duration::from_secs(2)))?;
        Ok(Self(Mutex::new(Connection {
            socket,
            failed: false,
        })))
    }
    fn request(&self, command: u8, argument: u32) -> Result<u32> {
        let mut connection = self.0.lock().map_err(|_| error(12))?;
        if connection.failed {
            return Err(error(12));
        }
        let mut request = vec![command];
        request.extend(argument.to_be_bytes());
        let mut response = [0; 5];
        let exchange = (|| {
            connection.socket.write_all(&request)?;
            connection.socket.read_exact(&mut response)
        })();
        if exchange.is_err() {
            // An uncorrelated late response must never acknowledge a later
            // operation. Recreate the socketpair after any transport failure.
            connection.failed = true;
            let _ = connection.socket.shutdown(std::net::Shutdown::Both);
            return Err(error(12));
        }
        if !matches!(response[0], 0 | 1 | 9 | 12) {
            connection.failed = true;
            let _ = connection.socket.shutdown(std::net::Shutdown::Both);
            return Err(error(12));
        }
        if response[0] != 0 {
            return Err(error(response[0]));
        }
        Ok(u32::from_be_bytes(response[1..].try_into().unwrap()))
    }
}
impl Broker for SocketpairBroker {
    fn freeze(&self, timeout: Duration) -> Result<Option<u32>> {
        if timeout.is_zero() || timeout > Duration::from_secs(1) {
            return Err(error(1));
        }
        let ms = timeout.as_millis().max(1) as u32;
        match self.request(1, ms)? {
            0 => Ok(None),
            id => Ok(Some(id)),
        }
    }
    fn thaw(&self) -> Result<()> {
        self.request(2, 0).map(|_| ())
    }
    fn kill_sessions(&self, sessions: Option<&[u32]>) -> Result<u16> {
        if sessions.is_some() {
            return Err(error(2));
        }
        u16::try_from(self.request(3, 0)?).map_err(|_| error(12))
    }
}
/// Production socketpair handler. Invalid payloads are refused before Controls
/// is called; EOF also thaws, so a crashed daemon never leaves sessions frozen.
pub fn serve(socket: &mut UnixStream, controls: &mut impl Controls) -> io::Result<()> {
    let result: io::Result<()> = (|| loop {
        let mut request = [0; 5];
        socket.read_exact(&mut request)?;
        let argument = u32::from_be_bytes(request[1..].try_into().unwrap());
        let result = match (request[0], argument) {
            (1, 1..=1000) => controls
                .freeze(Duration::from_millis(u64::from(argument)))
                .map(|id| id.unwrap_or(0)),
            (2, 0) => controls.thaw().map(|_| 0),
            (3, 0) => controls.kill().map(u32::from),
            _ => {
                socket.write_all(&[1, 0, 0, 0, 0])?;
                continue;
            }
        };
        let mut response = [0; 5];
        match result {
            Ok(value) => response[1..].copy_from_slice(&value.to_be_bytes()),
            Err(e) => {
                response[0] = if e.kind() == io::ErrorKind::TimedOut {
                    9
                } else {
                    12
                }
            }
        }
        socket.write_all(&response)?;
    })();
    let thaw = controls.thaw();
    match result {
        Err(ref e) if e.kind() == io::ErrorKind::UnexpectedEof => thaw,
        _ => result.and(thaw),
    }
}
