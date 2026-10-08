package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"golang.org/x/crypto/ssh"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Exercise the campaign through actual SSH subsystem framing. The peer is a
// test-only protocol fake; this is not installed confinement or root evidence.
func TestSFTPCampaignRejectsSuccessfulOutsideMutations(t *testing.T) {
	for _, accepted := range []uint32{0, 20, 21, 22, 23, 100} {
		t.Run(string(rune('a'+accepted)), func(t *testing.T) {
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
			done := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					done <- err
					return
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				config := &ssh.ServerConfig{NoClientAuth: true}
				config.AddHostKey(signer)
				server, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					done <- err
					return
				}
				defer server.Close()
				go ssh.DiscardRequests(requests)
				incoming := <-channels
				channel, reqs, err := incoming.Accept()
				if err != nil {
					done <- err
					return
				}
				defer channel.Close()
				req := <-reqs
				if req.Type != "subsystem" {
					done <- net.ErrClosed
					return
				}
				req.Reply(true, nil)
				init, err := readSFTPPacket(channel)
				if err != nil {
					done <- err
					return
				}
				if len(init) != 5 || init[0] != 1 {
					done <- net.ErrClosed
					return
				}
				writeAll(channel, []byte{0, 0, 0, 5, 2, 0, 0, 0, 3})
				for {
					packet, err := readSFTPPacket(channel)
					if err != nil {
						done <- nil
						return
					}
					id := binary.BigEndian.Uint32(packet[1:5])
					var reply []byte
					if id == 1 {
						reply = append([]byte{102}, packet[1:5]...)
						reply = append(reply, ssh.Marshal(struct{ Handle string }{"fixture"})...)
					} else {
						code := uint32(3)
						if accepted == 100 {
							code = 4 // actual OpenSSH EROFS mapping
						}
						if id == 2 || id == 3 || id == accepted {
							code = 0
						}
						if id == 23 && accepted != 23 {
							code = 4
						}
						reply = append([]byte{101}, packet[1:5]...)
						reply = append(reply, ssh.Marshal(struct {
							Code              uint32
							Message, Language string
						}{code, "", ""})...)
					}
					if err := binary.Write(channel, binary.BigEndian, uint32(len(reply))); err != nil {
						done <- nil
						return
					}
					if err := writeAll(channel, reply); err != nil {
						done <- nil
						return
					}
				}
			}()
			client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", HostKeyCallback: ssh.FixedHostKey(signer.PublicKey()), Timeout: 5 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			evidence := t.TempDir()
			err = sftpBoundaryFixture(client, false, evidence)
			client.Close()
			raw, readErr := os.ReadFile(filepath.Join(evidence, "sftp-packets.jsonl"))
			if readErr != nil {
				t.Fatal(readErr)
			}
			rows := bytes.Split(bytes.TrimSpace(raw), []byte("\n"))
			if len(rows) < 8 {
				t.Fatalf("lost SFTP packet receipts: %d", len(rows))
			}
			for _, row := range rows {
				var packet struct {
					Request []byte
					Reply   []byte
				}
				if json.Unmarshal(row, &packet) != nil || len(packet.Request) < 5 || len(packet.Reply) < 5 {
					t.Fatalf("invalid raw SFTP receipt: %s", row)
				}
			}
			if (err == nil) != (accepted == 0 || accepted == 100) {
				t.Fatalf("accepted outside mutation %d: %v", accepted, err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

// This peer tests campaign completion/error cleanup, not a kernel path race.
func TestSFTPPathRaceRequiresBothTargetsAndAlwaysStopsRacer(t *testing.T) {
	for _, mode := range []string{"both", "only-workspace", "failed-write"} {
		t.Run(mode, func(t *testing.T) {
			_, key, _ := ed25519.GenerateKey(rand.Reader)
			signer, _ := ssh.NewSignerFromKey(key)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			stopped := make(chan struct{})
			done := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					done <- err
					return
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				config := &ssh.ServerConfig{NoClientAuth: true}
				config.AddHostKey(signer)
				server, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					done <- err
					return
				}
				defer server.Close()
				go ssh.DiscardRequests(requests)
				for incoming := range channels {
					channel, reqs, err := incoming.Accept()
					if err != nil {
						done <- err
						return
					}
					go func() {
						defer channel.Close()
						req := <-reqs
						if req == nil {
							return
						}
						var argv struct{ Command string }
						if req.Type != "exec" || ssh.Unmarshal(req.Payload, &argv) != nil {
							req.Reply(false, nil)
							return
						}
						req.Reply(true, nil)
						if argv.Command == "touch /workspace/trm06-race-stop" {
							close(stopped)
						} else {
							channel.Write([]byte("ready"))
							<-stopped
							channel.Write([]byte("12"))
						}
						channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
					}()
				}
				done <- nil
			}()
			client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", HostKeyCallback: ssh.FixedHostKey(signer.PublicKey()), Timeout: 5 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			opens := 0
			request := func(kind byte, id uint32, body []byte) ([]byte, error) {
				if kind == 6 && mode == "failed-write" {
					return nil, errors.New("fixture write failure")
				}
				reply := make([]byte, 5)
				binary.BigEndian.PutUint32(reply[1:], id)
				if kind == 3 {
					opens++
					if opens%2 == 0 && mode != "only-workspace" {
						reply[0] = 101
						return append(reply, ssh.Marshal(struct{ Code uint32 }{3})...), nil
					}
					reply[0] = 102
					return append(reply, ssh.Marshal(struct{ Handle string }{"held"})...), nil
				}
				reply[0] = 101
				return append(reply, ssh.Marshal(struct{ Code uint32 }{0})...), nil
			}
			err = sftpPathRace(client, request, func(path string) []byte { return []byte(path) })
			client.Close()
			if (err == nil) != (mode == "both") {
				t.Fatalf("%s: %v", mode, err)
			}
			select {
			case <-stopped:
			default:
				t.Fatal("racer was not stopped")
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}
