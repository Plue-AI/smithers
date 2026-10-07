package microsandbox

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The subprocess substitutes the VM transport. Guest recovery itself is tested
// with real journals/forks separately; this checks startup ordering and refusal.
func startupRecoveryTransport(t *testing.T, failed string) (*Runtime, *workspace, string) {
	t.Helper()
	r, _ := admissionFixture()
	r.semaphore = make(chan struct{}, 1)
	r.root = t.TempDir()
	r.owner = "smithers-backend-0123456789abcdef"
	require.NoError(t, os.MkdirAll(filepath.Join(r.root, "workspaces"), 0700))
	ws := addReclaimWorkspace(t, r, "startup", string(workspaceapi.WorkspaceStopped), "")
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	binary, log := filepath.Join(r.root, "msb"), filepath.Join(r.root, "calls")
	script := fmt.Sprintf(`#!%s
import hashlib,json,sys
args=sys.argv[1:]
if args[0]=='exec':
 if args[-1]=='install':
  op='install'
  assert hashlib.sha256(sys.stdin.buffer.read()).hexdigest()==%q
 else:
  operands=args[args.index('run')+1:];op=operands[0]
  assert op in ('kill-all','recover-files') and len(operands)==1,operands
  assert sys.stdin.buffer.read()==b''
else:op=args[0]
with open(%q,'a') as out:out.write(op+'\n')
if op==%q:
 sys.stderr.write('injected '+op+' failure\n');sys.exit(125)
if op=='list':print(json.dumps([{'name':%q,'status':'running'}]))
`, python, guestHelperDigest, log, failed, ws.Machine)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: r.root}
	return r, ws, log
}

func TestCleanupGuestRecoversOnlyAfterTrustedInstallAndCollection(t *testing.T) {
	for _, failed := range []string{"", "install", "kill-all", "recover-files"} {
		t.Run("failure="+failed, func(t *testing.T) {
			r, ws, log := startupRecoveryTransport(t, failed)
			err := r.cleanupGuest(t.Context(), ws.Machine)
			if failed == "" {
				require.NoError(t, err)
			} else {
				require.ErrorIs(t, err, ErrUnavailable)
				require.ErrorContains(t, err, "injected "+failed+" failure")
			}
			want := []string{"install", "kill-all", "recover-files"}
			if failed == "install" {
				want = want[:1]
			} else if failed == "kill-all" {
				want = want[:2]
			}
			require.Equal(t, want, invocations(t, log))
		})
	}
}

func TestRetainedWorkspaceRecoveryFailurePreventsPreparationAndAdmission(t *testing.T) {
	r, ws, log := startupRecoveryTransport(t, "recover-files")
	_, err := r.StartWorkspace(t.Context(), ws.ID)
	require.ErrorIs(t, err, ErrUnavailable)
	require.ErrorContains(t, err, "injected recover-files failure")
	require.Equal(t, []string{"list", "install", "kill-all", "recover-files", "stop"}, invocations(t, log))
	require.Equal(t, string(workspaceapi.WorkspaceStopped), readReclaimMetadata(t, ws).State)
	require.False(t, ws.guestOK)
	require.False(t, ws.booting)
	require.Zero(t, r.InUse())
	_, err = r.ExecuteCommand(t.Context(), ws.ID, workspaceapi.Command{Args: []string{"echo", "must not run"}})
	require.Error(t, err)
	require.NotContains(t, strings.Join(invocations(t, log), "\n"), "setup")
	require.Equal(t, []string{"list", "install", "kill-all", "recover-files", "stop"}, invocations(t, log))
}
