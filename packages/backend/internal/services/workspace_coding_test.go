package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func codingFixture() WorkspaceCodingInput {
	description := "one"
	op := strings.Repeat("a", 128)
	return WorkspaceCodingInput{Operation: "create", RequestID: uuid.NewString(), ExpectedOperationID: op,
		Target: WorkspaceCodingRevision{Kind: "resolved", ChangeID: strings.Repeat("z", 32), CommitID: strings.Repeat("b", 40),
			TreeID: strings.Repeat("c", 40), OperationID: op, ParentCommitIDs: []string{strings.Repeat("d", 40)}}, Description: &description}
}

func TestWorkspaceCoding_ValidatesBeforeExecution(t *testing.T) {
	for _, mutate := range []func(*WorkspaceCodingInput){
		func(input *WorkspaceCodingInput) { input.RequestID = "" },
		func(input *WorkspaceCodingInput) { input.ExpectedOperationID = "short" },
		func(input *WorkspaceCodingInput) { input.Target.ChangeID = "@ | all()" },
		func(input *WorkspaceCodingInput) { input.Target.TreeID = "" },
		func(input *WorkspaceCodingInput) { input.Target.ParentCommitIDs = nil },
		func(input *WorkspaceCodingInput) { input.Target.Kind = "conflicted" },
		func(input *WorkspaceCodingInput) { input.Operation = "arbitrary-exec" },
		func(input *WorkspaceCodingInput) { input.Operation = "amend" },
		func(input *WorkspaceCodingInput) { input.Description = nil },
	} {
		input := codingFixture()
		mutate(&input)
		_, err := (*WorkspaceService)(nil).ApplyCodingOperation(context.Background(), "ws", 1, 1, input)
		assertAPIErrorStatus(t, err, http.StatusBadRequest)
	}
}

func TestWorkspaceCoding_FilePatchValidation(t *testing.T) {
	content, digest := "new bytes", strings.Repeat("a", 64)
	input := codingFixture()
	input.Operation, input.Description = "apply_files", nil
	input.Files = []WorkspaceCodingFile{{Path: "src/feature.ts", BeforeDigest: &digest, Content: &content}}
	require.NoError(t, validateCodingInput(input))
	for _, path := range []string{"../escape", "/escape", ".jj/state", "src/.git/config", "a//b", "a/./b", "a\\b", "a\nb"} {
		other := input
		other.Files = []WorkspaceCodingFile{{Path: path, Content: &content}}
		require.Error(t, validateCodingInput(other), path)
	}
	for _, files := range [][]WorkspaceCodingFile{nil, {{Path: "same"}},
		{{Path: "a", Content: &content}, {Path: "a/b", Content: &content}},
		{{Path: "a", Content: &content}, {Path: "a", Content: &content}}} {
		other := input
		other.Files = files
		require.Error(t, validateCodingInput(other))
	}
	large := strings.Repeat("x", (256<<10)+1)
	input.Files[0].Content = &large
	require.ErrorContains(t, validateCodingInput(input), "256 KiB")
	projection := WorkspaceCodingProjection{Operation: "apply_files", OperationID: strings.Repeat("a", 128),
		ParentOperationID: strings.Repeat("b", 128), Timestamp: time.Now().UTC(), ChangeIDs: []string{strings.Repeat("z", 32)}}
	require.NoError(t, validateCodingProjections([]WorkspaceCodingProjection{projection}))
}

func TestWorkspaceCoding_FileRecoveryReceiptSurvivesCloudBoundary(t *testing.T) {
	failed := int32(1)
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{StatusCode: &failed, Stdout: `{"error":{"code":"file_conflict","message":"Inspect retained files","recovery":{"requestId":"stable-request","path":"/home/developer/.smithers-coding-recovery/repo/request","files":[{"path":"value","preimage":"/private/0.before","proposed":"/private/0.after"}]}}}`}, nil
	}}
	_, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm)).ApplyCodingOperation(context.Background(), "ws-1", 101, 1, codingFixture())
	assertAPIErrorStatus(t, err, http.StatusConflict)
	var apiError *pkgerrors.APIError
	require.ErrorAs(t, err, &apiError)
	require.Equal(t, pkgerrors.CodeCodingFileConflict, apiError.Code)
	recovery := apiError.Details.(map[string]any)["recovery"].(*WorkspaceCodingRecovery)
	require.Equal(t, "stable-request", recovery.RequestID)
	require.Len(t, recovery.Files, 1)
	require.Equal(t, "value", recovery.Files[0].Path)
}

