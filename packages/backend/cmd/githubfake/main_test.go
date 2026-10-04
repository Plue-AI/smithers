package main

import "testing"

func TestLoopbackOnly(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", "[::]:0", "localhost:0", "example.com:80", ":0", "127.0.0.1"} {
		if loopback(addr) {
			t.Fatalf("accepted %s", addr)
		}
		if run(addr, "") == nil {
			t.Fatalf("ran %s", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:0", "[::1]:0"} {
		if !loopback(addr) {
			t.Fatalf("refused %s", addr)
		}
	}
}
