package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A persisted GitHub push starts the repository's push workflows. Only a
// person's push to the GitHub repository's default branch is reviewed
// history and records push, which saves workflow caches. Any other branch,
// and a bot's or app's push, records system_push: it restores and saves none.
func TestGitHubWebhookPushSavesCachesOnlyForAPersonsDefaultBranchPushPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "gh-owner", LowerUsername: "gh-owner", DisplayName: "GitHub owner"})
	require.NoError(t, err)
	repoID := ciTestRepo(t, pool, owner.ID, "app")
	var config map[string]any
	require.NoError(t, json.Unmarshal([]byte(ciTestWorkflowConfig), &config))
	config["on"] = map[string]any{"push": map[string]any{}}
	raw, err := json.Marshal(config)
	require.NoError(t, err)
	definition, err := q.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID, Name: "CI", Path: ".smithers/workflows/ci.tsx",
		Config: json.RawMessage(`{"on":{"push":{}},"jobs":{"database-only":{}}}`),
	})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workflow_triggers (repository_id, workflow_definition_id, workflow_path, event_type) VALUES ($1, $2, $3, 'push')`,
		repoID, definition.ID, definition.Path)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO github_app_installations (installation_id, account_login) VALUES (7, 'gh-owner')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO github_app_installation_repositories (installation_id, github_repository_id, owner_login, owner_login_lower, repo_name, repo_name_lower) VALUES (7, 70, 'gh-owner', 'gh-owner', 'app', 'app')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO repo_connections (user_id, repo_owner, repo_name, repo_owner_lower, repo_name_lower, license_spdx_id) VALUES ($1, 'gh-owner', 'app', 'gh-owner', 'app', 'MIT')`, owner.ID)
	require.NoError(t, err)

	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://blob.test"})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	cache := services.NewWorkflowCacheService(q, store, services.WorkflowCacheConfig{})
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_FFI_LIBRARY_PATH is also required: push admission must use the real repository resolver")
		}
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to exercise the real repository resolver")
	}
	storage := t.TempDir()
	local, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "push-cache-test", FFILibraryPath: ffi})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	require.NoError(t, local.Client().InitRepo(ctx, "gh-owner", "app", "main", true))
	syncer := services.NewWorkflowSyncService(q, local.Client(), pushCacheFixtureParser{})
	worker := services.NewGitHubWebhookEventWorker(q, services.NewWorkflowRunService(q,
		services.WithWorkflowRunBookmarkCommitResolver(syncer),
		services.WithWorkflowRunDefinitionCommitLoader(syncer),
	))
	repoPath := filepath.Join(storage, "gh-owner", "app")
	jj := func(args ...string) string {
		t.Helper()
		argv := append([]string{"--config", "user.name=Push cache test", "--config", "user.email=push-cache@example.test"}, args...)
		cmd := exec.CommandContext(t.Context(), "jj", argv...)
		cmd.Dir = repoPath
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "jj %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	newRevision := func(description, ref string, withWorkflow bool) string {
		t.Helper()
		// The embedded engine advances the repository operation independently
		// of this fixture's working copy.
		jj("workspace", "update-stale")
		jj("new", "main")
		if withWorkflow {
			require.NoError(t, os.MkdirAll(filepath.Join(repoPath, ".smithers", "workflows"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(repoPath, definition.Path), raw, 0o644))
		} else {
			require.NoError(t, os.Remove(filepath.Join(repoPath, definition.Path)))
		}
		require.NoError(t, os.WriteFile(filepath.Join(repoPath, "revision.txt"), []byte(description), 0o644))
		jj("commit", "-m", description)
		commit := jj("log", "--no-graph", "-r", "@-", "-T", "commit_id")
		jj("bookmark", "set", strings.TrimPrefix(ref, "refs/heads/"), "-r", commit)
		return commit
	}

	for _, push := range []struct {
		name, ref, senderType, trigger string
		saves                          bool
	}{
		{"person on the default branch", "refs/heads/main", "User", "push", true},
		{"person on another branch", "refs/heads/feature", "User", "system_push", false},
		{"person on a branch named like the Smithers default", "refs/heads/Main", "User", "system_push", false},
		{"bot on the default branch", "refs/heads/main", "Bot", "system_push", false},
		{"app landing branch", "refs/heads/smithers/landing-1", "Bot", "system_push", false},
		{"sender missing", "refs/heads/main", "", "system_push", false},
	} {
		commit := newRevision(push.name, push.ref, true)
		payload, err := json.Marshal(map[string]any{
			"ref": push.ref, "after": commit,
			"installation": map[string]any{"id": 7},
			"repository": map[string]any{
				"id": 70, "name": "app", "full_name": "gh-owner/app", "default_branch": "main",
				"owner": map[string]any{"login": "gh-owner"},
			},
			"pusher": map[string]any{"name": "someone"},
			"sender": map[string]any{"login": "someone", "id": 99, "type": push.senderType},
		})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO github_webhook_jobs (delivery_id, event_type, installation_id, github_repository_id, payload) VALUES ($1, 'push', 7, 70, $2)`,
			uuid.New(), payload)
		require.NoError(t, err)
		require.NoError(t, worker.PollOnce(ctx))

		var runID int64
		var trigger string
		require.NoError(t, pool.QueryRow(ctx, `SELECT id, trigger_event FROM workflow_runs WHERE repository_id = $1 AND trigger_commit_sha = $2`,
			repoID, commit).Scan(&runID, &trigger), push.name)
		assert.Equal(t, push.trigger, trigger, push.name)
		run, err := q.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: runID, RepositoryID: repoID})
		require.NoError(t, err)
		var stepName string
		require.NoError(t, pool.QueryRow(ctx, `SELECT name FROM workflow_steps WHERE workflow_run_id = $1`, runID).Scan(&stepName))
		assert.Equal(t, "build", stepName, "the immutable pushed tree, not the database config, supplies the job")
		_, err = cache.BeginSave(ctx, run, "deps", "v1", 16)
		if push.saves {
			assert.NoError(t, err, "%s saves", push.name)
			continue
		}
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr, push.name)
		assert.Equal(t, http.StatusForbidden, apiErr.Status, "%s restores caches and saves none", push.name)
	}

	// A late delivery cannot resurrect a workflow removed on the current
	// branch, even though the database still contains an active definition.
	stale := newRevision("not delivered before main advances", "main", true)
	removed := newRevision("workflow removed from main", "main", false)
	for _, commit := range []string{stale, removed} {
		payload, err := json.Marshal(map[string]any{
			"ref": "refs/heads/main", "after": commit,
			"installation": map[string]any{"id": 7},
			"repository": map[string]any{
				"id": 70, "name": "app", "default_branch": "main",
				"owner": map[string]any{"login": "gh-owner"},
			},
			"sender": map[string]any{"login": "someone", "type": "User"},
		})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO github_webhook_jobs (delivery_id, event_type, installation_id, github_repository_id, payload) VALUES ($1, 'push', 7, 70, $2)`, uuid.New(), payload)
		require.NoError(t, err)
		require.NoError(t, worker.PollOnce(ctx))
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id = $1 AND trigger_commit_sha = $2`, repoID, commit).Scan(&count))
		require.Zero(t, count, "stale or removed workflow must not use the active database config")
	}

	// A main-pulled repository's default branch runs from the main pull's
	// verified fast-forward (a platform push), so the webhook starts none.
	worker.SetMainPull(pulledMain{})
	payload, err := json.Marshal(map[string]any{
		"ref": "refs/heads/main", "after": fmt.Sprintf("%040d", 99),
		"installation": map[string]any{"id": 7},
		"repository":   map[string]any{"id": 70, "name": "app", "default_branch": "main", "owner": map[string]any{"login": "gh-owner"}},
		"sender":       map[string]any{"login": "merge-queue", "type": "Bot"},
	})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO github_webhook_jobs (delivery_id, event_type, installation_id, github_repository_id, payload) VALUES ($1, 'push', 7, 70, $2)`, uuid.New(), payload)
	require.NoError(t, err)
	require.NoError(t, worker.PollOnce(ctx))
	var runs int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runs WHERE trigger_commit_sha = $1`, fmt.Sprintf("%040d", 99)).Scan(&runs))
	assert.Zero(t, runs)
	var total, completed int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE status = 'done' AND error = '') FROM github_webhook_jobs`).Scan(&total, &completed))
	require.Equal(t, 9, total)
	require.Equal(t, total, completed, "a failed or deferred delivery cannot prove that admission refused the run")
}

// Only TypeScript parsing is replaced: these fixtures store normalized JSON so
// this cache-policy regression does not depend on the separate TS evaluator.
// Ref lookup, immutable file reads, dispatch, persistence and cache admission
// use the real repository engine and PostgreSQL.
type pushCacheFixtureParser struct{}

func (pushCacheFixtureParser) Parse(_ context.Context, _ string, content []byte) (*services.WorkflowConfig, error) {
	var config services.WorkflowConfig
	if err := json.Unmarshal(content, &config); err != nil {
		return nil, err
	}
	return &config, nil
}

type pulledMain struct{}

func (pulledMain) RequestForGitHub(context.Context, string, string) error { return nil }
func (pulledMain) PullsBranch(_ context.Context, _ int64, branch string) (bool, error) {
	return branch == "main", nil
}
