//go:build !linux && !darwin

package repohostserver

import (
	"errors"
	"syscall"
	"time"
)

// Elsewhere no process can be identified: a live gc.pid holds its repository
// (inspectGCPid).

var errProcessLookup = errors.New("process lookup is not supported on this platform")

func setMaintenanceParentDeathSignal(*syscall.SysProcAttr) {}

func processName(int) (string, error) { return "", errProcessLookup }

func processStart(int) (time.Time, error) { return time.Time{}, errProcessLookup }

func processArgs(int) ([]string, error) { return nil, errProcessLookup }

func processEnv(int) ([]string, error) { return nil, errProcessLookup }

func processCwd(int) (string, error) { return "", errProcessLookup }
