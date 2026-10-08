package services

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// guestLayoutRuntime is a sandboxed runtime whose guests run commands as
// account, with home and checkout root. Repository metadata is synthetic; a
// placement store records each box's vm_id, as a hosted runtime does. Every
// /bin/sh script it runs is recorded and answered by answer.
type guestLayoutRuntime struct {
	workspaceapi.WorkspaceRuntime
	pool                *pgxpool.Pool
	account, home, root string
	uid                 string
	accountTruncated    bool
	repositoryID        int64
	cloneURL            string
	answer              func(script string) string

	mu      sync.Mutex
	state   map[string]workspaceapi.WorkspaceState
	scripts []string
}

func newGuestLayoutRuntime(account, home, root string) *guestLayoutRuntime {
	return &guestLayoutRuntime{account: account, home: home, root: root, uid: "1000", state: map[string]workspaceapi.WorkspaceState{},
		answer: func(string) string { return "" }}
}

func (*guestLayoutRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}

func (*guestLayoutRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{PersistentFiles: true, Execution: true, FileOperations: true}
}

func (r *guestLayoutRuntime) observe(id string) (workspaceapi.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state, ok := r.state[id]
	if !ok {
		return workspaceapi.Workspace{}, workspaceapi.ErrWorkspaceNotFound
	}
	return workspaceapi.Workspace{ID: id, Root: r.root, Home: r.home, State: state}, nil
}

func (r *guestLayoutRuntime) CreateWorkspace(ctx context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	if r.pool != nil {
		if _, err := r.pool.Exec(ctx, `UPDATE workspaces SET vm_id = 'msb-' || id::text WHERE id = $1::uuid`, spec.ID); err != nil {
			return workspaceapi.Workspace{}, err
		}
	}
	r.mu.Lock()
	r.state[spec.ID] = workspaceapi.WorkspaceRunning
	r.mu.Unlock()
	return r.observe(spec.ID)
}

func (r *guestLayoutRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return r.observe(id)
}

func (r *guestLayoutRuntime) StartWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.mu.Lock()
	r.state[id] = workspaceapi.WorkspaceRunning
	r.mu.Unlock()
	return r.observe(id)
}

func (*guestLayoutRuntime) ListFiles(_ context.Context, _, path string) ([]workspaceapi.FileEntry, error) {
	if path == ".git" {
		return []workspaceapi.FileEntry{{Name: "smithers-workspace-initialization.json"}}, nil
	}
	return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}, {Name: ".jj", IsDir: true}}, nil
}

func (r *guestLayoutRuntime) ReadFile(_ context.Context, workspaceID, _ string) ([]byte, error) {
	return json.Marshal(workspaceRepositoryReceipt{Version: workspaceRepositoryReceiptVersion, WorkspaceID: workspaceID,
		RepositoryID: r.repositoryID, CloneURL: r.cloneURL, SourceBookmark: "main",
		SourceRevision: strings.Repeat("a", 40), InitializedAt: time.Now().UTC()})
}

func (*guestLayoutRuntime) WriteRepositoryReceipt(context.Context, string, []byte) error {
	return nil
}

func (r *guestLayoutRuntime) ExecuteCommand(_ context.Context, _ string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	switch {
	case len(command.Args) >= 2 && command.Args[0] == "git" && command.Args[1] == "remote":
		return workspaceapi.CommandResult{Stdout: r.cloneURL + "\n"}, nil
	case len(command.Args) == 3 && command.Args[0] == "/bin/sh" && command.Args[1] == "-c":
		r.mu.Lock()
		r.scripts = append(r.scripts, command.Args[2])
		r.mu.Unlock()
		if command.Args[2] == "id -u && id -un" {
			return workspaceapi.CommandResult{Stdout: r.uid + "\n" + r.account + "\n", OutputTruncated: r.accountTruncated}, nil
		}
		return workspaceapi.CommandResult{Stdout: r.answer(command.Args[2])}, nil
	}
	return workspaceapi.CommandResult{}, nil
}

func (r *guestLayoutRuntime) recorded() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.scripts...)
}

const codingAnswer = `{"status":"unchanged","operationId":"`

func answerGuestScripts(script string) string {
	switch {
	case strings.Contains(script, "--local <<'SMITHERS_CODING_JSON'"):
		return codingAnswer + strings.Repeat("a", 128) + `"}`
	case strings.Contains(script, "cp -a --reflink=auto"):
		return "clean"
	case strings.Contains(script, "op revert --what repo"):
		return "undo-op\nparent-op\n"
	}
	return ""
}

