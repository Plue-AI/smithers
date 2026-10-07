package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// Persist admission and deduplicate the request before any machine wake. The
// returned row is a request receipt; the existing provisioner settles it.
func (s *WorkspaceService) OpenBranchTerminal(ctx context.Context, branch string, repository, member int64, request string) (WorkspaceSessionResponse, error) {
	return s.openMemberTerminal(ctx, branch, repository, member, request, "terminal")
}
func (s *WorkspaceService) OpenSSHReservation(ctx context.Context, branch string, repository, member int64, request string) (WorkspaceSessionResponse, error) {
	return s.openMemberTerminal(ctx, branch, repository, member, request, "ssh")
}
func (s *WorkspaceService) openMemberTerminal(ctx context.Context, branch string, repository, member int64, request, via string) (WorkspaceSessionResponse, error) {
	if !s.memberSessionsAvailable() || (via == "terminal" && s.branchTerminalHost == nil) {
		return WorkspaceSessionResponse{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Terminal is unavailable")
	}
	if _, installed := s.runtime.(interface{ MachinedRegistry() *machined.Registry }); !installed {
		return WorkspaceSessionResponse{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Terminal is unavailable")
	}
	id, parseErr := uuid.Parse(request)
	if parseErr != nil {
		return WorkspaceSessionResponse{}, pkgerrors.BadRequest("Invalid terminal request")
	}
	request = id.String()
	row, err := s.branchFileWorkspace(ctx, strings.TrimSpace(branch), repository, member)
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	if err = s.requireBranchMachineProviders(); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	// Take request serialization before authorization's row locks. A waiter
	// must not hold a workspace SHARE lock while its winner inserts a session.
	key := fmt.Sprintf("terminal:%d:%d:%s", repository, member, request)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	if err = s.authorizeBranchMachine(ctx, tx, repository, member, row.TargetBookmark, row.ID); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	q := db.New(tx)
	if err = ensureWorkspaceShare(ctx, q, row, member); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	principal := fmt.Sprintf("member:%d", member)
	var prior struct {
		Via     string `json:"via"`
		Branch  string `json:"branch"`
		Session string `json:"session"`
	}
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT data FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND event_type='terminal.requested' AND data->>'request'=$3`, fmt.Sprint(repository), principal, request).Scan(&raw)
	if err == nil {
		if json.Unmarshal(raw, &prior) != nil || prior.Branch != row.ID || prior.Via != via {
			return WorkspaceSessionResponse{}, pkgerrors.Conflict("Terminal request changed")
		}
		session, e := q.GetWorkspaceSession(ctx, prior.Session)
		return toWorkspaceSessionResponse(session), e
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return WorkspaceSessionResponse{}, err
	}
	session, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: row.ID, RepositoryID: repository, UserID: member, Cols: 80, Rows: 24})
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	metadata, _ := json.Marshal(map[string]any{"via": via})
	if session, err = q.UpdateWorkspaceSessionSSHConnectionInfo(ctx, db.UpdateWorkspaceSessionSSHConnectionInfoParams{ID: session.ID, SshConnectionInfo: metadata}); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	data, err := json.Marshal(map[string]any{"request": request, "via": via, "branch": row.ID, "session": session.ID})
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: principal}, uuid.NewString(), "terminal.requested", "requested", data); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return WorkspaceSessionResponse{}, err
	}
	admittedCtx := ctx
	var span *terminalWakeSpan
	if via == "terminal" {
		admittedCtx, span = beginTerminalWakeObservation(ctx, request, strings.TrimSpace(branch))
	}
	provisionCtx, cancel := context.WithTimeout(context.WithoutCancel(personMachineDemand(admittedCtx)), workspaceProvisionTimeout)
	done := s.trackProvision()
	go func() {
		defer done()
		defer cancel()
		response, err := s.finishWorkspaceSessionProvisioning(provisionCtx, session, row, CreateWorkspaceSessionInput{WorkspaceID: row.ID, RepositoryID: repository, UserID: member, SourceBookmark: row.TargetBookmark, Kind: WorkspaceSessionKindTerminal}, 80, 24)
		if span != nil {
			span.complete(err == nil && response.Status == "running")
		}
	}()
	return toWorkspaceSessionResponse(session), nil
}

// The install door requires the complete native member admission boundary.
func (s *WorkspaceService) BindBranchTerminalHost(prepare func(context.Context, db.Workspace, int64) error) {
	s.branchTerminalHost = prepare
}
func (s *WorkspaceService) prepareBranchTerminalSession(ctx context.Context, workspace db.Workspace, session db.WorkspaceSession) error {
	var metadata struct {
		Via string `json:"via"`
	}
	if json.Unmarshal(session.SshConnectionInfo, &metadata) != nil || metadata.Via != "terminal" {
		return nil
	}
	if s.branchTerminalHost == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Terminal is unavailable")
	}
	return s.branchTerminalHost(ctx, workspace, session.UserID)
}
func (s *WorkspaceService) BranchTerminalAvailable() bool {
	return s.memberSessionsAvailable() && s.branchTerminalHost != nil
}
func (s *WorkspaceService) memberSessionsAvailable() bool {
	if s == nil || s.q == nil || s.transactions == nil || !s.WorkspaceRuntimeTerminalAvailable() {
		return false
	}
	installed, ok := s.runtime.(interface{ MachinedRegistry() *machined.Registry })
	return ok && installed.MachinedRegistry() != nil && s.requireBranchMachineProviders() == nil
}
