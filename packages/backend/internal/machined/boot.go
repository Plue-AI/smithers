package machined

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// BootSecrets are host-generated authority, never repository input. They must
// not be logged or included in a person-facing response. Planting owns the
// protected directory, machined ownership and mode 0400 of the resulting file.
type BootSecrets struct {
	ID          [16]byte
	RelaySecret [32]byte
	Credential  [32]byte
}

// MintBoot rotates the branch authority before a runtime plants a new boot.
// Entropy failure leaves the old binding intact.
func (r *Registry) MintBoot(branch, machine string) (BootSecrets, error) {
	var b BootSecrets
	if branch == "" || machine == "" {
		return b, ErrUnauthorized
	}
	if _, err := rand.Read(b.ID[:]); err != nil {
		return BootSecrets{}, err
	}
	if _, err := rand.Read(b.RelaySecret[:]); err != nil {
		return BootSecrets{}, err
	}
	if _, err := rand.Read(b.Credential[:]); err != nil {
		return BootSecrets{}, err
	}
	if err := r.bindBoot(branch, machine, b.ID, []byte(hex.EncodeToString(b.Credential[:])), b.RelaySecret); err != nil {
		return BootSecrets{}, err
	}
	return b, nil
}

// BootFile emits ADR 0004's configuration only; it is not a frame codec.
// A fixed hex alphabet prevents a credential from injecting another key.
func (b BootSecrets) BootFile(topology string, bridgePort uint16) ([]byte, error) {
	if b.ID == ([16]byte{}) || b.RelaySecret == ([32]byte{}) || b.Credential == ([32]byte{}) {
		return nil, ErrUnauthorized
	}
	if topology != "relay" && topology != "bridge" || topology == "bridge" && bridgePort == 0 || topology == "relay" && bridgePort != 0 {
		return nil, fmt.Errorf("invalid machined topology")
	}
	file := fmt.Sprintf("boot_id=%x\nrelay_secret=%x\ncredential=%s\ntopology=%s\n", b.ID, b.RelaySecret, hex.EncodeToString(b.Credential[:]), topology)
	if topology == "bridge" {
		file += fmt.Sprintf("bridge_port=%d\n", bridgePort)
	}
	return []byte(file), nil
}

// HostProof supplies only the nonce HMAC to the shared wire codec. An unknown
// or revoked boot cannot solicit a proof; relay-secret bytes never leave here.
func (r *Registry) HostProof(id [16]byte, nonce [32]byte) ([32]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b := r.boots[id]
	if b == nil || r.branches[b.branch] != b || b.relaySecret == ([32]byte{}) {
		return [32]byte{}, ErrUnauthorized
	}
	mac := hmac.New(sha256.New, b.relaySecret[:])
	_, _ = mac.Write([]byte("smithers-machined/v1 host"))
	_, _ = mac.Write(id[:])
	_, _ = mac.Write(nonce[:])
	var proof [32]byte
	copy(proof[:], mac.Sum(nil))
	return proof, nil
}