// A hosted deployment's runtime owns its guests' layout: account developer,
// home /home/developer, checkout /home/developer/workspace. Its composition
// also holds a sandbox provider for compute. Workspace start, SSH, coding
// operations and operation undo all use the runtime's layout, never this
// backend's own agent guest (smithers#3747). Real PostgreSQL holds the
// workspace, its repository and its owner.
func TestRuntimeGuestLayoutDrivesAHostedDeveloperGuest(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	queries := db.New(pool)
	slug, err := queries.GetRepoOwnerSlugAndNameByID(ctx, repo)
	require.NoError(t, err)
	runtime := newGuestLayoutRuntime("developer", "/home/developer", "/home/developer/workspace")
	runtime.pool, runtime.repositoryID = pool, repo
	runtime.cloneURL = testWorkspaceGitBaseURL + "/" + slug.OwnerSlug + "/" + slug.RepoName + ".git"
	runtime.answer = answerGuestScripts
	artifactCallsiteFixture(t)
	compute := &runtimeArtifactClient{artifactRecordingClient: newArtifactRecordingClient(), bootstrapStatus: "done"}
	var grants [][]string
	compute.grantVMPermissionFn = func(_ context.Context, _, _ string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
		grants = append(grants, req.AllowedUsers)
		return sandbox.AccessGrant{ID: "grant"}, nil
	}
	svc := NewWorkspaceService(queries, WithWorkspaceGitBaseURL(testWorkspaceGitBaseURL), WithWorkspaceRuntime(runtime),
		WithWorkspaceSandboxClient(compute), WithWorkspaceSSHHost("ssh.example.test"),
		WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))

	created, err := svc.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repo, UserID: owner, RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName, Name: "main"})
	require.NoError(t, err)
	require.Equal(t, "running", created.Status)

	info, err := svc.GetWorkspaceSSHConnectionInfoAs(ctx, created.ID, repo, owner, "")
	require.NoError(t, err)
	require.Equal(t, "developer", info.Username)
	require.Contains(t, info.SSHHost, "+developer@ssh.example.test")
	require.Equal(t, "/home/developer/workspace", info.Workdir)
	for _, requested := range []string{"agent", "root"} {
		_, err = svc.GetWorkspaceSSHConnectionInfoAs(ctx, created.ID, repo, owner, requested)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr, requested)
		require.Equal(t, pkgerrors.CodeWorkspaceSSHUserInvalid, apiErr.Code, requested)
	}

	read, err := svc.ReadCodingRevisions(ctx, created.ID, repo, owner, nil)
	require.NoError(t, err)
	require.Equal(t, "unchanged", read.Status)
	applied, err := svc.ApplyCodingOperation(ctx, created.ID, repo, owner, codingFixture())
	require.NoError(t, err)
	require.Equal(t, "unchanged", applied.Status)
	state, err := svc.PreviewOperationUndo(ctx, created.ID, repo, owner, "target-op", []string{strings.Repeat("k", 32)})
	require.NoError(t, err)
	require.Equal(t, "clean", state)
	undone, err := svc.UndoOperation(ctx, created.ID, repo, owner, "target-op")
	require.NoError(t, err)
	require.Equal(t, WorkspaceUndoResult{OperationID: "undo-op", ParentOperationID: "parent-op"}, undone)

	var coding, undo int
	for _, script := range runtime.recorded() {
		switch {
		case strings.Contains(script, "--local <<'SMITHERS_CODING_JSON'"):
			coding++
			require.Contains(t, script, `"repositoryPath":"/home/developer/workspace"`)
			require.Contains(t, script, workspaceJJExportPath)
			require.NotContains(t, script, "runuser", "the runtime runs it as its own account")
		case strings.Contains(script, "op revert --what repo"):
			undo++
			require.Contains(t, script, "repo='/home/developer/workspace'")
		}
	}
	require.Equal(t, 2, coding, "both coding requests ran through the runtime")
	require.Equal(t, 2, undo, "the undo preview and the undo ran through the runtime")

	require.Equal(t, [][]string{{"developer"}}, grants, "one grant, for the runtime's account; refused accounts mint none")
	bootstrap := stagedWorkspaceScript(compute.artifactRecordingClient)
	require.Contains(t, bootstrap, "install -d -o developer -g developer -m 700 /home/developer/.smithers")
	require.NotContains(t, bootstrap, "agent")
	var probed bool
	for _, command := range compute.commands {
		require.NotContains(t, command, "/home/agent", "the compute provider never addresses this backend's own guest")
		require.NotContains(t, command, "--local", "coding never runs through the compute provider")
		require.NotContains(t, command, "op revert", "undo never runs through the compute provider")
		probed = probed || strings.Contains(command, "/home/developer/.local/bin/smithers")
	}
	require.True(t, probed, "the CLI probe looks in the runtime guest's home")
}

