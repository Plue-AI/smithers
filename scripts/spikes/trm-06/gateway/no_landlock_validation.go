package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// This check requires a real unsupported kernel. A supported kernel, malformed
// sample or a permission error is not evidence of the no-Landlock variant.
func requireUnsupportedLandlock(body []byte) error {
	var sample struct {
		ABI     *int            `json:"abi"`
		Errno   *int            `json:"errno"`
		Kernel  string          `json:"kernel"`
		Outside json.RawMessage `json:"outside"`
	}
	if json.Unmarshal(body, &sample) != nil || sample.ABI == nil || sample.Errno == nil || sample.Kernel == "" {
		return errors.New("independent Landlock kernel observation unavailable")
	}
	if (*sample.ABI == 1 || *sample.ABI == 2) && *sample.Errno == 0 {
		return nil
	}
	if *sample.ABI == -1 && (*sample.Errno == 38 || *sample.Errno == 95) {
		return nil
	}
	return errors.New("no-Landlock campaign requires an approved kernel with ABI below 3 or ENOSYS/EOPNOTSUPP")
}

// Same installed listener/SSH mapper and authenticated DialWorkspacePort relay
// as the positive campaign. No kernel switch, seccomp shim, alternate image or
// caller-provided executable is accepted. The owner supplies an approved bundle
// containing the unsupported kernel through the ordinary release path.
func validateNoLandlockBoundary(ctx context.Context, control relayControl, observe func(string) ([]byte, error), before []byte, evidence string) error {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	host, err := ssh.NewSignerFromKey(private)
	if err != nil {
		return err
	}
	_, private, err = ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	ben, err := ssh.NewSignerFromKey(private)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	serving, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- serveListener(serving, listener, listenerAuthority{host, ben.PublicKey(), control.opener(serving)})
	}()
	defer func() { cancel(); <-done }()
	socket, err := net.DialTimeout("tcp", listener.Addr().String(), 5*time.Second)
	if err != nil {
		return err
	}
	defer socket.Close()
	if err = socket.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return err
	}
	connection, channels, requests, err := ssh.NewClientConn(socket, listener.Addr().String(), &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(ben)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: 5 * time.Second})
	if err != nil {
		return err
	}
	client := ssh.NewClient(connection, channels, requests)
	defer client.Close()
	if err = noLandlockSSHRequests(client, evidence); err != nil {
		return err
	}
	// Preserve the authenticated broker's explicit typed refusal too. A closed
	// transport alone cannot prove the kernel confinement rejection.
	stream, err := control.connect(ctx)
	if err != nil {
		return err
	}
	request := []byte(`{"type":"open_session","kind":"exec","argv":["/bin/sh","-c","printf canary > /workspace/trm06-member-canary"]}`)
	refusal, err := validationRefusal(stream, request, uint32(len(request)))
	stream.Close()
	if err != nil {
		return err
	}
	if bytes.Equal(refusal, []byte(`{"transport_closed":true}`)) {
		return errors.New("unsupported kernel lacked explicit broker refusal")
	}
	if err = os.WriteFile(filepath.Join(evidence, "no-landlock-refusal.json"), refusal, 0600); err != nil {
		return err
	}
	after, err := observe("boundary-sample")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "no-landlock-after.json"), after, 0600); err != nil {
		return err
	}
	var state struct {
		Canary *bool `json:"member_canary_exists"`
		Sample struct {
			Processes *[]json.RawMessage `json:"processes"`
		} `json:"sample"`
	}
	if json.Unmarshal(after, &state) != nil || state.Canary == nil || *state.Canary || state.Sample.Processes == nil || len(*state.Sample.Processes) != 0 {
		return errors.New("unsupported kernel used payload or left member processes")
	}
	return compareOutside(before, after)
}

// Exact SSH negative replies are required for all four session kinds;
// EOF/timeouts are not acceptance.
func noLandlockSSHRequests(client *ssh.Client, evidence string) error {
	// A fully valid member command must fail before payload use. Deadline failure
	// is not refusal; the SSH peer must return an unsuccessful completion.
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	completed := make(chan error, 1)
	go func() { completed <- session.Start("printf canary > /workspace/trm06-member-canary") }()
	select {
	case err = <-completed:
	case <-time.After(5 * time.Second):
		session.Close()
		return errors.New("unsupported kernel exec did not refuse")
	}
	session.Close()
	if err == nil || err.Error() != "ssh: command printf canary > /workspace/trm06-member-canary failed" {
		return errors.New("unsupported kernel lacked explicit SSH exec refusal")
	}
	files, err := sftp.NewClient(client)
	if err == nil {
		files.Close()
		return errors.New("unsupported kernel admitted SFTP")
	}
	if err.Error() != "ssh: subsystem request failed" {
		return errors.New("unsupported kernel lacked explicit SFTP refusal")
	}
	// A valid PTY request may be acknowledged before spawn. The subsequent
	// shell request must explicitly refuse, rather than start a member shell.
	session, err = client.NewSession()
	if err != nil {
		return err
	}
	if err = session.RequestPty("xterm", 24, 80, ssh.TerminalModes{}); err != nil {
		session.Close()
		return errors.New("unsupported kernel PTY fixture was rejected before spawn")
	}
	err = session.Shell()
	session.Close()
	if err == nil || err.Error() != "ssh: could not start shell" {
		return errors.New("unsupported kernel lacked explicit PTY shell refusal")
	}
	// A literal valid loopback target distinguishes confinement refusal from
	// the gateway's invalid-target policy. No TCP worker may start either.
	forwarded, err := client.Dial("tcp", "127.0.0.1:3000")
	if forwarded != nil {
		forwarded.Close()
	}
	var channelError *ssh.OpenChannelError
	if !errors.As(err, &channelError) || channelError.Reason != ssh.ConnectionFailed || channelError.Message != "guest unavailable" {
		return errors.New("unsupported kernel lacked explicit TCP worker refusal")
	}
	if err = os.WriteFile(filepath.Join(evidence, "no-landlock-ssh.json"), []byte(`{"exec_request_accepted":false,"sftp_request_accepted":false,"pty_shell_request_accepted":false,"tcp_channel_accepted":false}`), 0600); err != nil {
		return err
	}

	return nil
}
