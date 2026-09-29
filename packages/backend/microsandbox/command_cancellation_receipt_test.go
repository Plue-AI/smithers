package microsandbox

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// The host may only acknowledge cancellation when its guest kill command
// succeeded. These tests use a real executable boundary without booting a VM.
func TestGuestCommandCancellationRequiresGuestKillReceipt(t *testing.T) {
	for _, tc := range []struct {
		name string
		exit int
	}{
		{"guest kill confirms termination", 0},
		{"guest kill fails", 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "invocations")
			binary := filepath.Join(t.TempDir(), "fake-msb")
			script := fmt.Sprintf("#!/bin/sh\nprintf x >> %q\nexit %d\n", marker, tc.exit)
			require.NoError(t, os.WriteFile(binary, []byte(script), 0o700))
			finished := make(chan struct{})
			close(finished)
			command := &guestCommand{
				runtime: &Runtime{cli: &cli{binary: binary, home: t.TempDir()}},
				machine: "fixture-machine", id: "fixture-command", cmd: &exec.Cmd{}, done: finished,
			}
			for attempt := 0; attempt < 2; attempt++ {
				err := command.cancel()
				if tc.exit == 0 {
					require.NoError(t, err)
				} else {
					require.ErrorIs(t, err, workspaceapi.ErrCommandTerminationUnconfirmed)
				}
			}
			invocations, err := os.ReadFile(marker)
			require.NoError(t, err)
			require.Equal(t, "x", string(invocations), "cancellation must make one guest kill attempt")
		})
	}
}

func TestGuestCgroupKillRequiresEmptyGroup(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skipf("python3 required for guest helper test: %v", err)
	}
	helper, err := filepath.Abs(filepath.Join("guest", "smithers-guest.py"))
	require.NoError(t, err)
	for _, scenario := range []string{"populated1", "populated0", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			command := exec.Command(python, "-c", guestCgroupKillProbe, helper, scenario)
			output, runErr := command.CombinedOutput()
			if scenario == "populated1" {
				require.NoError(t, runErr, string(output))
				require.Equal(t, "unconfirmed", strings.TrimSpace(string(output)))
			} else {
				require.NoError(t, runErr, string(output))
				require.Equal(t, "confirmed", strings.TrimSpace(string(output)))
			}
		})
	}
}

const guestCgroupKillProbe = `
import os, sys, tempfile, types
namespace = {'__name__': 'guest_cancellation_test'}
with open(sys.argv[1], encoding='utf-8') as source:
    exec(compile(source.read(), sys.argv[1], 'exec'), namespace)
scenario = sys.argv[2]
base = tempfile.mkdtemp()
group = os.path.join(base, 'group')
if scenario != 'missing':
    os.mkdir(group)
    with open(os.path.join(group, 'cgroup.kill'), 'w') as target:
        target.write('')
    with open(os.path.join(group, 'cgroup.events'), 'w') as target:
        target.write('populated 1' if scenario == 'populated1' else 'populated 0')
real_rmdir = os.rmdir
def fake_rmdir(path):
    if scenario == 'populated1':
        raise AssertionError('still-populated group must not be removed')
    os.unlink(os.path.join(path, 'cgroup.kill'))
    os.unlink(os.path.join(path, 'cgroup.events'))
    real_rmdir(path)
namespace['os'] = types.SimpleNamespace(path=os.path, stat=os.stat, rmdir=fake_rmdir)
ticks = [0]
def monotonic():
    ticks[0] += 1
    return 0 if ticks[0] <= 2 else 11
namespace['time'] = types.SimpleNamespace(monotonic=monotonic, sleep=lambda _: None)
try:
    namespace['cgroup_kill'](group)
except RuntimeError:
    if scenario != 'populated1':
        raise
    print('unconfirmed')
else:
    if scenario == 'populated1':
        raise AssertionError('populated group was falsely confirmed')
    print('confirmed')
`
