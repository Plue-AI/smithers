package microsandbox

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// C-SEC-02 must run from the reviewed, approved install source, never a branch
// build as root. This artifact is an independent oracle, not production policy.
func approvedRootBoundaryRuntime(t *testing.T) (*Runtime, string) {
	t.Helper()
	if os.Getenv("SMITHERS_GUEST_ROOT_BOUNDARY_CHECK") != "1" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("approved root boundary check mode is required for microVM tests")
		}
		t.Skip("PENDING C-SEC-02: run only from the approved install source with bundled msb")
	}
	approved := os.Getenv("SMITHERS_APPROVED_GUEST_HELPER")
	require.NotEmpty(t, approved, "approved bundle helper artifact is required")
	body, err := os.ReadFile(approved)
	require.NoError(t, err)
	sum := sha256.Sum256(body)
	sourceSum := sha256.Sum256(guestHelper)
	require.Equal(t, hex.EncodeToString(sum[:]), hex.EncodeToString(sourceSum[:]), "test source must match approved install; digest equality alone does not authorize root execution")
	r := realRuntime(t, t.TempDir())
	return r, hex.EncodeToString(sum[:])
}

func TestRootBoundaryApprovedBundleStartup(t *testing.T) {
	r, digest := approvedRootBoundaryRuntime(t)
	ctx := operation("sec01-helper")
	_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "sec01-helper"})
	require.NoError(t, err)
	// T-SEC-01 R1: imports controlled by members may run only after UID drop.
	require.NoError(t, r.WriteFile(ctx, "sec01-helper", "sitecustomize.py", []byte(`import os
with open("/workspace/import-observed","a") as f: f.write(str(os.geteuid())+"\n")
`), 0o644))
	observations := 0
	probe := func() {
		result, err := r.ExecuteCommand(ctx, "sec01-helper", workspaceapi.Command{
			Args: []string{"/usr/bin/python3", "-c", `import hashlib,os
print(os.getuid(),os.getgid(),os.getgroups())
print(hashlib.sha256(open("/opt/smithers/guest/smithers-guest.py","rb").read()).hexdigest())`},
			Environment: map[string]string{"PATH": "/workspace", "PYTHONPATH": "/workspace", "LD_PRELOAD": "/workspace/absent.so"},
		})
		require.NoError(t, err)
		require.Equal(t, 0, result.ExitCode, result.Stderr)
		require.Equal(t, "19999 19999 [20000]\n"+digest+"\n", result.Stdout)
		marker, err := r.ReadFile(ctx, "sec01-helper", "import-observed")
		require.NoError(t, err)
		observations++
		require.Equal(t, strings.Repeat("19999\n", observations), string(marker), "every member import observation must be preserved")
		t.Logf("guest import observations=%q root_import_canaries=%d helper_sha256=%s", marker, strings.Count("\n"+string(marker), "\n0\n"), digest)
	}
	probe()
	// A member cannot substitute privileged executables or helper ancestors.
	// Fail before retained wake if any protected destination was writable.
	attack, err := r.ExecuteCommand(ctx, "sec01-helper", workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-S", "-c", `import os
for path in ('/opt/smithers/guest/smithers-guest.py','/opt/smithers/guest/.install-member','/usr/bin/python3'):
 try: os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o644)
 except PermissionError: print('denied',path)
 else: raise AssertionError('protected destination was writable: '+path)
try: os.rename('/opt/smithers/guest','/opt/smithers/member-guest')
except PermissionError: print('denied helper parent')
else: raise AssertionError('helper parent was replaceable')`}})
	require.NoError(t, err)
	require.Equal(t, 0, attack.ExitCode, attack.Stderr)
	require.Equal(t, "denied /opt/smithers/guest/smithers-guest.py\ndenied /opt/smithers/guest/.install-member\ndenied /usr/bin/python3\ndenied helper parent\n", attack.Stdout)
	t.Logf("protected substitutions: %s", attack.Stdout)
	require.NoError(t, r.StopWorkspace(ctx, "sec01-helper"))
	_, err = r.StartWorkspace(ctx, "sec01-helper")
	require.NoError(t, err)
	marker, err := r.ReadFile(ctx, "sec01-helper", "import-observed")
	require.NoError(t, err)
	require.Equal(t, "19999\n", string(marker), "retained wake must not import member code")
	probe()
}

func TestRootBoundaryApprovedBundleRetainedHome(t *testing.T) {
	for _, outside := range []string{"/etc", "/root"} {
		t.Run(strings.TrimPrefix(outside, "/"), func(t *testing.T) {
			r, _ := approvedRootBoundaryRuntime(t)
			ctx := operation("sec01-home")
			_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "sec01-home"})
			require.NoError(t, err)
			// Read protected OS sentinels through the production exec dispatcher.
			// The observer itself runs as agent; no root fixture is installed.
			observe := func() string {
				request, err := json.Marshal(map[string]any{
					"id": "sec01-sentinel", "user": "agent", "root": "/workspace", "cwd": "/workspace",
					"argv": []string{"/usr/bin/python3", "-I", "-S", "-c", `import hashlib,json,os
result={}
for path in ('/etc/passwd','/root'):
 s=os.stat(path)
 result[path]={'uid':s.st_uid,'gid':s.st_gid,'mode':s.st_mode}
 if path=='/etc/passwd': result[path]['sha256']=hashlib.sha256(open(path,'rb').read()).hexdigest()
