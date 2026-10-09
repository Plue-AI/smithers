package services

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The retained-source host is the only test port: it plays the install
// repository, which holds main and the refs retention pushes. The machine is a
// real process workspace running real git and jj, and the access tokens are
// real rows. It does not qualify the microVM's unprivileged user.
type reviewRetentionHost struct {
	t       *testing.T
	bare    string
	refusal error
	calls   []RepositorySourceRetentionInput
	deleted []string
}

func (h *reviewRetentionHost) Retain(_ context.Context, repo, user int64, input RepositorySourceRetentionInput) (RepositorySourceRetentionResult, error) {
	h.calls = append(h.calls, input)
	if h.refusal != nil {
		return RepositorySourceRetentionResult{}, h.refusal
	}
	result := RepositorySourceRetentionResult{Status: "retained", WorkspaceID: input.WorkspaceID, Head: input.Head, Base: input.Base, CloneURL: h.bare,
		HeadRef: repohost.WorkspaceSourceRef(input.WorkspaceID, input.Head), BaseRef: repohost.WorkspaceSourceRef(input.WorkspaceID, input.Base)}
	reviewGit(h.t, h.bare, "update-ref", result.HeadRef, input.Head)
	reviewGit(h.t, h.bare, "update-ref", result.BaseRef, input.Base)
	return result, nil
}

func (h *reviewRetentionHost) DeleteWorkspaceRefs(_ context.Context, owner, repo, workspace string) (repohost.DeletedWorkspaceRefs, error) {
	h.deleted = append(h.deleted, owner+"/"+repo+"@"+workspace)
	return repohost.DeletedWorkspaceRefs{}, nil
}

func reviewPin(source, digest string) flowruntime.Pin {
	return flowruntime.Pin{Flow: "review", SourceCommit: source, ExecutionDigest: digest}
}

func reviewGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_AUTHOR_DATE=2026-10-01T11:00:00Z",
		"GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid", "GIT_COMMITTER_DATE=2026-10-01T11:00:00Z")
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, string(output))
	return strings.TrimSpace(string(output))
}

