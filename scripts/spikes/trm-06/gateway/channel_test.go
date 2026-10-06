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
		`{"type":"data","stream":3,"bytes":[1]}`, `{"type":"close","uid":0}`,
		`{"type":"exit"}`, `{"type":"exit_signal","name":"STOP","core":false}`,
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
