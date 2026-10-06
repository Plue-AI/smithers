package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This fixture records the batch at the provider seam. It does not claim to
// implement or qualify the guest's exclusion and crash recovery algorithm.
type fileBatchRuntime struct {
	repositoryID int64
	cloneURL     string
	*authorityRuntime
	writes     [][]workspaceapi.FileMutation
	operations []workspaceapi.Operation
	err        error
	raced      []workspaceapi.FileRace
	receipt    func(*workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult
}

func (r *fileBatchRuntime) CompareWriteFiles(ctx context.Context, id string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	r.writes = append(r.writes, changes)
	op, _ := workspaceapi.OperationFromContext(ctx)
	r.operations = append(r.operations, op)
	if r.park {
		return nil, r.effect("compare-write")
	}
	if r.err != nil {
		return nil, r.err
	}
	result := &workspaceapi.FileWriteResult{Raced: r.raced}
	for _, change := range changes {
		digest := "absent"
		if change.Content != nil {
			digest = fmt.Sprintf("%x", sha256.Sum256(change.Content))
		}
		result.Paths = append(result.Paths, workspaceapi.FileMutationResult{Path: change.Path, Digest: digest})
	}
	if r.receipt != nil {
		result = r.receipt(result)
	}
	return result, nil
}

func (r *fileBatchRuntime) ListFiles(ctx context.Context, id, path string) ([]workspaceapi.FileEntry, error) {
	return (&snapshotLostWorkerRuntime{}).ListFiles(ctx, id, path)
}
func (r *fileBatchRuntime) ReadFile(_ context.Context, id, _ string) ([]byte, error) {
	repo, clone := r.repositoryID, r.cloneURL
	if repo == 0 {
		repo = 101
	}
	if clone == "" {
		clone = testWorkspaceGitBaseURL + "/alice/demo.git"
	}
	return json.Marshal(workspaceRepositoryReceipt{Version: workspaceRepositoryReceiptVersion, WorkspaceID: id, RepositoryID: repo, CloneURL: clone, SourceBookmark: "main", SourceRevision: strings.Repeat("a", 40), InitializedAt: time.Now().UTC()})
}
func (r *fileBatchRuntime) ExecuteCommand(_ context.Context, _ string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if len(command.Args) >= 4 && command.Args[0] == "git" && command.Args[1] == "remote" {
		clone := r.cloneURL
		if clone == "" {
			clone = testWorkspaceGitBaseURL + "/alice/demo.git"
		}
		return workspaceapi.CommandResult{Stdout: clone + "\n"}, nil
	}
	return workspaceapi.CommandResult{}, nil
}

func TestWorkspaceService_FileBatch(t *testing.T) {
	runtime := &fileBatchRuntime{authorityRuntime: newAuthorityRuntime(workspaceapi.WorkspaceRunning)}
	svc := newWorkspaceServiceForTests(&repositoryIdentityQuerier{}, WithWorkspaceRuntime(runtime))
	changes := []workspaceapi.FileMutation{
		{Path: "old", BaseDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Content: nil},
		{Path: "new", BaseDigest: "absent", Content: []byte("hello\n")},
		{Path: "empty", BaseDigest: "absent", Content: []byte{}},
	}
	got, err := svc.WriteWorkspaceFiles(context.Background(), "ws-1", 101, 1, changes)
	require.NoError(t, err)
	require.Equal(t, []WorkspaceFileMutationResult{{Path: "old", Digest: "absent"}, {Path: "new", Digest: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"}, {Path: "empty", Digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}}, got.Paths)
	require.NotNil(t, got.Raced)
	require.Empty(t, got.Raced)
	require.Len(t, runtime.writes, 1)
	require.Equal(t, changes, runtime.writes[0])
	require.Equal(t, "1", runtime.operations[0].PrincipalID)
	require.Equal(t, "1", runtime.operations[0].TenantID)
	changes[1].Content[0] = 'X'
	require.Equal(t, []byte("hello\n"), runtime.writes[0][1].Content, "provider owns an immutable input snapshot")

	single, err := svc.WriteWorkspaceFile(context.Background(), "ws-1", 101, 1, "empty", "", "absent")
	require.NoError(t, err)
	require.Equal(t, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", single.Digest)
	require.Len(t, runtime.writes, 2)
	require.Len(t, runtime.writes[1], 1)
	require.NotNil(t, runtime.writes[1][0].Content, "empty file must not become a deletion")
	_, err = svc.WriteWorkspaceFiles(context.Background(), "ws-1", 101, 1, []workspaceapi.FileMutation{{Path: "empty", BaseDigest: "absent"}})
	require.NoError(t, err)
	require.NotEqual(t, runtime.operations[1].OperationID, runtime.operations[2].OperationID, "delete and empty create need different operation identities")
}

func TestWorkspaceService_FileBatchValidation(t *testing.T) {
	valid := workspaceapi.FileMutation{Path: "a", BaseDigest: "absent", Content: []byte("x")}
	cases := []struct {
		name    string
		changes []workspaceapi.FileMutation
		status  int
	}{
		{"empty", nil, 400},
		{"too many", make([]workspaceapi.FileMutation, 257), 400},
		{"duplicate", []workspaceapi.FileMutation{valid, valid}, 400},
		{"parent", []workspaceapi.FileMutation{valid, {Path: "a/b", BaseDigest: "absent"}}, 400},
		{"reverse parent", []workspaceapi.FileMutation{{Path: "a/b/c", BaseDigest: "absent"}, valid}, 400},
		{"invalid base", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "oops"}}, 400},
		{"aggregate limit", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: make([]byte, MaxWorkspaceFileBytes)}, {Path: "b", BaseDigest: "absent", Content: []byte("x")}}, 413},
		{"file limit", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: make([]byte, MaxWorkspaceFileBytes+1)}}, 413},
	}
	for _, path := range []string{"", "/a", "../a", "a//b", "a/./b", "a/../b", "a\x00b"} {
		cases = append(cases, struct {
			name    string
			changes []workspaceapi.FileMutation
			status  int
		}{"path " + path, []workspaceapi.FileMutation{{Path: path, BaseDigest: "absent"}}, 400})
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			runtime := &fileBatchRuntime{authorityRuntime: newAuthorityRuntime(workspaceapi.WorkspaceStopped)}
			svc := newWorkspaceServiceForTests(&repositoryIdentityQuerier{}, WithWorkspaceRuntime(runtime))
			result, err := svc.WriteWorkspaceFiles(context.Background(), "ws-1", 101, 1, tt.changes)
			assertAPIErrorStatus(t, err, tt.status)
			require.Nil(t, result)
			require.Empty(t, runtime.writes)
			require.Empty(t, runtime.sideEffects())
		})
	}
	for _, count := range []int{1, 256} {
		t.Run(fmt.Sprintf("inclusive limits %d", count), func(t *testing.T) {
			runtime := &fileBatchRuntime{authorityRuntime: newAuthorityRuntime(workspaceapi.WorkspaceRunning)}
			svc := newWorkspaceServiceForTests(&repositoryIdentityQuerier{}, WithWorkspaceRuntime(runtime))
			changes := make([]workspaceapi.FileMutation, count)
			for i := range changes {
				changes[i] = workspaceapi.FileMutation{Path: fmt.Sprintf(" file %d ", i), BaseDigest: "absent", Content: []byte{}}
			}
			changes[0].Content = make([]byte, MaxWorkspaceFileBytes)
			got, err := svc.WriteWorkspaceFiles(context.Background(), "ws-1", 101, 1, changes)
			require.NoError(t, err)
			require.Len(t, got.Paths, count)
			require.Equal(t, changes, runtime.writes[0])
		})
	}
}

