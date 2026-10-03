//! 3f condition 6: fresh mutual proofs resist replay, reflection and wrong secrets.
use smithers_machined::{conn::ProtocolError, link::*, msg::*};
fn host(secret: &[u8; 32], boot: &Id128, d: &Digest, h: &Digest) -> HostProof {
    HostProof {
        protocol: PROTOCOL,
        nonce: *h,
        mac: proof(secret, ProofRole::Host, boot, d, h),
    }
}
#[test]
fn mutual_proof_replay_reflection_wrong_secret() {
    let (secret, boot, d, h) = ([7; 32], [1; 16], [2; 32], [3; 32]);
    let p = host(&secret, &boot, &d, &h);
    let mut daemon = DaemonProof::with_nonce(secret, boot, d);
    assert_eq!(
        daemon.machine(vec![1], [0; 16], 1, vec![]),
        Err(ProtocolError::HandshakeOrder)
    );
    daemon.accept(&p).unwrap();
    let m = daemon.machine(vec![1], [0; 16], 7, vec![1]).unwrap();
    verify(&secret, ProofRole::Daemon, &boot, &d, &h, &m.mac).unwrap();
    assert_eq!(daemon.accept(&p), Err(ProtocolError::HandshakeOrder));
    assert_eq!(
        DaemonProof::with_nonce(secret, boot, [4; 32]).accept(&p),
        Err(ProtocolError::AuthFailed)
    );
    assert_eq!(
        DaemonProof::with_nonce(secret, [5; 16], d).accept(&p),
        Err(ProtocolError::AuthFailed)
    );
    assert_eq!(
        DaemonProof::with_nonce([9; 32], boot, d).accept(&p),
        Err(ProtocolError::AuthFailed)
    );
    assert_eq!(
        verify(&secret, ProofRole::Daemon, &boot, &d, &h, &p.mac),
        Err(ProtocolError::AuthFailed)
    );
    assert_eq!(
        verify(&secret, ProofRole::Host, &boot, &d, &h, &m.mac),
        Err(ProtocolError::AuthFailed)
    );
    assert_eq!(
        verify(&secret, ProofRole::Daemon, &boot, &d, &[6; 32], &m.mac),
        Err(ProtocolError::AuthFailed)
    );
}
#[test]
fn generated_nonces_are_fresh() {
    assert_ne!(nonce().unwrap(), nonce().unwrap());
}
