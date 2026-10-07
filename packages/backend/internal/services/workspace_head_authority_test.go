package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

type headAuthorityTokenStore struct {
	*mockWorkspaceQuerier
	token db.AccessToken
	err   error
}

func (s *headAuthorityTokenStore) GetAccessTokenByID(context.Context, int64) (db.AccessToken, error) {
	return s.token, s.err
}

func TestWorkspaceHeadTokenMatchesAuthority(t *testing.T) {
	scopes := workspaceHeadTokenScopes(1, "workspace") + "," + middleware.AgentSessionRestrictionScope("current-run")
	for _, cell := range []struct {
		name   string
		mutate func(*headAuthorityTokenStore)
		want   bool
	}{
		{"current", func(*headAuthorityTokenStore) {}, true},
		{"replaced run", func(s *headAuthorityTokenStore) {
			s.token.Scopes = strings.ReplaceAll(scopes, "current-run", "prior-run")
		}, false},
		{"unbound run", func(s *headAuthorityTokenStore) { s.token.Scopes = workspaceHeadTokenScopes(1, "workspace") }, false},
		{"different sponsor", func(s *headAuthorityTokenStore) { s.token.UserID = 2 }, false},
		{"person issued", func(s *headAuthorityTokenStore) { s.token.SystemIssued = false }, false},
		{"expired", func(s *headAuthorityTokenStore) { s.token.ExpiresAt.Time = time.Now().Add(-time.Second) }, false},
		{"unreadable", func(s *headAuthorityTokenStore) { s.err = errors.New("store unavailable") }, false},
	} {
		t.Run(cell.name, func(t *testing.T) {
			q := &headAuthorityTokenStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, token: db.AccessToken{UserID: 1, Scopes: scopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}}}
			cell.mutate(q)
			service := newWorkspaceServiceForTests(q)
			require.Equal(t, cell.want, service.headTokenMatchesAuthority(t.Context(), 42, 1, scopes))
		})
	}
}

func TestWorkspaceHeadAuthorityScopesPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := t.Context()
	user, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: "run-authority", Kind: "container", Status: "running"})
	require.NoError(t, err)
	service := NewWorkspaceService(q, WithWorkspaceInstallAuthorization(q))
	base := workspaceHeadTokenScopes(repo, workspace.ID)
	scopes, err := service.workspaceHeadAuthorityScopes(ctx, workspace, user)
	require.NoError(t, err)
	require.Equal(t, base, scopes, "an ordinary workspace gets no TODO authority")
	var itemID pgtype.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,workspace_id,request_run_id,owner_id,attempt) VALUES($1,'todo','running','Run authority',$2,'current-run',$3,1) RETURNING id`, repo, workspace.ID, user).Scan(&itemID))
	_, err = pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'request')`, workspace.ID, repo, itemID)
	require.NoError(t, err)
	scopes, err = service.workspaceHeadAuthorityScopes(ctx, workspace, user)
	require.NoError(t, err)
	require.Equal(t, base+","+middleware.AgentSessionRestrictionScope("current-run"), scopes)
	scopes, err = service.workspaceHeadAuthorityScopes(ctx, workspace, user+1)
	require.NoError(t, err)
	require.Equal(t, base, scopes, "another sponsor cannot receive the attempt's run grant")
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET request_run_id='replacement-run' WHERE id=$1`, itemID)
	require.NoError(t, err)
	scopes, err = service.workspaceHeadAuthorityScopes(ctx, workspace, user)
	require.NoError(t, err)
	require.Equal(t, base+","+middleware.AgentSessionRestrictionScope("replacement-run"), scopes)
	for _, cell := range []struct{ name, set string }{
		{"ordinary coding work", "source='chat'"},
		{"attempt not admitted", "attempt=0"},
		{"run not attached", "request_run_id=''"},
		{"closed TODO", "state='landed'"},
		{"sponsor removed", "owner_id=NULL"},
		{"workspace replaced", "workspace_id=''"},
	} {
		t.Run(cell.name, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer func() { _ = tx.Rollback(context.Background()) }()
			_, err = tx.Exec(ctx, "UPDATE mythical_items SET "+cell.set+" WHERE id=$1", itemID)
			require.NoError(t, err)
			scoped := NewWorkspaceService(q, WithWorkspaceInstallAuthorization(db.New(tx)))
			actual, err := scoped.workspaceHeadAuthorityScopes(ctx, workspace, user)
			require.NoError(t, err)
			require.Equal(t, base, actual)
		})
	}
	t.Run("malformed stored run", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(context.Background()) }()
		_, err = tx.Exec(ctx, `UPDATE mythical_items SET request_run_id='run,write:user' WHERE id=$1`, itemID)
		require.NoError(t, err)
		scoped := NewWorkspaceService(q, WithWorkspaceInstallAuthorization(db.New(tx)))
		actual, err := scoped.workspaceHeadAuthorityScopes(ctx, workspace, user)
		require.Error(t, err)
		require.Empty(t, actual, "stored run text cannot inject a credential scope")
	})
	_, err = pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at=now() WHERE workspace_id=$1`, workspace.ID)
	require.NoError(t, err)
	scopes, err = service.workspaceHeadAuthorityScopes(ctx, workspace, user)
	require.NoError(t, err)
	require.Equal(t, base, scopes, "a retired lane retains head reporting without TODO authority")
}
