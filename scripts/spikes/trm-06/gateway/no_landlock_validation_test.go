package main

import (
	"context"
	"errors"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"testing"
	"time"
)

// Supplemental real SSH boundary: guest refusal is synthetic here. This proves
// the installed campaign demands actual negative request replies, not a broken
// connection that would falsely qualify an unsupported kernel.
func TestNoLandlockSSHRequiresExplicitRequestRefusals(t *testing.T) {
	host, ben := testSigner(t), testSigner(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serveListener(ctx, listener, listenerAuthority{host, ben.PublicKey(), func(*open) (io.ReadWriteCloser, error) {
			return nil, errors.New("synthetic kernel confinement refusal")
		}})
	}()
	defer func() { cancel(); <-done }()
	client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(ben)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = noLandlockSSHRequests(client, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	client.Close()
	if err = noLandlockSSHRequests(client, t.TempDir()); err == nil {
		t.Fatal("closed connection certified kernel refusal")
	}
}

func TestNoLandlockVariantRequiresIndependentUnsupportedKernel(t *testing.T) {
	for _, test := range []struct {
		body string
		pass bool
	}{
		{`{"abi":-1,"errno":38,"kernel":"fixture-no-landlock"}`, true},
		{`{"abi":-1,"errno":95,"kernel":"fixture-disabled-landlock"}`, true},
		{`{"abi":1,"errno":0,"kernel":"fixture-abi1"}`, true},
		{`{"abi":2,"errno":0,"kernel":"fixture-abi2"}`, true},
		{`{"abi":3,"errno":0,"kernel":"fixture-supported"}`, false},
		{`{"abi":6,"errno":0,"kernel":"fixture-supported"}`, false},
		{`{"abi":-1,"errno":1,"kernel":"fixture-denied"}`, false},
		{`{"abi":-1,"errno":13,"kernel":"fixture-denied"}`, false},
		{`{"abi":0,"errno":0,"kernel":"fixture-invalid"}`, false},
		{`{"abi":2,"errno":38,"kernel":"fixture-contradictory"}`, false},
		{`{"errno":38,"kernel":"fixture-missing-abi"}`, false},
		{`{"abi":2,"kernel":"fixture-missing-errno"}`, false},
		{`{"abi":2,"errno":0}`, false},
		{`{`, false},
	} {
		if err := requireUnsupportedLandlock([]byte(test.body)); (err == nil) != test.pass {
			t.Fatalf("%s: %v; want pass=%v", test.body, err, test.pass)
		}
	}
}
