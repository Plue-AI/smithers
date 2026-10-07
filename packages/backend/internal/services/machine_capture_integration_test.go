package services

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstalledHeadCredentialRetirement(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var owner, repository, token int64
	branch := uuid.NewString()
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('retire-owner','retire-owner') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'retire','retire') RETURNING id`, owner).Scan(&repository))
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name) VALUES($1,$2,$3,'retire')`, branch, repository, owner)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO access_tokens(user_id,name,token_hash,scopes) VALUES($1,$2,$3,'write:repository') RETURNING id`, owner, "sandbox-workspace-"+branch, strings.Repeat("a", 64)).Scan(&token))
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, branch, token)
	require.NoError(t, err)
	q := db.New(pool)
	row, err := q.GetWorkspace(ctx, branch)
	require.NoError(t, err)
	svc := &WorkspaceService{q: q}
	require.NoError(t, svc.retireInstalledHeadCredential(ctx, row))
	require.NoError(t, svc.retireInstalledHeadCredential(ctx, row), "a replay must reread the cleared row")
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE id=$1`, token).Scan(&count))
	require.Zero(t, count)
	current, err := q.GetWorkspace(ctx, branch)
	require.NoError(t, err)
	require.False(t, current.HeadPushTokenID.Valid)
}
