// smithers-sftp is the bundle's stdio subsystem, executed after broker UID drop.
package main

import (
	"errors"
	"fmt"
	"github.com/pkg/sftp"
	"io"
	"os"
)

type stdio struct {
	io.ReadCloser
	io.WriteCloser
}

func (s stdio) Close() error { return errors.Join(s.ReadCloser.Close(), s.WriteCloser.Close()) }
func serve(connection io.ReadWriteCloser, uid int) error {
	if uid <= 0 {
		return errors.New("SFTP requires an unprivileged identity")
	}
	server, err := sftp.NewServer(connection)
	if err != nil {
		return err
	}
	defer server.Close()
	err = server.Serve()
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
func main() {
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "SFTP is unavailable")
		os.Exit(1)
	}
	if err := serve(stdio{os.Stdin, os.Stdout}, os.Geteuid()); err != nil {
		fmt.Fprintln(os.Stderr, "SFTP is unavailable")
		os.Exit(1)
	}
}