func TestWorkspaceService_FileBatchRefusals(t *testing.T) {
	stale := &workspaceapi.StaleFileError{Path: "later", CurrentDigest: "absent"}
	for _, tt := range []struct {
		name   string
		err    error
		status int
	}{
		{"stale", stale, 0},
		{"unknown stale path", &workspaceapi.StaleFileError{Path: "outside", CurrentDigest: "absent"}, 500},
		{"invalid stale digest", &workspaceapi.StaleFileError{Path: "later", CurrentDigest: "no"}, 500},
		{"provider failed", errors.New("transport failed"), 500},
		{"canceled", context.Canceled, 500},
	} {
		t.Run(tt.name, func(t *testing.T) {
			runtime := &fileBatchRuntime{authorityRuntime: newAuthorityRuntime(workspaceapi.WorkspaceRunning), err: tt.err}
			svc := newWorkspaceServiceForTests(&repositoryIdentityQuerier{}, WithWorkspaceRuntime(runtime))
			got, err := svc.WriteWorkspaceFiles(context.Background(), "ws-1", 101, 1, []workspaceapi.FileMutation{{Path: "first", BaseDigest: "absent", Content: []byte("new")}, {Path: "later", BaseDigest: "absent"}})
			require.Nil(t, got)
			require.Len(t, runtime.writes, 1)
			require.Len(t, runtime.writes[0], 2)
			if tt.status == 0 {
				require.ErrorIs(t, err, stale)
			} else {
				assertAPIErrorStatus(t, err, tt.status)
			}
		})
	}
	for _, actor := range []int64{1, 2} {
		t.Run(fmt.Sprintf("unqualified actor %d", actor), func(t *testing.T) {
			runtime := newAuthorityRuntime(workspaceapi.WorkspaceStopped)
			q := &mockWorkspaceQuerier{getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
				return db.WorkspaceShare{Level: string(WorkspaceAccessRead)}, nil
			}}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
			_, err := svc.WriteWorkspaceFiles(context.Background(), "ws-1", 101, actor, []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: []byte("x")}})
			if actor == 1 {
				assertAPIErrorStatus(t, err, 503)
			} else {
				assertAPIErrorStatus(t, err, 403)
			}
			require.Empty(t, runtime.sideEffects(), "refusal must not start a machine")
		})
	}
}