// Smithers' own sandboxed runtime keeps its agent guest: coding requests run
// through it in /workspace.
func TestRuntimeGuestLayoutKeepsTheSelfHostedAgentGuest(t *testing.T) {
	runtime := newGuestLayoutRuntime("agent", "/home/agent", "/workspace")
	runtime.answer = answerGuestScripts
	runtime.state["ws-1"] = workspaceapi.WorkspaceRunning
	q := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		row := sampleDBWorkspace("ws-1")
		row.VmID = ""
		return row, nil
	}, getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
		row := sampleDBWorkspace("ws-1")
		row.VmID = ""
		return row, nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	result, err := svc.ReadCodingRevisions(context.Background(), "ws-1", 101, 1, nil)
	require.NoError(t, err)
	require.Equal(t, "unchanged", result.Status)
	scripts := runtime.recorded()
	require.Len(t, scripts, 1)
	require.Contains(t, scripts[0], `"repositoryPath":"/workspace"`)
}

// A deployment without a workspace runtime keeps provisioning this backend's
// agent guest through its sandbox provider.
func TestSandboxGuestCodingKeepsTheAgentLayout(t *testing.T) {
	var command string
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		command = req.Command
		zero := int32(0)
		return sandbox.ExecResult{StatusCode: &zero, Stdout: codingAnswer + strings.Repeat("a", 128) + `"}`}, nil
	}}
	_, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm)).
		ReadCodingRevisions(context.Background(), "ws-1", 101, 1, nil)
	require.NoError(t, err)
	require.Contains(t, command, "runuser -u 'agent' -- env -u JJ_CONFIG HOME='/home/agent'")
	require.Contains(t, command, `"repositoryPath":"/workspace"`)
}

// The account is the one the runtime runs commands as, read once per
// workspace; root or a malformed answer is refused.
func TestWorkspaceGuestLayoutReadsTheRuntimeAccount(t *testing.T) {
	row := sampleDBWorkspace("ws-1")
	for _, tc := range []struct {
		name, uid, account, want string
		truncated                bool
	}{
		{name: "developer", uid: "1000", account: "developer", want: "developer"},
		{name: "root", uid: "0", account: "root"},
		{name: "zero padded root", uid: "00", account: "agent"},
		{name: "negative uid", uid: "-1", account: "developer"},
		{name: "not a uid", uid: "unknown", account: "developer"},
		{name: "uid overflow", uid: "4294967296", account: "developer"},
		{name: "truncated", uid: "1000", account: "developer", truncated: true},
		{name: "malformed", uid: "1000", account: "dev eloper"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := newGuestLayoutRuntime(tc.account, "/home/developer", "/home/developer/workspace")
			runtime.uid = tc.uid
			runtime.accountTruncated = tc.truncated
			runtime.state[row.ID] = workspaceapi.WorkspaceRunning
			svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(runtime))
			layout, err := svc.workspaceGuestLayout(context.Background(), row, row.UserID)
			if tc.want == "" {
				require.ErrorContains(t, err, "no unprivileged account")
				// Refused observations never become a cached SSH identity.
				runtime.uid, runtime.account, runtime.accountTruncated = "1000", "developer", false
				recovered, err := svc.workspaceGuestLayout(context.Background(), row, row.UserID)
				require.NoError(t, err)
				require.Equal(t, "developer", recovered.User)
				require.Len(t, runtime.recorded(), 2)
				return
			}
			require.NoError(t, err)
			require.Equal(t, workspaceGuestLayout{User: tc.want, Home: "/home/developer", Root: "/home/developer/workspace"}, layout)
			_, err = svc.workspaceGuestLayout(context.Background(), row, row.UserID)
			require.NoError(t, err)
			require.Len(t, runtime.recorded(), 1, "the account is read once")
		})
	}
	layout, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).workspaceGuestLayout(context.Background(), row, row.UserID)
	require.NoError(t, err)
	require.Equal(t, defaultWorkspaceGuestLayout, layout, "a sandbox-provider guest is this backend's own")
}