func TestWorkspaceCoding_ReadSelectorsEncodeAsArrays(t *testing.T) {
	changeID := strings.Repeat("k", 32)
	for _, test := range []struct {
		name string
		ids  []string
		want []string
	}{
		{name: "absent", want: []string{}},
		{name: "explicit", ids: []string{changeID}, want: []string{changeID}},
	} {
		t.Run(test.name, func(t *testing.T) {
			vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				const marker = "<<'SMITHERS_CODING_JSON'\n"
				parts := strings.SplitN(req.Command, marker, 2)
				require.Len(t, parts, 2)
				raw := strings.TrimSuffix(parts[1], "\nSMITHERS_CODING_JSON")
				var payload struct {
					Operation string   `json:"operation"`
					ChangeIDs []string `json:"changeIds"`
				}
				require.NoError(t, json.Unmarshal([]byte(raw), &payload))
				require.Equal(t, "read", payload.Operation)
				require.Contains(t, raw, `"changeIds":[`, "native helper requires an array, not null")
				require.Equal(t, test.want, payload.ChangeIDs)
				zero := int32(0)
				return sandbox.ExecResult{StatusCode: &zero, Stdout: `{"status":"read","operationId":"` + strings.Repeat("a", 128) + `"}`}, nil
			}}
			result, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm)).
				ReadCodingRevisions(context.Background(), "ws-1", 101, 1, test.ids)
			require.NoError(t, err)
			require.Equal(t, "read", result.Status)
		})
	}
}

func TestWorkspaceCoding_ReadShareCannotMutate(t *testing.T) {
	q := &mockWorkspaceQuerier{getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
		return db.WorkspaceShare{Level: "read"}, nil
	}}
	called := false
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		called = true
		return sandbox.ExecResult{}, nil
	}}
	_, err := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm)).ApplyCodingOperation(context.Background(), "ws-1", 101, 2, codingFixture())
	assertAPIErrorStatus(t, err, http.StatusForbidden)
	require.False(t, called)
}

func TestWorkspaceCoding_RechecksShareBeforeExecution(t *testing.T) {
	checks, executed := 0, false
	q := &mockWorkspaceQuerier{getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
		checks++
		if checks == 1 {
			return db.WorkspaceShare{Level: "write"}, nil
		}
		return db.WorkspaceShare{Level: "read"}, nil
	}}
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		executed = true
		return sandbox.ExecResult{}, nil
	}}
	_, err := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm)).ApplyCodingOperation(context.Background(), "ws-1", 101, 2, codingFixture())
	assertAPIErrorStatus(t, err, http.StatusForbidden)
	require.False(t, executed)
}

func TestWorkspaceCoding_RejectsReplacedExecutionBeforeMutation(t *testing.T) {
	loads, executed := 0, false
	q := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		loads++
		workspace := db.Workspace{ID: "ws-1", RepositoryID: 101, UserID: 1, VmID: "vm-source-1", Status: "running"}
		if loads > 1 {
			workspace.VmID = "replacement-vm"
		}
		return workspace, nil
	}}
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		executed = true
		return sandbox.ExecResult{}, nil
	}}
	_, err := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm)).ApplyCodingOperation(context.Background(), "ws-1", 101, 1, codingFixture())
	assertAPIErrorStatus(t, err, http.StatusConflict)
	require.False(t, executed)
}

type codingProvenanceTestStore struct {
	*mockWorkspaceQuerier
	record func(db.RecordWorkspaceCodingOperationParams) error
}

func (q codingProvenanceTestStore) RecordWorkspaceCodingOperation(_ context.Context, input db.RecordWorkspaceCodingOperationParams) (db.JjOperation, error) {
	return db.JjOperation{}, q.record(input)
}

