package main

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestGatewayRevocationClosesSSHBeforeDrainAndReportsRealFailure(t *testing.T) {
	for _, failure := range []error{nil, errors.New("guest cgroup still populated")} {
		t.Run(map[bool]string{true: "failure", false: "success"}[failure != nil], func(t *testing.T) {
			host, ben := testSigner(t), testSigner(t)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			address := listener.Addr().String()
			requests := make(chan revocationRequest, 1)
			completed := make(chan error, 1)
			closed := make(chan error, 1)
			revokeStarted := make(chan struct{})
			finishDrain := make(chan struct{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go func() {
				completed <- serveGateway(ctx, listener,
					func(context.Context) listenerAuthority {
						return listenerAuthority{host, ben.PublicKey(), func(*open) (io.ReadWriteCloser, error) { return nil, errors.New("synthetic guest") }}
					},
					func(ctx context.Context) error {
						deadline, ok := ctx.Deadline()
						if !ok || time.Until(deadline) > 5*time.Second {
							return errors.New("missing five second deadline")
						}
						close(revokeStarted)
						<-finishDrain
						return failure
					}, requests)
			}()
			client, err := ssh.Dial("tcp", address, &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(ben)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			go func() { closed <- client.Wait() }()
			receipt := make(chan error, 1)
			requests <- revocationRequest{receipt}
			select {
			case <-revokeStarted:
			case <-time.After(2 * time.Second):
				t.Fatal("drain did not start")
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("SSH survived admission stop")
			}
			if conn, err := net.DialTimeout("tcp", address, time.Second); err == nil {
				conn.Close()
				t.Fatal("new admission after revoke")
			}
			select {
			case <-receipt:
				t.Fatal("receipt before guest drain")
			default:
			}
			close(finishDrain)
			select {
			case err := <-receipt:
				if !errors.Is(err, failure) {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("no drain receipt")
			}
			select {
			case err := <-completed:
				if !errors.Is(err, failure) {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("gateway stuck")
			}
		})
	}
}

func TestGatewayRefusesMissingRevocationAuthorityBeforeListening(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := serveGateway(context.Background(), listener, nil, nil, nil); err != errAuthority {
		t.Fatal(err)
	}
	if conn, err := net.DialTimeout("tcp", address, time.Second); err == nil {
		conn.Close()
		t.Fatal("refused listener left open")
	}
}

func TestRevocationCancelsPendingSSHSessionOpenBeforeGuestDrain(t *testing.T) {
	host, ben := testSigner(t), testSigner(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := make(chan revocationRequest, 1)
	completed := make(chan error, 1)
	opened := make(chan struct{})
	canceledOpen := make(chan struct{})
	go func() {
		completed <- serveGateway(ctx, listener, func(serving context.Context) listenerAuthority {
			return listenerAuthority{host, ben.PublicKey(), func(*open) (io.ReadWriteCloser, error) {
				close(opened)
				<-serving.Done()
				close(canceledOpen)
				return nil, serving.Err()
			}}
		}, func(context.Context) error {
			select {
			case <-canceledOpen:
				return nil
			default:
				return errors.New("drained before pending open stopped")
			}
		}, requests)
	}()
	client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(ben)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	started := make(chan error, 1)
	go func() { started <- session.Start("sleep 60") }()
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("SSH did not reach opener")
	}
	requests <- revocationRequest{nil} // lost caller must not stall shutdown
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending open stalled drain")
	}
	select {
	case err := <-started:
		if err == nil {
			t.Fatal("canceled session admitted")
		}
	case <-time.After(time.Second):
		t.Fatal("SSH request stuck")
	}
}
