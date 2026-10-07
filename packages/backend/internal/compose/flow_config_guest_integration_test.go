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
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
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
			marker := flw02Canary(t)
			files := flw02Repository(marker)
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
			flw02StackActive(t, h)
			if scenario == "missing-defaults-recovery" {
				_, err = h.pool.Exec(t.Context(), `DELETE FROM install_settings WHERE key=$1`, services.InstallCodingProjectKey)
				require.NoError(t, err)
			}
			flw02FileTodo(t, h)
			if scenario != "valid" {
				flw02WaitTodo(t, h, "failed")
				_, err = os.Lstat(marker)
				require.True(t, os.IsNotExist(err), "refused main/defaults must not execute on the host")
				var snapshots int
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key LIKE 'coding.snapshot:todo:%'`).Scan(&snapshots))
				if scenario == "hostile-main" {
					// Unknown fields reach only the canonical guest loader as
					// pinned data; that loader refuses them before planning.
					require.Equal(t, 1, snapshots)
					observed, err := h.runtime.ExecuteCommand(h.ctx(t), flw02Workspace(t, h), workspaceapi.Command{Args: []string{"python3", "-c", `import glob,json,os,sys
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
				// T-INS-06: Source ready's persisted defaults are the provider;
				// restoring them and pressing Retry recovers the same TODO.
				_, err = h.pool.Exec(t.Context(), `INSERT INTO install_settings(key,value) VALUES($1,$2::jsonb)`, services.InstallCodingProjectKey, stored)
				require.NoError(t, err)
				h.expect("POST", "/api/todos/1", `{"op":"retry","steer":"Use the restored install configuration"}`, 202)
			}
			flw02WaitTodo(t, h, "in_review")
			flw02RequireAgentConfigAndCheck(t, h, marker)
		})
	}

	// Each Scope provider the install composes, removed in turn. The TODO
	// must hold before its effect (no flow launch, configuration snapshot or
	// check, and no host canary), then recover once the provider is supplied.
	// The fault is the provider's absence, never a fabricated result.
	hold := 30 * time.Second
	for _, provider := range []struct {
		name string
		// omit composes the install without the provider; recover supplies it.
		omit func(*Options)
		// machineLater files the TODO between Source ready and Machine ready.
		machineLater bool
		file         func(t *testing.T, h *rootLayerHarness)
		held         func(t *testing.T, h *rootLayerHarness)
		recover      func(t *testing.T, h *rootLayerHarness)
	}{
		{
			// T-FLW-01: without the guest dispatcher no flow is admitted, so
			// neither the TODO nor the generated-page refresh starts.
			name: "T-FLW-01 guest dispatch",
			omit: func(options *Options) { options.FlowHostRegistry = nil },
			held: func(t *testing.T, h *rootLayerHarness) {
				var reason string
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT reason FROM mythical_items WHERE number=1`).Scan(&reason))
				require.Equal(t, "TODO admission unavailable", reason)
				require.Empty(t, flw02WorkspaceID(t, h), "admission refuses before placement")
				var launches, wikis int
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationLaunch).Scan(&launches))
				require.Zero(t, launches, "no flow launch without the guest dispatcher")
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_wikis WHERE state='running' OR published_commit<>''`).Scan(&wikis))
				require.Zero(t, wikis, "no generated-page refresh without the guest dispatcher")
			},
			recover: func(t *testing.T, h *rootLayerHarness) { h.recompose() },
		},
		{
			// T-SEC-01: without the validated guest machine providers (microVM
			// only, one fixed non-root account) no lane machine is created.
			name: "T-SEC-01 validated guest machines",
			omit: func(options *Options) { options.InstallBranchMachines = false },
			held: func(t *testing.T, h *rootLayerHarness) {
				require.Empty(t, flw02WorkspaceID(t, h), "no lane machine without validated guest providers")
			},
			recover: func(t *testing.T, h *rootLayerHarness) { h.recompose() },
		},
		{
			// T-MCH-10: before Machine ready there is no image for main and no
			// detected toolchain, so a TODO filed after Source ready waits.
			name:         "T-MCH-10 machine image",
			machineLater: true,
			recover: func(t *testing.T, h *rootLayerHarness) {
				state, message := h.runMachine(t, "flw02-machine-recovery")
				require.Equal(t, "done", state, message)
			},
		},
		{
			// T-STK-01: TODO admission needs the active stack. A stack the
			// worker has not admitted refuses the TODO before any row exists;
			// the owner's bootstrap door supplies it.
			name: "T-STK-01 TODO admission",
			file: func(t *testing.T, h *rootLayerHarness) {
				_, err := h.pool.Exec(t.Context(), `UPDATE mythical_stacks SET state='bootstrapping', next_attempt_at='infinity'`)
				require.NoError(t, err)
				code, body := h.request("POST", "/api/todos", flw02TodoBody, "flw02-todo-refused")
				require.Equal(t, 503, code, string(body))
				require.Contains(t, string(body), "stack_unavailable")
				var items int
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&items))
				require.Zero(t, items, "a refused TODO leaves no row")
			},
			recover: func(t *testing.T, h *rootLayerHarness) {
				h.expect("POST", "/api/repos/rehearsal-owner/app/mythical/bootstrap", `{}`, 202)
				flw02StackActive(t, h)
				flw02FileTodo(t, h)
			},
		},
	} {
		t.Run(provider.name, func(t *testing.T) {
			coding := fixture
			coding.omit = provider.omit
			h := startRootLayerHarnessRuntime(t, true, coding)
			marker := flw02Canary(t)
			h.commitMain(flw02Repository(marker))
			h.runSetupThroughSource()
			if !provider.machineLater {
				state, message := h.runMachine(t, "flw02-"+strings.ReplaceAll(provider.name, " ", "-"))
				require.Equal(t, "done", state, message)
			}
			flw02StackActive(t, h)
			if provider.file != nil {
				provider.file(t, h)
			} else {
				flw02FileTodo(t, h)
				for deadline := time.Now().Add(hold); time.Now().Before(deadline); time.Sleep(time.Second) {
					var state, reason string
					require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT state,reason FROM mythical_items WHERE number=1`).Scan(&state, &reason))
					require.Equal(t, "queued", state, "%s must hold the TODO: %s", provider.name, reason)
					var snapshots int
					require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key LIKE 'coding.snapshot:%'`).Scan(&snapshots))
					require.Zero(t, snapshots, "no configuration reaches a machine before its provider")
					_, err := os.Lstat(marker)
					require.True(t, os.IsNotExist(err), "no check runs on the host")
					if provider.held != nil {
						provider.held(t, h)
					}
				}
			}
			provider.recover(t, h)
			flw02WaitTodo(t, h, "in_review")
			flw02RequireAgentConfigAndCheck(t, h, marker)
		})
	}
}

