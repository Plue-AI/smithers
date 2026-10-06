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
		t.Logf("R1 observation=%d helperSHA256=%s identity=%q importCanary=%q", observations, digest, result.Stdout, marker)
		require.Equal(t, strings.Repeat("19999\n", observations), string(marker), "every member import observation must be preserved")
	}
	probe()
	require.NoError(t, r.StopWorkspace(ctx, "sec01-helper"))
	_, err = r.StartWorkspace(ctx, "sec01-helper")
	require.NoError(t, err)
	marker, err := r.ReadFile(ctx, "sec01-helper", "import-observed")
	require.NoError(t, err)
	require.Equal(t, "19999\n", string(marker), "retained wake must not import member code")
	probe()
}

func TestRootBoundaryApprovedBundleRetainedHome(t *testing.T) {
	for _, fixture := range []struct{ name, memberPath, outside string }{
		{"etc", "/home/agent/.config", "/etc"},
		{"root", "/home/agent/.config", "/root"},
		{"leaf", "/home/agent/.cache", "/var/lib/smithers/state/sec01-outside"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			outside := fixture.outside
			r, _ := approvedRootBoundaryRuntime(t)
			ctx := operation("sec01-home")
			_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "sec01-home"})
			require.NoError(t, err)
			rootBoundaryMemberProbe(t, r, "sec01-home", "import os; p='/var/lib/smithers/state/sec01-outside'; open(p,'wb').write(b'outside sentinel\\n'); os.chmod(p,0o640); print('sentinel-created')")
			// Observe outside sentinels as the member, never as root.
			before := rootBoundaryOutsideFacts(t, r, "sec01-home")
			// The member changes only its own home. No test fixture runs as root.
			result, err := r.ExecuteCommand(ctx, "sec01-home", workspaceapi.Command{Args: []string{"/bin/sh", "-c", fmt.Sprintf(`rm -rf %s; ln -s %s %s`, fixture.memberPath, outside, fixture.memberPath)}})
			require.NoError(t, err)
			require.Equal(t, 0, result.ExitCode, result.Stderr)
			require.NoError(t, r.StopWorkspace(ctx, "sec01-home"))
			_, err = r.StartWorkspace(ctx, "sec01-home")
			require.Error(t, err, "retained setup must refuse a symlinked member-home ancestor")
			require.Contains(t, err.Error(), "guest setup")
			require.True(t, strings.Contains(err.Error(), "home_defaults") || strings.Contains(err.Error(), "Not a directory"), "must refuse the home path, not fail transport: %v", err)
			refusal := err.Error()
			// Failed preparation stops the VM. Boot only to observe and repair
			// the member fixture through the digest-pinned helper's UID drop.
			_, err = r.cli.run(ctx, nil, "start", r.machineName("sec01-home"))
			require.NoError(t, err)
			after := rootBoundaryOutsideFacts(t, r, "sec01-home")
			require.JSONEq(t, before, after, "outside sentinel bytes, owner and mode must survive refusal")
			rootBoundaryMemberProbe(t, r, "sec01-home", fmt.Sprintf("import os; os.unlink(%q); print('restored')", fixture.memberPath))
			_, err = r.cli.run(ctx, nil, "stop", r.machineName("sec01-home"))
			require.NoError(t, err)
			_, err = r.StartWorkspace(ctx, "sec01-home")
			require.NoError(t, err, "restored retained home is the paired positive control")
			require.JSONEq(t, before, rootBoundaryOutsideFacts(t, r, "sec01-home"))
			t.Logf("R2 target=%s before=%s after=%s refusal=%q restored=true", outside, before, after, refusal)
		})
	}
}

