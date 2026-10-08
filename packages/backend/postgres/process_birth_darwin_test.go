//go:build darwin

package postgres

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// parseBirth splits "darwin:<seconds>:<microseconds>".
func parseBirth(t *testing.T, birth string) (seconds, microseconds int64) {
	t.Helper()
	if _, err := fmt.Sscanf(birth, "darwin:%d:%d", &seconds, &microseconds); err != nil {
		t.Fatalf("birth %q is not darwin:<seconds>:<microseconds>: %v", birth, err)
	}
	return seconds, microseconds
}

// On macOS a process's birth is the start time the kernel recorded for it:
// sysctl kern.proc.pid.<pid> answers its kinfo_proc, whose kp_proc.p_starttime
// is a timeval. ps reads the same field, so its lstart is an independent
// check of the seconds; the microseconds are what keep a reused PID apart.
func TestProcessBirthIsTheKernelStartTime(t *testing.T) {
	before := time.Now()
	process := exec.Command("/bin/sleep", "60")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := false
	defer func() {
		if !reaped {
			_ = process.Process.Kill()
			_ = process.Wait()
		}
	}()
	after := time.Now()
	pid := process.Process.Pid

	birth, err := ProcessBirth(pid)
	if err != nil {
		t.Fatal(err)
	}
	seconds, microseconds := parseBirth(t, birth)
	if microseconds < 0 || microseconds > 999999 {
		t.Fatalf("microseconds out of range in %q", birth)
	}
	started := time.Unix(seconds, microseconds*1000)
	if started.Before(before.Add(-time.Second)) || started.After(after.Add(time.Second)) {
		t.Fatalf("birth %s is not when the process started (%s..%s)", started, before, after)
	}

	// The kernel's own record, read directly.
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		t.Fatal(err)
	}
	if want := fmt.Sprintf("darwin:%d:%d", info.Proc.P_starttime.Sec, info.Proc.P_starttime.Usec); birth != want {
		t.Fatalf("birth %q, kernel p_starttime %q", birth, want)
	}
	// ps prints the same start time to the second.
	out, err := exec.Command("/bin/ps", "-o", "lstart=", "-p", fmt.Sprint(pid)).Output()
	if err != nil {
		t.Fatal(err)
	}
	listed, err := time.ParseInLocation("Mon Jan _2 15:04:05 2006", strings.TrimSpace(string(out)), time.Local)
	if err != nil {
		t.Fatalf("ps lstart %q: %v", out, err)
	}
	if listed.Unix() != seconds {
		t.Fatalf("ps reports the process started at %d, birth says %d", listed.Unix(), seconds)
	}

	// A birth never changes while the process lives.
	time.Sleep(20 * time.Millisecond)
	if again, err := ProcessBirth(pid); err != nil || again != birth {
		t.Fatalf("birth changed from %q to %q (%v)", birth, again, err)
	}
	// Two processes never share a birth, even started back to back.
	other := exec.Command("/bin/sleep", "60")
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	otherBirth, err := ProcessBirth(other.Process.Pid)
	_ = other.Process.Kill()
	_ = other.Wait()
	if err != nil || otherBirth == birth {
		t.Fatalf("a second process has birth %q, the first %q (%v)", otherBirth, birth, err)
	}
	if own, err := ProcessBirth(os.Getpid()); err != nil || own == birth {
		t.Fatalf("this process has birth %q, the child %q (%v)", own, birth, err)
	}

	// Killed but not yet reaped, the process is a zombie: its PID and start
	// time still exist in the process table, and it is not alive.
	if err := process.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		zombie, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
		if err == nil && zombie.Proc.P_stat == 5 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the killed process never became a zombie")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if zombieBirth, err := ProcessBirth(pid); err == nil {
		t.Fatalf("a zombie answered birth %q; a process that exited has none", zombieBirth)
	}
	_ = process.Wait()
	reaped = true
	if gone, err := ProcessBirth(pid); err == nil {
		t.Fatalf("an exited process answered birth %q", gone)
	}
}
