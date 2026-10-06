//! Per-boot authentication and live-connection replacement on the ADR transport.
//! A candidate has no authority until both proof and Welcome have been checked.
use crate::conn::{self, Frame, ProtocolError};
use std::{
    io,
    net::{Shutdown, TcpStream},
    sync::Mutex,
    time::Duration,
};

pub struct Identity {
    pub boot: [u8; 16],
    secret: [u8; 32],
    credential: Vec<u8>,
    instance: [u8; 16],
}
impl Identity {
    pub fn new(boot: [u8; 16], secret: [u8; 32], credential: Vec<u8>) -> io::Result<Self> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut instance = [0; 16];
        getrandom::fill(&mut instance)
            .map_err(|_| io::Error::other("random source unavailable"))?;
        Ok(Self {
            boot,
            secret,
            credential,
            instance,
        })
    }
}
fn hello(variant: u8, fields: &[Vec<u8>]) -> Frame {
    Frame {
        kind: 0,
        stream: 0,
        payload: conn::tagged(variant, fields),
    }
}
fn fail(stream: &mut TcpStream, error: ProtocolError) -> ProtocolError {
    let _ = hello(5, &[conn::field(1, [error as u8])]).write(stream);
    let _ = stream.shutdown(Shutdown::Both);
    error
}
fn read_hello(stream: &mut TcpStream, variant: u8) -> Result<Frame, ProtocolError> {
    let frame = Frame::read(stream)?;
    if frame.kind != 0 || frame.payload.first() != Some(&variant) {
        return Err(ProtocolError::HandshakeOrder);
    }
    Ok(frame)
}
/// Performs bounded authentication without touching the live connection.
/// Only callers that hold this result may publish RPCs or receipts.
pub struct Authenticated(TcpStream);
impl Authenticated {
    pub fn stream(&mut self) -> &mut TcpStream {
        &mut self.0
    }
}
pub fn authenticate(
    mut stream: TcpStream,
    identity: &Identity,
    next_seq: u64,
    sessions: &[u32],
) -> Result<Authenticated, ProtocolError> {
    let result = (|| {
        if sessions.len() > 512 {
            return Err(ProtocolError::BadValue);
        }
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| ProtocolError::Truncated)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| ProtocolError::Truncated)?;
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| ProtocolError::AuthFailed)?;
        hello(
            1,
            &[
                conn::field(1, 0x534d4d44u32.to_be_bytes()),
                conn::field(2, conn::PROTOCOL.to_be_bytes()),
                conn::field(3, identity.boot),
                conn::field(4, nonce),
            ],
        )
        .write(&mut stream)
        .map_err(|_| ProtocolError::Truncated)?;
        let proof = read_hello(&mut stream, 2)?;
        let fields = conn::fields("proof", &proof.payload[1..])?;
        // The codec reads retained v1 and v2 records. A live peer must still
        // prove the exact protocol advertised by this ready composition.
        if fields[0].1 != conn::PROTOCOL.to_be_bytes() {
            return Err(ProtocolError::VersionMismatch);
        }
        if !conn::verify_host_mac(&identity.secret, &identity.boot, &nonce, fields[1].1) {
            return Err(ProtocolError::AuthFailed);
        }
        let mut credential = (identity.credential.len() as u32).to_be_bytes().to_vec();
        credential.extend(&identity.credential);
        let mut live = (sessions.len() as u16).to_be_bytes().to_vec();
        for id in sessions {
            live.extend(id.to_be_bytes());
        }
        hello(
            3,
            &[
                conn::field(1, credential),
                conn::field(2, identity.instance),
                conn::field(3, next_seq.to_be_bytes()),
                conn::field(4, live),
            ],
        )
        .write(&mut stream)
        .map_err(|_| ProtocolError::Truncated)?;
        read_hello(&mut stream, 4)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(|_| ProtocolError::Truncated)?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(Authenticated(stream)),
        Err(e) => Err(fail(&mut stream, e)),
    }
}
/// Serializes authority replacement. Failed candidate handshakes never call it.
#[derive(Default)]
pub struct Live(Mutex<Option<TcpStream>>);
impl Live {
    pub fn replace(&self, candidate: &Authenticated) -> io::Result<()> {
        let duplicate = candidate.0.try_clone()?;
        let mut live = self
            .0
            .lock()
            .map_err(|_| io::Error::other("poisoned link"))?;
        if let Some(mut old) = live.replace(duplicate) {
            let _ = old.set_write_timeout(Some(Duration::from_millis(50)));
            let _ = hello(5, &[conn::field(1, [ProtocolError::Superseded as u8])]).write(&mut old);
            let _ = old.shutdown(Shutdown::Both);
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Backoff(u8);
impl Backoff {
    pub fn delay(&mut self) -> Duration {
        let ms = (250u64 << self.0.min(5)).min(5000);
        self.0 = self.0.saturating_add(1);
        Duration::from_millis(ms)
    }
    pub fn reset(&mut self) {
        self.0 = 0;
    }
}

/// Both transport choices share authentication and dispatch.
pub trait LinkSource: Send {
    fn next(&mut self) -> io::Result<TcpStream>;
}
pub struct RelayListener(pub std::net::TcpListener);
impl LinkSource for RelayListener {
    fn next(&mut self) -> io::Result<TcpStream> {
        self.0.accept().map(|(s, _)| s)
    }
}
pub struct BridgeDialer(pub u16);
impl LinkSource for BridgeDialer {
    fn next(&mut self) -> io::Result<TcpStream> {
        TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], self.0)),
            std::time::Duration::from_secs(5),
        )
    }
}
