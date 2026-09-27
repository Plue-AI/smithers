package repohostserver

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// setMaintenanceParentDeathSignal does nothing: macOS has no parent-death
// signal. reapOrphanedMaintenance terminates what a crashed repo-host left.
func setMaintenanceParentDeathSignal(*syscall.SysProcAttr) {}

// kinfoProc is the kernel's record of the process pid.
func kinfoProc(pid int) (*unix.KinfoProc, error) {
	proc, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return nil, err
	}
	if int(proc.Proc.P_pid) != pid {
		return nil, syscall.ESRCH
	}
	return proc, nil
}

// processName is the command name of the process pid.
func processName(pid int) (string, error) {
	proc, err := kinfoProc(pid)
	if err != nil {
		return "", err
	}
	name, _, _ := bytes.Cut(proc.Proc.P_comm[:], []byte{0})
	return string(name), nil
}

// processStart is when the process pid started.
func processStart(pid int) (time.Time, error) {
	proc, err := kinfoProc(pid)
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(proc.Proc.P_starttime.Unix()), nil
}

// processArgs is the argument vector of the process pid.
func processArgs(pid int) ([]string, error) {
	args, _, err := procArgs(pid)
	return args, err
}

// processEnv is the environment of the process pid.
func processEnv(pid int) ([]string, error) {
	_, env, err := procArgs(pid)
	return env, err
}

// procArgs is the argument vector and environment of the process pid, from
// KERN_PROCARGS2: argc, the executable path, then argc arguments and the
// environment, each NUL-terminated.
func procArgs(pid int) (args, env []string, err error) {
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return nil, nil, err
	}
	if len(raw) < 4 {
		return nil, nil, errors.New("short KERN_PROCARGS2 for pid " + strconv.Itoa(pid))
	}
	argc := int(binary.LittleEndian.Uint32(raw))
	_, rest, ok := bytes.Cut(raw[4:], []byte{0})
	if !ok {
		return nil, nil, errors.New("unterminated KERN_PROCARGS2 for pid " + strconv.Itoa(pid))
	}
	rest = bytes.TrimLeft(rest, "\x00")
	for len(rest) > 0 {
		value, tail, ok := bytes.Cut(rest, []byte{0})
		if !ok || (len(args) == argc && len(value) == 0) {
			break
		}
		if len(args) < argc {
			args = append(args, string(value))
		} else {
			env = append(env, string(value))
		}
		rest = tail
	}
	if len(args) != argc {
		return nil, nil, errors.New("truncated KERN_PROCARGS2 for pid " + strconv.Itoa(pid))
	}
	return args, env, nil
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
