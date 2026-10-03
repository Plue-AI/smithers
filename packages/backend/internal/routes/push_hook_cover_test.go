package routes

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/configsync"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type pushHookCovRepoResolver struct {
	row            db.GetRepoByOwnerAndNameRow
	repo           db.Repository
	ownerErr       error
	repoErr        error
	orgOwner       bool
	teamPermission string
	collabPerm     string
}

func (r *pushHookCovRepoResolver) GetRepoByOwnerAndName(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	if r.ownerErr != nil {
		return db.GetRepoByOwnerAndNameRow{}, r.ownerErr
	}
	return r.row, nil
}

func (r *pushHookCovRepoResolver) GetRepoByID(context.Context, int64) (db.Repository, error) {
	if r.repoErr != nil {
		return db.Repository{}, r.repoErr
	}
	return r.repo, nil
}

func (r *pushHookCovRepoResolver) GetRepoOwnerSlugAndNameByID(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	if r.repoErr != nil {
		return db.GetRepoOwnerSlugAndNameByIDRow{}, r.repoErr
	}
	name := r.repo.Name
	if name == "" {
		name = r.row.Name
	}
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "alice", RepoName: name}, nil
}

func (r *pushHookCovRepoResolver) IsOrgOwnerForRepoUser(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return r.orgOwner, nil
}

func (r *pushHookCovRepoResolver) GetHighestTeamPermissionForRepoUser(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return r.teamPermission, nil
}

func (r *pushHookCovRepoResolver) GetCollaboratorPermissionForRepoUser(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return r.collabPerm, nil
}

type pushHookCovDispatcher struct {
	err     error
	repoID  int64
	event   webhooks.EventType
	payload any
}

func (d *pushHookCovDispatcher) DispatchEvent(_ context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	d.repoID = repoID
	d.event = eventType
	d.payload = payload
	return d.err
}

func (d *pushHookCovDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	return nil
}

type pushHookCovWorkflowSync struct {
	loadCalled    bool
	persistCalled bool
}

func (s *pushHookCovWorkflowSync) LoadDefinitionsFromCommit(context.Context, int64, string) (services.WorkflowLoadResult, error) {
	s.loadCalled = true
	return services.WorkflowLoadResult{Definitions: []services.LoadedWorkflowDefinition{{Name: "ci", Path: ".smithers/workflows/ci.ts"}}}, nil
}

func (s *pushHookCovWorkflowSync) PersistDefinitions(context.Context, int64, services.WorkflowLoadResult, ...string) error {
	s.persistCalled = true
	return nil
}

type pushHookCovWorkflowRun struct {
	input services.DispatchForEventInput
}

func (r *pushHookCovWorkflowRun) DispatchForEvent(_ context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	r.input = input
	return []services.WorkflowRunResult{{WorkflowRunID: 9}}, nil
}

type pushHookCovConfigSync struct {
	input  configsync.SyncInput
	called bool
}

func (s *pushHookCovConfigSync) SyncFromCommit(_ context.Context, input configsync.SyncInput) (configsync.SyncResult, error) {
	s.input = input
	s.called = true
	return configsync.SyncResult{}, nil
}

