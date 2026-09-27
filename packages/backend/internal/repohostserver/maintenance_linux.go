package repohostserver

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
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

// processStart is when the process pid started.
func processStart(pid int) (time.Time, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return time.Time{}, err
	}
	// The command name, in parentheses, may hold spaces: fields after it
	// start at the state, the third; the start time, in clock ticks since
	// boot, is the twenty-second.
	stat := string(raw)
	fields := strings.Fields(stat[strings.LastIndexByte(stat, ')')+1:])
	if len(fields) < 20 {
		return time.Time{}, errors.New("short /proc stat for pid " + strconv.Itoa(pid))
	}
	ticks, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil {
		return time.Time{}, err
	}
	boot, err := bootTime()
	if err != nil {
		return time.Time{}, err
	}
	// USER_HZ is 100 on every Linux architecture Go supports.
	return boot.Add(time.Duration(ticks) * (time.Second / 100)), nil
}

// bootTime is when the system booted, to the second (rounded down).
func bootTime() (time.Time, error) {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if value, ok := strings.CutPrefix(line, "btime "); ok {
			seconds, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
			return time.Unix(seconds, 0), err
		}
	}
	return time.Time{}, errors.New("no btime in /proc/stat")
}

// processArgs is the argument vector of the process pid.
func processArgs(pid int) ([]string, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, errors.New("no arguments for pid " + strconv.Itoa(pid))
	}
	return strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00"), nil
}

// processEnv is the environment of the process pid.
func processEnv(pid int) ([]string, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if err != nil {
		return nil, err
	}
	return strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00"), nil
}

// processCwd is the working directory of the process pid.
func processCwd(pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
}
