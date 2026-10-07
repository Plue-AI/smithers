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
def fake_rmdir(path, **kwargs):
    path = os.path.join(base, path)
    if scenario == 'populated1':
        raise AssertionError('still-populated group must not be removed')
    os.unlink(os.path.join(path, 'cgroup.kill'))
    os.unlink(os.path.join(path, 'cgroup.events'))
    real_rmdir(path)
namespace['CGROUP_ROOT'] = base
class OS:
    def __getattr__(self, name): return getattr(os, name)
    rmdir = staticmethod(fake_rmdir)
namespace['os'] = OS()
namespace['ROOT_UID'] = os.getuid()
namespace['safe_directory'] = lambda path, **kwargs: os.open(path, os.O_RDONLY | os.O_DIRECTORY)
ticks = [0]
def monotonic():
    ticks[0] += 1
    return 0 if ticks[0] <= 2 else 11
namespace['time'] = types.SimpleNamespace(monotonic=monotonic, sleep=lambda _: None)
try:
    namespace['cgroup_kill'](group)
except RuntimeError as error:
    assert str(error)=="command cgroup remains populated after cancellation", error
    if scenario != 'populated1':
        raise
    print('unconfirmed')
else:
    if scenario == 'populated1':
        raise AssertionError('populated group was falsely confirmed')
    print('confirmed')
`

func TestServiceStopRequiresConfirmedGuestTermination(t *testing.T) {
	for _, method := range []string{"stop", "manage stop", "manage restart"} {
		for _, confirmed := range []bool{false, true} {
			if method == "manage restart" && confirmed {
				continue
			}
			t.Run(fmt.Sprintf("%s/confirmed=%t", method, confirmed), func(t *testing.T) {
				marker := filepath.Join(t.TempDir(), "invocations")
				binary := filepath.Join(t.TempDir(), "fake-msb")
				exit := 7
				if confirmed {
					exit = 0
				}
				require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf("#!/bin/sh\nprintf x >> %q\nexit %d\n", marker, exit)), 0700))
				finished := make(chan struct{})
				close(finished)
				runtime := &Runtime{cli: &cli{binary: binary, home: t.TempDir()}, workspaces: map[string]*workspace{}}
				ws := newWorkspace(metadata{ID: "workspace", Machine: "fixture-machine", State: "running"}, "")
				service := &managedService{spec: workspaceapi.ServiceSpec{Name: "app"}, command: &guestCommand{runtime: runtime, machine: ws.Machine, id: "fixture-command", cmd: &exec.Cmd{}, done: finished, stdout: &limitedBuffer{}, stderr: &limitedBuffer{}}}
				_, err := service.command.stderr.Write([]byte("\x00SMITHERS-EXIT 0\x00"))
				require.NoError(t, err)
				ws.services["app"] = service
				sibling := &managedService{spec: workspaceapi.ServiceSpec{Name: "other"}, command: &guestCommand{done: make(chan struct{}), stdout: &limitedBuffer{}, stderr: &limitedBuffer{}}}
				ws.services["other"] = sibling
				runtime.workspaces[ws.ID] = ws
				stop := func() error {
					if method == "stop" {
						return runtime.StopService(t.Context(), ws.ID, "app")
					}
					action := strings.TrimPrefix(method, "manage ")
					_, err := runtime.ManageService(t.Context(), ws.ID, "app", action)
					return err
				}
				for attempt := 0; attempt < 2; attempt++ {
					err := stop()
					if confirmed {
						require.NoError(t, err)
					} else {
						require.ErrorIs(t, err, workspaceapi.ErrCommandTerminationUnconfirmed)
					}
					require.Equal(t, confirmed, service.stopped, "failed broker termination must not publish stopped")
				}
				observed, err := runtime.InspectService(t.Context(), ws.ID, "app")
				require.NoError(t, err)
				if confirmed {
					require.Equal(t, workspaceapi.ServiceStopped, observed.State)
				} else {
					require.Equal(t, workspaceapi.ServiceExited, observed.State)
				}
				require.Same(t, service, ws.services["app"], "failed stop cannot restart the service")
				require.False(t, sibling.stopped)
				require.False(t, sibling.command.finished())
				calls, err := os.ReadFile(marker)
				require.NoError(t, err)
				require.Equal(t, "x", string(calls))
			})
		}
	}
}
