package product

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// 0120 (M-17, stage 2 item 9): one active workspace per repository and
// branch, whatever its kind, name, owner or source; stack lanes are told
// apart by lane name and children by their parent.
func TestOneLiveBranchMigration(t *testing.T) {
	t.Run("upgrade keeps every row", func(t *testing.T) {
		pool := reviewDatabase(t, 119)
		repo := reviewRepo(t, pool)
		ctx := t.Context()
		main, err := historicWorkspace(t, pool, db.CreateWorkspaceParams{RepositoryID: repo, UserID: 1001, Name: "main", TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		for _, arg := range []db.CreateWorkspaceParams{
			{Name: "retired", TargetBookmark: "main", Kind: "vm", Status: "stopped"},
			{Name: "TODO 1 attempt 1 g1", TargetBookmark: "mythical", Kind: "container", Status: "running"},
			{Name: "TODO 2 attempt 1 g1", TargetBookmark: "mythical", Kind: "container", Status: "starting"},
			{Name: "child-1", TargetBookmark: "main", Kind: "container", Status: "running", IsFork: true, ParentWorkspaceID: uuidValue(main)},
		} {
			arg.RepositoryID, arg.UserID = repo, 1001
			_, err := historicWorkspace(t, pool, arg)
			require.NoError(t, err)
		}
		require.NoError(t, Apply(ctx, pool))
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE deleted_at IS NULL`).Scan(&count))
		require.Equal(t, 5, count)
	})
	t.Run("refuses two live machines on one branch", func(t *testing.T) {
		pool := reviewDatabase(t, 119)
		repo := reviewRepo(t, pool)
		for _, arg := range []db.CreateWorkspaceParams{
			{Name: "editor", Kind: "container"},
			{Name: "terminal", Kind: "vm"},
		} {
			arg.RepositoryID, arg.UserID, arg.TargetBookmark, arg.Status = repo, 1001, "main", "running"
			_, err := historicWorkspace(t, pool, arg)
			require.NoError(t, err)
		}
		require.ErrorContains(t, Apply(t.Context(), pool), "two active workspaces serve one branch")
		var count int
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM workspaces WHERE deleted_at IS NULL`).Scan(&count))
		require.Equal(t, 2, count, "the refusal deletes nothing")
	})
}

// liveBranchModel is the key 0120 enforces, in Go: active, parentless rows
// are unique by (repository, branch, lane name on the stack's bookmark).
type liveBranchRow struct {
	repo           int64
	branch, name   string
	status         string
	parent, active bool
}

func (r liveBranchRow) key() string {
	lane := ""
	if r.branch == "mythical" {
		lane = r.name
	}
	return fmt.Sprintf("%d\x00%s\x00%s", r.repo, r.branch, lane)
}

func (r liveBranchRow) live() bool {
	return !r.parent && (r.status == "pending" || r.status == "starting" || r.status == "running" || r.status == "suspended")
}

// Property: for random inserts and status changes, the database admits a row
// exactly when the model does.
func TestOneLiveBranchIndexMatchesModel(t *testing.T) {
	pool := reviewDatabase(t, 0)
	repoA := reviewRepo(t, pool)
	var repoB int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO repositories (user_id,name,lower_name) VALUES (1001,'other','other') RETURNING id`).Scan(&repoB))
	ctx := t.Context()
	parent, err := historicWorkspace(t, pool, db.CreateWorkspaceParams{RepositoryID: repoB, UserID: 1001, Name: "parent", TargetBookmark: "parent", Kind: "container", Status: "failed"})
	require.NoError(t, err)

	seed := uint64(0x5eed0120)
	rng := rand.New(rand.NewPCG(seed, seed))
	branches := []string{"main", "mythical", "scratch/alice/try", "feature"}
	names := []string{"", "editor", "TODO 1 attempt 1 g1", "TODO 2 attempt 1 g1"}
	kinds := []string{"container", "vm", "agent"}
	statuses := []string{"pending", "starting", "running", "suspended", "stopped", "failed"}
	users := []int64{1001, 2, 3}
	type stored struct {
		id  string
		row liveBranchRow
	}
	var rows []stored
	held := map[string]int{}
	for step := 0; step < 400; step++ {
		if len(rows) > 0 && rng.IntN(3) == 0 {
			i := rng.IntN(len(rows))
			next := rows[i].row
			next.status = statuses[rng.IntN(len(statuses))]
			want := true
			if next.live() && !rows[i].row.live() {
				want = held[next.key()] == 0
			}
			_, err := pool.Exec(ctx, `UPDATE workspaces SET status=$2 WHERE id=$1`, rows[i].id, next.status)
			requireAdmitted(t, err, want, step, next)
			if err == nil {
				if rows[i].row.live() {
					held[rows[i].row.key()]--
				}
				if next.live() {
					held[next.key()]++
				}
				rows[i].row = next
			}
			continue
		}
		row := liveBranchRow{repo: []int64{repoA, repoB}[rng.IntN(2)], branch: branches[rng.IntN(len(branches))],
			name: names[rng.IntN(len(names))], status: statuses[rng.IntN(len(statuses))], parent: rng.IntN(5) == 0}
		arg := db.CreateWorkspaceParams{RepositoryID: row.repo, UserID: users[rng.IntN(len(users))], Name: row.name,
			TargetBookmark: row.branch, Kind: kinds[rng.IntN(len(kinds))], Status: row.status}
		if row.parent {
			arg.IsFork, arg.ParentWorkspaceID = true, uuidValue(parent)
		}
		switch rng.IntN(4) {
		case 1:
			arg.SourceCommit = "0123456789abcdef0123456789abcdef01234567"
		case 2:
			arg.IsFork = true
		}
		want := !row.live() || held[row.key()] == 0
		id, err := historicWorkspace(t, pool, arg)
		requireAdmitted(t, err, want, step, row)
		if err == nil {
			if row.live() {
				held[row.key()]++
			}
			rows = append(rows, stored{id: id, row: row})
		}
	}
	requireLiveBranchesUnique(t, pool)
}

func requireAdmitted(t *testing.T, err error, want bool, step int, row liveBranchRow) {
	t.Helper()
	if want {
		require.NoError(t, err, "step %d: %+v", step, row)
		return
	}
	var pgErr *pgconn.PgError
	require.True(t, errors.As(err, &pgErr), "step %d: %+v admitted: %v", step, row, err)
	require.Equal(t, "uq_workspaces_active", pgErr.ConstraintName, "step %d", step)
}

func requireLiveBranchesUnique(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var dupes int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM (SELECT 1 FROM workspaces
        WHERE parent_workspace_id IS NULL AND deleted_at IS NULL AND status IN ('pending','starting','running','suspended')
        GROUP BY repository_id, target_bookmark, CASE WHEN target_bookmark='mythical' THEN name ELSE '' END HAVING count(*) > 1) d`).Scan(&dupes))
	require.Zero(t, dupes)
}
