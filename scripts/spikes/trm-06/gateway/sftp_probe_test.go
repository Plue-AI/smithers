package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"golang.org/x/crypto/ssh"
	"net"
	"testing"
	"time"
)

// Exercise the campaign through actual SSH subsystem framing. The peer is a
// test-only protocol fake; this is not installed confinement or root evidence.
func TestSFTPCampaignRejectsSuccessfulOutsideMutations(t *testing.T) {
	for _, accepted := range []uint32{0, 20, 21, 22, 23} {
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
			err = sftpFixture(client)
			client.Close()
			if (err == nil) != (accepted == 0) {
				t.Fatalf("accepted outside mutation %d: %v", accepted, err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}
