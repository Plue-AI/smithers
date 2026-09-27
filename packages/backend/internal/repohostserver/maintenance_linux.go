package repohostserver

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// setMaintenanceParentDeathSignal has the kernel send maintenance git SIGTERM
// when repo-host dies, so it removes its lock files and exits. Only git itself
// gets it; reapOrphanedMaintenance terminates the children it started.
func setMaintenanceParentDeathSignal(attr *syscall.SysProcAttr) {
	attr.Pdeathsig = syscall.SIGTERM
}

// processName is the command name of the process pid.
func processName(pid int) (string, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm")
	return strings.TrimSpace(string(raw)), err
}
