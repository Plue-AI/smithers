package product

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestWorkspaceServicePreviewDurableConsent(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	require.NoError(t, Apply(ctx, pool))
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	exec(`INSERT INTO users(id,username,lower_username,is_active) VALUES(1,'preview-owner','preview-owner',true)`)
	exec(`INSERT INTO repositories(id,user_id,name,lower_name) VALUES(1,1,'preview','preview')`)
	const id = "11111111-1111-4111-8111-111111111111"
	exec(`INSERT INTO workspaces(id,repository_id,user_id) VALUES($1,1,1)`, id)
	q := db.New(pool)
	check := func(want bool) {
		t.Helper()
		got, err := q.AuthorizePublicWorkspaceService(ctx, db.AuthorizePublicWorkspaceServiceParams{WorkspaceID: id, Port: 3000})
		require.NoError(t, err)
		require.Equal(t, want, got)
	}
	check(false)
	require.NoError(t, q.SetWorkspaceServicePublic(ctx, db.SetWorkspaceServicePublicParams{WorkspaceID: id, Port: 3000, Public: true}))
	q = db.New(pool)
	check(true)
	other, err := q.AuthorizePublicWorkspaceService(ctx, db.AuthorizePublicWorkspaceServiceParams{WorkspaceID: id, Port: 3001})
	require.NoError(t, err)
	require.False(t, other)
	exec(`UPDATE users SET prohibit_login=true WHERE id=1`)
	check(false)
	exec(`UPDATE users SET prohibit_login=false,is_active=false WHERE id=1`)
	check(false)
	exec(`UPDATE users SET is_active=true,deleted_at=now() WHERE id=1`)
	check(false)
	exec(`UPDATE users SET deleted_at=NULL WHERE id=1`)
	check(true)
	exec(`UPDATE workspaces SET deleted_at=now() WHERE id=$1`, id)
	check(false)
	exec(`UPDATE workspaces SET deleted_at=NULL WHERE id=$1`, id)
	check(true)
	require.NoError(t, q.SetWorkspaceServicePublic(ctx, db.SetWorkspaceServicePublicParams{WorkspaceID: id, Port: 3000, Public: false}))
	check(false)
	for _, port := range []int32{0, 65536} {
		require.Error(t, q.SetWorkspaceServicePublic(ctx, db.SetWorkspaceServicePublicParams{WorkspaceID: id, Port: port, Public: true}))
	}
	exec(`DELETE FROM workspaces WHERE id=$1`, id)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_service_previews`).Scan(&count))
	require.Zero(t, count)
}
