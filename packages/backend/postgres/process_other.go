//go:build !darwin && !linux

package postgres

import (
	"context"
	"errors"
	"os"
	"os/exec"
)

var errUnsupportedPlatform = errors.New("packaged postgres lifecycle is supported on macOS and Linux")

func configurePostmaster(*exec.Cmd)               {}
func runBounded(context.Context, *exec.Cmd) error { return errUnsupportedPlatform }
func signalPID(int, os.Signal) error              { return errUnsupportedPlatform }
func signalProcessGroup(int, os.Signal) error     { return errUnsupportedPlatform }
func immediateShutdownSignal() os.Signal          { return os.Interrupt }
func processAlive(int) (bool, error)              { return false, errUnsupportedPlatform }
func processIdentity(int) (string, string, error) { return "", "", errUnsupportedPlatform }
func syncDirectory(string) error                  { return errUnsupportedPlatform }

// ProcessBirth identifies one run of a PID where the platform can.
func ProcessBirth(int) (string, error) { return "", errUnsupportedPlatform }
