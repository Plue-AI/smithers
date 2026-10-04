// githubfake is a loopback-only process for the local browser rehearsal.
package main

import (
	"flag"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"net"
	"net/http"
	"os"
)

func loopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	return err == nil && net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
}
func run(addr, gitRoot string) error {
	if !loopback(addr) {
		return fmt.Errorf("--addr must be a literal loopback address")
	}
	cfg, err := githubfake.LocalSeed()
	if err != nil {
		return err
	}
	cfg.GitRoot = gitRoot
	fake, err := githubfake.Handler(cfg)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	defer listener.Close()
	fake.URL = "http://" + listener.Addr().String()
	fmt.Println("ready", fake.URL)
	fmt.Println("seed owner=local-owner app=smithers-local repo=local-owner/demo")
	return http.Serve(listener, fake.Handler())
}
func main() {
	addr := flag.String("addr", "127.0.0.1:0", "loopback listener")
	gitRoot := flag.String("git-root", "", "directory containing fixture bare repositories")
	flag.Parse()
	if err := run(*addr, *gitRoot); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
