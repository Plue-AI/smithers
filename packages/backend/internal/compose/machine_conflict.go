package compose

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// Only the existing pinned attempt's committed native rebase can admit a
// retained conflict during wake. Ordinary wake conflicts grant no admission.
func machineRetainedConflict(ctx context.Context, pool *pgxpool.Pool, branch string) (*machined.RetainedConflict, error) {
	q := db.New(pool)
	lane, err := q.GetMythicalLane(ctx, branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return machineScratchRetainedConflict(ctx, pool, branch)
	}
	if err != nil {
		return nil, err
	}
	if lane.RetiredAt.Valid {
		return nil, nil
	}
	item, err := q.GetMythicalItem(ctx, lane.ItemID)
	if err != nil {
		return nil, err
	}
	if item.RepositoryID != lane.RepositoryID || item.WorkspaceID != branch || item.Reason != "rebase_conflict_pending" || item.RequestRunID == "" || !item.FlowDigest.Valid {
		return nil, nil
	}
	var checks struct {
		RunLaunched bool `json:"run_launched"`
		RunAttached bool `json:"run_attached"`
		Rebase      struct {
			Onto   string
			Native *machined.RewriteResult
		}
		Reservation struct{ Change, Onto, Run string } `json:"conflictReservation"`
	}
	var integration struct{ Conflict struct{ Head, Onto string } }
	if json.Unmarshal(item.Checks, &checks) != nil || json.Unmarshal(item.Integration, &integration) != nil {
		return nil, machined.ErrNotReady
	}
	result := checks.Rebase.Native
	retained := checks.Reservation
	if result == nil && checks.RunLaunched && checks.RunAttached && retained.Run == item.RequestRunID && checks.Rebase.Onto == retained.Onto && integration.Conflict.Head == retained.Change && integration.Conflict.Onto == retained.Onto {
		// A host-only conflict has not rewritten the sleeping native working
		// copy. Wake that original capture normally; the fenced stack rebase
		// must produce its own native receipt before conflict admission.
		return nil, nil
	}
	if !checks.RunLaunched || !checks.RunAttached || result == nil || len(result.Paths) == 0 || !result.Inspected || result.ReceiptID == "" || result.Head != retained.Change || retained.Run != item.RequestRunID || checks.Rebase.Onto != retained.Onto || integration.Conflict.Head != retained.Change || integration.Conflict.Onto != retained.Onto {
		return nil, machined.ErrNotReady
	}
	return &machined.RetainedConflict{Change: retained.Change, Onto: retained.Onto}, nil
}

// Scratch retains the same authenticated native receipt, but never supplies a
// TODO root or flow digest. Boot still verifies the native change/target and
// acknowledged working copy through the existing retained-inspection path.
func machineScratchRetainedConflict(ctx context.Context, pool *pgxpool.Pool, branch string) (*machined.RetainedConflict, error) {
	row, err := db.New(pool).GetWorkspace(ctx, branch)
	if err != nil {
		return nil, err
	}
	if !row.IsFork || !strings.HasPrefix(row.TargetBookmark, "scratch/") || row.SourceCommit == "" || row.BranchArchivedAt.Valid {
		return nil, nil
	}
	var raw []byte
	err = pool.QueryRow(ctx, `SELECT authorization_context->'scratch_rebase' FROM product_job_requests WHERE tenant_id=$1 AND principal_id=$2 AND operation='branch.rebase-requested'
 AND authorization_context->'scratch_rebase'->>'phase' IN ('conflict','resolved') ORDER BY created_at DESC,id DESC LIMIT 1`, strconv.FormatInt(row.RepositoryID, 10), "branch:"+row.ID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var retained struct {
		Workspace      string                  `json:"workspace"`
		Branch         string                  `json:"branch"`
		Onto           string                  `json:"onto"`
		ConflictChange string                  `json:"conflict_change"`
		Native         *machined.RewriteResult `json:"native"`
	}
	if json.Unmarshal(raw, &retained) != nil {
		return nil, machined.ErrNotReady
	}
	native := retained.Native
	if native == nil || !native.Inspected {
		// The host retained a data-only merge. The native working copy was not
		// rewritten, so its ordinary wake remains on the pre-rebase capture.
		return nil, nil
	}
	if retained.Workspace != row.ID || retained.Branch != row.TargetBookmark || retained.Onto == "" || retained.ConflictChange == "" || native.Head != retained.ConflictChange || native.ReceiptID == "" || len(native.Paths) == 0 {
		return nil, machined.ErrNotReady
	}
	return &machined.RetainedConflict{Change: retained.ConflictChange, Onto: retained.Onto}, nil
}
