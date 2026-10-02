//go:build unix

package flowhost

import (
	"context"
	"encoding/json"
	"flag"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// The real process adapter executes this test binary with the canonical host
// argv. Only its authenticated bridge health endpoint is substituted.
func init() {
	if os.Getenv("SMITHERS_FLOWHOST_TEST_CHILD") != "1" {
		return
	}
	flags := flag.NewFlagSet("host-fixture", flag.ExitOnError)
	root := flags.String("root", "", "")
	state := flags.String("state-dir", "", "")
	host := flags.String("host", "", "")
	port := flags.Int("port", 0, "")
	flags.Bool("listen", false, "")
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		os.Exit(2)
	}
	_ = flags.Parse(os.Args[2:])
	bytes, _ := json.Marshal(map[string]string{"root": *root, "state": *state, "host": *host, "port": strconv.Itoa(*port), "pid": strconv.Itoa(os.Getpid())})
	if os.WriteFile(os.Getenv("SMITHERS_FLOWHOST_TEST_MARKER"), bytes, 0600) != nil {
		os.Exit(3)
	}
	generation, _ := strconv.ParseInt(os.Getenv("SMITHERS_OWNER_GENERATION"), 10, 64)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" || r.Header.Get("Authorization") != "Bearer "+os.Getenv("SMITHERS_API_KEY") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"runtimeBridge": flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: os.Getenv("SMITHERS_FLOW_ARTIFACT_SHA256"), SourceRevision: os.Getenv("SMITHERS_SOURCE_REVISION"), OwnerGeneration: generation}})
	})
	if http.ListenAndServe(net.JoinHostPort(*host, strconv.Itoa(*port)), handler) != nil {
		os.Exit(4)
	}
	os.Exit(0)
}

type observedRuntime struct {
	*process.Runtime
	operations []workspaceapi.Operation
	isolation  workspaceapi.IsolationLevel
}

func (r *observedRuntime) Isolation() workspaceapi.IsolationLevel {
	if r.isolation != "" {
		return r.isolation
	}
	return r.Runtime.Isolation()
}

func (r *observedRuntime) observe(ctx context.Context) {
	operation, _ := workspaceapi.OperationFromContext(ctx)
	r.operations = append(r.operations, operation)
}
func (r *observedRuntime) InspectManagedHost(ctx context.Context, id string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	r.observe(ctx)
	return r.Runtime.InspectManagedHost(ctx, id, spec)
}
func (r *observedRuntime) StartManagedHost(ctx context.Context, id string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	r.observe(ctx)
	return r.Runtime.StartManagedHost(ctx, id, spec)
}
func (r *observedRuntime) ResolveWorkspaceSourceRevision(ctx context.Context, id string) (string, error) {
	r.observe(ctx)
	return r.Runtime.ResolveWorkspaceSourceRevision(ctx, id)
}
func (r *observedRuntime) StopService(ctx context.Context, id, name string) error {
	r.observe(ctx)
	return r.Runtime.StopService(ctx, id, name)
}

