package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/configsync"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestPushHook_H_RemainingPostAndWorkflowBranches(t *testing.T) {
	t.Run("repo resolver error and async branch", func(t *testing.T) {
		handler := &InternalPushHookHandler{
			RepoResolver: &pushHookCovRepoResolver{repoErr: errors.New("db down")},
			Dispatcher:   &pushHookCovDispatcher{},
		}
		req := httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{"repository_id":101,"owner":"alice","repo":"demo"}`))
		rec := httptest.NewRecorder()
		postAndProcess(t, handler, rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler = &InternalPushHookHandler{
			RepoResolver: &pushHookCovRepoResolver{row: db.GetRepoByOwnerAndNameRow{ID: 101, Name: "demo"}},
			Dispatcher:   &pushHookCovDispatcher{},
			WorkflowRun:  &pushHookCovWorkflowRun{},
		}
		req = httptest.NewRequest(http.MethodPost, "/internal/push", strings.NewReader(`{"repository_id":101,"owner":"alice","repo":"demo","commit_sha":"abc","pusher_id":7}`))
		rec = httptest.NewRecorder()
		postAndProcess(t, handler, rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("workflow load persist config and dispatch errors", func(t *testing.T) {
		handler := &InternalPushHookHandler{
			RepoResolver: &pushHookHRepoResolver{
				repo: db.Repository{ID: 101, DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 7, Valid: true}},
			},
			WorkflowSync: &pushHookHWorkflowSync{loadErr: errors.New("load failed")},
			WorkflowRun:  &pushHookHWorkflowRun{err: errors.New("dispatch failed")},
			ConfigSync:   &pushHookHConfigSync{err: errors.New("sync failed")},
		}
		err := handler.handleWorkflowsForPush(context.Background(), 101, PushHookEventRequest{Ref: "refs/heads/main", CommitSHA: "abc", PusherID: 7, PusherLogin: "alice"})
		require.ErrorContains(t, err, "workflow dispatch", "only a dispatch failure fails the step")

		handler.WorkflowSync = &pushHookHWorkflowSync{persistErr: errors.New("persist failed")}
		handler.handleWorkflowsForPush(context.Background(), 101, PushHookEventRequest{Ref: "refs/heads/main", CommitSHA: "abc", PusherID: 7, PusherLogin: "alice"})
	})

	t.Run("permission helpers fail closed", func(t *testing.T) {
		handler := &InternalPushHookHandler{RepoResolver: &pushHookHRepoResolver{
			repoErr: errors.New("repo missing"),
		}}
		require.False(t, handler.pusherCanAdmin(context.Background(), 101, 7))
		require.False(t, handler.shouldPersistDefinitions(context.Background(), 101, "refs/heads/main"))

		handler = &InternalPushHookHandler{RepoResolver: &pushHookHRepoResolver{
			repo:      db.Repository{ID: 101, DefaultBookmark: "main"},
			permErr:   errors.New("perm failed"),
			collabErr: errors.New("collab failed"),
		}}
		require.False(t, handler.pusherCanAdmin(context.Background(), 101, 7))
	})

	t.Run("config sync skipped when pusher lacks admin", func(t *testing.T) {
		handler := &InternalPushHookHandler{
			RepoResolver: &pushHookHRepoResolver{repo: db.Repository{ID: 101, DefaultBookmark: "main"}},
			ConfigSync:   &pushHookHConfigSync{},
		}
		handler.handleWorkflowsForPush(context.Background(), 101, PushHookEventRequest{Ref: "refs/heads/main", CommitSHA: "abc", PusherID: 0})
	})
}

type pushHookHRepoResolver struct {
	repo      db.Repository
	repoErr   error
	permErr   error
	collabErr error
}

func (r *pushHookHRepoResolver) GetRepoByOwnerAndName(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	return db.GetRepoByOwnerAndNameRow{}, nil
}

func (r *pushHookHRepoResolver) GetRepoByID(context.Context, int64) (db.Repository, error) {
	return r.repo, r.repoErr
}

func (r *pushHookHRepoResolver) GetRepoOwnerSlugAndNameByID(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "alice", RepoName: r.repo.Name}, r.repoErr
}

func (r *pushHookHRepoResolver) IsOrgOwnerForRepoUser(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, r.permErr
}

func (r *pushHookHRepoResolver) GetHighestTeamPermissionForRepoUser(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", r.permErr
}

func (r *pushHookHRepoResolver) GetCollaboratorPermissionForRepoUser(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return "", r.collabErr
}

type pushHookHWorkflowSync struct {
	loadErr    error
	persistErr error
}

func (s *pushHookHWorkflowSync) LoadDefinitionsFromCommit(context.Context, int64, string) (services.WorkflowLoadResult, error) {
	return services.WorkflowLoadResult{Definitions: []services.LoadedWorkflowDefinition{{Name: "ci"}}}, s.loadErr
}

func (s *pushHookHWorkflowSync) PersistDefinitions(context.Context, int64, services.WorkflowLoadResult) error {
	return s.persistErr
}

type pushHookHWorkflowRun struct {
	err error
}

func (r *pushHookHWorkflowRun) DispatchForEvent(context.Context, services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	return nil, r.err
}

type pushHookHConfigSync struct {
	err error
}

func (s *pushHookHConfigSync) SyncFromCommit(context.Context, configsync.SyncInput) (configsync.SyncResult, error) {
	return configsync.SyncResult{}, s.err
}
