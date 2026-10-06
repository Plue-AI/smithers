package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestFrameRejectsHostileGuestEnvelopes(t *testing.T) {
	for _, body := range []string{
		`{"type":"window","bytes":262145}`, `{"type":"window","bytes":0}`,
		`{"type":"data","stream":1,"bytes":[256]}`, `{"type":"data","stream":1,"bytes":[]}`,
		`{"type":"data","stream":1,"bytes":[null]}`,
		`{"type":"data","stream":1,"bytes":[1,null,2]}`,
		`{"type":"data","stream":1,"bytes":[0.0]}`,
		`{"type":"data","stream":1,"bytes":[-1]}`,
		`{"type":"data","stream":3,"bytes":[1]}`, `{"type":"close","uid":0}`,
		`{"type":"exit"}`, `{"type":"exit_signal","name":"STOP","core":false}`,
		`{"type":"exit","code":0,"code":7}`,
		`{"type":"close","type":"exit","code":7}`,
		`{"type":"data","stream":0,"stream":1,"bytes":[1]}`,
		`{"type":"window","bytes":0,"bytes":1}`,
		`{"type":"close"} {"type":"close"}`, `null`, `[]`,
		`{"type":"signal","name":"TERM"}`, `{"type":"eof","stream":null}`,
	} {
		var wire bytes.Buffer
		binary.Write(&wire, binary.BigEndian, uint32(len(body)))
		wire.WriteString(body)
		f, err := readFrame(&wire)
		if err == nil {
			t.Fatalf("accepted %s: %+v", body, f)
		}
	}
	for _, length := range []uint32{0, 65537} {
		var wire bytes.Buffer
		binary.Write(&wire, binary.BigEndian, length)
		if _, err := readFrame(&wire); err == nil {
			t.Fatal(length)
		}
	}
}

// Actual SSH channels exercise the adapter, not the installed authority or real
// relay. This test is deliberately not a C-SPK-08 passing receipt.
func TestSSHChannelExecHalfCloseAndExit(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)
	results := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			results <- err
			return
		}
		conn.SetDeadline(time.Now().Add(10 * time.Second))
		server, channels, requests, err := ssh.NewServerConn(conn, config)
		if err != nil {
			results <- err
			return
		}
		defer server.Close()
		go ssh.DiscardRequests(requests)
		channel := <-channels
		ch, reqs, err := channel.Accept()
		if err != nil {
			results <- err
			return
		}
		results <- serveSession(ch, reqs, func(spec *open) (io.ReadWriteCloser, error) {
			if spec.Kind != "exec" || strings.Join(spec.Argv, " ") != "/bin/sh -c exit 7" {
				return nil, io.ErrUnexpectedEOF
			}
			host, guest := net.Pipe()
			go func() {
				defer guest.Close()
				// Input decoding here uses literal JSON so it does not reuse the output
				// parser, which intentionally refuses host-only frames.
				var received []byte
				for {
					var size uint32
					if binary.Read(guest, binary.BigEndian, &size) != nil {
						return
					}
					body := make([]byte, size)
					if _, err := io.ReadFull(guest, body); err != nil {
						return
					}
					var input struct {
						Type   string
						Stream uint8
						Bytes  []uint16
					}
					if json.Unmarshal(body, &input) != nil {
						return
					}
					if input.Type == "eof" {
						break
					}
					if input.Type != "data" || input.Stream != 0 {
						return
					}
					for _, b := range input.Bytes {
						received = append(received, byte(b))
					}
				}
				if !bytes.Equal(received, []byte{0, 255, 10}) {
					return
				}
				writer := frameWriter{w: guest}
				if writer.write(frame{Type: "data", Stream: ptr(uint8(1)), Data: frameBytes{111, 107, 10}}) != nil {
					return
				}
				// Gateway grants credit only after the SSH output write completes.
				window, err := readFrame(guest)
				if err != nil || window.Credit == nil || *window.Credit != 3 {
					return
				}
				if writer.write(frame{Type: "data", Stream: ptr(uint8(2)), Data: frameBytes{101, 114, 114, 10}}) != nil {
					return
				}
				window, err = readFrame(guest)
				if err != nil || window.Credit == nil || *window.Credit != 4 {
					return
				}
				writer.write(frame{Type: "eof", Stream: ptr(uint8(1))})
				writer.write(frame{Type: "eof", Stream: ptr(uint8(2))})
				writer.write(frame{Type: "exit", Code: ptr(uint8(7))})
				readFrame(guest) // consume close so net.Pipe write completes
			}()
			return host, nil
		})
	}()
	client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", HostKeyCallback: ssh.FixedHostKey(signer.PublicKey()), Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	session.Stdin = bytes.NewReader([]byte{0, 255, 10})
	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	err = session.Run("exit 7")
	exit, ok := err.(*ssh.ExitError)
	if !ok || exit.ExitStatus() != 7 || stdout.String() != "ok\n" || stderr.String() != "err\n" {
		t.Fatalf("exit=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
	}
	if err := <-results; err != nil {
		t.Fatal(err)
	}
}

