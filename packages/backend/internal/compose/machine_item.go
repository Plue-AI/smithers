package compose

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// The boot authority follows the host's lane and logical item change. Guest
// request fields, Git bookmarks and working-copy trees cannot select an item.
func machineItemBinding(ctx context.Context, pool *pgxpool.Pool, branch string, source ...*repohost.Client) (machined.ItemBinding, error) {
	if pool == nil || branch == "" {
		return machined.ItemBinding{}, machined.ErrNotReady
	}
	var number int64
	var change, preMove, bookmark string
	var retired bool
	var bound, reader bool
	err := pool.QueryRow(ctx, `SELECT COALESCE(i.number,0),COALESCE(i.checks->'machineItemChanges'->>w.id::text,(SELECT CASE WHEN COUNT(DISTINCT c.change_id)=1 THEN MAX(c.change_id) ELSE '' END FROM mythical_changes c WHERE c.item_id=i.id AND c.repository_id=w.repository_id),''),COALESCE(l.retired_at IS NOT NULL,false),l.item_id IS NOT NULL, COALESCE(w.moved_off->>'pre_move_commit',''),w.target_bookmark,EXISTS (SELECT 1 FROM mythical_wikis wiki WHERE wiki.workspace_id=w.id::text AND wiki.repository_id=w.repository_id) OR EXISTS (SELECT 1 FROM flow_loads f WHERE f.workspace_id=w.id::text AND f.repository_id=w.repository_id)
	 FROM workspaces w LEFT JOIN mythical_lanes l ON l.workspace_id=w.id::text
	 LEFT JOIN mythical_items i ON i.id=l.item_id AND i.repository_id=w.repository_id WHERE w.id=$1`, branch).Scan(&number, &change, &retired, &bound, &preMove, &bookmark, &reader)
	if err != nil {
		return machined.ItemBinding{}, err
	}
	if retired || number < 0 {
		return machined.ItemBinding{}, machined.ErrUnauthorized
	}
	if number == 0 {
		if bound || bookmark == "mythical" && !reader {
			return machined.ItemBinding{}, machined.ErrNotReady
		}
		return machined.ItemBinding{}, nil
	}
	if len(source) > 0 && source[0] != nil {
		q := db.New(pool)
		row, err := q.GetWorkspace(ctx, branch)
		if err != nil {
			return machined.ItemBinding{}, err
		}
		if row.SourceCommit == "" {
			return machined.ItemBinding{}, machined.ErrNotReady
		}
		scope, err := q.GetRepoOwnerSlugAndNameByID(ctx, row.RepositoryID)
		if err != nil {
			return machined.ItemBinding{}, err
		}
		// The lane's immutable source was pinned before its first boot. Item
		// projections can replace checks; the published review change cannot
		// rebind a retained coding machine when those projections replay.
		pinned, err := source[0].GetChange(ctx, scope.OwnerSlug, scope.RepoName, row.SourceCommit)
		if err != nil {
			return machined.ItemBinding{}, err
		}
		if pinned.CommitID != row.SourceCommit || pinned.ChangeID == "" {
			return machined.ItemBinding{}, machined.ErrNotReady
		}
		change = pinned.ChangeID
	}
	if change == "" {
		return machined.ItemBinding{}, machined.ErrNotReady
	}
	return machined.ItemBinding{Number: uint64(number), Change: change, PreMoveCommit: preMove}, nil
}