func TestWorkspaceLauncherUsesRealManagedProcessSourceAndRetirement(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	runtime, err := process.New(process.Config{Root: t.TempDir(), Environment: map[string]string{"PATH": os.Getenv("PATH")}, TerminationGrace: 100 * time.Millisecond})
	require.NoError(t, err)
	defer runtime.Close()
	observed := &observedRuntime{Runtime: runtime}
	launcher, err := NewWorkspaceLauncher(observed, WorkspaceLauncherConfig{AllowTrustedProcessForTests: true})
	require.NoError(t, err)
	workspace, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: uuid.NewString()})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	for _, args := range [][]string{{"git", "init"}, {"git", "-c", "user.name=Host Test", "-c", "user.email=host@example.invalid", "commit", "--allow-empty", "-m", "initial"}} {
		result, err := runtime.ExecuteCommand(ctx, workspace.ID, workspaceapi.Command{Args: args})
		require.NoError(t, err)
		require.Zero(t, result.ExitCode, result.Stderr)
	}
	authority := Authority{Target: flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: uuid.NewString()}, RepositoryID: 5, UserID: 9, WorkspaceID: workspace.ID, CatalogKey: CatalogCoding}
	revision, err := launcher.(SourceResolver).ResolveFlowHostSource(ctx, authority)
	require.NoError(t, err)
	require.Len(t, revision, 40)
	authority.SourceRevision = revision
	executable, err := os.Executable()
	require.NoError(t, err)
	marker := filepath.Join(t.TempDir(), "host.json")
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, SystemFlows: []string{"merge"}, Executable: executable, ArtifactDigest: strings.Repeat("a", 64), ServiceName: "coding-host", ReadyTimeout: 3 * time.Second, Environment: map[string]string{"SMITHERS_FLOWHOST_TEST_CHILD": "1", "SMITHERS_FLOWHOST_TEST_MARKER": marker}}
	binding := Binding{ID: uuid.NewString(), TenantID: authority.Target.TenantID, PrincipalID: authority.Target.PrincipalID, BindingKind: authority.Target.BindingKind, BindingID: authority.Target.BindingID, RepositoryID: 5, UserID: 9, WorkspaceID: workspace.ID, CatalogKey: CatalogCoding, ServiceName: catalog.ServiceName, RuntimeArtifactDigest: catalog.ArtifactDigest, SourceRevision: revision, OwnerGeneration: 1, State: "starting"}
	launch := HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "private-host-bearer"}
	_, err = launcher.InspectFlowHost(ctx, launch)
	require.ErrorIs(t, err, ErrHostNotRunning)
	first, err := launcher.StartFlowHost(ctx, launch)
	require.NoError(t, err)
	second, err := launcher.StartFlowHost(ctx, launch)
	require.NoError(t, err)
	require.Equal(t, first.Endpoint, second.Endpoint)
	inspected, err := launcher.InspectFlowHost(ctx, launch)
	require.NoError(t, err)
	require.Equal(t, first.Endpoint, inspected.Endpoint)
	// After a host-bundle deploy the catalog that started this host is gone.
	// Only its recorded identity still reaches it (plue#538), and never starts it.
	upgraded := catalog
	upgraded.ArtifactDigest = strings.Repeat("c", 64)
	superseded := HostLaunch{Binding: binding, Authority: authority, Catalog: upgraded, Credential: launch.Credential, Superseded: true}
	_, err = launcher.InspectFlowHost(ctx, HostLaunch{Binding: binding, Authority: authority, Catalog: upgraded, Credential: launch.Credential})
	require.Error(t, err, "the current catalog does not name the live host")
	_, err = launcher.InspectFlowHost(ctx, superseded)
	require.Error(t, err, "a superseded host without a recorded identity is unreachable")
	superseded.Binding.ServiceIdentity = "flow-host:stale"
	_, err = launcher.InspectFlowHost(ctx, superseded)
	require.ErrorIs(t, err, ErrHostIdentityConflict, "a stale recorded identity never names the live host")
	superseded.Binding.ServiceIdentity = hostServiceIdentity(launch)
	kept, err := launcher.InspectFlowHost(ctx, superseded)
	require.NoError(t, err)
	require.Equal(t, first.Endpoint, kept.Endpoint)
	_, err = launcher.StartFlowHost(ctx, superseded)
	require.Error(t, err)
	var receipt map[string]string
	data, err := os.ReadFile(marker)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &receipt))
	require.Equal(t, workspace.Root, receipt["root"])
	require.Equal(t, "127.0.0.1", receipt["host"])
	require.Equal(t, filepath.Join(workspace.StateDir, "managed-hosts"), filepath.Dir(receipt["state"]), "adapter state is already binding-specific")
	require.NoError(t, os.WriteFile(filepath.Join(receipt["state"], "journal"), []byte("persisted"), 0600))
	incorrect := launch
	incorrect.Credential = "wrong"
	_, err = launcher.InspectFlowHost(ctx, incorrect)
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrHostNotRunning)
	require.NoError(t, launcher.(RetirementStopper).StopFlowHost(ctx, binding))
	_, err = launcher.InspectFlowHost(ctx, launch)
	require.ErrorIs(t, err, ErrHostNotRunning)
	launch.Binding.OwnerGeneration++
	_, err = launcher.StartFlowHost(ctx, launch)
	require.NoError(t, err)
	data, err = os.ReadFile(filepath.Join(receipt["state"], "journal"))
	require.NoError(t, err)
	require.Equal(t, "persisted", string(data))
	require.NoError(t, runtime.DeleteWorkspace(ctx, workspace.ID))
	require.NoError(t, launcher.(RetirementStopper).StopFlowHost(ctx, launch.Binding))
	for _, operation := range observed.operations {
		require.Equal(t, "9", operation.TenantID)
		require.Equal(t, "9", operation.PrincipalID)
		require.NotEmpty(t, operation.OperationID)
	}
}

