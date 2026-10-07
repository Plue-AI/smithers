package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func testSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}
func TestListenerAuthenticationAndShutdown(t *testing.T) {
	host, ben, stranger := testSigner(t), testSigner(t), testSigner(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- serveListener(ctx, listener, listenerAuthority{host, ben.PublicKey(), func(*open) (io.ReadWriteCloser, error) { return nil, errors.New("synthetic guest unavailable") }})
	}()
	dial := func(user string, signer ssh.Signer) (*ssh.Client, error) {
		return ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: user, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: time.Second})
	}
	for _, candidate := range []struct {
		user   string
		signer ssh.Signer
	}{{"root", ben}, {"agent", ben}, {"ben", stranger}} {
		client, err := dial(candidate.user, candidate.signer)
		if err == nil {
			client.Close()
			t.Fatalf("accepted %s", candidate.user)
		}
	}
	client, err := dial("ben", ben)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if accepted, _, err := client.SendRequest("tcpip-forward", true, ssh.Marshal(struct {
		Host string
		Port uint32
	}{"127.0.0.1", 1234})); err != nil || accepted {
		t.Fatalf("remote forwarding: accepted=%v err=%v", accepted, err)
	}
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Run("exit 7"); err == nil {
		t.Fatal("missing guest accepted")
	}
	session.Close()
	// A stalled, unauthenticated handshake is also owned and canceled.
	stalled, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close()
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("listener shutdown blocked")
	}
}
func TestListenerRequiresAuthorityBeforeAccept(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := serveListener(context.Background(), listener, listenerAuthority{}); !errors.Is(err, errAuthority) {
		t.Fatal(err)
	}
}