func TestSSHDispatchPTYSettingsAndUnavailableAuthority(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		t.Run(map[bool]string{false: "pty", true: "unavailable"}[unavailable], func(t *testing.T) {
			_, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			signer, err := ssh.NewSignerFromKey(private)
			if err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			config := &ssh.ServerConfig{NoClientAuth: true}
			config.AddHostKey(signer)
			opened := make(chan *open, 1)
			finished := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					finished <- err
					return
				}
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				server, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					conn.Close()
					finished <- err
					return
				}
				defer server.Close()
				var opener sessionOpener
				if !unavailable {
					opener = func(spec *open) (io.ReadWriteCloser, error) {
						opened <- spec
						return nil, io.ErrClosedPipe
					}
				}
				serveChannels(channels, requests, opener)
				finished <- nil
			}()
			client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", HostKeyCallback: ssh.FixedHostKey(signer.PublicKey()), Timeout: 5 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			if unavailable {
				if ch, _, err := client.OpenChannel("session", nil); err == nil {
					ch.Close()
					t.Fatal("session admitted without authority")
				}
				payload := ssh.Marshal(struct {
					Host       string
					Port       uint32
					Origin     string
					OriginPort uint32
				}{"localhost", 3000, "127.0.0.1", 40000})
				if ch, _, err := client.OpenChannel("direct-tcpip", payload); err == nil {
					ch.Close()
					t.Fatal("TCP admitted without authority")
				}
			} else {
				session, err := client.NewSession()
				if err != nil {
					t.Fatal(err)
				}
				defer session.Close()
				if err := session.RequestPty("xterm-256color", 24, 80, ssh.TerminalModes{ssh.ECHO: 0, 128: 38400}); err != nil {
					t.Fatal(err)
				}
				if err := session.Shell(); err == nil {
					t.Fatal("failed guest open reported success")
				}
				select {
				case spec := <-opened:
					if spec.Kind != "pty" || spec.Term != "xterm-256color" || spec.Cols != 80 || spec.Rows != 24 {
						t.Fatalf("lost PTY settings: %+v", spec)
					}
					modes := map[byte]uint32{}
					raw := spec.Modes
					for len(raw) >= 5 && raw[0] != 0 {
						modes[raw[0]] = binary.BigEndian.Uint32(raw[1:5])
						raw = raw[5:]
					}
					echo, present := modes[53]
					if !present || echo != 0 || modes[128] != 38400 || !bytes.Equal(raw, []byte{0}) {
						t.Fatalf("lost modes: %v / %x", modes, raw)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("guest opener not called")
				}
			}
			client.Close()
			select {
			case err := <-finished:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("dispatch did not stop")
			}
		})
	}
}

func TestSSHDispatchRefusesHostileGuestFrames(t *testing.T) {
	for _, fixture := range []struct{ name, body, refusal string }{
		{"duplicate-exit", `{"type":"exit","code":0,"code":7}`, "duplicate frame field"},
		{"null-byte", `{"type":"data","stream":1,"bytes":[65,null,66]}`, "invalid byte"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			checkSSHDispatchRefusal(t, fixture.body, fixture.refusal)
		})
	}
}

func checkSSHDispatchRefusal(t *testing.T, hostile, refusal string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)
	result := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			result <- err
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		server, channels, requests, err := ssh.NewServerConn(conn, config)
		if err != nil {
			result <- err
			return
		}
		defer server.Close()
		go ssh.DiscardRequests(requests)
		incoming := <-channels
		ch, reqs, err := incoming.Accept()
		if err != nil {
			result <- err
			return
		}
		result <- serveSession(ch, reqs, func(*open) (io.ReadWriteCloser, error) {
			host, guest := net.Pipe()
			go func() {
				defer guest.Close()
				// Literal hostile peer bytes; no shared encoder or payload process.
				body := []byte(hostile)
				binary.Write(guest, binary.BigEndian, uint32(len(body)))
				guest.Write(body)
				io.Copy(io.Discard, guest) // keep peer alive until adapter refuses
			}()
			return host, nil
		})
	}()
	client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", HostKeyCallback: ssh.FixedHostKey(signer.PublicKey()), Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	// An ambiguous guest exit must close the channel without reporting success
	// or laundering the last value into a legitimate SSH exit-status.
	var output bytes.Buffer
	session.Stdout = &output
	if err := session.Run("exit 7"); err == nil {
		t.Fatal("ambiguous exit reported success")
	} else if _, ok := err.(*ssh.ExitMissingError); !ok {
		t.Fatalf("ambiguous exit reported an exit status: %T: %v", err, err)
	}
	select {
	case err := <-result:
		if output.Len() != 0 {
			t.Fatalf("hostile output delivered: %x", output.Bytes())
		}
		if err == nil || err.Error() != refusal {
			t.Fatalf("dispatch result: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch did not refuse")
	}
}
