package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type branchMachineRequest struct {
	Branch            string
	Repository, Actor int64
	Op                string
	Credential        middleware.Credential
}

// RequestBranchMachine records the person action before capture or admission.
// The existing worker owns execution and its durable completion/failure receipt.
func (s *WorkspaceService) RequestBranchMachine(ctx context.Context, branch string, repository, actor int64, op, request string) (jobs.RequestReceipt, error) {
	if (op != "sleep" && op != "wake") || strings.TrimSpace(request) == "" || len(request) > 256 {
		return jobs.RequestReceipt{}, pkgerrors.BadRequest("Invalid branch request")
	}
	if s.commandJobs == nil || s.transactions == nil {
		return jobs.RequestReceipt{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Branch unavailable")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	decision, err := Authorize(ctx, db.New(tx), "branch."+op)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	if decision.UserID != actor {
		return jobs.RequestReceipt{}, pkgerrors.Forbidden("access denied")
	}
	row, err := s.branchFileWorkspace(ctx, branch, repository, actor)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	if _, err = s.loadOwnedWorkspace(ctx, row.ID, repository, actor); err != nil {
		return jobs.RequestReceipt{}, err
	}
	payload, err := json.Marshal(branchMachineRequest{row.ID, repository, actor, op, middleware.CredentialOf(middleware.AuthInfoFromContext(ctx))})
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	receipt, err := s.commandJobs.Admit(ctx, jobs.Admission{Scope: repositoryJobFlowScope(repository, actor), Operation: "branch." + op, RequestID: row.ID + ":" + request, Payload: payload, EffectPolicy: jobs.EffectUnsafe})
	if errors.Is(err, jobs.ErrPayloadConflict) {
		return receipt, pkgerrors.Conflict("Branch request changed")
	}
	return receipt, err
}

func (s *WorkspaceService) handleBranchMachineRequest(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var input branchMachineRequest
	fail := func(code string) error {
		receipt, _ := json.Marshal(map[string]string{"code": code})
		settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		return lease.Fail(settle, receipt)
	}
	if json.Unmarshal(claim.Payload, &input) != nil || (input.Op != "sleep" && input.Op != "wake") || claim.Operation != "branch."+input.Op || claim.Scope != repositoryJobFlowScope(input.Repository, input.Actor) {
		return fail("invalid_branch_request")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	info, err := middleware.ReloadCredential(ctx, db.New(tx), input.Credential, time.Now())
	_ = tx.Rollback(context.WithoutCancel(ctx))
	if err != nil {
		return fail("permission")
	}
	ctx = middleware.ContextWithAuthInfo(ctx, info)
	tx, err = s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	decision, err := Authorize(ctx, db.New(tx), claim.Operation)
	_ = tx.Rollback(context.WithoutCancel(ctx))
	if err != nil || decision.UserID != input.Actor {
		return fail("permission")
	}
	if err := lease.StartExternal(ctx, json.RawMessage(`{"phase":"machine"}`)); err != nil {
		return err
	}
	var result WorkspaceResponse
	if input.Op == "sleep" {
		result, err = s.SuspendWorkspace(ctx, input.Branch, input.Repository, input.Actor)
	} else {
		result, err = s.ResumeWorkspace(personMachineDemand(ctx), input.Branch, input.Repository, input.Actor)
	}
	if err != nil {
		return fail("infra")
	}
	receipt, err := json.Marshal(result)
	if err != nil {
		return err
	}
	settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	return lease.Complete(settle, receipt)
}
