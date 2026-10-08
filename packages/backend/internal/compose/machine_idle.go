package compose

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

// Safe-idle duration starts with a complete quiet observation, never the last
// database write. A lost authority resets it, including after host restart.
func machineIdleObserver(pool *pgxpool.Pool, presence *branchPresence, registry *machined.Registry, todos liveTodos, documents bool) func(context.Context, db.Workspace) (microsandbox.AdmissionSafety, error) {
	var mu sync.Mutex
	type idleObservation struct {
		since      time.Time
		machine    string
		generation int32
		resumed    time.Time
	}
	idle := map[string]idleObservation{}
	return func(ctx context.Context, row db.Workspace) (microsandbox.AdmissionSafety, error) {
		s := microsandbox.AdmissionSafety{BurstsEnabled: true, DocumentsEnabled: documents}
		state, err := presence.rebasePresence(ctx, row.RepositoryID, row.ID)
		s.PresenceKnown = err == nil && state != services.RebasePresenceUnknown
		s.Presence = state == services.RebasePresencePeople
		var sessions bool
		err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_sessions WHERE workspace_id=$1 AND status IN ('pending','starting','running')) OR EXISTS(SELECT 1 FROM agent_sessions WHERE workspace_id=$1 AND status='active' AND deleted_at IS NULL)`, row.ID).Scan(&sessions)
		s.SessionsKnown = err == nil
		s.Terminal = sessions
		lane, err := db.New(pool).GetMythicalLane(ctx, row.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			s.RunKnown = s.PresenceKnown
			s.RunningStep = state == services.RebasePresenceAgent
		} else if err == nil && todos != nil {
			item, err := db.New(pool).GetMythicalItem(ctx, lane.ItemID)
			if err == nil && item.Number.Valid {
				card, err := todos.Todo(ctx, row.RepositoryID, item.Number.Int64)
				if err == nil {
					s.TODOState, s.RunKnown = card["state"].(string)
					switch s.TODOState {
					case "queued", "starting", "working", "in_review", "needs_you", "paused", "failed", "merged", "dropped":
					default:
						s.RunKnown = false
					}
					s.RunningStep = state == services.RebasePresenceAgent || s.TODOState == "working" || s.TODOState == "starting" || s.TODOState == "queued"
				}
			}
		}
		if registry != nil {
			bursts, flushed, err := registry.IdleSafety(ctx, row.ID)
			s.BurstsKnown = err == nil
			s.BurstOpen = !bursts
			s.DocumentsKnown = err == nil
			s.Unflushed = !flushed
		}
		mu.Lock()
		defer mu.Unlock()
		if s.PresenceKnown && s.SessionsKnown && s.RunKnown && !s.Presence && !s.Terminal && !s.RunningStep && s.BurstsKnown && !s.BurstOpen && (!documents || s.DocumentsKnown && !s.Unflushed) {
			prior := idle[row.ID]
			if prior.since.IsZero() || prior.machine != row.VmID || prior.generation != row.ProvisioningGeneration || !prior.resumed.Equal(row.ResumedAt.Time) {
				prior = idleObservation{presence.clock(), row.VmID, row.ProvisioningGeneration, row.ResumedAt.Time}
				idle[row.ID] = prior
			}
			s.IdleSince = prior.since
		} else {
			delete(idle, row.ID)
		}
		return s, nil
	}
}
