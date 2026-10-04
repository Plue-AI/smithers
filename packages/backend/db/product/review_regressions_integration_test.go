package product

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// reviewDatabase creates an isolated database and applies the registered
// product migrations up to version (0 means every migration).
func reviewDatabase(t *testing.T, version int) *pgxpool.Pool {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := context.Background()
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	if version > 0 {
		migrations = migrations[:version]
	}
	require.NoError(t, applyOnce(ctx, pool, migrations))
	return pool
}

func reviewRepo(t *testing.T, p *pgxpool.Pool) int64 {
	t.Helper()
	_, err := p.Exec(t.Context(), `INSERT INTO users (id, username, lower_username) VALUES (1001,'alice','alice'),(2,'bob','bob'),(3,'carol','carol')`)
	require.NoError(t, err)
	var repo int64
	err = p.QueryRow(t.Context(), `INSERT INTO repositories (user_id,name,lower_name) VALUES (1001,'review','review') RETURNING id`).Scan(&repo)
	require.NoError(t, err)
	return repo
}

// The generated revocation queries must run against a fresh database and
// against one upgraded from the version that predates key_fingerprint.
func TestReviewRevocationsFreshAndV15Upgrade(t *testing.T) {
	for _, version := range []int{0, 15} {
		name := "fresh"
		if version == 15 {
			name = "upgrade15"
		}
		t.Run(name, func(t *testing.T) {
			p := reviewDatabase(t, version)
			ctx := t.Context()
			_, err := p.Exec(ctx, `INSERT INTO revocation_events(kind) VALUES ('token_revoked')`)
			require.NoError(t, err)
			require.NoError(t, Apply(ctx, p))
			q := db.New(p)
			rows, err := q.ListRevocationEventsAfter(ctx, db.ListRevocationEventsAfterParams{LimitCount: 100})
			require.NoError(t, err)
			require.Len(t, rows, 1)
			require.Empty(t, rows[0].KeyFingerprint)
			for _, kind := range []string{"token_revoked", "token_scopes_narrowed", "user_disabled", "user_enabled", "collaborator_removed", "workspace_share_removed", "agent_session_cancelled", "org_member_removed", "gateway_revoked", "ssh_key_revoked"} {
				row, err := q.InsertRevocationEvent(ctx, db.InsertRevocationEventParams{Kind: kind, KeyFingerprint: "SHA256:review", SandboxIds: []string{}})
				require.NoError(t, err)
				replay, err := q.ListRevocationEventsAfter(ctx, db.ListRevocationEventsAfterParams{AfterID: row.ID - 1, LimitCount: 1})
				require.NoError(t, err)
				require.Len(t, replay, 1)
				require.Equal(t, kind, replay[0].Kind)
				require.Equal(t, "SHA256:review", replay[0].KeyFingerprint)
			}
			_, err = p.Exec(ctx, `INSERT INTO revocation_events(kind) VALUES ('unknown')`)
			require.Error(t, err)
		})
	}
}

// UpsertPendingWorkflowCache must return the row it wrote, both for a brand
// new key and for a reservation it took over, not the pre-statement snapshot.
func TestReviewWorkflowCacheReservationReturnsCommittedRow(t *testing.T) {
	for _, update := range []bool{false, true} {
		name := "insert"
		if update {
			name = "update"
		}
		t.Run(name, func(t *testing.T) {
			p := reviewDatabase(t, 0)
			repo := reviewRepo(t, p)
			ctx := t.Context()
			q := db.New(p)
			var def, run int64
			require.NoError(t, p.QueryRow(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config) VALUES ($1,'ci','ci.yml','{}') RETURNING id`, repo).Scan(&def))
			require.NoError(t, p.QueryRow(ctx, `INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event) VALUES ($1,$2,'running','push') RETURNING id`, repo, def).Scan(&run))
			if update {
				_, err := p.Exec(ctx, `INSERT INTO workflow_caches(repository_id,bookmark_name,cache_key,object_key,object_size_bytes,expires_at) VALUES ($1,'main','deps','objects/old',100,NOW()-INTERVAL '1 hour')`, repo)
				require.NoError(t, err)
			}
			arg := db.UpsertPendingWorkflowCacheParams{RepositoryID: repo, WorkflowRunID: pgtype.Int8{Int64: run, Valid: true}, BookmarkName: "main", CacheKey: "deps", CacheVersion: "static", ObjectKey: "objects/new", ObjectSizeBytes: 200, Compression: "tar+gzip", ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)}
			row, err := q.UpsertPendingWorkflowCache(ctx, arg)
			require.NoError(t, err)
			committed, err := q.GetWorkflowCacheByID(ctx, row.ID)
			require.NoError(t, err)
			require.Equal(t, arg.ObjectKey, row.ObjectKey)
			require.Equal(t, arg.ObjectSizeBytes, row.ObjectSizeBytes)
			require.Equal(t, arg.WorkflowRunID, row.WorkflowRunID)
			require.True(t, arg.ExpiresAt.Equal(row.ExpiresAt))
			require.Equal(t, committed, row)
			// A live reservation owned by another run must still return its unchanged row.
			arg.WorkflowRunID = pgtype.Int8{}
			arg.ObjectKey = "objects/blocked"
			unchanged, err := q.UpsertPendingWorkflowCache(ctx, arg)
			require.NoError(t, err)
			require.Equal(t, row, unchanged)
		})
	}
}