func TestPushHook_Cov_PostPushEventBranches(t *testing.T) {
	t.Parallel()

	t.Run("invalid json", func(t *testing.T) {
		t.Parallel()

		h := &InternalPushHookHandler{}
		req := httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{`))
		rec := httptest.NewRecorder()

		postAndProcess(t, h, rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "Invalid JSON payload")
	})

	t.Run("not configured", func(t *testing.T) {
		t.Parallel()

		h := &InternalPushHookHandler{}
		req := httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{"owner":"alice","repo":"demo"}`))
		rec := httptest.NewRecorder()

		postAndProcess(t, h, rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("repo not found", func(t *testing.T) {
		t.Parallel()

		h := &InternalPushHookHandler{
			RepoResolver: &pushHookCovRepoResolver{repoErr: pgx.ErrNoRows},
			Dispatcher:   &pushHookCovDispatcher{},
		}
		req := httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{"repository_id":101,"owner":"alice","repo":"demo"}`))
		rec := httptest.NewRecorder()

		postAndProcess(t, h, rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("webhook enqueue error does not fail the push", func(t *testing.T) {
		t.Parallel()

		h := &InternalPushHookHandler{
			RepoResolver: &pushHookCovRepoResolver{row: db.GetRepoByOwnerAndNameRow{ID: 101, Name: "demo"}},
			Dispatcher:   &pushHookCovDispatcher{err: errors.New("queue down")},
		}
		req := httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{"repository_id":101,"owner":"alice","repo":"demo","ref_name":"refs/heads/main","pusher_id":7,"pusher_login":"alice"}`))
		rec := httptest.NewRecorder()

		postAndProcess(t, h, rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("wrapped repo not found is 404", func(t *testing.T) {
		t.Parallel()

		h := &InternalPushHookHandler{
			RepoResolver: &pushHookCovRepoResolver{repoErr: fmt.Errorf("lookup: %w", pgx.ErrNoRows)},
			Dispatcher:   &pushHookCovDispatcher{},
		}
		req := httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{"repository_id":101,"owner":"alice","repo":"demo"}`))
		rec := httptest.NewRecorder()

		postAndProcess(t, h, rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("repo resolve error is 500", func(t *testing.T) {
		t.Parallel()

		h := &InternalPushHookHandler{
			RepoResolver: &pushHookCovRepoResolver{repoErr: errors.New("pool exhausted")},
			Dispatcher:   &pushHookCovDispatcher{},
		}
		req := httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{"repository_id":101,"owner":"alice","repo":"demo"}`))
		rec := httptest.NewRecorder()

		postAndProcess(t, h, rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.NotContains(t, rec.Body.String(), "pool exhausted")
	})

	t.Run("success dispatches push payload", func(t *testing.T) {
		t.Parallel()

		dispatcher := &pushHookCovDispatcher{}
		h := &InternalPushHookHandler{
			RepoResolver: &pushHookCovRepoResolver{row: db.GetRepoByOwnerAndNameRow{ID: 101, Name: "demo"}},
			Dispatcher:   dispatcher,
		}
		req := httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{"repository_id":101,"owner":"alice","repo":"demo","ref_name":"refs/heads/main","pusher_id":7,"pusher_login":"alice"}`))
		rec := httptest.NewRecorder()

		postAndProcess(t, h, rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, int64(101), dispatcher.repoID)
		assert.Equal(t, webhooks.EventTypePush, dispatcher.event)
		payload, ok := dispatcher.payload.(webhooks.PushEventPayload)
		require.True(t, ok)
		assert.Equal(t, "alice/demo", payload.Repository.FullName)
		assert.Equal(t, "alice", payload.Sender.Login)
	})
}

func TestPushHook_Cov_WorkflowAndPermissionHelpers(t *testing.T) {
	t.Parallel()

	t.Run("persist config and dispatch loaded definitions on default bookmark", func(t *testing.T) {
		t.Parallel()

		syncer := &pushHookCovWorkflowSync{}
		runner := &pushHookCovWorkflowRun{}
		configSync := &pushHookCovConfigSync{}
		resolver := &pushHookCovRepoResolver{repo: db.Repository{
			ID:              101,
			Name:            "demo",
			DefaultBookmark: "main",
			UserID:          pgtype.Int8{Int64: 7, Valid: true},
		}}
		h := &InternalPushHookHandler{
			RepoResolver: resolver,
			WorkflowSync: syncer,
			WorkflowRun:  runner,
			ConfigSync:   configSync,
		}

		h.handleWorkflowsForPush(context.Background(), 101, PushHookEventRequest{
			Ref:         "refs/heads/main",
			CommitSHA:   "abc123",
			PusherID:    7,
			PusherLogin: "alice",

			PusherCredential: "person",
		})

		assert.True(t, syncer.loadCalled)
		assert.True(t, syncer.persistCalled)
		assert.True(t, configSync.called)
		require.NotNil(t, configSync.input.ActorID)
		assert.Equal(t, int64(7), *configSync.input.ActorID)
		// Dispatch loads push definitions from the trigger commit itself
		// (83e105a60): the hook never hands it a loaded snapshot.
		assert.False(t, runner.input.UseLoadedDefinitions)
		assert.Empty(t, runner.input.LoadedDefinitions)
		assert.Equal(t, "abc123", runner.input.Event.CommitSHA)
	})

	t.Run("fails closed when pusher cannot admin", func(t *testing.T) {
		t.Parallel()

		h := &InternalPushHookHandler{RepoResolver: &pushHookCovRepoResolver{repo: db.Repository{ID: 101, Name: "demo"}}}
		assert.False(t, h.pusherCanAdmin(context.Background(), 101, 0))
		assert.False(t, h.pusherCanAdmin(context.Background(), 101, 55))
	})

	t.Run("does not persist non default bookmark", func(t *testing.T) {
		t.Parallel()

		h := &InternalPushHookHandler{RepoResolver: &pushHookCovRepoResolver{repo: db.Repository{ID: 101, Name: "demo", DefaultBookmark: "main"}}}
		assert.False(t, h.shouldPersistDefinitions(context.Background(), 101, "refs/heads/feature"))
		assert.False(t, (&InternalPushHookHandler{}).shouldPersistDefinitions(context.Background(), 101, "refs/heads/main"))
	})
}
