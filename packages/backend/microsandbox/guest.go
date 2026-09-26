package microsandbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed guest/smithers-guest.py
var guestHelper []byte

const (
	guestHelperDir  = "/opt/smithers/guest"
	guestHelperPath = guestHelperDir + "/smithers-guest.py"
)

var guestHelperDigest = func() string {
	sum := sha256.Sum256(guestHelper)
	return hex.EncodeToString(sum[:])
}()

// guestArgs is the msb argv that runs one helper subcommand in a machine.
func guestArgs(machine string, env map[string]string, stream bool, subcommand ...string) []string {
	args := []string{"exec"}
	if stream {
		args = append(args, "--stream")
	}
	for key, value := range env {
		args = append(args, "-e", key+"="+value)
	}
	args = append(args, machine, "--", "python3", guestHelperPath)
	return append(args, subcommand...)
}

// guest runs one short helper subcommand and returns its stdout.
func (r *Runtime) guest(ctx context.Context, machine string, stdin []byte, subcommand ...string) ([]byte, error) {
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	output, err := r.cli.run(callCtx, stdin, guestArgs(machine, nil, false, subcommand...)...)
	if err != nil {
		return output, fmt.Errorf("%w: guest %s in %s: %v", ErrUnavailable, subcommand[0], machine, err)
	}
	return output, nil
}

// installGuest plants the helper when the guest does not hold this exact
// version. The digest check makes a backend upgrade replace an older helper.
func (r *Runtime) installGuest(ctx context.Context, machine string) error {
	check := fmt.Sprintf("test \"$(sha256sum %s 2>/dev/null | cut -d' ' -f1)\" = %s", guestHelperPath, guestHelperDigest)
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if _, err := r.cli.run(callCtx, nil, "exec", machine, "--", "sh", "-c", check); err == nil {
		return nil
	}
	install := fmt.Sprintf("set -e; mkdir -p %s; umask 022; cat > %s.tmp; mv %s.tmp %s; command -v python3 >/dev/null",
		guestHelperDir, guestHelperPath, guestHelperPath, guestHelperPath)
	if _, err := r.cli.run(callCtx, guestHelper, "exec", machine, "--", "sh", "-c", install); err != nil {
		return fmt.Errorf("%w: install guest helper in %s: %v", ErrUnavailable, machine, err)
	}
	return nil
}

// killOrphanClients ends `msb exec` clients left by a backend process that
// died without killing its children. macOS has no parent-death signal, and a
// surviving client would keep its guest session alive.
func killOrphanClients(binary, machinePrefix string) {
	output, err := exec.Command("/bin/ps", "-axo", "pid=,ppid=,command=").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[1] != "1" || fields[2] != binary || fields[3] != "exec" {
			continue
		}
		if !bytes.Contains([]byte(line), []byte(" "+machinePrefix)) {
			continue
		}
		if pid, err := strconv.Atoi(fields[0]); err == nil && pid > 1 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}
