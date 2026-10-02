//go:build unix

package flowhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const freshBoxEcho = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("echo", {
  description: "Echo",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: { text: Schema.String },
  success: Schema.String,
  body: ({ text }) => Node.succeed(text)
})
`

// A real process workspace with only project policy and one tiny user flow
// must boot the distribution host and serve its bundled coding routes. Run
// explicitly: building the bundle and starting Node are acceptance costs.
func TestFreshBoxRealManagedCodingHost(t *testing.T) {
	if os.Getenv("SMITHERS_FLOWHOST_FRESH_BOX") != "1" {
		t.Skip("set SMITHERS_FLOWHOST_FRESH_BOX=1 to build and start the real coding host")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	require.NoError(t, err)
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	jj, err := exec.LookPath("jj")
	require.NoError(t, err)
	exporter := os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY")
	if exporter == "" {
		exporter = filepath.Join(repositoryRoot, "target", "release", "smithers-jj-export")
	}
	exporter, err = filepath.Abs(exporter)
	require.NoError(t, err)
	_, err = os.Stat(exporter)
	require.NoError(t, err, "build the native smithers-jj-export helper first")
	helperContents, err := os.ReadFile(exporter)
	require.NoError(t, err)
	helperSum := sha256.Sum256(helperContents)
	artifact := os.Getenv("SMITHERS_FLOWHOST_ARTIFACT")
	if artifact == "" {
		artifact = filepath.Join(t.TempDir(), "smithers-coding-host")
		build := exec.CommandContext(ctx, node, "flows/coding/build.mjs", artifact)
		build.Dir = repositoryRoot
		output, buildErr := build.CombinedOutput()
		require.NoError(t, buildErr, "build bundled coding host: %s", output)
	}
	artifact, err = filepath.Abs(artifact)
	require.NoError(t, err)
	contents, err := os.ReadFile(artifact)
	require.NoError(t, err)
	sum := sha256.Sum256(contents)
	digest := hex.EncodeToString(sum[:])
	t.Logf("coding host artifact=%s sha256=%s exporter=%s exporter_sha256=%x", artifact, digest, exporter, helperSum)

	workspaces, err := process.New(process.Config{Root: t.TempDir(), Environment: map[string]string{"PATH": os.Getenv("PATH")}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, workspaces.Close()) })
	workspace, err := workspaces.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: uuid.NewString()})
	require.NoError(t, err)
	workspace, err = workspaces.StartWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Join(workspace.Root, ".smithers"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(workspace.Root, "flows", "echo"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(workspace.Root, ".smithers", "coding-project.json"), []byte(`{"wiki":false,"implementation":"coding/implementation","checks":[]}`), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(workspace.Root, "flows", "echo", "flow.ts"), []byte(freshBoxEcho), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(workspace.Root, "README.md"), []byte("# Fresh box\n"), 0o644))
	// The file flow uses the same public packages as the bundle. JJ must not
	// snapshot the shared dependency tree in this otherwise fresh workspace.
	require.NoError(t, os.Symlink(filepath.Join(repositoryRoot, "node_modules"), filepath.Join(workspace.Root, "node_modules")))
	require.NoError(t, os.WriteFile(filepath.Join(workspace.Root, ".gitignore"), []byte("node_modules\n"), 0o644))
	for _, args := range [][]string{{jj, "git", "init", "--colocate"}, {jj, "--config", "user.name=Fresh Box", "--config", "user.email=box@example.invalid", "commit", "-m", "fresh box fixture", "README.md", ".smithers/coding-project.json", "flows/echo/flow.ts"}} {
		result, commandErr := workspaces.ExecuteCommand(ctx, workspace.ID, workspaceapi.Command{Args: args})
		require.NoError(t, commandErr)
		require.Zero(t, result.ExitCode, "%v: %s", args, result.Stderr)
	}
	launcher, err := NewWorkspaceLauncher(workspaces, WorkspaceLauncherConfig{AllowTrustedProcessForTests: true})
	require.NoError(t, err)
	authority := Authority{Target: flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: uuid.NewString(), WorkspaceID: workspace.ID}, RepositoryID: 5, UserID: 9, WorkspaceID: workspace.ID, CatalogKey: CatalogCoding}
	revision, err := launcher.(SourceResolver).ResolveFlowHostSource(ctx, authority)
	require.NoError(t, err)
	require.Len(t, revision, 40)
	t.Logf("fresh JJ source revision=%s", revision)
	authority.SourceRevision = revision
	// Explicit launch-spec fixture; production reads the services catalog.
	systemFlows := []string{
		"stack", "stack.move", "stack.propose", "merge", "members", "settings", "secrets", "sync", "admission", "setup", "flow-load", "summarizer",
		"repository/setup", "repository/trigger", "repository-jobs/issues", "repository-jobs/review", "repository-jobs/ci", "repository-jobs/feature", "repository-jobs/chores",
		"coding", "coding/dispatch", "coding/implementation", "coding/request", "coding/vibe", "coding/verify", "coding/wiki",
	}
	catalog := Catalog{SystemFlows: systemFlows, Key: CatalogCoding, Family: CatalogCoding, Executable: artifact, ArtifactDigest: digest, ServiceName: "coding-host", ReadyTimeout: 120 * time.Second, ImplementationModel: "openai:scripted", Environment: map[string]string{"SMITHERS_CODING_LOCAL_OWNER": "1", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY": exporter, "SMITHERS_JJ_PATH": jj}}
	binding := Binding{ID: uuid.NewString(), TenantID: authority.Target.TenantID, PrincipalID: authority.Target.PrincipalID, BindingKind: authority.Target.BindingKind, BindingID: authority.Target.BindingID, RepositoryID: 5, UserID: 9, WorkspaceID: workspace.ID, CatalogKey: CatalogCoding, ServiceName: catalog.ServiceName, RuntimeArtifactDigest: digest, SourceRevision: revision, OwnerGeneration: 1, State: "starting"}
	launch := HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "fresh-box-test-bearer"}
	_, err = launcher.InspectFlowHost(ctx, launch)
	require.ErrorIs(t, err, ErrHostNotRunning)
	connection, err := launcher.StartFlowHost(ctx, launch)
	if err != nil {
		observation, inspectErr := workspaces.InspectService(context.Background(), workspace.ID, catalog.ServiceName)
		t.Fatalf("start real managed coding host: %v; service=%+v; inspect=%v", err, observation, inspectErr)
	}
	client, err := runtimebridge.New(runtimebridge.Config{Endpoint: connection.Endpoint, HTTPClient: connection.HTTPClient, Credential: launch.Credential})
	require.NoError(t, err)
	identity, err := client.Identity(ctx)
	require.NoError(t, err)
	require.Equal(t, flowruntime.Protocol, identity.Protocol)
	require.Equal(t, digest, identity.RuntimeArtifactDigest)
	require.Equal(t, revision, identity.SourceRevision)
	require.Equal(t, int64(1), identity.OwnerGeneration)
	listed, err := client.CallRPC(ctx, "List", json.RawMessage(`{"_tag":"flows"}`))
	require.NoError(t, err)
	var list struct {
		OK      bool `json:"ok"`
		Payload struct {
			Items []struct {
				FlowID string `json:"flowId"`
			} `json:"items"`
		} `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(listed, &list))
	require.True(t, list.OK, "List: %s", listed)
	flows := make([]string, 0, len(list.Payload.Items))
	for _, item := range list.Payload.Items {
		flows = append(flows, item.FlowID)
	}
	for _, flow := range []string{"coding/request", "coding/verify", "echo"} {
		require.Contains(t, flows, flow)
	}
	t.Logf("listed %d flows including coding/request, coding/verify, echo", len(flows))

	request := flowruntime.Launch{ApplicationRequestID: uuid.NewString(), Attempt: 1, OwnerGeneration: binding.OwnerGeneration, RuntimeArtifactDigest: digest, SourceRevision: revision, FlowID: "echo", Payload: json.RawMessage(`{"text":"fresh-box-ok"}`)}
	started, err := client.Launch(ctx, request)
	require.NoError(t, err)
	require.Equal(t, "Parked", started.Receipt.Tag, "launch receipt: %+v", started)
	require.NotEmpty(t, started.Approval)
	approved, err := client.Approve(ctx, flowruntime.Decision{ApplicationRequestID: started.ApplicationRequestID, OwnerGeneration: binding.OwnerGeneration, Approval: started.Approval})
	require.NoError(t, err)
	require.Equal(t, "Accepted", approved.Receipt.Tag, "approval receipt: %+v", approved)
	request.Attempt++
	started, err = client.Launch(ctx, request)
	require.NoError(t, err)
	require.NotEmpty(t, started.Receipt.RunID, "approved launch receipt: %+v", started)
	var observed flowruntime.Observation
	for {
		observed, err = client.Observe(ctx, started.Receipt.RunID, "", 100)
		require.NoError(t, err)
		if observed.Terminal {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("echo did not reach terminal state")
		case <-time.After(100 * time.Millisecond):
		}
	}
	require.Equal(t, "completed", observed.Run.Status, "run: %+v", observed.Run)
	require.NotNil(t, observed.Run.FinalOutput)
	require.Equal(t, "fresh-box-ok", *observed.Run.FinalOutput)
	require.NotEmpty(t, observed.Events, "real host must expose execution records")
	kinds := make([]string, 0, len(observed.Events))
	for _, event := range observed.Events {
		kinds = append(kinds, event.Kind)
	}
	require.Contains(t, kinds, "control.run.completed", "journal kinds: %v", kinds)
	t.Logf("run=%s status=%s records=%d final=%s", observed.Run.RunID, observed.Run.Status, len(observed.Events), *observed.Run.FinalOutput)
	require.NoError(t, launcher.(RetirementStopper).StopFlowHost(ctx, binding))
	_, err = launcher.InspectFlowHost(ctx, launch)
	require.ErrorIs(t, err, ErrHostNotRunning)
	require.NoError(t, workspaces.DeleteWorkspace(ctx, workspace.ID))
	_, err = os.Stat(workspace.Root)
	require.True(t, os.IsNotExist(err), "workspace root must be removed: %v", err)
	t.Logf("cleanup: managed host stopped; workspace %s removed", workspace.ID)
}
