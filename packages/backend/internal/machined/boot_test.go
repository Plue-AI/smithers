package machined

import (
	"encoding/hex"
	"strings"
	"testing"
)

func TestMintBootRotationAndFileCredential(t *testing.T) {
	var r Registry
	a, err := r.MintBoot("A", "machine-A")
	expectError(t, err, nil)
	contents, err := a.BootFile("relay", 0)
	expectError(t, err, nil)
	fields := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(contents)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatal("invalid boot file line")
		}
		fields[key] = value
	}
	if len(fields) != 4 || fields["topology"] != "relay" || len(fields["boot_id"]) != 32 || len(fields["relay_secret"]) != 64 || len(fields["credential"]) != 64 {
		t.Fatal("boot file does not satisfy ADR 0004")
	}
	stream := new(testStream)
	c, err := r.Admit(a.ID, []byte(fields["credential"]), stream)
	expectError(t, err, nil)
	expectError(t, c.RequireReady("A"), ErrNotReady)
	b, err := r.MintBoot("A", "machine-A")
	expectError(t, err, nil)
	if a.ID == b.ID || a.RelaySecret == b.RelaySecret || a.Credential == b.Credential || stream.closed.Load() != 1 {
		t.Fatal("rotation reused authority or retained old stream")
	}
	_, err = r.HostProof(a.ID, [32]byte{1})
	expectError(t, err, ErrUnauthorized)
	_, err = r.Admit(a.ID, []byte(fields["credential"]), new(testStream))
	expectError(t, err, ErrUnauthorized)
	_, err = r.Admit(b.ID, []byte(fields["credential"]), new(testStream))
	expectError(t, err, ErrUnauthorized)
	_, err = r.HostProof(b.ID, [32]byte{1})
	expectError(t, err, nil)
	bridge, err := b.BootFile("bridge", 49200)
	expectError(t, err, nil)
	if !strings.HasSuffix(string(bridge), "topology=bridge\nbridge_port=49200\n") {
		t.Fatal("missing bridge port")
	}
}

func TestHostProofIndependentVector(t *testing.T) {
	var r Registry
	var id [16]byte
	var secret, nonce [32]byte
	for i := range id {
		id[i] = byte(i)
	}
	for i := range secret {
		secret[i], nonce[i] = byte(i), byte(i+32)
	}
	expectError(t, r.bindBoot("A", "M", id, []byte("credential"), secret), nil)
	proof, err := r.HostProof(id, nonce)
	expectError(t, err, nil)
	// Independently generated with Python hmac/hashlib, fixed ADR domain.
	if hex.EncodeToString(proof[:]) != "cb2e664494fb7c6cfb71c0ce7e439d918ff94c812e5dd99fd860628686887fba" {
		t.Fatal("wrong nonce HMAC")
	}
	nonce[0] ^= 1
	changed, err := r.HostProof(id, nonce)
	expectError(t, err, nil)
	if changed == proof {
		t.Fatal("nonce is not bound to proof")
	}
	_, err = r.HostProof([16]byte{99}, nonce)
	expectError(t, err, ErrUnauthorized)
	var unminted Registry
	expectError(t, unminted.BindBoot("A", "M", id, []byte("credential")), nil)
	_, err = unminted.HostProof(id, nonce)
	expectError(t, err, ErrUnauthorized)
}

func TestBootConfigurationRefusals(t *testing.T) {
	var r Registry
	for _, binding := range [][2]string{{"", "M"}, {"A", ""}} {
		_, err := r.MintBoot(binding[0], binding[1])
		expectError(t, err, ErrUnauthorized)
	}
	if len(r.boots) != 0 {
		t.Fatal("invalid mint mutated registry")
	}
	b, err := r.MintBoot("A", "M")
	expectError(t, err, nil)
	for _, tc := range []struct {
		topology string
		port     uint16
	}{{"", 0}, {"relay\ncredential=x", 0}, {"bridge", 0}, {"relay", 970}} {
		if file, err := b.BootFile(tc.topology, tc.port); err == nil || file != nil {
			t.Fatal("invalid topology emitted secrets")
		}
	}
	for _, invalid := range []BootSecrets{{}, {ID: b.ID}, {ID: b.ID, RelaySecret: b.RelaySecret}, {ID: b.ID, Credential: b.Credential}} {
		if file, err := invalid.BootFile("relay", 0); err == nil || file != nil {
			t.Fatal("incomplete boot emitted secrets")
		}
	}
}