func TestWorkspaceCoding_ProvenanceRetryKeepsNativeReceiptAndFreshTransportKey(t *testing.T) {
	input := codingFixture()
	result := WorkspaceCodingResult{Status: "accepted", OperationID: strings.Repeat("e", 128), ParentOperationID: input.ExpectedOperationID,
		Timestamp: time.Now().UTC(), Revisions: []WorkspaceCodingRevision{input.Target}}
	raw, err := json.Marshal(result)
	require.NoError(t, err)
	keys := []string{}
	zero := int32(0)
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(ctx context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		key, keyErr := sandbox.RequestIdempotencyKey(ctx)
		require.NoError(t, keyErr)
		keys = append(keys, key)
		require.Contains(t, req.Command, shellQuote(workspaceJJExportPath)+" --local")
		require.True(t, strings.HasPrefix(req.Command, "runuser -u 'developer' -- env -u JJ_CONFIG HOME='/home/developer'"))
		require.Contains(t, req.Command, "XDG_CONFIG_HOME='/home/developer/.config' USER='developer' LOGNAME='developer'")
		return sandbox.ExecResult{StatusCode: &zero, Stdout: string(raw)}, nil
	}}
	calls := 0
	q := codingProvenanceTestStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, record: func(record db.RecordWorkspaceCodingOperationParams) error {
		calls++
		require.Equal(t, result.OperationID, record.OperationID)
		require.Equal(t, input.ExpectedOperationID, record.ParentOperationID)
		require.Equal(t, []string{input.Target.ChangeID}, record.ChangeIds)
		if calls == 1 {
			return errors.New("lost database connection")
		}
		return nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))
	_, err = svc.ApplyCodingOperation(context.Background(), "ws-1", 101, 1, input)
	assertAPIErrorStatus(t, err, http.StatusServiceUnavailable)
	actual, err := svc.ApplyCodingOperation(context.Background(), "ws-1", 101, 1, input)
	require.NoError(t, err)
	require.Equal(t, result.OperationID, actual.OperationID)
	require.Len(t, keys, 2)
	require.NotEqual(t, keys[0], keys[1])
}

