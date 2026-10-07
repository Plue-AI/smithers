package ssh

import (
	"context"
	"encoding/binary"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"io"
	"strconv"
	"time"

	gliderssh "github.com/gliderlabs/ssh"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// DaemonStream is the bounded, credit-controlled stream of the authenticated
// daemon transport. It never opens a guest SSH hop or a host process.
const daemonExitSignalSent = -1

type DaemonStream interface {
	Send(context.Context, []byte) error
	Receive(context.Context) ([]byte, error)
}
type DaemonClient interface {
	OpenSession(context.Context, machined.SessionUser, machined.SessionKind, []string, *machined.SessionSize) (uint32, error)
	CloseSession(context.Context, uint32) error
	TCPConnect(context.Context, uint16) (uint32, error)
	Stream(context.Context, uint32) (DaemonStream, error)
}

type daemonClient struct {
	*machined.Sessions
	stream func(context.Context, uint32) (DaemonStream, error)
}

func (c daemonClient) Stream(ctx context.Context, id uint32) (DaemonStream, error) {
	if c.Sessions == nil || c.stream == nil {
		return nil, ErrWorkspaceUnavailable
	}
	return c.stream(ctx, id)
}

// NewDaemonClient binds controls and streams from the same authenticated,
// boot-fenced transport. The stream provider is unavailable until T-TRM-07
// supplies its production implementation; no host or private SSH fallback.
func NewDaemonClient(s *machined.Sessions, stream func(context.Context, uint32) (DaemonStream, error)) DaemonClient {
	return daemonClient{Sessions: s, stream: stream}
}

// DaemonBridge requires every authority before authentication succeeds. Ready
// is read-only; Admit waits as a person, reconciles the wake and returns the
// boot-bound transport. Track holds safe-idle and reports the SSH actor/session
// and broker cgroup until its release. ID zero reserves tracking before wake;
// a nonzero ID publishes the broker session. Missing providers never wake a machine.
// The install composes these only after member provisioning is available.
type DaemonBridge struct {
	Ready func(context.Context, WorkspaceAccess) error
	Admit func(context.Context, WorkspaceAccess, microsandbox.AdmissionRequest, io.Writer) (DaemonClient, func(), error)
	Track func(context.Context, WorkspaceAccess, uint32) (func(), error)
}

func (b *DaemonBridge) Validate(ctx context.Context, a WorkspaceAccess) error {
	if b == nil || b.Ready == nil || b.Admit == nil || b.Track == nil {
		return ErrWorkspaceUnavailable
	}
	if !validMemberLogin(a.User) || a.UID < 20000 || a.MemberID <= 0 || a.SandboxID == "" || a.Token != "" {
		return ErrWorkspaceAccessDenied
	}
	return b.Ready(ctx, a)
}

func (b *DaemonBridge) Serve(sess gliderssh.Session, a WorkspaceAccess) (int, error) {
	ctx, cancel := context.WithCancel(sess.Context())
	defer cancel()
	if err := b.Validate(ctx, a); err != nil {
		return 1, err
	}
	kind := machined.SessionPTY
	var argv []string
	var size *machined.SessionSize
	pty, windows, hasPTY := sess.Pty()
	if sess.Subsystem() != "" {
		if sess.Subsystem() != "sftp" || hasPTY || sess.RawCommand() != "" {
			return 1, ErrWorkspaceAccessDenied
		}
		kind = machined.SessionSFTP
	} else if command := sess.RawCommand(); command != "" {
		kind = machined.SessionExec
		// The broker owns this trusted absolute shell and drops identity before
		// applying command text. Parsing into argv would lose shell semantics.
		argv = []string{"/bin/sh", "-c", command}
		if hasPTY {
			kind = machined.SessionPTY
		}
	}
	if hasPTY {
		if pty.Window.Width < 1 || pty.Window.Width > 65535 || pty.Window.Height < 1 || pty.Window.Height > 65535 {
			return 1, ErrWorkspaceAccessDenied
		}
		size = &machined.SessionSize{Cols: uint16(pty.Window.Width), Rows: uint16(pty.Window.Height)}
	}
	reserved, err := b.Track(ctx, a, 0)
	if err != nil {
		return 1, err
	}
	if reserved == nil {
		return 1, ErrWorkspaceUnavailable
	}
	defer reserved()
	client, release, err := b.Admit(ctx, a, daemonAdmission(a), sess.Stderr())
	if err != nil {
		return 1, err
	}
	if release != nil {
		defer release()
	}
	if client == nil {
		return 1, ErrWorkspaceUnavailable
	}
	// Re-check membership after a queued wake, before any process starts.
	if err = b.Validate(ctx, a); err != nil {
		return 1, err
	}
	id, err := client.OpenSession(ctx, machined.SessionUser{Login: a.User, UID: a.UID}, kind, argv, size)
	if err != nil {
		return 1, err
	}
	defer func() {
		closeCtx, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		_ = client.CloseSession(closeCtx, id)
	}()
	untrack, err := b.Track(ctx, a, id)
	if err != nil {
		return 1, err
	}
	if untrack == nil {
		return 1, ErrWorkspaceUnavailable
	}
	defer untrack()
	stream, err := client.Stream(ctx, id)
	if err != nil {
		return 1, err
	}
	signals := make(chan gliderssh.Signal, 16)
	sess.Signals(signals)
	defer sess.Signals(nil)
	errs := make(chan error, 2)
	fail := func(err error) {
		select {
		case errs <- err:
		default:
		}
		cancel()
	}
	go func() {
		buffer := make([]byte, 32768)
		for {
			n, e := sess.Read(buffer)
			if n > 0 {
				if err := stream.Send(ctx, append([]byte{1, 0}, buffer[:n]...)); err != nil {
					fail(err)
					return
				}
			}
			if e != nil {
				if e == io.EOF {
					e = stream.Send(ctx, []byte{2, 0})
				}
				if e != nil {
					fail(e)
				}
				return
			}
		}
	}()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case window, ok := <-windows:
				if !ok {
					windows = nil
					continue
				}
				if window.Width < 1 || window.Width > 65535 || window.Height < 1 || window.Height > 65535 {
					fail(ErrWorkspaceAccessDenied)
					return
				}
				payload := []byte{3, 0, 0, 0, 0}
				binary.BigEndian.PutUint16(payload[1:3], uint16(window.Width))
				binary.BigEndian.PutUint16(payload[3:], uint16(window.Height))
				if err := stream.Send(ctx, payload); err != nil {
					fail(err)
					return
				}
			case signal := <-signals:
				number := daemonSignal(signal)
				if number == 0 {
					continue
				}
				if err := stream.Send(ctx, []byte{4, number}); err != nil {
					fail(err)
					return
				}
			}
		}
	}()
	for {
		select {
		case err := <-errs:
			return 1, err
		default:
		}
		payload, err := stream.Receive(ctx)
		if err != nil {
			return 1, err
		}
		if len(payload) == 0 {
			return 1, ErrWorkspaceUnavailable
		}
		switch payload[0] {
		case 1:
			if len(payload) < 2 || (payload[1] != 1 && payload[1] != 2) {
				return 1, ErrWorkspaceUnavailable
			}
			out := io.Writer(sess)
			if payload[1] == 2 {
				out = sess.Stderr()
			}
			n, err := out.Write(payload[2:])
			if err != nil {
				return 1, err
			}
			if n != len(payload)-2 {
				return 1, io.ErrShortWrite
			}
			if n > 0 {
				credit := []byte{6, 0, 0, 0, 0}
				binary.BigEndian.PutUint32(credit[1:], uint32(n))
				if err = stream.Send(ctx, credit); err != nil {
					return 1, err
				}
			}
		case 2:
			if len(payload) != 2 {
				return 1, ErrWorkspaceUnavailable
			}
			if payload[1] == 1 {
				if err := sess.CloseWrite(); err != nil {
					return 1, err
				}
			}
		case 5:
			if len(payload) == 6 && payload[1] == 0 {
				return int(binary.BigEndian.Uint32(payload[2:])), nil
			}
			if len(payload) == 4 && payload[1] == 1 && payload[2] >= 1 && payload[2] <= 7 && payload[3] <= 1 {
				signal := string(daemonSignalName(payload[2]))
				_, err = sess.SendRequest("exit-signal", false, marshalExitSignal(signal, payload[3] == 1))
				return daemonExitSignalSent, err
			}
			return 1, ErrWorkspaceUnavailable
		case 6:
			if len(payload) != 5 {
				return 1, ErrWorkspaceUnavailable
			}
		case 7:
			return 1, io.ErrUnexpectedEOF
		default:
			return 1, fmt.Errorf("unsupported daemon session message")
		}
	}
}
func daemonSignal(s gliderssh.Signal) byte {
	for i, name := range []gliderssh.Signal{gliderssh.SIGINT, gliderssh.SIGTERM, gliderssh.SIGHUP, gliderssh.SIGKILL, gliderssh.SIGQUIT, gliderssh.SIGUSR1, gliderssh.SIGUSR2} {
		if s == name {
			return byte(i + 1)
		}
	}
	return 0
}
func daemonSignalName(n byte) gliderssh.Signal {
	return []gliderssh.Signal{"", gliderssh.SIGINT, gliderssh.SIGTERM, gliderssh.SIGHUP, gliderssh.SIGKILL, gliderssh.SIGQUIT, gliderssh.SIGUSR1, gliderssh.SIGUSR2}[n]
}
func marshalExitSignal(signal string, core bool) []byte {
	payload := make([]byte, 4+len(signal)+1+4+4)
	binary.BigEndian.PutUint32(payload, uint32(len(signal)))
	copy(payload[4:], signal)
	if core {
		payload[4+len(signal)] = 1
	}
	return payload
}

func daemonAdmission(a WorkspaceAccess) microsandbox.AdmissionRequest {
	return microsandbox.AdmissionRequest{Class: "person", Holder: "workspace:" + a.SandboxID, Actor: "person:" + strconv.FormatInt(a.MemberID, 10), Reason: "ssh"}
}
