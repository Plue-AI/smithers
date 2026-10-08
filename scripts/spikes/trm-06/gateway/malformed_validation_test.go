package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// The installed campaign uses this observer on an authenticated VM stream.
// Synthetic replies here qualify only its refusal/evidence rules.
func TestMalformedFrameRetainsBytesAndRequiresBoundedUnchangedSession(t *testing.T) {
	window := `{"type":"window","bytes":262144}`
	framed := func(body string) []byte {
		data := make([]byte, len(body)+4)
		binary.BigEndian.PutUint32(data, uint32(len(body)))
		copy(data[4:], body)
		return data
	}
	for _, test := range []struct {
		name  string
		reply []byte
		pass  bool
	}{
		{"closed", nil, true},
		{"initial window", framed(window), true},
		{"extra window", append(framed(window), framed(window)...), false},
		{"changed credit", framed(`{"type":"window","bytes":1}`), false},
		{"duplicate credit", framed(`{"type":"window","bytes":1,"bytes":262144}`), false},
		{"unexpected field", framed(`{"type":"window","bytes":262144,"uid":0}`), false},
		{"exit", framed(`{"type":"exit","code":0}`), false},
		{"zero length", []byte{0, 0, 0, 0}, false},
		{"oversized", []byte{0, 1, 0, 1}, false},
		{"partial header", []byte{0}, false},
		{"partial body", []byte{0, 0, 0, 40, '{'}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, peer := net.Pipe()
			defer client.Close()
			done := make(chan []byte, 1)
			go func() {
				defer peer.Close()
				var length uint32
				if binary.Read(peer, binary.BigEndian, &length) != nil {
					done <- nil
					return
				}
				request := make([]byte, length)
				_, _ = io.ReadFull(peer, request)
				done <- request
				_, _ = peer.Write(test.reply)
			}()
			evidence := t.TempDir()
			bad := `{"type":"window","bytes":0}`
			err := validateMalformedSessionFrame(client, bad, evidence, 0)
			client.Close()
			if (err == nil) != test.pass {
				t.Fatalf("pass=%v: %v", test.pass, err)
			}
			if request := <-done; string(request) != bad {
				t.Fatalf("request %q", request)
			}
			stem := filepath.Join(evidence, "invalid-frame-000")
			request, readErr := os.ReadFile(stem + "-request.raw")
			if readErr != nil || !bytes.Equal(request, framed(bad)) {
				t.Fatalf("request evidence %x: %v", request, readErr)
			}
			reply, readErr := os.ReadFile(stem + "-reply.raw")
			// Extra windows are refused at the second header, before allocating a body.
			expected := test.reply
			if test.name == "extra window" {
				expected = expected[:len(framed(window))+4]
			}
			if readErr != nil || !bytes.Equal(reply, expected) {
				t.Fatalf("reply evidence %x: %v", reply, readErr)
			}
			raw, readErr := os.ReadFile(stem + ".json")
			var result struct {
				Closed bool   `json:"transport_closed"`
				Error  string `json:"error"`
			}
			if readErr != nil || json.Unmarshal(raw, &result) != nil || result.Closed != test.pass || (result.Error == "") != test.pass {
				t.Fatalf("result %s: %v", raw, readErr)
			}
		})
	}
}

func TestMalformedFrameEvidenceFailureCannotPass(t *testing.T) {
	client, peer := net.Pipe()
	defer client.Close()
	defer peer.Close()
	if err := validateMalformedSessionFrame(client, `{`, filepath.Join(t.TempDir(), "missing"), 0); err == nil {
		t.Fatal("missing evidence storage passed")
	}
	evidence := t.TempDir()
	// Never overwrite a retained reply from a previous control.
	path := filepath.Join(evidence, "invalid-frame-000-reply.raw")
	if err := os.WriteFile(path, []byte("previous"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateMalformedSessionFrame(client, `{`, evidence, 0); err == nil {
		t.Fatal("overwrote previous reply")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "previous" {
		t.Fatalf("retained evidence changed: %s %v", raw, err)
	}
}