func TestWorkspaceCoding_NativePostgresProjection(t *testing.T) {
	if os.Getenv("SMITHERS_CODING_NATIVE_TEST") == "" {
		t.Skip("SMITHERS_CODING_NATIVE_TEST enables actual guest command + PostgreSQL acceptance")
	}
	helper := os.Getenv(workspaceJJExportBinaryEnv)
	if helper == "" {
		t.Skip("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY must name the built native helper")
	}
	pool := getAgentTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repoID, UserID: userID, Name: "coding", TargetBookmark: "main", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='coding-test-vm' WHERE id=$1`, workspace.ID)
	require.NoError(t, err)
	repo := t.TempDir()
	command := exec.Command("jj", "git", "init", repo)
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	for _, pair := range [][2]string{{"user.name", "Coding Test"}, {"user.email", "coding@example.com"}} {
		output, err = exec.Command("jj", "-R", repo, "config", "set", "--repo", pair[0], pair[1]).CombinedOutput()
		require.NoError(t, err, string(output))
	}
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(ctx context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		guestCommand := strings.ReplaceAll(req.Command, defaultWorkspaceClonePath, repo)
		// This local transport adapter runs on macOS; the production command's
		// Linux runuser boundary is asserted above, while native JJ executes as
		// this test's owner against its isolated configured repository.
		start := strings.Index(guestCommand, shellQuote(workspaceJJExportPath)+" --local")
		require.GreaterOrEqual(t, start, 0)
		guestCommand = strings.Replace(guestCommand[start:], shellQuote(workspaceJJExportPath), shellQuote(helper), 1)
		cmd := exec.CommandContext(ctx, "sh", "-c", guestCommand)
		cmd.Env = append(os.Environ(), "SMITHERS_CODING_LOCAL_OWNER=1")
		var stderr strings.Builder
		cmd.Stderr = &stderr
		stdout, runErr := cmd.Output()
		code := int32(0)
		if runErr != nil {
			code = 1
		}
		return sandbox.ExecResult{StatusCode: &code, Stdout: string(stdout), Stderr: stderr.String()}, nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))
	read, err := svc.ReadCodingRevisions(ctx, workspace.ID, repoID, userID, nil)
	require.NoError(t, err)
	description := "feat: literal $(touch /tmp/smithers-coding-injection) `echo nope`"
	input := WorkspaceCodingInput{Operation: "create", RequestID: uuid.NewString(), ExpectedOperationID: read.OperationID, Target: *read.Head, Description: &description}
	result, err := svc.ApplyCodingOperation(ctx, workspace.ID, repoID, userID, input)
	require.NoError(t, err)
	require.Equal(t, "accepted", result.Status)
	require.Equal(t, description+"\n", result.Revision.Description)
	replay, err := svc.ApplyCodingOperation(ctx, workspace.ID, repoID, userID, input)
	require.NoError(t, err)
	require.True(t, replay.Replayed)
	require.Equal(t, result.OperationID, replay.OperationID)
	count, err := q.CountJjOperationsByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
	stored, err := q.GetJjOperationForWorkspace(ctx, db.GetJjOperationForWorkspaceParams{RepositoryID: repoID, OperationID: result.OperationID, WorkspaceID: workspace.ID})
	require.NoError(t, err)
	require.Equal(t, "coding/create", stored.OperationType)
	require.Contains(t, stored.ChangeIds, result.Revision.ChangeID)

	// A local authorized guest writes only native history. The existing head
	// report projects that receipt later, and replay after a lost ACK upserts
	// the same immutable row under the effective workspace execution principal.
	current, err := svc.ReadCodingRevisions(ctx, workspace.ID, repoID, userID, nil)
	require.NoError(t, err)
	local, err := svc.executeCoding(ctx, workspace.ID, repoID, userID, WorkspaceAccessWrite, map[string]any{
		"operation": "create", "requestId": uuid.NewString(), "expectedOperationId": current.OperationID,
		"target": current.Head, "description": "local guest", "actorId": userID,
		"workspaceId": workspace.ID, "reportProvenance": true,
	})
	require.NoError(t, err)
	count, err = q.CountJjOperationsByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Equal(t, int64(1), count, "local native acceptance has not claimed cloud provenance yet")
	canonicalRoot, err := filepath.EvalSymlinks(repo)
	require.NoError(t, err)
	digest := sha256.Sum256([]byte(canonicalRoot))
	hexDigest := fmt.Sprintf("%x", digest)
	ownerID := fmt.Sprintf("%s-%s-4%s-8%s-%s", hexDigest[:8], hexDigest[8:12], hexDigest[13:16], hexDigest[17:20], hexDigest[20:32])
	projectionBytes, err := exec.Command(helper, "--projections", repo, ownerID, "").CombinedOutput()
	require.NoError(t, err, string(projectionBytes))
	var projection struct {
		Operations []WorkspaceCodingProjection `json:"coding_operations"`
	}
	require.NoError(t, json.Unmarshal(projectionBytes, &projection))
	require.Len(t, projection.Operations, 1)
	require.Equal(t, local.OperationID, projection.Operations[0].OperationID)
	headInput := ReportWorkspaceHeadInput{WorkspaceID: workspace.ID, RepositoryID: repoID,
		TokenWorkspaceID: workspace.ID, ChangeID: local.Head.ChangeID, CommitID: local.Head.CommitID,
		CodingOperations: projection.Operations}
	for range 2 {
		_, err = svc.ReportWorkspaceHead(ctx, headInput)
		require.NoError(t, err)
	}
	count, err = q.CountJjOperationsByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
	projected, err := q.GetJjOperationForWorkspace(ctx, db.GetJjOperationForWorkspaceParams{
		RepositoryID: repoID, OperationID: local.OperationID, WorkspaceID: workspace.ID})
	require.NoError(t, err)
	require.Equal(t, userID, projected.UserID)
	require.Equal(t, local.ParentOperationID, projected.ParentOperationID)
	_, err = os.Stat("/tmp/smithers-coding-injection")
	require.True(t, os.IsNotExist(err))
	// A different actor cannot take over an already projected native operation.
	otherID, _ := setupTestUserAndRepo(t, pool)
	_, err = q.RecordWorkspaceCodingOperation(ctx, db.RecordWorkspaceCodingOperationParams{RepositoryID: repoID, OperationID: result.OperationID, OperationType: "coding/create", UserID: otherID, WorkspaceID: workspace.ID, ParentOperationID: result.ParentOperationID, ChangeIds: stored.ChangeIds, CreatedAt: result.Timestamp})
	require.Error(t, err)
}
