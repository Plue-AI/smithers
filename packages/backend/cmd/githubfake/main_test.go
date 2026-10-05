package main

import "testing"

func TestLoopbackOnly(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", "[::]:0", "localhost:0", "example.com:80", ":0", "127.0.0.1"} {
		if loopback(addr) {
			t.Fatalf("accepted %s", addr)
		}
		if run(addr, "", "local-owner") == nil {
			t.Fatalf("ran %s", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:0", "[::1]:0"} {
		if !loopback(addr) {
			t.Fatalf("refused %s", addr)
		}
	}
}

// An owner GitHub would refuse never names the seeded repository path.
func TestOwnerMustBeAGitHubLogin(t *testing.T) {
	for _, owner := range []string{"", "../x", "maya/demo", "-maya"} {
		if run("127.0.0.1:0", "", owner) == nil {
			t.Fatalf("ran with owner %q", owner)
		}
	}
}
