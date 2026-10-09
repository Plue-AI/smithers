package compose

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// The existing manager supplies lifecycle and attachment facts. Broker readiness
// supplies frozen state; terminal metadata never depends on workspace sessions.
func terminalProjection(pool *pgxpool.Pool, manager *routes.TerminalSessionManager, registry *machined.Registry) func(context.Context, db.Workspace, map[string]int) ([]any, error) {
	return func(ctx context.Context, branch db.Workspace, colors map[string]int) ([]any, error) {
		entries := manager.BranchTerminals(branch.RepositoryID, branch.ID)

		frozen := true
		if registry != nil {
			if link, err := registry.Current(branch.ID); err == nil {
				frozen = link.TerminalsFrozen(branch.ID)
			}
		}
		result := make([]any, 0, len(entries))
		q := db.New(pool)
		for _, entry := range entries {
			member := entry.Owner
			if entry.RunID != "" {
				member = entry.ForMember
			}
			owner, err := q.GetUserByID(ctx, member)
			if err != nil {
				return nil, err
			}
			if !owner.IsActive || owner.ProhibitLogin || owner.DeletedAt.Valid {
				continue
			}
			watching := []any{}
			if manager != nil {
				for _, id := range entry.Watchers {
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
			title := "Terminal"
			actor := branchPersonActor(owner, colors[owner.Username])
			if entry.RunID != "" {
				title = entry.Title
				actor = branchAgentActor("agent:"+entry.RunID, leaseParticipant{AgentKind: "coding", RunID: entry.RunID, SessionID: entry.ID, DisplayName: "Agent"}, &owner, colors[owner.Username])
			}
			row := map[string]any{"id": entry.ID, "title": title, "owner": actor, "watchers": watching, "agents": []any{}, "frozen": frozen || branch.Status != "running"}
			if entry.Command != "" {
				row["command"] = entry.Command
			}
			result = append(result, row)
		}
		return result, nil
	}
}

// Terminal participants come from the same authenticated process leases and
// actor adapter as Branch presence. All live sessions count, even when an
// agent's latest location is a file or step. Display never changes input owner.
func projectTerminalAgents(terminals, presence []any) error {
	byTerminal := map[string][]any{}
	for _, value := range presence {
		entry := value.(map[string]any)
		actor := entry["actor"].(map[string]any)
		if actor["kind"] != "agent" {
			continue
		}
		seen := map[string]bool{}
		for _, value := range entry["sessions"].([]any) {
			session := value.(map[string]any)
			raw := session["where"].(json.RawMessage)
			if len(raw) == 0 {
				continue
			}
			var where struct {
				Kind string `json:"kind"`
				ID   string `json:"id"`
			}
			if err := json.Unmarshal(raw, &where); err != nil {
				return err
			}
			if where.Kind == "terminal" && where.ID != "" && !seen[where.ID] {
				seen[where.ID] = true
				participant := make(map[string]any, len(actor)+1)
				for key, value := range actor {
					participant[key] = value
				}
				participant["session_id"] = session["id"]
				byTerminal[where.ID] = append(byTerminal[where.ID], participant)
			}
		}
	}
	for _, value := range terminals {
		terminal := value.(map[string]any)
		agents := byTerminal[terminal["id"].(string)]
		if agents == nil {
			agents = []any{}
		}
		terminal["agents"] = agents
	}
	return nil
}
