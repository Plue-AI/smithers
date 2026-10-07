package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestOwnerControlCutsOwnedTransportAndRefusesReconnect(t *testing.T) {
	faults := &relayFaults{}
	listener, err := net.Listen("unix", filepath.Join(t.TempDir(), "control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		serveRevocation(ctx, listener, make(chan revocationRequest, 1), &ownerControl{faults: faults})
		close(done)
	}()
	guestListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer guestListener.Close()
	peer, err := net.Dial("tcp", guestListener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	transport, err := guestListener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	owned, err := faults.admit(transport)
	if err != nil {
		t.Fatal(err)
	}
	defer owned.Close()
	caller, err := net.Dial("unix", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Close()
	if err = writeAll(caller, []byte("cut-relay\n")); err != nil {
		t.Fatal(err)
	}
	var ack [4]byte
	if _, err = io.ReadFull(caller, ack[:]); err != nil || string(ack[:]) != "cut\n" {
		t.Fatalf("ack %q %v", ack, err)
	}
	peer.SetReadDeadline(time.Now().Add(time.Second))
	if n, err := peer.Read(make([]byte, 1)); n != 0 || err != io.EOF {
		t.Fatalf("transport survived cut: %d %v", n, err)
	}
	a, b := net.Pipe()
	defer b.Close()
	if _, err = faults.admit(a); err == nil {
		t.Fatal("admitted reconnect during real owner cut")
	}
	if n, err := b.Read(make([]byte, 1)); n != 0 || err != io.EOF {
		t.Fatal("denied transport retained")
	}
	faults.mu.Lock()
	if time.Until(faults.deniedUntil) < 9*time.Second {
		t.Fatal("owner cut is shorter than ten seconds")
	}
	if len(faults.connections) != 0 {
		t.Fatal("cut lost owned connections")
	}
	faults.mu.Unlock()
	// A zero-duration cut is an explicit local fixture reset, never a member op.
	faults.cut(0)
	a, b = net.Pipe()
	defer b.Close()
	owned, err = faults.admit(a)
	if err != nil {
		t.Fatal(err)
	}
	owned.Close()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("owner control outlived cancellation")
	}
}

// Real TCP is deliberate: EOF injection forwards bytes before closing, which
// a synchronous net.Pipe write would not represent without a reading peer.
func TestFrameFaultsAreOneShotAndPreserveControl(t *testing.T) {
	for _, mode := range []string{"lost-window", "delivered-eof"} {
		t.Run(mode, func(t *testing.T) {
			f := &relayFaults{}
			if err := f.arm(mode); err != nil {
				t.Fatal(err)
			}
			if f.arm(mode) == nil {
				t.Fatal("overwrote armed fault")
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			peer, err := net.Dial("tcp", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer peer.Close()
			connection, err := listener.Accept()
			if err != nil {
				t.Fatal(err)
			}
			owned, err := f.admit(connection)
			if err != nil {
				t.Fatal(err)
			}
			defer owned.Close()
			owned.SetDeadline(time.Now().Add(time.Second))
			peer.SetDeadline(time.Now().Add(time.Second))
			if mode == "lost-window" {
				done := make(chan error, 1)
				go func() {
					writer := &frameWriter{w: peer}
					for _, value := range []any{map[string]string{"session": "s-0000000000000001"}, map[string]any{"type": "window", "bytes": 8192}} {
						if err := writer.write(value); err != nil {
							done <- err
							return
						}
					}
					done <- nil
				}()
				if reply, err := controlExchangeReadOnly(owned); err != nil || reply.Session == "" {
					t.Fatalf("control lost: %+v %v", reply, err)
				}
				if _, err := readFrame(owned); err != io.EOF {
					t.Fatalf("consumed window leaked: %v", err)
				}
				if err := <-done; err != nil {
					t.Fatal(err)
				}
			} else {
				done := make(chan error, 1)
				go func() { done <- (&frameWriter{w: owned}).write(map[string]any{"type": "eof", "stream": 0}) }()
				frame, err := readFrame(peer)
				if err != nil || frame.Type != "eof" || *frame.Stream != 0 {
					t.Fatalf("EOF not forwarded: %+v %v", frame, err)
				}
				if err := <-done; err != io.ErrUnexpectedEOF {
					t.Fatalf("EOF delivery not ambiguous: %v", err)
				}
			}
			a, b := net.Pipe()
			defer b.Close()
			next, err := f.admit(a)
			if err != nil {
				t.Fatal(err)
			}
			defer next.Close()
			if next.(*faultConnection).mode != "" {
				t.Fatal("fault repeated on reconnect")
			}
		})
	}
	if (&relayFaults{}).arm("member-mode") == nil {
		t.Fatal("unknown fault accepted")
	}
}

func controlExchangeReadOnly(connection net.Conn) (controlReply, error) {
	var length uint32
	if err := binary.Read(connection, binary.BigEndian, &length); err != nil {
		return controlReply{}, err
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(connection, body); err != nil {
		return controlReply{}, err
	}
	var reply controlReply
	err := strictControlReply(body, &reply)
	return reply, err
}

func TestAttachedStreamRecoversActualTCPFrameFaults(t *testing.T) {
	for _, mode := range []string{"lost-window", "delivered-eof"} {
		t.Run(mode, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			faults := &relayFaults{}
			if err = faults.arm(mode); err != nil {
				t.Fatal(err)
			}
			dial := func() (net.Conn, error) {
				connection, err := net.Dial("tcp", listener.Addr().String())
				if err != nil {
					return nil, err
				}
				connection.SetDeadline(time.Now().Add(3 * time.Second))
				return faults.admit(connection)
			}
			first, err := dial()
			if err != nil {
				t.Fatal(err)
			}
			stream := newAttachedStream(first, "s-0000000000000001", dial)
			defer stream.Close()
			failures := make(chan error, 1)
			go func() {
				guest, err := listener.Accept()
				if err != nil {
					failures <- err
					return
				}
				defer guest.Close()
				guest.SetDeadline(time.Now().Add(3 * time.Second))
				frame, err := readFrameInput(guest)
				if err != nil || frame.Type != "data" || len(frame.Data) != 3 {
					failures <- io.ErrUnexpectedEOF
					return
				}
				if mode == "delivered-eof" {
					frame, err = readFrameInput(guest)
					if err != nil || frame.Type != "eof" {
						failures <- io.ErrUnexpectedEOF
						return
					}
				} else if err = (&frameWriter{w: guest}).write(map[string]any{"type": "window", "bytes": 3}); err != nil {
					failures <- err
					return
				}
				attached, err := listener.Accept()
				if err != nil {
					failures <- err
					return
				}
				defer attached.Close()
				attached.SetDeadline(time.Now().Add(3 * time.Second))
				request := receiveControl(attached)
				if request["type"] != "attach_session" || request["received"] != float64(0) {
					failures <- io.ErrUnexpectedEOF
					return
				}
				writer := &frameWriter{w: attached}
				if err = writer.write(map[string]any{"session": "s-0000000000000001", "received": 3, "written": 3, "input_eof": mode == "delivered-eof"}); err != nil {
					failures <- err
					return
				}
				failures <- writer.write(frameOutputFixture())
			}()
			writer := &frameWriter{w: stream}
			if err = writer.write(frame{Type: "data", Stream: ptr(uint8(0)), Data: frameBytes{1, 2, 3}}); err != nil {
				t.Fatal(err)
			}
			if mode == "delivered-eof" {
				if err = writer.write(frame{Type: "eof", Stream: ptr(uint8(0))}); err != nil {
					t.Fatal(err)
				}
			}
			credit, err := readFrame(stream)
			if err != nil || credit.Type != "window" || *credit.Credit != 3 {
				t.Fatalf("lost credit not repaired: %+v %v", credit, err)
			}
			output, err := readFrame(stream)
			if err != nil || output.Type != "data" || len(output.Data) != 1 || output.Data[0] != 7 {
				t.Fatalf("recovered output: %+v %v", output, err)
			}
			if err = <-failures; err != nil {
				t.Fatal(err)
			}
		})
	}
}
func frameOutputFixture() frame {
	return frame{Type: "data", Stream: ptr(uint8(1)), Data: frameBytes{7}}
}
