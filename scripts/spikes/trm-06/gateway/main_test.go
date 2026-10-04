package main

import (
	"bytes"
	"context"
	"golang.org/x/crypto/ssh"
	"testing"
)

func TestExitLiteralSSHMessages(t *testing.T) {
	kind, body, err := exitRequest(7, "", false)
	if err != nil || kind != "exit-status" || !bytes.Equal(body, []byte{0, 0, 0, 7}) {
		t.Fatalf("%s %x %v", kind, body, err)
	}
	kind, body, err = exitRequest(0, "TERM", false)
	expected := []byte{0, 0, 0, 4, 'T', 'E', 'R', 'M', 0, 0, 0, 0, 0, 0, 0, 0, 0}
	if err != nil || kind != "exit-signal" || !bytes.Equal(body, expected) {
		t.Fatalf("%s %x %v", kind, body, err)
	}
	if _, _, err := exitRequest(0, "STOP", false); err == nil {
		t.Fatal("accepted STOP")
	}
}
func TestPTYResizeAndSignal(t *testing.T) {
	var m requestMapper
	pty := ssh.Marshal(struct {
		Term                      string
		Cols, Rows, Width, Height uint32
		Modes                     string
	}{"xterm", 80, 24, 0, 0, "\x00"})
	if _, _, err := m.request("pty-req", pty); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.request("pty-req", pty); err == nil {
		t.Fatal("duplicate PTY")
	}
	o, _, err := m.request("shell", nil)
	if err != nil || o.Kind != "pty" || o.Cols != 80 || o.Rows != 24 {
		t.Fatalf("%+v %v", o, err)
	}
	size := ssh.Marshal(struct{ Cols, Rows, Width, Height uint32 }{120, 40, 0, 0})
	_, frame, err := m.request("window-change", size)
	if err != nil || string(frame) != `{"type":"resize","cols":120,"rows":40}` {
		t.Fatalf("%s %v", frame, err)
	}
	_, frame, err = m.request("signal", ssh.Marshal(struct{ Name string }{"INT"}))
	if err != nil || string(frame) != `{"type":"signal","name":"INT"}` {
		t.Fatalf("%s %v", frame, err)
	}
	if _, _, err := m.request("shell", nil); err == nil {
		t.Fatal("second launch")
	}
}
func TestRequestRefusalsDoNotConsumeLaunch(t *testing.T) {
	for _, kind := range []string{"auth-agent-req@openssh.com", "tcpip-forward", "env", "unknown", "window-change", "signal", "exec", "subsystem"} {
		var m requestMapper
		if _, _, err := m.request(kind, nil); err == nil {
			t.Fatal(kind)
		}
		o, _, err := m.request("shell", nil)
		if err != nil || o.Kind != "exec" {
			t.Fatalf("refusal consumed launch: %s", kind)
		}
	}
	var m requestMapper
	if _, _, err := m.request("exec", make([]byte, 65537)); err == nil {
		t.Fatal("oversized request")
	}
	if _, _, err := m.request("shell", []byte{1}); err == nil {
		t.Fatal("shell payload")
	}
	for _, modes := range [][]byte{nil, {1}, {1, 0, 0, 0, 1}, {160, 0}, {0, 1}} {
		if validModes(modes) {
			t.Fatalf("accepted %x", modes)
		}
	}
	if !validModes([]byte{1, 0, 0, 0, 1, 0}) {
		t.Fatal("valid modes")
	}
}
func TestExecSFTPAndLoopback(t *testing.T) {
	var m requestMapper
	o, _, err := m.request("exec", ssh.Marshal(struct{ Command string }{"exit 7"}))
	if err != nil || o.Kind != "exec" || len(o.Argv) != 3 || o.Argv[2] != "exit 7" {
		t.Fatalf("%+v %v", o, err)
	}
	m = requestMapper{}
	o, _, err = m.request("subsystem", ssh.Marshal(struct{ Name string }{"sftp"}))
	if err != nil || o.Kind != "sftp" || len(o.Argv) != 0 {
		t.Fatalf("%+v %v", o, err)
	}
	for _, host := range []string{"localhost", "127.0.0.1", "::1", "127.1", "example.com", "localhost.example", "169.254.169.254"} {
		for _, port := range []uint32{0, 3000, 65535, 65536} {
			payload := ssh.Marshal(struct {
				Host       string
				Port       uint32
				Origin     string
				OriginPort uint32
			}{host, port, "127.0.0.1", 40000})
			o, err := directTCP(payload)
			valid := (host == "localhost" || host == "127.0.0.1" || host == "::1") && (port == 3000 || port == 65535)
			if valid != (err == nil) {
				t.Fatalf("%s:%d: %v", host, port, err)
			}
			if valid && (o.Kind != "tcp" || uint32(o.Port) != port) {
				t.Fatalf("%+v", o)
			}
			if _, err := directTCP(append(payload, 1)); err == nil {
				t.Fatal("trailing payload")
			}
		}
	}
	if _, err := directTCP(make([]byte, 4097)); err == nil {
		t.Fatal("oversized tcp")
	}
}
func TestFreshOnlyAndNoFallback(t *testing.T) {
	config := freshConfig()
	if config.Environments != nil || config.Artifacts != nil || config.Image != "node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b" {
		t.Fatalf("%+v", config)
	}
	if conn, err := relay(context.Background(), nil, "ben"); err != errAuthority || conn != nil {
		t.Fatalf("%v %v", conn, err)
	}
}

func TestMalformedPTYAndNonProcessSignals(t *testing.T) {
	for _, size := range [][2]uint32{{0, 24}, {80, 0}, {65536, 24}, {80, 65536}} {
		var m requestMapper
		payload := ssh.Marshal(struct {
			Term                      string
			Cols, Rows, Width, Height uint32
			Modes                     string
		}{"xterm", size[0], size[1], 0, 0, "\x00"})
		if _, _, err := m.request("pty-req", payload); err == nil {
			t.Fatalf("accepted %v", size)
		}
		if m.pty || m.started {
			t.Fatal("invalid PTY changed state")
		}
	}
	var m requestMapper
	if _, _, err := m.request("subsystem", ssh.Marshal(struct{ Name string }{"sftp"})); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.request("signal", ssh.Marshal(struct{ Name string }{"TERM"})); err == nil {
		t.Fatal("SFTP signal")
	}
	m = requestMapper{}
	if _, _, err := m.request("shell", nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.request("signal", ssh.Marshal(struct{ Name string }{"STOP"})); err == nil {
		t.Fatal("unsupported signal")
	}
	if _, _, err := m.request("window-change", ssh.Marshal(struct{ Cols, Rows, Width, Height uint32 }{120, 40, 0, 0})); err == nil {
		t.Fatal("non-PTY resize")
	}
}
