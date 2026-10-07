package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"testing"
)

func receiveControl(r io.Reader) map[string]any {
	var length uint32
	binary.Read(r, binary.BigEndian, &length)
	body := make([]byte, length)
	io.ReadFull(r, body)
	var value map[string]any
	json.Unmarshal(body, &value)
	return value
}
func TestAttachReplaysOnlyUnacceptedInputAndRepairsLostCredit(t *testing.T) {
	first, guest := net.Pipe()
	next, reattached := net.Pipe()
	defer reattached.Close()
	failures := make(chan error, 1)
	go func() {
		defer guest.Close()
		// The fake accepts only the first two input bytes before transport loss.
		readFrame(guest)
		readFrame(guest)
		readFrame(guest)
	}()
	stream := newAttachedStream(first, "s-0000000000000001", func() (net.Conn, error) { return next, nil })
	defer stream.Close()
	writer := &frameWriter{w: stream}
	for _, data := range []frameBytes{{1, 2}, {3}} {
		if err := writer.write(frame{Type: "data", Stream: ptr(uint8(0)), Data: data}); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.write(frame{Type: "eof", Stream: ptr(uint8(0))}); err != nil {
		t.Fatal(err)
	}
	go func() {
		request := receiveControl(reattached)
		if request["type"] != "attach_session" || request["id"] != "s-0000000000000001" || request["received"] != float64(0) {
			failures <- io.ErrUnexpectedEOF
			return
		}
		w := &frameWriter{w: reattached}
		err := w.write(map[string]any{"session": "s-0000000000000001", "received": 2, "written": 1, "input_eof": false})
		if err != nil {
			failures <- err
			return
		}
		replay, err := readFrameInput(reattached)
		if err != nil || replay.Type != "data" || len(replay.Data) != 1 || replay.Data[0] != 3 {
			failures <- io.ErrUnexpectedEOF
			return
		}
		eof, err := readFrameInput(reattached)
		if err != nil || eof.Type != "eof" {
			failures <- io.ErrUnexpectedEOF
			return
		}
		err = w.write(frame{Type: "data", Stream: ptr(uint8(1)), Data: frameBytes{7, 8}})
		failures <- err
	}()
	credit, err := readFrame(stream)
	if err != nil || credit.Type != "window" || *credit.Credit != 1 {
		t.Fatalf("credit %+v %v", credit, err)
	}
	output, err := readFrame(stream)
	if err != nil || output.Type != "data" || len(output.Data) != 2 || output.Data[0] != 7 {
		t.Fatalf("output %+v %v", output, err)
	}
	if err := <-failures; err != nil {
		t.Fatal(err)
	}
}

// The guest-facing codec accepts stdin frames; readFrame intentionally rejects
// them. This literal test decoder reads only data/eof for the synthetic peer.
func readFrameInput(r io.Reader) (frame, error) {
	var length uint32
	if err := binary.Read(r, binary.BigEndian, &length); err != nil {
		return frame{}, err
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return frame{}, err
	}
	var f frame
	err := json.Unmarshal(body, &f)
	return f, err
}
func TestAttachDoesNotReconnectMalformedGuestFrames(t *testing.T) {
	host, guest := net.Pipe()
	defer guest.Close()
	called := false
	stream := newAttachedStream(host, "s-0000000000000001", func() (net.Conn, error) { called = true; return nil, io.EOF })
	defer stream.Close()
	go (&frameWriter{w: guest}).write(json.RawMessage(`{"type":"exit","code":0,"code":7}`))
	if _, err := readFrame(stream); err == nil {
		t.Fatal("accepted duplicate")
	}
	if called {
		t.Fatal("retried invalid guest bytes")
	}
}
