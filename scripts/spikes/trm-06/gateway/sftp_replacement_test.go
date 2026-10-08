package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// Ordinary member-owned filesystem syscalls and a real SSH exec transport.
// The SFTP policy peer below substitutes confinement; this proves campaign
// ordering and held-inode checks, never installed Landlock/root acceptance.
func TestSFTPHeldReplacementSchedules(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		t.Run(fmt.Sprint(corrupt), func(t *testing.T) {
			root := t.TempDir()
			workspace := filepath.Join(root, "workspace")
			outside := filepath.Join(root, "outside")
			for _, path := range []string{workspace, outside} {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			sentinel := filepath.Join(outside, "trm06-outside")
			if err := os.WriteFile(sentinel, []byte("outside-fixture\x00"), 0640); err != nil {
				t.Fatal(err)
			}
			_, key, _ := ed25519.GenerateKey(rand.Reader)
			signer, _ := ssh.NewSignerFromKey(key)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			done := make(chan error, 1)
			go func() {
				connection, err := listener.Accept()
				if err != nil {
					done <- err
					return
				}
				defer connection.Close()
				_ = connection.SetDeadline(time.Now().Add(15 * time.Second))
				config := &ssh.ServerConfig{NoClientAuth: true}
				config.AddHostKey(signer)
				server, channels, requests, err := ssh.NewServerConn(connection, config)
				if err != nil {
					done <- err
					return
				}
				defer server.Close()
				go ssh.DiscardRequests(requests)
				var workers sync.WaitGroup
				for incoming := range channels {
					channel, requests, err := incoming.Accept()
					if err != nil {
						done <- err
						return
					}
					workers.Add(1)
					go func() {
						defer workers.Done()
						defer channel.Close()
						request := <-requests
						if request == nil {
							return
						}
						var payload struct{ Command string }
						if request.Type != "exec" || ssh.Unmarshal(request.Payload, &payload) != nil {
							_ = request.Reply(false, nil)
							return
						}
						_ = request.Reply(true, nil)
						command := strings.ReplaceAll(strings.ReplaceAll(payload.Command, "/workspace", workspace), "/var/tmp", outside)
						output, err := exec.Command("/bin/sh", "-c", command).CombinedOutput()
						_, _ = channel.Write(output)
						code := uint32(0)
						if err != nil {
							code = 1
						}
						_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{code}))
					}()
				}
				workers.Wait()
				done <- nil
			}()
			client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "ben", HostKeyCallback: ssh.FixedHostKey(signer.PublicKey()), Timeout: 5 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			handles := map[string]*os.File{}
			defer func() {
				for _, file := range handles {
					_ = file.Close()
				}
			}()
			opened, denied, written, closed := 0, 0, 0, 0
			request := func(kind byte, id uint32, body []byte) ([]byte, error) {
				reply := make([]byte, 5)
				binary.BigEndian.PutUint32(reply[1:], id)
				status := func(code uint32) []byte {
					reply[0] = 101
					return append(reply, ssh.Marshal(struct{ Code uint32 }{code})...)
				}
				switch kind {
				case 3:
					path := strings.ReplaceAll(string(body), "/workspace", workspace)
					resolved, err := filepath.EvalSymlinks(path)
					if err != nil {
						return nil, err
					}
					if strings.HasPrefix(resolved, outside+"/") {
						denied++
						return status(3), nil
					}
					file, err := os.OpenFile(path, os.O_RDWR|os.O_TRUNC, 0)
					if err != nil {
						return nil, err
					}
					opened++
					name := fmt.Sprint(opened)
					handles[name] = file
					reply[0] = 102
					return append(reply, ssh.Marshal(struct{ Handle string }{name})...), nil
				case 6:
					var data struct {
						Handle string
						Offset uint64
						Data   string
					}
					if err := ssh.Unmarshal(body, &data); err != nil {
						return nil, err
					}
					if corrupt {
						data.Data = "wrong"
					}
					if _, err := handles[data.Handle].WriteAt([]byte(data.Data), int64(data.Offset)); err != nil {
						return nil, err
					}
					written++
					return status(0), nil
				case 4:
					var data struct{ Handle string }
					if err := ssh.Unmarshal(body, &data); err != nil {
						return nil, err
					}
					closed++
					return status(0), handles[data.Handle].Close()
				}
				return nil, fmt.Errorf("unexpected request %d", kind)
			}
			err = sftpHeldPathReplacements(client, request, func(path string) []byte { return []byte(path) })
			_ = client.Close()
			if serverErr := <-done; serverErr != nil {
				t.Fatal(serverErr)
			}
			if (err != nil) != corrupt {
				t.Fatalf("corrupt=%v: %v", corrupt, err)
			}
			if !corrupt && (opened != 32 || denied != 32 || written != 32 || closed != 32) {
				t.Fatalf("schedules: open=%d deny=%d write=%d close=%d", opened, denied, written, closed)
			}
			data, err := os.ReadFile(sentinel)
			if err != nil || string(data) != "outside-fixture\x00" {
				t.Fatalf("outside changed: %q %v", data, err)
			}
		})
	}
}
