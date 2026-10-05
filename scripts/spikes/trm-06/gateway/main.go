// Disposable SSH-to-session protocol probe. Existing terminal viewers do not
// map SSH channel requests to guest session lifetimes. No product registration.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspace "github.com/smithersai/smithers/packages/backend/workspace"
	"golang.org/x/crypto/ssh"
)

var errAuthority = errors.New("prototype_authority_unavailable: main-pinned installed provider required")

func main() {
	fmt.Fprintln(os.Stderr, errAuthority)
	os.Exit(78)
}

// Only the installed authority provider may supply a fresh workspace/runtime.
// There is deliberately no direct TCP dial or host process fallback.
func relay(ctx context.Context, runtime *microsandbox.Runtime, workspaceID string) (net.Conn, error) {
	if runtime == nil || workspaceID == "" {
		return nil, errAuthority
	}
	return runtime.DialWorkspacePort(ctx, workspaceID, workspace.PortRequest{Port: 970})
}

// Fresh configuration never resolves a branch index, layer or coding artifact.
func freshConfig() microsandbox.Config {
	return microsandbox.Config{Image: microsandbox.DefaultImage, Environments: nil, Bundle: nil}
}

type open struct {
	Kind       string
	Argv       []string
	Cols, Rows uint16
	Port       uint16
}
type requestMapper struct {
	kind       string
	started    bool
	pty        bool
	cols, rows uint16
}

// SSH authentication supplies the fixed Ben identity, never request payloads.
// This pure adapter has no root, spawn, filesystem or network side effects.
func (m *requestMapper) request(kind string, payload []byte) (*open, []byte, error) {
	if len(payload) > 65536 {
		return nil, nil, errors.New("oversized SSH request")
	}
	switch kind {
	case "pty-req":
		var p struct {
			Term                      string
			Cols, Rows, Width, Height uint32
			Modes                     string
		}
		if m.started || m.pty || ssh.Unmarshal(payload, &p) != nil || p.Cols == 0 || p.Rows == 0 || p.Cols > 65535 || p.Rows > 65535 || len(p.Term) > 128 || !validModes([]byte(p.Modes)) {
			return nil, nil, errors.New("invalid pty")
		}
		m.pty, m.cols, m.rows = true, uint16(p.Cols), uint16(p.Rows)
		return nil, nil, nil
	case "shell", "exec", "subsystem":
		if m.started {
			return nil, nil, errors.New("session already started")
		}
		o := &open{Kind: "exec", Cols: m.cols, Rows: m.rows}
		switch kind {
		case "shell":
			if len(payload) != 0 {
				return nil, nil, errors.New("invalid shell")
			}
			o.Argv = []string{"/bin/sh", "-l"}
		case "exec":
			var p struct{ Command string }
			if ssh.Unmarshal(payload, &p) != nil || len(p.Command) == 0 || len(p.Command) > 32768 {
				return nil, nil, errors.New("invalid command")
			}
			o.Argv = []string{"/bin/sh", "-c", p.Command}
		case "subsystem":
			var p struct{ Name string }
			if ssh.Unmarshal(payload, &p) != nil || p.Name != "sftp" || m.pty {
				return nil, nil, errors.New("unsupported subsystem")
			}
			o.Kind = "sftp"
		}
		if m.pty {
			o.Kind = "pty"
		}
		m.started = true
		m.kind = o.Kind
		return o, nil, nil
	case "window-change":
		var p struct{ Cols, Rows, Width, Height uint32 }
		if !m.started || !m.pty || ssh.Unmarshal(payload, &p) != nil || p.Cols == 0 || p.Rows == 0 || p.Cols > 65535 || p.Rows > 65535 {
			return nil, nil, errors.New("invalid resize")
		}
		return nil, []byte(fmt.Sprintf(`{"type":"resize","cols":%d,"rows":%d}`, p.Cols, p.Rows)), nil
	case "signal":
		var p struct{ Name string }
		if !m.started || (m.kind != "pty" && m.kind != "exec") || ssh.Unmarshal(payload, &p) != nil || !validSignal(p.Name) {
			return nil, nil, errors.New("invalid signal")
		}
		return nil, []byte(fmt.Sprintf(`{"type":"signal","name":%q}`, p.Name)), nil
	default:
		// Includes env, auth-agent-req@openssh.com and tcpip-forward.
		return nil, nil, errors.New("unsupported SSH request")
	}
}
func validSignal(name string) bool {
	switch name {
	case "INT", "TERM", "HUP", "KILL", "QUIT", "USR1", "USR2":
		return true
	}
	return false
}
func validModes(modes []byte) bool {
	// RFC 4254: one opcode followed by uint32; opcode 0 terminates. Do not
	// interpret unknown modes or silently accept truncated root-facing data.
	for len(modes) > 0 {
		if modes[0] == 0 {
			return len(modes) == 1
		}
		if modes[0] >= 160 || len(modes) < 5 {
			return false
		}
		modes = modes[5:]
	}
	return false
}
func directTCP(payload []byte) (*open, error) {
	if len(payload) > 4096 {
		return nil, errors.New("oversized tcp request")
	}
	var p struct {
		Host       string
		Port       uint32
		Origin     string
		OriginPort uint32
	}
	if ssh.Unmarshal(payload, &p) != nil || (p.Host != "localhost" && p.Host != "127.0.0.1" && p.Host != "::1") || p.Port == 0 || p.Port > 65535 || p.OriginPort > 65535 || len(p.Origin) > 255 {
		return nil, errors.New("invalid guest loopback target")
	}
	return &open{Kind: "tcp", Port: uint16(p.Port)}, nil
}

// Exit messages use RFC 4254 payloads. There is no local command execution.
func exitRequest(code uint8, signal string, core bool) (string, []byte, error) {
	if signal == "" {
		return "exit-status", ssh.Marshal(struct{ Status uint32 }{uint32(code)}), nil
	}
	if !validSignal(signal) {
		return "", nil, errors.New("invalid exit signal")
	}
	return "exit-signal", ssh.Marshal(struct {
		Signal            string
		Core              bool
		Message, Language string
	}{signal, core, "", ""}), nil
}