func TestReviewSourceRestoresHeadBesidePinnedSource(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is required for the machine's working copy")
	}
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "review-source-owner", LowerUsername: "review-source-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)

	// Install repository: pinned source R, main M (base) and the unmerged PR head H.
	work, bare := t.TempDir(), t.TempDir()
	reviewGit(t, bare, "init", "--quiet", "--bare")
	reviewGit(t, work, "init", "--quiet", "-b", "main")
	require.NoError(t, os.MkdirAll(filepath.Join(work, "flows/review"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(work, "flows/review/flow.ts"), []byte("// pinned review flow\n"), 0o600))
	reviewGit(t, work, "add", ".")
	reviewGit(t, work, "commit", "--quiet", "-m", "Pinned review flow")
	pinned := reviewGit(t, work, "rev-parse", "HEAD")
	require.NoError(t, os.WriteFile(filepath.Join(work, "cache.ts"), []byte("export const capacity = 2\n"), 0o600))
	reviewGit(t, work, "add", ".")
	reviewGit(t, work, "commit", "--quiet", "-m", "Base")
	base := reviewGit(t, work, "rev-parse", "HEAD")
	reviewGit(t, work, "push", "--quiet", bare, "HEAD:refs/heads/main")
	require.NoError(t, os.WriteFile(filepath.Join(work, "cache.ts"), []byte("export const capacity = 2 + 1\n"), 0o600))
	// The PR also edits the review flow. The machine must still hold the pinned bytes.
	require.NoError(t, os.WriteFile(filepath.Join(work, "flows/review/flow.ts"), []byte("// PR-controlled review flow\n"), 0o600))
	reviewGit(t, work, "commit", "--quiet", "-am", "Keep one more entry")
	head := reviewGit(t, work, "rev-parse", "HEAD")
	reviewGit(t, work, "push", "--quiet", bare, head+":refs/pull/50/head")
	digest := strings.Repeat("c", 64)
	_, err = q.InsertFlowVersion(ctx, repo.ID, "review", "flows/review/flow.ts", pinned, digest, "loaded", "", []byte(`{}`))
	require.NoError(t, err)

	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	runtime, err := process.New(process.Config{Root: root, Environment: map[string]string{"PATH": os.Getenv("PATH")}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	host := &reviewRetentionHost{t: t, bare: bare}
	source := &ReviewSource{q: q, runtime: runtime, retention: host, refs: host}
	admission := ReviewAdmission{RepositoryID: repo.ID, RequesterID: owner.ID, Number: 50, Head: head, Base: base,
		Pin: reviewPin(pinned, digest)}

	t.Run("refuses before allocation", func(t *testing.T) {
		for name, tc := range map[string]struct {
			source *ReviewSource
			pin    func(*ReviewAdmission)
			code   string
		}{
			"no retention":      {&ReviewSource{q: q, runtime: runtime}, nil, "review_source_unavailable"},
			"no runtime":        {&ReviewSource{q: q, retention: host}, nil, "review_source_unavailable"},
			"unmeasured digest": {source, func(a *ReviewAdmission) { a.Pin.ExecutionDigest = strings.Repeat("d", 64) }, "review_source_unavailable"},
			"other source":      {source, func(a *ReviewAdmission) { a.Pin.SourceCommit = base }, "review_digest_mismatch"},
			"todo pin":          {source, func(a *ReviewAdmission) { a.Pin.Flow = "todo" }, "review_binding_unavailable"},
		} {
			t.Run(name, func(t *testing.T) {
				refused := admission
				if tc.pin != nil {
					tc.pin(&refused)
				}
				requireTodoControl(t, tc.source.Prepare(ctx, refused), 503, tc.code)
			})
		}
		require.Empty(t, host.calls, "no refusal retains source")
		_, err := q.InsertFlowVersion(ctx, repo.ID, "review", "flows/review/flow.ts", base, strings.Repeat("e", 64), "failed", "load failed", []byte(`{}`))
		require.NoError(t, err)
		failed := admission
		failed.Pin = reviewPin(base, strings.Repeat("e", 64))
		requireTodoControl(t, source.Prepare(ctx, failed), 503, "review_digest_mismatch")
		// The built-in version the install ships needs no measured row: Restore
		// checks its commit is on main, and the host serves it only there.
		digests, err := builtinFlowDigests()
		require.NoError(t, err)
		builtin := admission
		builtin.Pin = reviewPin(base, digests["review"])
		require.NoError(t, source.Prepare(ctx, builtin))
		builtin.Pin.Flow = "learning"
		requireTodoControl(t, source.Prepare(ctx, builtin), 503, "review_binding_unavailable")
		require.Empty(t, host.calls, "Prepare retains no source")
	})

	workspaceID := "6a4b3b0e-9a59-5c4f-8c1b-0f7d2b5d1a10"
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: workspaceID})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, workspaceID)
	require.NoError(t, err)

	t.Run("a refused retention checks nothing out", func(t *testing.T) {
		host.refusal = sourceRetentionError("source_changed")
		err := source.Restore(ctx, workspaceID, admission)
		require.Error(t, err)
		require.Contains(t, err.Error(), "source changed")
		entries, err := runtime.ListFiles(ctx, workspaceID, "")
		require.NoError(t, err)
		require.Empty(t, entries)
		host.refusal = nil
	})

	host.calls = nil
	require.NoError(t, source.Restore(ctx, workspaceID, admission))
	require.Equal(t, []RepositorySourceRetentionInput{{WorkspaceID: workspaceID, Kind: "pull_request", Number: 50, Head: head, Base: base}}, host.calls)
	revision, err := workspaceapi.ResolveSourceRevision(ctx, runtime, workspaceID)
	require.NoError(t, err)
	require.Equal(t, head, revision, "the machine's recorded revision is the PR head")
	read := func(path string) string {
		data, err := runtime.ReadFile(ctx, workspaceID, path)
		require.NoError(t, err)
		return string(data)
	}
	// Restore is the review machine's whole setup, so it ends with the receipt
	// a Flow host start waits for; without it /review waited forever (J10 row 9).
	receipt, err := runtime.ReadFile(ctx, workspaceID, workspaceRepositoryReceiptPath)
	require.NoError(t, err)
	require.True(t, completedWorkspaceReceipt(receipt, workspaceID, admission.RepositoryID), string(receipt))
	require.Contains(t, string(receipt), `"source_revision":"`+head+`"`)
	require.False(t, completedWorkspaceReceipt(receipt, workspaceID, admission.RepositoryID+1), "the receipt names its own repository")
	require.Equal(t, "export const capacity = 2 + 1\n", read("cache.ts"))
	show := func(object string) string {
		result, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"git", "show", object}})
		require.NoError(t, err)
		require.Zero(t, result.ExitCode, result.Stderr)
		return result.Stdout
	}
	require.Equal(t, "// pinned review flow\n", show(pinned+":flows/review/flow.ts"), "the pinned commit is beside the PR head")
	require.Equal(t, "export const capacity = 2\n", show(base+":cache.ts"))
	remotes, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"git", "remote"}})
	require.NoError(t, err)
	require.Empty(t, strings.TrimSpace(remotes.Stdout), "no remote names a push destination")
	var tokens int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE user_id=$1`, owner.ID).Scan(&tokens))
	require.Zero(t, tokens, "the read token is revoked when restore returns")

	// A replay after a lost reply reuses the fetched refs: GitHub is not read
	// again, so a moved PR cannot change the selected head.
	host.refusal = sourceRetentionError("source_changed")
	require.NoError(t, source.Restore(ctx, workspaceID, admission))
	require.Len(t, host.calls, 1)
	revision, err = workspaceapi.ResolveSourceRevision(ctx, runtime, workspaceID)
	require.NoError(t, err)
	require.Equal(t, head, revision)

	require.NoError(t, source.Retire(ctx, workspaceID, admission))
	require.Equal(t, []string{"review-source-owner/app@" + workspaceID}, host.deleted)
}
