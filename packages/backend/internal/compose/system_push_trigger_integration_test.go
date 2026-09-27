package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A push event names the kind of credential behind it. A push by a
// system-issued credential (an agent run's token on its own bookmarks, or
// the platform's GitHub import and refresh) still starts the push
// workflows, but the run records system_push and saves no workflow cache.
// A person's push and the GitHub main pull (the API's own verified
// fast-forward to GitHub's reviewed default branch) record push and save; an
// unattributed push does not.
func TestSystemCredentialPushNeverSavesWorkflowCachesPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "push-owner", LowerUsername: "push-owner", DisplayName: "Push owner"})
	require.NoError(t, err)
	repoID := ciTestRepo(t, pool, owner.ID, "app")
	var config map[string]any
	require.NoError(t, json.Unmarshal([]byte(ciTestWorkflowConfig), &config))
	config["on"] = map[string]any{"push": map[string]any{}}
	raw, err := json.Marshal(config)
	require.NoError(t, err)
	_, err = q.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID, Name: "CI", Path: ".smithers/workflows/ci.tsx", Config: raw,
	})
	require.NoError(t, err)

	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://blob.test"})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	cache := services.NewWorkflowCacheService(q, store, services.WorkflowCacheConfig{})
	hook := &routes.InternalPushHookHandler{RepoResolver: q, Events: q, WorkflowRun: services.NewWorkflowRunService(q)}

	for i, push := range []struct {
		credential, login, trigger string
		saves                      bool
	}{
		{"run", "push-owner", "system_push", false},
		{"sync", "push-owner", "system_push", false},
		{"person", "push-owner", "push", true},
		{"platform", "github", "push", true},
		{"", "unattributed", "system_push", false},
	} {
		body, err := json.Marshal(map[string]any{
			"delivery_id": fmt.Sprintf("delivery-%d", i), "owner": "push-owner", "repo": "app",
			"ref_name": "refs/heads/main", "before_sha": "", "commit_sha": fmt.Sprintf("%040d", i+1),
			"pusher_id": owner.ID, "pusher_login": push.login, "pusher_credential": push.credential,
		})
		require.NoError(t, err)
		rec := httptest.NewRecorder()
		hook.PostPushEvent(rec, httptest.NewRequest(http.MethodPost, "/internal/push-hook", bytes.NewReader(body)))
		require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
		events, err := q.ClaimPendingRepoPushEvents(ctx, 10)
		require.NoError(t, err)
		require.Len(t, events, 1)
		assert.Equal(t, push.credential, events[0].PusherCredential)
		require.NoError(t, hook.ProcessRepoPushEvent(ctx, events[0], nil))

		var runID int64
		var trigger string
		require.NoError(t, pool.QueryRow(ctx, `SELECT id, trigger_event FROM workflow_runs WHERE repository_id = $1 AND trigger_commit_sha = $2`,
			repoID, fmt.Sprintf("%040d", i+1)).Scan(&runID, &trigger))
		assert.Equal(t, push.trigger, trigger, "push by %q", push.credential)
		run, err := q.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: runID, RepositoryID: repoID})
		require.NoError(t, err)
		_, err = cache.BeginSave(ctx, run, "deps", "v1", 16)
		if push.saves {
			assert.NoError(t, err, "push by %q saves", push.credential)
			continue
		}
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr, "push by %q", push.credential)
		assert.Equal(t, http.StatusForbidden, apiErr.Status, "push by %q restores caches and saves none", push.credential)
	}
}
