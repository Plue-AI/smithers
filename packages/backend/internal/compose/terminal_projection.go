package compose

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// Only committed person sessions enter the Branch terminal projection. The
// broker's current connection and owner/watch attachments supply live facts.
func terminalProjection(pool *pgxpool.Pool, watchers func(string) routes.TerminalPresence, registry *machined.Registry) func(context.Context, db.Workspace, map[string]int) ([]any, error) {
	return func(ctx context.Context, branch db.Workspace, colors map[string]int) ([]any, error) {
		rows, err := pool.Query(ctx, `SELECT s.id,s.user_id,s.status FROM workspace_sessions s JOIN users u ON u.id=s.user_id WHERE s.workspace_id=$1 AND s.repository_id=$2 AND s.kind='terminal' AND s.status IN ('pending','starting','running') AND COALESCE(s.ssh_connection_info->>'via','terminal')<>'ssh' AND u.is_active AND NOT u.prohibit_login AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM collaborators c WHERE c.repository_id=s.repository_id AND c.user_id=s.user_id AND c.suspended_at IS NULL AND c.permission IN ('write','admin')) ORDER BY s.created_at,s.id`, branch.ID, branch.RepositoryID)
		if err != nil {
			return nil, err
		}
		type terminal struct {
			id     string
			owner  int64
			status string
		}
		var entries []terminal
		for rows.Next() {
			var entry terminal
			if err = rows.Scan(&entry.id, &entry.owner, &entry.status); err != nil {
				rows.Close()
				return nil, err
			}
			entries = append(entries, entry)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		frozen := true
		if registry != nil {
			if link, err := registry.Current(branch.ID); err == nil {
				frozen = link.RequireReady(branch.ID) != nil
			}
		}
		result := make([]any, 0, len(entries))
		q := db.New(pool)
		for _, entry := range entries {
			owner, err := q.GetUserByID(ctx, entry.owner)
			if err != nil {
				return nil, err
			}
			watching := []any{}
			if watchers != nil {
				for _, id := range watchers(entry.id).Watchers {
					person, err := q.GetUserByID(ctx, id)
					if err != nil {
						return nil, err
					}
					if !person.IsActive || person.ProhibitLogin || person.DeletedAt.Valid {
						continue
					}
					watching = append(watching, branchPersonActor(person, colors[person.Username]))
				}
			}
			result = append(result, map[string]any{"id": entry.id, "title": "Terminal", "owner": branchPersonActor(owner, colors[owner.Username]), "watchers": watching, "agents": []any{}, "frozen": frozen || entry.status != "running" || branch.Status != "running"})
		}
		return result, nil
	}
}
