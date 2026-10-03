//! Dark seam for T-COL-03a; no side effect is admitted before its owner lands.
use crate::msg::Error;
pub fn connect() -> Result<(), Error> {
    Err(Error::unsupported())
}

use crate::{
    conn::ProtocolError,
    msg::{Challenge, Digest, HostProof, Id128, MachineHello, PROTOCOL},
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
type Hmac256 = Hmac<Sha256>;
#[derive(Clone, Copy)]
pub enum ProofRole {
    Host,
    Daemon,
}
/// Mutual proof binds both fresh nonces, boot, role and transmission direction.
/// Wire tags: HostProof.nonce=3, MachineHello.mac=5 (3f binding condition 6).
pub fn proof(
    secret: &[u8; 32],
    role: ProofRole,
    boot: &Id128,
    daemon_nonce: &Digest,
    host_nonce: &Digest,
) -> Digest {
    let mut h = Hmac256::new_from_slice(secret).expect("HMAC accepts every key length");
    h.update(match role {
        ProofRole::Host => b"smithers-machined/v1 host->daemon host",
        ProofRole::Daemon => b"smithers-machined/v1 daemon->host daemon",
    });
    h.update(boot);
    h.update(daemon_nonce);
    h.update(host_nonce);
    h.finalize().into_bytes().into()
}
pub fn verify(
    secret: &[u8; 32],
    role: ProofRole,
    boot: &Id128,
    daemon_nonce: &Digest,
    host_nonce: &Digest,
    mac: &Digest,
) -> Result<(), ProtocolError> {
    let mut h = Hmac256::new_from_slice(secret).expect("HMAC accepts every key length");
    h.update(match role {
        ProofRole::Host => b"smithers-machined/v1 host->daemon host",
        ProofRole::Daemon => b"smithers-machined/v1 daemon->host daemon",
    });
    h.update(boot);
    h.update(daemon_nonce);
    h.update(host_nonce);
    h.verify_slice(mac).map_err(|_| ProtocolError::AuthFailed)
}
pub fn nonce() -> Result<Digest, ProtocolError> {
    let mut n = [0; 32];
    getrandom::fill(&mut n).map_err(|_| ProtocolError::AuthFailed)?;
    Ok(n)
}
pub struct DaemonProof {
    secret: [u8; 32],
    challenge: Challenge,
    accepted: Option<Digest>,
    used: bool,
}
impl DaemonProof {
    pub fn new(secret: [u8; 32], boot_id: Id128) -> Result<Self, ProtocolError> {
        Ok(Self::with_nonce(secret, boot_id, nonce()?))
    }
    pub fn with_nonce(secret: [u8; 32], boot_id: Id128, nonce: Digest) -> Self {
        Self {
            secret,
            challenge: Challenge {
                magic: 0x534d4d44,
                protocol: PROTOCOL,
                boot_id,
                nonce,
            },
            accepted: None,
            used: false,
        }
    }
    pub fn challenge(&self) -> Challenge {
        self.challenge.clone()
    }
    pub fn accept(&mut self, p: &HostProof) -> Result<(), ProtocolError> {
        if self.used {
            return Err(ProtocolError::HandshakeOrder);
        }
        self.used = true;
        if p.protocol != PROTOCOL {
            return Err(ProtocolError::VersionMismatch);
        }
        verify(
            &self.secret,
            ProofRole::Host,
            &self.challenge.boot_id,
            &self.challenge.nonce,
            &p.nonce,
            &p.mac,
        )?;
        self.accepted = Some(p.nonce);
        Ok(())
    }
    pub fn machine(
        &self,
        credential: Vec<u8>,
        instance: Id128,
        next_seq: u64,
        sessions: Vec<u32>,
    ) -> Result<MachineHello, ProtocolError> {
        let host = self.accepted.ok_or(ProtocolError::HandshakeOrder)?;
        if credential.len() > 1024 || sessions.len() > 512 {
            return Err(ProtocolError::BadValue);
        }
        Ok(MachineHello {
            credential: crate::conn::Bytes(credential),
            instance,
            next_seq,
            sessions,
            mac: proof(
                &self.secret,
                ProofRole::Daemon,
                &self.challenge.boot_id,
                &self.challenge.nonce,
                &host,
            ),
        })
    }
}

/// Transport is the only topology-dependent seam (ADR 0004).
pub trait LinkSource: Send {
    fn next(
        &mut self,
    ) -> impl std::future::Future<Output = std::io::Result<tokio::net::TcpStream>> + Send;
}
pub struct RelayListener {
    pub listener: tokio::net::TcpListener,
}
pub struct BridgeDialer {
    pub port: u16,
}
impl LinkSource for RelayListener {
    async fn next(&mut self) -> std::io::Result<tokio::net::TcpStream> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "unsupported",
        ))
    }
}
impl LinkSource for BridgeDialer {
    async fn next(&mut self) -> std::io::Result<tokio::net::TcpStream> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "unsupported",
        ))
    }
}