const flw02TodoBody = `{"title":"First TODO","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`

// flw02Canary is a host path the fixture's check writes inside the guest.
// It must exist only in the guest.
func flw02Canary(t *testing.T) string {
	marker := "/var/tmp/flw02-" + uuid.NewString()
	_, err := os.Lstat(marker)
	require.True(t, os.IsNotExist(err), "the host canary must start absent")
	return marker
}

// flw02Repository is a Go repository with no Smithers files. Its one
// detected check (go test ./...) proves the guest identity and writes the
// guest canary.
func flw02Repository(marker string) map[string]string {
	return map[string]string{
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
}

func flw02StackActive(t *testing.T, h *rootLayerHarness) {
	t.Helper()
	require.Eventually(t, func() bool {
		var stack struct {
			State string `json:"state"`
		}
		return json.Unmarshal(h.expect("GET", "/api/repos/rehearsal-owner/app/mythical", "", 200), &stack) == nil && stack.State == "active"
	}, time.Minute, 100*time.Millisecond)
}

func flw02FileTodo(t *testing.T, h *rootLayerHarness) {
	t.Helper()
	accepted := h.expect("POST", "/api/todos", flw02TodoBody, 202)
	var admitted struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(accepted, &admitted))
	require.EqualValues(t, 1, admitted.N)
}

func flw02Todo(t *testing.T, h *rootLayerHarness) services.MythicalItemView {
	t.Helper()
	var todo services.MythicalItemView
	require.NoError(t, json.Unmarshal(h.expect("GET", "/api/todos/1", "", 200), &todo))
	return todo
}

func flw02WaitTodo(t *testing.T, h *rootLayerHarness, want string) {
	t.Helper()
	require.Eventually(t, func() bool { return flw02Todo(t, h).State == want }, 15*time.Minute, 250*time.Millisecond, "TODO never reached %s: %s", want, h.logs.String())
}

func flw02WorkspaceID(t *testing.T, h *rootLayerHarness) string {
	t.Helper()
	var workspace string
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=1`).Scan(&workspace))
	return workspace
}

func flw02Workspace(t *testing.T, h *rootLayerHarness) string {
	t.Helper()
	workspace := flw02WorkspaceID(t, h)
	require.NotEmpty(t, workspace)
	return workspace
}

// flw02RequireAgentConfigAndCheck observes identity before opening config or
// check payload bytes. The check's guest marker is the positive control for
// the absent host one; branch argv, env and cwd stay unprivileged guest data.
func flw02RequireAgentConfigAndCheck(t *testing.T, h *rootLayerHarness, marker string) {
	t.Helper()
	workspace := flw02Workspace(t, h)
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
}
