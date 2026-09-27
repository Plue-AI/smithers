//go:build !linux

package repohostserver

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// setMaintenanceParentDeathSignal does nothing: only Linux has a parent-death
// signal. reapOrphanedMaintenance terminates what a crashed repo-host left.
func setMaintenanceParentDeathSignal(*syscall.SysProcAttr) {}

// processName is the command name of the process pid.
func processName(pid int) (string, error) {
	return ps(pid, "comm")
}

// ps runs ps for the process pid with the given output format.
func ps(pid int, format string) (string, error) {
	cmd := exec.Command("ps", "-o", format+"=", "-p", strconv.Itoa(pid))
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// processStart is when the process pid started, to the second (rounded down).
func processStart(pid int) (time.Time, error) {
	out, err := ps(pid, "lstart")
	if err != nil {
		return time.Time{}, err
	}
	return time.ParseInLocation("Mon Jan _2 15:04:05 2006", out, time.Local)
}

// processArgs is the argument vector of the process pid, split at spaces: an
// argument that holds one never matches a path.
func processArgs(pid int) ([]string, error) {
	out, err := ps(pid, "args")
	return strings.Fields(out), err
}

// processCwd is the working directory of the process pid.
func processCwd(pid int) (string, error) {
	out, err := exec.Command("lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(out), "\n") {
		if cwd, ok := strings.CutPrefix(line, "n"); ok {
			return cwd, nil
		}
	}
	return "", errors.New("no working directory for pid " + strconv.Itoa(pid))
}
