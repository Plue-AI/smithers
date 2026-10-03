package microsandbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
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
func guestArgs(machine string, _ map[string]string, stream bool, subcommand ...string) []string {
	args := []string{"exec"}
	if stream {
		args = append(args, "--stream")
	}
	args = append(args, "-e", "PATH=/usr/bin:/bin", "-e", "PYTHONPATH=", "-e", "LD_PRELOAD=", "-e", "LD_LIBRARY_PATH=")
	args = append(args, machine, "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "PYTHONPATH=", "/usr/bin/python3", "-I", "-S", "-c", pinnedGuestBootstrap(), guestHelperDigest, "run")
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

// installGuest atomically installs digest-checked install-controlled helper bytes.
func (r *Runtime) installGuest(ctx context.Context, machine string) error {
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	args := guestArgs(machine, nil, false)
	args[len(args)-1] = "install"
	if _, err := r.cli.run(callCtx, guestHelper, args...); err != nil {
		return fmt.Errorf("%w: install guest helper in %s: %v", ErrUnavailable, machine, err)
	}
	return nil
}

// Retained wake and recovery must install trusted bytes before their first
// cleanup helper, including when the retained machine has an older helper.
func (r *Runtime) cleanupGuest(ctx context.Context, machine string) error {
	if err := r.installGuest(ctx, machine); err != nil {
		return err
	}
	_, err := r.guest(ctx, machine, nil, "kill-all")
	return err
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

// The isolated base interpreter validates each ancestor by descriptor and executes
// the bytes it hashed, avoiding a check/open replacement window.
const guestBootstrap = `import os,stat,sys,hashlib,secrets
os.umask(0o022)
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
for name in ('opt','smithers','guest'):
 try: os.mkdir(name,0o755,dir_fd=fd)
 except FileExistsError: pass
 child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
 info=os.fstat(child)
 if info.st_uid != 0 or info.st_mode & 0o022: raise RuntimeError('untrusted helper ancestor')
 os.close(fd); fd=child
name='smithers-guest.py'
if sys.argv[2]=='install':
 body=sys.stdin.buffer.read(1048577)
 if len(body)>1048576 or hashlib.sha256(body).hexdigest()!=sys.argv[1]: raise RuntimeError('helper digest mismatch')
 temporary='.install-'+secrets.token_hex(16)
 out=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644,dir_fd=fd)
 with os.fdopen(out,'wb') as handle: handle.write(body); handle.flush(); os.fsync(handle.fileno())
 os.rename(temporary,name,src_dir_fd=fd,dst_dir_fd=fd)
else:
 source=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 with os.fdopen(source,'rb') as handle:
  info=os.fstat(handle.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022: raise RuntimeError('untrusted helper')
  body=handle.read(1048577)
 if len(body)>1048576 or hashlib.sha256(body).hexdigest()!=sys.argv[1]: raise RuntimeError('helper digest mismatch')
 sys.argv=['/opt/smithers/guest/smithers-guest.py']+sys.argv[3:]
 exec(compile(body,sys.argv[0],'exec'),{'__name__':'__main__','ROOT_RECIPE_DIGESTS':ROOT_RECIPE_DIGESTS})
`

// These identities come from binary-owned constants, never request data.
func scriptDigest(script string) string {
	sum := sha256.Sum256([]byte(script))
	return hex.EncodeToString(sum[:])
}

func pinnedGuestBootstrap() string {
	pins, _ := json.Marshal(map[string]string{
		scriptDigest(playwrightSystemPackages): "apt",
		scriptDigest(rootMarkerScript):         "marker",
	})
	return "import json\nROOT_RECIPE_DIGESTS=json.loads(" + strconv.Quote(string(pins)) + ")\n" + guestBootstrap
}