print(json.dumps(result,sort_keys=True))`},
				})
				require.NoError(t, err)
				output, err := r.guest(ctx, r.machineName("sec01-home"), request, "exec", "sec01-sentinel")
				require.NoError(t, err)
				return string(output)
			}
			before := observe()
			// The member changes only its own home. No test fixture runs as root.
			result, err := r.ExecuteCommand(ctx, "sec01-home", workspaceapi.Command{Args: []string{"/bin/sh", "-c", fmt.Sprintf(`rm -rf /home/agent/.config; ln -s %s /home/agent/.config`, outside)}})
			require.NoError(t, err)
			require.Equal(t, 0, result.ExitCode, result.Stderr)
			require.NoError(t, r.StopWorkspace(ctx, "sec01-home"))
			_, err = r.StartWorkspace(ctx, "sec01-home")
			require.Error(t, err, "retained setup must refuse a symlinked member-home ancestor")
			after := observe()
			require.Equal(t, before, after, "outside sentinel bytes, owners and modes must survive refused retained wake")
			t.Logf("outside=%s before=%s after=%s", outside, before, after)
		})
	}
}

func TestRootBoundaryApprovedBundleDispatch(t *testing.T) {
	r, _ := approvedRootBoundaryRuntime(t)
	ctx := operation("sec01-envelope")
	_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "sec01-envelope"})
	require.NoError(t, err)
	result, err := r.ExecuteCommand(ctx, "sec01-envelope", workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-S", "-c", `import os; print(os.getuid(),os.getgid(),os.getgroups())`}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stderr)
	require.Equal(t, "19999 19999 [20000]\n", result.Stdout)
	terminal, err := r.OpenWorkspaceTerminal(ctx, "sec01-envelope", workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-S", "-c", `import os; print(os.getuid(),os.getgid(),os.getgroups())`}})
	require.NoError(t, err)
	defer terminal.Close()
	output, err := io.ReadAll(terminal)
	if err != nil {
		require.ErrorIs(t, err, syscall.EIO)
	}
	require.Contains(t, string(output), "19999 19999 [20000]")
	// Production relay dispatch and file entry receive real guest processes.
	_, err = r.StartService(ctx, "sec01-envelope", workspaceapi.ServiceSpec{Name: "sec01-http", Command: workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-S", "-m", "http.server", "18080", "--bind", "127.0.0.1"}}, ReadyAddress: "127.0.0.1:18080", ReadyTimeout: 30 * time.Second})
	require.NoError(t, err)
	conn, err := r.DialWorkspacePort(ctx, "sec01-envelope", workspaceapi.PortRequest{Port: 18080})
	require.NoError(t, err)
	_, err = conn.Write([]byte("GET / HTTP/1.0\r\nHost: guest\r\n\r\n"))
	require.NoError(t, err)
	header, err := bufio.NewReader(conn).ReadString('\n')
	require.NoError(t, err)
	require.Contains(t, header, "200")
	require.NoError(t, conn.Close())
	// Literal refusal envelopes from T-SEC-01 R3; no root payload is executed.
	valid := `{"id":"sec01-control","user":"agent","root":"/workspace","cwd":"/workspace","argv":["/usr/bin/printf","positive-control\n"]}`
	control, err := r.guest(ctx, r.machineName("sec01-envelope"), []byte(valid), "exec", "sec01-control")
	require.NoError(t, err, "paired valid envelope must execute")
	require.Equal(t, "positive-control\n", string(control))
	for _, fixture := range []struct{ name, body, refusal string }{
		{"malformed", `{`, "Expecting property name enclosed in double quotes"},
		{"array", `[]`, "invalid exec payload"},
		{"root", strings.Replace(valid, `"agent"`, `"root"`, 1), "invalid exec payload"},
		{"other-user", strings.Replace(valid, `"agent"`, `"other"`, 1), "invalid exec payload"},
		{"traversal", strings.Replace(valid, `"sec01-control"`, `"../escape"`, 1), "invalid exec payload"},
		{"unknown", strings.TrimSuffix(valid, "}") + `,"extra":1}`, "invalid exec payload"},
		// T-SEC-01 R3: valid JSON with only an oversized payload value.
		{"oversized", strings.Replace(valid, `/usr/bin/printf`, strings.Repeat("x", 1048577), 1), "request exceeds limit"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			_, err := r.cli.run(ctx, []byte(fixture.body), guestArgs(r.machineName("sec01-envelope"), nil, false, "exec", "sec01-control")...)
			require.Error(t, err)
			var refused *cliError
			require.True(t, errors.As(err, &refused), "must reach guest dispatch")
			require.Contains(t, refused.stderr, fixture.refusal, "must refuse by policy, not transport")
		})
	}
	require.NoError(t, r.WriteFile(ctx, "sec01-envelope", "positive.txt", []byte("positive fixture\n"), 0o640))
	body, err := r.ReadFile(ctx, "sec01-envelope", "positive.txt")
	require.NoError(t, err)
	require.Equal(t, "positive fixture\n", string(body))
	_, err = r.ReadFile(ctx, "sec01-envelope", "../../etc/passwd")
	require.Error(t, err)
	_, err = r.guest(ctx, r.machineName("sec01-envelope"), nil, "kill", "../escape")
	require.Error(t, err)
	_, err = r.guest(ctx, r.machineName("sec01-envelope"), nil, "relay", "65536")
	require.Error(t, err)
	_, err = r.guest(ctx, r.machineName("sec01-envelope"), nil, "bridge", "4000", "outside.example")
	require.Error(t, err)
}