func TestRootBoundaryApprovedBundleDispatch(t *testing.T) {
	r, _ := approvedRootBoundaryRuntime(t)
	ctx := operation("sec01-envelope")
	_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "sec01-envelope"})
	require.NoError(t, err)
	probe := func(phase string) {
		t.Run(phase, func(t *testing.T) {
			result, err := r.ExecuteCommand(ctx, "sec01-envelope", workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-S", "-c", `import os; print(os.getuid(),os.getgid(),os.getgroups())`}})
			require.NoError(t, err)
			require.Equal(t, 0, result.ExitCode, result.Stderr)
			require.Equal(t, "19999 19999 [20000]\n", result.Stdout)
			t.Logf("R3 phase=%s commandIdentity=%q", phase, result.Stdout)
			terminal, err := r.OpenWorkspaceTerminal(ctx, "sec01-envelope", workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-S", "-c", `import os; print(os.getuid(),os.getgid(),os.getgroups())`}})
			require.NoError(t, err)
			defer terminal.Close()
			output, err := io.ReadAll(terminal)
			if err != nil {
				require.ErrorIs(t, err, syscall.EIO)
			}
			require.Contains(t, string(output), "19999 19999 [20000]")
			t.Logf("R3 phase=%s terminalIdentity=%q", phase, output)
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
			valid := `{"id":"sec01-control","user":"agent","root":"/workspace","cwd":"/workspace","argv":["/usr/bin/printf","sec01-control\n"]}`
			control, err := r.guest(ctx, r.machineName("sec01-envelope"), []byte(valid), "exec", "sec01-control")
			require.NoError(t, err, "paired valid envelope must execute")
			require.Equal(t, "sec01-control\n", string(control))

			for _, invalidID := range []string{"", "../escape", "/root", "other/name"} {
				_, err := r.guest(ctx, r.machineName("sec01-envelope"), []byte(valid), "exec", invalidID)
				require.ErrorContains(t, err, "invalid exec identity", "fixed identity must be checked before consuming the payload")
				t.Logf("R3 phase=%s fixedID=%q refusal=%q", phase, invalidID, err)
			}
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
					t.Logf("R3 phase=%s fixture=%s refusal=%q", phase, fixture.name, refused.stderr)
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
			require.NoError(t, r.StopService(ctx, "sec01-envelope", "sec01-http"))

		})
	}
	probe("fresh")
	require.NoError(t, r.StopWorkspace(ctx, "sec01-envelope"))
	_, err = r.StartWorkspace(ctx, "sec01-envelope")
	require.NoError(t, err)
	probe("retained")
}

// The observer payload executes only after the production helper drops to the
// fixed member identity. It also works after a refused retained preparation,
// when the public workspace remains stopped and must not admit normal work.
func rootBoundaryMemberProbe(t *testing.T, r *Runtime, id, script string) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"id": "sec01-observe", "user": "agent", "root": "/workspace", "cwd": "/workspace",
		"argv": []string{"/usr/bin/python3", "-I", "-S", "-c", "import os; assert os.getuid()==19999 and os.getgid()==19999 and os.getgroups()==[20000]; " + script},
	})
	require.NoError(t, err)
	output, err := r.guest(operation("sec01-observe"), r.machineName(id), body, "exec", "sec01-observe")
	require.NoError(t, err)
	require.NotEmpty(t, output, "a failed observer cannot prove absence")
	return strings.TrimSpace(string(output))
}

func rootBoundaryOutsideFacts(t *testing.T, r *Runtime, id string) string {
	t.Helper()
	body := rootBoundaryMemberProbe(t, r, id, `import hashlib,json,stat
facts={}
for path in ('/etc/passwd','/etc/group','/root','/var/lib/smithers/state/sec01-outside'):
 info=os.lstat(path)
 facts[path]={'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode)}
 if stat.S_ISREG(info.st_mode):
  data=open(path,'rb').read()
  facts[path].update(sha256=hashlib.sha256(data).hexdigest(),bytes=len(data))
 if path=='/var/lib/smithers/state/sec01-outside': facts[path]['content']=data.decode()
print(json.dumps(facts,sort_keys=True))`)
	var facts map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(body), &facts))
	var sentinel struct {
		UID     int    `json:"uid"`
		GID     int    `json:"gid"`
		Mode    int    `json:"mode"`
		Content string `json:"content"`
	}
	require.NoError(t, json.Unmarshal(facts["/var/lib/smithers/state/sec01-outside"], &sentinel))
	require.Equal(t, 19999, sentinel.UID)
	require.Equal(t, 19999, sentinel.GID)
	require.Equal(t, 0o640, sentinel.Mode)
	require.Equal(t, "outside sentinel\n", sentinel.Content)
	return body
}
