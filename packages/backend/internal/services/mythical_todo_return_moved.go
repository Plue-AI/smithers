package services

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"time"
)

type MovedOffReturn interface {
	RequireReady(string) error
	ReturnToItem(context.Context, string, []byte) (machined.RewriteResult, error)
}
type TodoReturnRequest struct {
	User       int64                 `json:"user"`
	Credential middleware.Credential `json:"credential"`
	RawScopes  string                `json:"scopes"`
	Via        string                `json:"via"`
	Executed   bool                  `json:"executed,omitempty"`
	Error      string                `json:"error,omitempty"`
}

func (s *MythicalService) SetMovedOffReturn(provider MovedOffReturn) { s.movedReturn = provider }

// The existing stack worker consumes the durable choice. No HTTP request waits
// for capture, broker freeze, reconcile or thaw. Metadata alone settles the wait.
func (s *MythicalService) advanceMovedReturn(ctx context.Context, item db.MythicalItem) {
	checks := mythicalChecksOf(item)
	for i := range checks.Waits {
		wait := &checks.Waits[i]
		if wait.Kind != "moved_off" || wait.SettledAt != nil || wait.Answer != "return-to-item" || wait.Return == nil || wait.Return.Executed || wait.Return.Error != "" {
			continue
		}
		request := wait.Return
		fail := func() { request.Error = "Return failed." }
		info, err := middleware.ReloadCredential(ctx, s.queries(), request.Credential, s.now())
		if err != nil || info == nil || info.User == nil || info.User.ID != request.User || info.RawScopes != request.RawScopes || !middleware.BindInstallCredential(info) {
			fail()
		} else {
			info.ViaHint = request.Via
			current := middleware.ContextWithAuthInfo(ctx, info)
			repository, e := InstallRepositoryID(current, s.queries())
			_, authErr := Authorize(current, s.queries(), "todo.return-to-item")
			branchErr := AuthorizeTodoBranch(current, s.queries(), item.RepositoryID, item.Number.Int64)
			var raw []byte
			factErr := s.store.QueryRow(ctx, `SELECT w.moved_off FROM workspaces w JOIN mythical_lanes l ON l.workspace_id=w.id::text AND l.retired_at IS NULL WHERE w.id=$1 AND w.repository_id=$2 AND l.item_id=$3 AND w.deleted_at IS NULL`, item.WorkspaceID, item.RepositoryID, item.ID).Scan(&raw)
			var moved workspaceMovedOff
			validFact := factErr == nil && json.Unmarshal(raw, &moved) == nil && moved.Wait == wait.ID && moved.PreMoveCommit == wait.SHA && moved.Item == uint64(item.Number.Int64)
			if e != nil || authErr != nil || branchErr != nil || !validFact || repository != item.RepositoryID || s.movedReturn == nil || s.movedReturn.RequireReady(item.WorkspaceID) != nil {
				fail()
			} else {
				call, cancel := context.WithTimeout(current, 30*time.Second)
				result, e := s.movedReturn.ReturnToItem(call, item.WorkspaceID, []byte(info.User.Username))
				cancel()
				if e != nil || result.Head != wait.SHA {
					fail()
				} else {
					request.Executed = true
				}
			}
		}
		// A return event can win this CAS while the RPC is thawing. Keep its newer
		// settlement instead of overwriting any independent wait or run projection.
		err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
			item.Checks = checks.encode()
			saved, e := db.New(tx).SaveMythicalItem(ctx, item)
			if e != nil {
				return e
			}
			raw, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "n": item.Number.Int64, "wait": wait.ID, "error": request.Error, "executed": request.Executed})
			_, e = s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.return-dispatched", todoState(saved), raw)
			return e
		})
		if err != nil && err != pgx.ErrNoRows {
			s.logger.Warn("mythical.return_projection_failed", "item", uuidString(item.ID), "error", err)
		}
		return
	}
}
