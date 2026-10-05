package product

import (
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestBranchMachineMigration(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		name := "preserve"
		if conflict {
			name = "refuse conflict"
		}
		t.Run(name, func(t *testing.T) {
			pool := reviewDatabase(t, 107)
			repo := reviewRepo(t, pool)
			ctx := t.Context()
			q := db.New(pool)
			source, err := historicWorkspace(t, pool, db.CreateWorkspaceParams{RepositoryID: repo, UserID: 1001, Name: "main", TargetBookmark: "main", Kind: "container", Status: "running"})
			require.NoError(t, err)
			snapshot, err := q.CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: repo, UserID: 1001, WorkspaceID: source, Name: "saved", SnapshotID: "retained-snapshot"})
			require.NoError(t, err)
			for _, kind := range []string{"named", "fork", "snapshot", "pushed-ref", "agent"} {
				arg := db.CreateWorkspaceParams{RepositoryID: repo, UserID: 2, Name: kind, TargetBookmark: "scratch/bob/" + kind, Kind: "container", Status: "running"}
				if conflict {
					arg.TargetBookmark = "main"
					arg.Name = "conflict"
				}
				if kind == "fork" {
					arg.ParentWorkspaceID = uuidValue(source)
				}
				if kind == "snapshot" {
					arg.SourceSnapshotID = uuidValue(snapshot.ID)
				}
				if kind == "pushed-ref" {
					arg.SourceCommit = "0123456789abcdef0123456789abcdef01234567"
				}
				session := "11111111-1111-4111-8111-111111111111"
				if kind == "agent" {
					_, err = q.CreateAgentSession(ctx, db.CreateAgentSessionParams{ID: session, RepositoryID: repo, UserID: 2, Status: "active"})
					require.NoError(t, err)
					arg.AgentSessionID = uuidValue(session)
					arg.Kind = "agent"
				}
				row, err := historicWorkspace(t, pool, arg)
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id=$2 WHERE id=$1`, row, "retained-"+kind)
				require.NoError(t, err)
				_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: row, OwnerUserID: 2, GranteeUserID: 3, Level: "write"})
				require.NoError(t, err)
				if conflict {
					break
				}
			}
			err = Apply(ctx, pool)
			if conflict {
				require.ErrorContains(t, err, "conflicting branch machine bindings")
				var owner int64
				require.NoError(t, pool.QueryRow(ctx, `SELECT user_id FROM workspaces WHERE name='conflict'`).Scan(&owner))
				require.EqualValues(t, 2, owner)
				return
			}
			require.NoError(t, err)
			owner, err := q.GetBranchMachineOwner(ctx)
			require.NoError(t, err)
			require.NotEqualValues(t, 1001, owner)
			require.NotEqualValues(t, 2, owner)
			var snapshotOwner int64
			require.NoError(t, pool.QueryRow(ctx, `SELECT user_id FROM workspace_snapshots WHERE id=$1`, snapshot.ID).Scan(&snapshotOwner))
			require.Equal(t, owner, snapshotOwner)

			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1 AND user_id=$2 AND deleted_at IS NULL`, repo, owner).Scan(&count))
			require.Equal(t, 6, count)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE vm_id LIKE 'retained-%'`).Scan(&count))
			require.Equal(t, 5, count)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_shares WHERE owner_user_id=$1`, owner).Scan(&count))
			require.Equal(t, 5, count)
			var workspace string
			require.NoError(t, pool.QueryRow(ctx, `SELECT workspace_id FROM agent_sessions WHERE id='11111111-1111-4111-8111-111111111111'`).Scan(&workspace))
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id=$1 AND agent_session_id IS NULL`, workspace).Scan(&count))
			require.Equal(t, 1, count)
			for i := 0; i < 101; i++ {
				_, err = pool.Exec(ctx, `INSERT INTO workspaces(repository_id,user_id,name,target_bookmark,kind,status) VALUES($1,$2,$3,$3,'container','starting')`, repo, owner, fmt.Sprintf("scratch/system/%d", i))
				require.NoError(t, err)
			}
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE user_id=2`).Scan(&count))
			require.Equal(t, 0, count)
		})
	}
}

func uuidValue(raw string) pgtype.UUID { var id pgtype.UUID; _ = id.Scan(raw); return id }

// historicWorkspace inserts a workspace with only the columns the schema had
// at 0108, so a test of an older migration never depends on a column a later
// one adds (the generated queries select every current column).
func historicWorkspace(t *testing.T, pool *pgxpool.Pool, arg db.CreateWorkspaceParams) (string, error) {
	t.Helper()
	var id string
	err := pool.QueryRow(t.Context(), `INSERT INTO workspaces (repository_id, user_id, name, is_fork, parent_workspace_id, target_bookmark,
		source_snapshot_id, kind, status, agent_session_id, source_commit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id::text`,
		arg.RepositoryID, arg.UserID, arg.Name, arg.IsFork, arg.ParentWorkspaceID, arg.TargetBookmark, arg.SourceSnapshotID,
		arg.Kind, arg.Status, arg.AgentSessionID, arg.SourceCommit).Scan(&id)
	return id, err
}
