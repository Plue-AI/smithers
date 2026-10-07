package compose

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// The boot authority follows the host's lane and logical item change. Guest
// request fields, Git bookmarks and working-copy trees cannot select an item.
func machineItemBinding(ctx context.Context, pool *pgxpool.Pool, branch string) (machined.ItemBinding, error) {
	if pool == nil || branch == "" {
		return machined.ItemBinding{}, machined.ErrNotReady
	}
	var number int64
	var change, preMove string
	var retired bool
	var bound bool
	err := pool.QueryRow(ctx, `SELECT COALESCE(i.number,0),COALESCE((SELECT CASE WHEN COUNT(DISTINCT c.change_id)=1 THEN MAX(c.change_id) ELSE '' END FROM mythical_changes c WHERE c.item_id=i.id AND c.repository_id=w.repository_id),''),COALESCE(l.retired_at IS NOT NULL,false),l.item_id IS NOT NULL, COALESCE(w.moved_off->>'pre_move_commit','')
	 FROM workspaces w LEFT JOIN mythical_lanes l ON l.workspace_id=w.id::text
	 LEFT JOIN mythical_items i ON i.id=l.item_id AND i.repository_id=w.repository_id WHERE w.id=$1`, branch).Scan(&number, &change, &retired, &bound, &preMove)
	if err != nil {
		return machined.ItemBinding{}, err
	}
	if retired || number < 0 {
		return machined.ItemBinding{}, machined.ErrUnauthorized
	}
	if number == 0 {
		if bound {
			return machined.ItemBinding{}, machined.ErrNotReady
		}
		return machined.ItemBinding{}, nil
	}
	if change == "" {
		return machined.ItemBinding{}, machined.ErrNotReady
	}
	return machined.ItemBinding{Number: uint64(number), Change: change, PreMoveCommit: preMove}, nil
}
