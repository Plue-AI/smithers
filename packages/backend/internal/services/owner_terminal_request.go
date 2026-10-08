package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// BindOwnerTerminalOpen composes the existing manager, never a second broker.
func (s *WorkspaceService) BindOwnerTerminalOpen(open func(context.Context, string, string, int64, int64) error) {
	s.ownerTerminalOpen = open
}

func (s *WorkspaceService) requestOwnerTerminal(ctx context.Context, branch string, repository, member int64, request string) (WorkspaceSessionResponse, error) {
	if !s.BranchTerminalAvailable() {
		return WorkspaceSessionResponse{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Terminal is unavailable")
	}
	key, err := uuid.Parse(request)
	if err != nil {
		return WorkspaceSessionResponse{}, pkgerrors.BadRequest("Invalid terminal request")
	}
	request = key.String()
	row, err := s.AuthorizeTerminalBranch(ctx, branch, repository, member)
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	principal := fmt.Sprintf("member:%d", member)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fmt.Sprintf("terminal:%d:%d:%s", repository, member, request)); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	if err = s.authorizeBranchMachine(ctx, tx, repository, member, row.TargetBookmark, row.ID); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT data FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND event_type='terminal.requested' AND data->>'request'=$3`, fmt.Sprint(repository), principal, request).Scan(&raw)
	if err == nil {
		var prior struct {
			Branch, Via string
			Receipt     WorkspaceSessionResponse
		}
		if json.Unmarshal(raw, &prior) != nil || prior.Branch != row.ID || prior.Via != "terminal" {
			return WorkspaceSessionResponse{}, pkgerrors.Conflict("Terminal request changed")
		}
		var status string
		result := tx.QueryRow(ctx, `SELECT data->>'status' FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND data->>'session'=$3 AND event_type IN ('terminal.running','terminal.failed','terminal.closed') ORDER BY (event_type IN ('terminal.failed','terminal.closed')) DESC, sequence DESC LIMIT 1`, fmt.Sprint(repository), principal, prior.Receipt.ID).Scan(&status)
		if result == nil {
			prior.Receipt.Status = status
		} else if !errors.Is(result, pgx.ErrNoRows) {
			return WorkspaceSessionResponse{}, result
		}
		return prior.Receipt, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return WorkspaceSessionResponse{}, err
	}
	now := time.Now().UTC()
	receipt := WorkspaceSessionResponse{ID: uuid.NewString(), WorkspaceID: row.ID, RepositoryID: repository, UserID: member, Status: "pending", Kind: "terminal", Cols: 80, Rows: 24, CreatedAt: now, UpdatedAt: now, LastActivityAt: now}
	data, err := json.Marshal(map[string]any{"request": request, "via": "terminal", "branch": row.ID, "session": receipt.ID, "receipt": receipt})
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	scope := jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: principal}
	if _, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "terminal.requested", "requested", data); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	observed, span := beginTerminalWakeObservation(ctx, request, row.ID)
	background, cancel := context.WithTimeout(context.WithoutCancel(personMachineDemand(observed)), workspaceProvisionTimeout)
	done := s.trackProvision()
	go func() {
		defer done()
		defer cancel()
		status := "running"
		failure := s.ownerTerminalOpen(background, receipt.ID, row.ID, repository, member)
		span.complete(failure == nil)
		if failure != nil {
			status = "failed"
		}
		settled, stop := context.WithTimeout(context.WithoutCancel(background), 10*time.Second)
		defer stop()
		if err := s.recordOwnerTerminalResult(settled, scope, receipt.ID, status); err != nil {
			slog.Error("record terminal result", "terminal", receipt.ID, "error", err)
		}
	}()
	return receipt, nil
}

func (s *WorkspaceService) recordOwnerTerminalResult(ctx context.Context, scope jobs.Scope, id, status string) error {
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "terminal.result:"+scope.TenantID+":"+scope.PrincipalID+":"+id); err != nil {
		return err
	}
	var repeated bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND data->>'session'=$3 AND event_type=$4)`, scope.TenantID, scope.PrincipalID, id, "terminal."+status).Scan(&repeated); err != nil {
		return err
	}
	if repeated {
		return nil
	}
	if status == "running" || status == "failed" {
		var ended bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND data->>'session'=$3 AND event_type IN ('terminal.failed','terminal.closed'))`, scope.TenantID, scope.PrincipalID, id).Scan(&ended); err != nil {
			return err
		}
		if ended {
			return nil
		}
	}
	data, _ := json.Marshal(map[string]string{"session": id, "status": status})
	if _, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "terminal."+status, status, data); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scopeTenant(repository int64) string { return fmt.Sprint(repository) }

// OwnerTerminalClosed records real teardown without delaying the broker close.
func (s *WorkspaceService) OwnerTerminalClosed(repository, member int64, id string) {
	done := s.trackProvision()
	go func() {
		defer done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.recordOwnerTerminalResult(ctx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: fmt.Sprintf("member:%d", member)}, id, "closed"); err != nil {
			slog.Error("record terminal close", "terminal", id, "error", err)
		}
	}()
}

// A restarted install cannot recover a PTY or replay its keystrokes. Preserve
// the durable request as failed/closed rather than leaving it pending forever.
func (s *WorkspaceService) RecoverOwnerTerminalRequests(ctx context.Context) error {
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	rows, err := tx.Query(ctx, `SELECT e.tenant_id,e.principal_id,e.data->>'session',CASE WHEN EXISTS(SELECT 1 FROM product_job_events x WHERE x.tenant_id=e.tenant_id AND x.principal_id=e.principal_id AND x.data->>'session'=e.data->>'session' AND x.event_type='terminal.running') THEN 'closed' ELSE 'failed' END FROM product_job_events e WHERE e.event_type='terminal.requested' AND e.data ? 'receipt' AND NOT EXISTS(SELECT 1 FROM product_job_events x WHERE x.tenant_id=e.tenant_id AND x.principal_id=e.principal_id AND x.data->>'session'=e.data->>'session' AND x.event_type IN ('terminal.failed','terminal.closed'))`)
	if err != nil {
		return err
	}
	type ended struct{ tenant, principal, id, status string }
	var entries []ended
	for rows.Next() {
		var entry ended
		if err = rows.Scan(&entry.tenant, &entry.principal, &entry.id, &entry.status); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, entry)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		data, _ := json.Marshal(map[string]string{"session": entry.id, "status": entry.status})
		if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: entry.tenant, PrincipalID: entry.principal}, uuid.NewString(), "terminal."+entry.status, entry.status, data); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// BindOwnerTerminalClose reuses the existing manager for both pending opens and
// live PTYs. The durable owner receipt supplies authority before cancellation.
func (s *WorkspaceService) BindOwnerTerminalClose(close func(string)) { s.ownerTerminalClose = close }

func (s *WorkspaceService) closeOwnerTerminal(ctx context.Context, id string, repository, member int64) (bool, error) {
	if s.ownerTerminalClose == nil {
		return false, nil
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return true, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var branch string
	err = tx.QueryRow(ctx, `SELECT data->>'branch' FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND event_type='terminal.requested' AND data->>'session'=$3`, fmt.Sprint(repository), fmt.Sprintf("member:%d", member), id).Scan(&branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	decision, err := Authorize(ctx, db.New(tx), "terminal")
	if err != nil {
		return true, err
	}
	if decision.UserID != member {
		return true, pkgerrors.Forbidden("Terminal belongs to another member")
	}
	if _, err = s.AuthorizeTerminalBranch(ctx, branch, repository, member); err != nil {
		return true, err
	}
	scope := jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: fmt.Sprintf("member:%d", member)}
	if err = s.recordOwnerTerminalResult(ctx, scope, id, "closed"); err != nil {
		return true, err
	}
	s.ownerTerminalClose(id)
	return true, nil
}