func TestWorkspaceHostIdentityIgnoresAllocatedPortButBindsConfiguration(t *testing.T) {
	launch := HostLaunch{Binding: Binding{ID: "binding", WorkspaceID: "workspace", OwnerGeneration: 1}, Catalog: Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/host", Environment: map[string]string{"CONFIG": "one"}}}
	initial := hostServiceIdentity(launch)
	launch.Catalog.Environment["CONFIG"] = "two"
	require.NotEqual(t, initial, hostServiceIdentity(launch))
	launch.Catalog.Environment["CONFIG"] = "one"
	launch.Credential = "ephemeral"
	require.Equal(t, initial, hostServiceIdentity(launch))
}

func TestWorkspaceLauncherRefusesTrustedProcessBeforeStartingHost(t *testing.T) {
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	observed := &observedRuntime{Runtime: runtime}
	launcher, err := NewWorkspaceLauncher(observed)
	require.Nil(t, launcher)
	requireIsolationRequired(t, err)
	require.Empty(t, observed.operations, "refusal must not inspect or launch repository code")
}

// Changing a runtime after the launcher is built cannot authorize repository
// imports through an inspect, a new start, or source capture.
func TestWorkspaceLauncherRechecksIsolationForEveryExecutableOperation(t *testing.T) {
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	observed := &observedRuntime{Runtime: runtime, isolation: workspaceapi.IsolationSandboxed}
	launcher, err := NewWorkspaceLauncher(observed)
	require.NoError(t, err)
	require.Equal(t, workspaceapi.IsolationSandboxed, launcher.(IsolationLauncher).Isolation())
	observed.isolation = workspaceapi.IsolationTrustedProcess
	_, err = launcher.InspectFlowHost(context.Background(), HostLaunch{})
	requireIsolationRequired(t, err)
	_, err = launcher.StartFlowHost(context.Background(), HostLaunch{})
	requireIsolationRequired(t, err)
	_, err = launcher.(SourceResolver).ResolveFlowHostSource(context.Background(), Authority{})
	requireIsolationRequired(t, err)
	require.Empty(t, observed.operations)
}

func TestWorkspaceLauncherRejectsAmbiguousTestConfiguration(t *testing.T) {
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	launcher, err := NewWorkspaceLauncher(runtime, WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}, WorkspaceLauncherConfig{})
	require.Nil(t, launcher)
	require.ErrorContains(t, err, "at most one configuration")
}

type capabilityRuntime struct {
	workspaceapi.WorkspaceRuntime
	capabilities workspaceapi.WorkspaceCapabilities
}

func (*capabilityRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (r *capabilityRuntime) Capabilities() workspaceapi.WorkspaceCapabilities { return r.capabilities }

func TestWorkspaceLauncherRequiresCompleteSandboxFacets(t *testing.T) {
	launcher, err := NewWorkspaceLauncher(nil)
	require.Nil(t, launcher)
	require.ErrorContains(t, err, "requires a workspace runtime")
	managed := &sandboxedManagedRuntime{}
	for _, test := range []struct {
		name    string
		runtime workspaceapi.WorkspaceRuntime
		error   string
	}{
		{"missing managed hosts", &capabilityRuntime{capabilities: workspaceapi.WorkspaceCapabilities{ManagedHTTPHosts: true, SourceRevision: true}}, "does not support managed HTTP hosts"},
		{"disabled managed hosts", struct {
			workspaceapi.WorkspaceRuntime
			workspaceapi.WorkspaceManagedHosts
			workspaceapi.WorkspaceSourceRevisionResolver
		}{&capabilityRuntime{capabilities: workspaceapi.WorkspaceCapabilities{SourceRevision: true}}, managed, managed}, "does not support managed HTTP hosts"},
		{"missing source resolver", struct {
			workspaceapi.WorkspaceRuntime
			workspaceapi.WorkspaceManagedHosts
		}{&capabilityRuntime{capabilities: workspaceapi.WorkspaceCapabilities{ManagedHTTPHosts: true, SourceRevision: true}}, managed}, "does not resolve source revisions"},
		{"disabled source resolver", struct {
			workspaceapi.WorkspaceRuntime
			workspaceapi.WorkspaceManagedHosts
			workspaceapi.WorkspaceSourceRevisionResolver
		}{&capabilityRuntime{capabilities: workspaceapi.WorkspaceCapabilities{ManagedHTTPHosts: true}}, managed, managed}, "does not resolve source revisions"},
	} {
		t.Run(test.name, func(t *testing.T) {
			launcher, err := NewWorkspaceLauncher(test.runtime)
			require.Nil(t, launcher)
			require.ErrorContains(t, err, test.error)
		})
	}
	require.Zero(t, managed.starts)
}
