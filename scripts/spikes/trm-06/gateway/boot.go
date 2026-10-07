package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
	"net"
	"time"
)

// This disposable handshake keeps the ADR host-proof domain. The additional
// guest proof binds a fresh host nonce so an unauthenticated relay cannot replay
// an old guest response. Installed state supplies both fixed boot and secret.
type bootIdentity struct {
	Boot   [16]byte
	Secret [32]byte
}

func (b bootIdentity) authenticate(ctx context.Context, stream net.Conn) error {
	if b.Boot == ([16]byte{}) || b.Secret == ([32]byte{}) {
		return errAuthority
	}
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := stream.SetDeadline(deadline); err != nil {
		return err
	}
	stop := context.AfterFunc(ctx, func() { stream.Close() })
	defer stop()
	success := false
	defer func() {
		if !success {
			stream.Close()
		}
	}()
	var challenge [54]byte
	if _, err := io.ReadFull(stream, challenge[:]); err != nil {
		return err
	}
	if !bytes.Equal(challenge[:6], []byte("TRM06\x01")) || !bytes.Equal(challenge[6:22], b.Boot[:]) {
		return errors.New("boot identity refused")
	}
	var response [64]byte
	if _, err := rand.Read(response[:32]); err != nil {
		return err
	}
	mac := hmac.New(sha256.New, b.Secret[:])
	mac.Write([]byte("smithers-machined/v1 host"))
	mac.Write(b.Boot[:])
	mac.Write(challenge[22:])
	copy(response[32:], mac.Sum(nil))
	if err := writeAll(stream, response[:]); err != nil {
		return err
	}
	var proof [32]byte
	if _, err := io.ReadFull(stream, proof[:]); err != nil {
		return err
	}
	mac = hmac.New(sha256.New, b.Secret[:])
	mac.Write([]byte("smithers-trm06/v1 guest"))
	mac.Write(b.Boot[:])
	mac.Write(challenge[22:])
	mac.Write(response[:32])
	if !hmac.Equal(proof[:], mac.Sum(nil)) {
		return errors.New("guest authentication refused")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := stream.SetDeadline(time.Time{}); err != nil {
		return err
	}
	success = true
	return nil
}
func writeAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
