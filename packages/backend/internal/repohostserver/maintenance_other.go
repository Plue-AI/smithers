//go:build !linux

package repohostserver

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// setMaintenanceParentDeathSignal does nothing: only Linux has a parent-death
// signal. reapOrphanedMaintenance terminates what a crashed repo-host left.
func setMaintenanceParentDeathSignal(*syscall.SysProcAttr) {}

// processName is the command name of the process pid.
func processName(pid int) (string, error) {
	out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	return strings.TrimSpace(string(out)), err
}
