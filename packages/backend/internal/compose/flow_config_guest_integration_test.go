package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Reference-host body, using the same composed setup router and dispatcher as
// the image rehearsal. No process runtime or recording msb can qualify it.
// Identity literals follow spec §5.5.1 (19999 supersedes this ticket's 1500).
func TestInstallStoredConfigGuestBoundary(t *testing.T) {
	if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") != "1" {
		t.Skip("reference host: set SMITHERS_REQUIRE_MICROVM_TESTS=1 and provide the approved install bundle")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	require.NotEmpty(t, os.Getenv("SMITHERS_TEST_DATABASE_URL"))
	require.NotEmpty(t, os.Getenv("SMITHERS_CHECK_BUNDLE"))
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err)
	manifest, err := bundle.Expect("SMITHERS_FLOW_HOST_MANIFEST", "", "bin/flow-hosts.json", false)
	require.NoError(t, err)
	registry, err := flowmanifest.Load(manifest)
	require.NoError(t, err)
	msb, err := bundle.Expect("SMITHERS_MICROSANDBOX_BIN", os.Getenv("SMITHERS_MICROSANDBOX_BIN"), "bin/msb", true)
	require.NoError(t, err)
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", msb)
	profile, err := microsandbox.Detect(t.TempDir())
	require.NoError(t, err)
	fixture := rootLayerCodingFixture{bundle: bundle, registry: registry, profile: profile}
	t.Logf("approved bundle revision=%s manifest=%s", bundle.Revision(), bundle.ManifestSHA256())

	for _, scenario := range []string{"valid", "missing-defaults-recovery", "hostile-main", "symlink-main"} {
		t.Run(scenario, func(t *testing.T) {
			h := startRootLayerHarnessRuntime(t, true, fixture)
			marker := "/var/tmp/flw02-" + uuid.NewString()
			_, err := os.Lstat(marker)
			require.True(t, os.IsNotExist(err), "the host canary must start absent")
			files := map[string]string{
				"go.mod":     "module example.com/fixture\n\ngo 1.26.8\n",
				"x.go":       "package fixture\n",
				"JOURNEY.md": "Add a greeting to JOURNEY.md\n",
				"boundary_test.go": fmt.Sprintf(`package fixture
import("os";"testing")
func TestGuestBoundary(t *testing.T){
 if os.Getuid()!=19999 || os.Getgid()!=19999 {t.Fatalf("identity before payload: %%d:%%d",os.Getuid(),os.Getgid())}
 if err:=os.WriteFile(%q,[]byte("agent-check:19999:19999"),0600);err!=nil{t.Fatal(err)}
 t.Log("agent-check:19999:19999")
}
`, marker),
			}
			if scenario == "hostile-main" {
				files[".smithers/coding-project.json"] = fmt.Sprintf(`{"seats":{"coding/implement":"$(touch %s)"},"rootCommand":"touch %s"}`, marker, marker)
			}
			if scenario == "symlink-main" {
				files[".smithers/coding-project.json"] = symlinkPrefix + marker
			}
			h.commitMain(files)
			h.runSetupThroughSource()
			var stored []byte
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT value FROM install_settings WHERE key=$1`, services.InstallCodingProjectKey).Scan(&stored))
			state, message := h.runMachine(t, "flw02-"+scenario)
			require.Equal(t, "done", state, message)
			require.Eventually(t, func() bool {
				var stack struct {
					State string `json:"state"`
				}
				return json.Unmarshal(h.expect("GET", "/api/repos/rehearsal-owner/app/mythical", "", 200), &stack) == nil && stack.State == "active"
			}, time.Minute, 100*time.Millisecond)
			if scenario == "missing-defaults-recovery" {
				_, err = h.pool.Exec(t.Context(), `DELETE FROM install_settings WHERE key=$1`, services.InstallCodingProjectKey)
				require.NoError(t, err)
			}
			accepted := h.expect("POST", "/api/todos", `{"title":"First TODO","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, 202)
			var admitted struct {
				N int64 `json:"n"`
			}
			require.NoError(t, json.Unmarshal(accepted, &admitted))
			require.EqualValues(t, 1, admitted.N)
			readTodo := func() services.MythicalItemView {
				var todo services.MythicalItemView
				require.NoError(t, json.Unmarshal(h.expect("GET", "/api/todos/1", "", 200), &todo))
				return todo
			}
			wait := func(want string) {
				require.Eventually(t, func() bool { return readTodo().State == want }, 15*time.Minute, 250*time.Millisecond, "TODO never reached %s: %s", want, h.logs.String())
			}
			if scenario != "valid" {
				wait("failed")
				_, err = os.Lstat(marker)
				require.True(t, os.IsNotExist(err), "refused main/defaults must not execute on the host")
				var snapshots int
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key LIKE 'coding.snapshot:todo:%'`).Scan(&snapshots))
				if scenario == "hostile-main" {
					// Unknown fields reach only the canonical guest loader as
					// pinned data; that loader refuses them before planning.
					require.Equal(t, 1, snapshots)
					var workspace string
					require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=1`).Scan(&workspace))
					observed, err := h.runtime.ExecuteCommand(h.ctx(t), workspace, workspaceapi.Command{Args: []string{"python3", "-c", `import glob,json,os,sys
assert (os.getuid(),os.getgid())==(19999,19999)
paths=glob.glob('/var/tmp/smithers/smithers-project-*/project.json')+glob.glob('/tmp/smithers-project-*/project.json')
assert paths
for path in paths:
 with open(path) as source: data=json.load(source)
 assert data['rootCommand']=='touch '+sys.argv[1]
 assert data['seats']['coding/implement']=='$(touch '+sys.argv[1]+')'
assert not os.path.exists(sys.argv[1])
print('hostile-data:19999:19999')`, marker}})
					require.NoError(t, err)
					require.Equal(t, 0, observed.ExitCode, observed.Stdout+observed.Stderr)
					require.Contains(t, observed.Stdout, "hostile-data:19999:19999")
				} else {
					require.Zero(t, snapshots, "missing defaults and invalid main must refuse before pinning")
				}
				if scenario != "missing-defaults-recovery" {
					return
				}
				_, err = h.pool.Exec(t.Context(), `INSERT INTO install_settings(key,value) VALUES($1,$2::jsonb)`, services.InstallCodingProjectKey, stored)
				require.NoError(t, err)
				h.expect("POST", "/api/todos/1", `{"op":"retry","steer":"Use the restored install configuration"}`, 202)
			}
			wait("in_review")
			var workspace string
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=1`).Scan(&workspace))
			require.NotEmpty(t, workspace)
			// Observe identity before opening config or check payload bytes. The
			// check's guest marker is the positive control for the absent host one.
			observed, err := h.runtime.ExecuteCommand(h.ctx(t), workspace, workspaceapi.Command{Args: []string{"python3", "-c", `import glob,json,os,stat,sys
assert (os.getuid(),os.getgid())==(19999,19999)
paths=glob.glob('/var/tmp/smithers/smithers-project-*/project.json')+glob.glob('/tmp/smithers-project-*/project.json')
assert paths,'no delivered configuration'
for path in paths:
 info=os.stat(path,follow_symlinks=False)
 assert info.st_uid==19999 and stat.S_IMODE(info.st_mode)==0o600 and not path.startswith('/workspace/')
 with open(path) as source: project=json.load(source)
 assert [c['id'] for c in project['checks']]==['test']
 assert [c['argv'] for c in project['detected']]==[['go','test','./...']]
 assert [p['id'] for p in project['pages']]==['overview','architecture']
with open(sys.argv[1]) as check: assert check.read()=='agent-check:19999:19999'
print('config-and-check:19999:19999')`, marker}})
			require.NoError(t, err)
			require.Equal(t, 0, observed.ExitCode, observed.Stdout+observed.Stderr)
			require.Contains(t, observed.Stdout, "config-and-check:19999:19999")
			_, err = os.Lstat(marker)
			require.True(t, os.IsNotExist(err), "the guest positive control must remain absent on the host")
			// Relative cwd is branch data; a symlink into root must refuse as
			// agent, while argv and env shell text remain unprivileged guest data.
			command, err := h.runtime.ExecuteCommand(h.ctx(t), workspace, workspaceapi.Command{Args: []string{"/bin/sh", "-ec", `test "$(id -u):$(id -g)" = 19999:19999; ln -s /root hostile-cwd; printf '%s' "$FLW02_LITERAL"`}, Environment: map[string]string{"FLW02_LITERAL": "$(touch " + marker + ")"}})
			require.NoError(t, err)
			require.Equal(t, 0, command.ExitCode, command.Stderr)
			require.Equal(t, "$(touch "+marker+")", command.Stdout)
			refused, err := h.runtime.ExecuteCommand(h.ctx(t), workspace, workspaceapi.Command{Args: []string{"/bin/sh", "-ec", "touch " + marker}, Directory: "hostile-cwd"})
			require.True(t, err != nil || refused.ExitCode != 0, "root cwd must not execute a branch check")
			_, err = os.Lstat(marker)
			require.True(t, os.IsNotExist(err))
			paths := h.git("--git-dir", h.bare, "ls-tree", "-r", "--name-only", "main")
			for _, name := range strings.Fields(paths) {
				require.False(t, strings.HasPrefix(name, ".smithers/") || strings.HasPrefix(name, "flows/"))
			}
		})
	}
}