// A real PostgreSQL share lock encloses the entire provider call. The recording
// runtime keeps this test focused on revocation ordering, not guest qualification.
func TestWorkspaceService_FileBatchHoldsAuthorityPostgres(t *testing.T) {
	for _, change := range []string{"revoke", "demote"} {
		t.Run(change, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			fx := newAuthorityFixture(t, "running", workspaceapi.WorkspaceRunning, false)
			slug, err := fx.store.GetRepoOwnerSlugAndNameByID(ctx, fx.repoID)
			require.NoError(t, err)
			runtime := &fileBatchRuntime{authorityRuntime: fx.runtime, repositoryID: fx.repoID, cloneURL: testWorkspaceGitBaseURL + "/" + slug.OwnerSlug + "/" + slug.RepoName + ".git"}
			svc := NewWorkspaceService(fx.store, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(fx.pool), WithWorkspaceGitBaseURL(testWorkspaceGitBaseURL))
			changes := []workspaceapi.FileMutation{{Path: "first", BaseDigest: "absent", Content: []byte("new")}, {Path: "last", BaseDigest: "absent", Content: []byte("last")}}
			call := func(actor int64) error {
				_, err := svc.WriteWorkspaceFiles(ctx, fx.workspaceID, fx.repoID, actor, changes)
				return err
			}
			for _, actor := range []int64{fx.reader, fx.revoked} {
				assertAPIErrorStatus(t, call(actor), 403)
			}
			require.Empty(t, runtime.writes)
			runtime.park = true
			released := false
			defer func() {
				if !released {
					close(runtime.release)
				}
			}()
			mutation := make(chan error, 1)
			go func() { mutation <- call(fx.writer) }()
			select {
			case <-runtime.entered:
			case err := <-mutation:
				t.Fatalf("batch never reached provider: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			changed := make(chan error, 1)
			go func() {
				if change == "revoke" {
					changed <- fx.store.DeleteWorkspaceShare(ctx, db.DeleteWorkspaceShareParams{WorkspaceID: fx.workspaceID, GranteeUserID: fx.writer})
					return
				}
				_, err := fx.store.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: fx.workspaceID, OwnerUserID: fx.owner, GranteeUserID: fx.writer, Level: "read"})
				changed <- err
			}()
			require.Eventually(t, func() bool { return shareRevocationWaiting(ctx, fx.pool) }, 5*time.Second, 10*time.Millisecond)
			select {
			case err := <-changed:
				t.Fatalf("grant changed during batch: %v", err)
			default:
			}
			close(runtime.release)
			released = true
			require.Error(t, <-mutation)
			require.NoError(t, <-changed)
			require.Len(t, runtime.writes, 1)
			require.Equal(t, changes, runtime.writes[0])
			require.Equal(t, fmt.Sprint(fx.writer), runtime.operations[0].PrincipalID)
			assertAPIErrorStatus(t, call(fx.writer), 403)
			require.Len(t, runtime.writes, 1)
		})
	}
}

func TestWorkspaceService_FileBatchReceipts(t *testing.T) {
	changes := []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: []byte("new")}}
	runtime := &fileBatchRuntime{authorityRuntime: newAuthorityRuntime(workspaceapi.WorkspaceRunning), raced: []workspaceapi.FileRace{{Path: "a", Version: "retained-outside"}}}
	svc := newWorkspaceServiceForTests(&repositoryIdentityQuerier{}, WithWorkspaceRuntime(runtime))
	got, err := svc.WriteWorkspaceFiles(t.Context(), "ws-1", 101, 1, changes)
	require.NoError(t, err)
	require.Equal(t, runtime.raced, got.Raced, "preserve the retained version, not the new content digest")
	require.Equal(t, "11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437", got.Paths[0].Digest)
	for name, corrupt := range map[string]func(*workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult{
		"nil":          func(*workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult { return nil },
		"missing path": func(r *workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult { r.Paths = nil; return r },
		"foreign path": func(r *workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult {
			r.Paths[0].Path = "other"
			return r
		},
		"wrong digest": func(r *workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult {
			r.Paths[0].Digest = "absent"
			return r
		},
		"foreign race": func(r *workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult {
			r.Raced = []workspaceapi.FileRace{{Path: "other", Version: "version"}}
			return r
		},
		"missing version": func(r *workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult {
			r.Raced = []workspaceapi.FileRace{{Path: "a"}}
			return r
		},
		"duplicate race": func(r *workspaceapi.FileWriteResult) *workspaceapi.FileWriteResult {
			r.Raced = []workspaceapi.FileRace{{Path: "a", Version: "one"}, {Path: "a", Version: "two"}}
			return r
		},
	} {
		t.Run(name, func(t *testing.T) {
			runtime.receipt = corrupt
			got, err := svc.WriteWorkspaceFiles(t.Context(), "ws-1", 101, 1, changes)
			require.Error(t, err)
			require.Nil(t, got, "invalid provider receipts cannot claim a successful write")
		})
	}
}
