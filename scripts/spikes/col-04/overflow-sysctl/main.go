// overflow-sysctl is a main-built guest fixture, never a repository hook.
// It accepts no path, value, command, or environment configuration. Close stdin
// after the unprivileged overflow fixture finishes to restore the kernel value.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
)

const queuePath = "/proc/sys/fs/inotify/max_queued_events"

type kernelFile interface {
	io.Reader
	io.Writer
	io.Seeker
	io.Closer
}

func withOverflowLimit(args []string, open func(string) (kernelFile, error), ready io.Writer, wait func() error) (err error) {
	if len(args) != 0 {
		return errors.New("overflow helper accepts no arguments")
	}
	file, err := open(queuePath)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	saved, err := io.ReadAll(io.LimitReader(file, 32))
	if err != nil {
		return err
	}
	text := strings.TrimSpace(string(saved))
	prior, err := strconv.ParseUint(text, 10, 31)
	if err != nil || prior == 0 || text != strconv.FormatUint(prior, 10) {
		return errors.New("invalid kernel queue limit")
	}
	write := func(value string) error {
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return err
		}
		n, err := io.WriteString(file, value+"\n")
		if err == nil && n != len(value)+1 {
			err = io.ErrShortWrite
		}
		return err
	}
	// Restore even if the reducing write or the readiness receipt fails.
	defer func() { err = errors.Join(err, write(text)) }()
	if err = write("64"); err != nil {
		return err
	}
	if _, err = io.WriteString(ready, "ready\n"); err != nil {
		return err
	}
	return wait()
}

func main() {
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "overflow helper requires the trusted guest root identity")
		os.Exit(1)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	err := withOverflowLimit(os.Args[1:], func(path string) (kernelFile, error) {
		return os.OpenFile(path, os.O_RDWR, 0)
	}, os.Stdout, func() error {
		done := make(chan error, 1)
		go func() { _, err := io.Copy(io.Discard, os.Stdin); done <- err }()
		select {
		case err := <-done:
			return err
		case sig := <-signals:
			return fmt.Errorf("interrupted: %s", sig)
		}
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
