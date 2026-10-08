package main

import (
	"context"
	"errors"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

// Supplemental real SSH boundary: guest refusal is synthetic here. This proves
// the installed campaign demands actual negative request replies, not a broken
// connection that would falsely qualify an unsupported kernel.
func TestNoLandlockSSHRequiresExplicitRequestRefusals(t *testing.T) {
	host, ben := testSigner(t), testSigner(t)
	var mu sync.Mutex
	var kinds []string
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serveListener(ctx, listener, listenerAuthority{host, ben.PublicKey(), func(spec *open) (io.ReadWriteCloser, error) {
			mu.Lock()
			kinds = append(kinds, spec.Kind)
			mu.Unlock()
			return nil, errors.New("synthetic kernel confinement refusal")
		}})
	}()
	defer func() { cancel(); <-done }()
	client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(ben)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	evidence := t.TempDir()
	if err = noLandlockSSHRequests(client, evidence); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	observed := append([]string(nil), kinds...)
	mu.Unlock()
	if !reflect.DeepEqual(observed, []string{"exec", "sftp", "pty", "tcp"}) {
		t.Fatalf("kernel refusals did not cover all session kinds: %v", observed)
	}
	body, err := os.ReadFile(filepath.Join(evidence, "no-landlock-ssh.json"))
	if err != nil || string(body) != `{"exec_request_accepted":false,"sftp_request_accepted":false,"pty_shell_request_accepted":false,"tcp_channel_accepted":false}` {
		t.Fatalf("incomplete SSH evidence: %s, %v", body, err)
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

// A missing guard in any one spawn path must prevent certification even if
// every other kind refuses. The SSH gateway is real; this is not a native
// unsupported-kernel receipt.
func TestNoLandlockSSHRejectsAnyAdmittedKind(t *testing.T) {
	for _, admitted := range []string{"exec", "sftp", "pty", "tcp"} {
		t.Run(admitted, func(t *testing.T) {
			host, ben := testSigner(t), testSigner(t)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan error, 1)
			go func() {
				done <- serveListener(ctx, listener, listenerAuthority{host, ben.PublicKey(), func(spec *open) (io.ReadWriteCloser, error) {
					if spec.Kind != admitted {
						return nil, errors.New("synthetic confinement refusal")
					}
					member, peer := net.Pipe()
					peer.Close()
					return member, nil
				}})
			}()
			defer func() { cancel(); <-done }()
			socket, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer socket.Close()
			socket.SetDeadline(time.Now().Add(5 * time.Second))
			conn, channels, requests, err := ssh.NewClientConn(socket, listener.Addr().String(), &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(ben)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey())})
			if err != nil {
				t.Fatal(err)
			}
			client := ssh.NewClient(conn, channels, requests)
			defer client.Close()
			evidence := t.TempDir()
			if err := noLandlockSSHRequests(client, evidence); err == nil {
				t.Fatal("admitted session certified unsupported kernel")
			}
			if _, err := os.Stat(filepath.Join(evidence, "no-landlock-ssh.json")); !os.IsNotExist(err) {
				t.Fatalf("failure published passing evidence: %v", err)
			}
		})
	}
}
