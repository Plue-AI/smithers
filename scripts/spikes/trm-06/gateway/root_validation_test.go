package main

import (
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func TestRootEnvelopeRefusalRequiresUnambiguousEvidence(t *testing.T) {
	for _, test := range []struct {
		name, body                    string
		length                        uint32
		close, partial, timeout, pass bool
	}{
		{name: "explicit", body: `{"class":"invalid","code":"session_refused"}`, pass: true},
		{name: "closed", close: true, pass: true},
		{name: "success", body: `{"ok":true}`},
		{name: "wrong-class", body: `{"class":"unavailable","code":"session_refused"}`},
		{name: "duplicate", body: `{"class":"invalid","class":"invalid","code":"session_refused"}`},
		{name: "malformed", body: `{`},
		{name: "oversized", length: 4097},
		{name: "truncated", body: `{"class":"invalid","code":"session_refused"}`, partial: true},
		{name: "timeout", timeout: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			client, err := net.Dial("tcp", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			server, err := listener.Accept()
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer server.Close()
				var length uint32
				if binary.Read(server, binary.BigEndian, &length) != nil {
					return
				}
				body := make([]byte, length)
				if _, err := io.ReadFull(server, body); err != nil {
					return
				}
				if string(body) != "invalid-fixture" {
					return
				}
				if test.close {
					return
				}
				if test.timeout {
					time.Sleep(2100 * time.Millisecond)
					return
				}
				length = uint32(len(test.body))
				if test.length != 0 {
					length = test.length
				}
				_ = binary.Write(server, binary.BigEndian, length)
				body = []byte(test.body)
				if test.partial {
					body = body[:1]
				}
				_ = writeAll(server, body)
			}()
			_, err = validationRefusal(client, []byte("invalid-fixture"), 15)
			if (err == nil) != test.pass {
				t.Fatalf("refusal evidence: %v, want passing=%v", err, test.pass)
			}
			client.Close()
			<-done
		})
	}
}
