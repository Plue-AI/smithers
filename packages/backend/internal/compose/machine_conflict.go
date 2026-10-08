package compose

import (
	"context"
	"encoding/json"
	"errors"

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
		return nil, nil
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
	if !checks.RunLaunched || !checks.RunAttached || result == nil || len(result.Paths) == 0 || !result.Inspected || result.ReceiptID == "" || result.Head != retained.Change || retained.Run != item.RequestRunID || checks.Rebase.Onto != retained.Onto || integration.Conflict.Head != retained.Change || integration.Conflict.Onto != retained.Onto {
		return nil, machined.ErrNotReady
	}
	return &machined.RetainedConflict{Change: retained.Change, Onto: retained.Onto}, nil
}
