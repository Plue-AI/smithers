package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// InstallRunFlowBinding carries an immutable parent authority on the existing
// durable launch. It never carries bearer bytes or person-session authority.
const InstallRunFlowBinding = "run-flow"

type installRunFlowBinding struct {
	Credential middleware.Credential
	Subject    InstallSubject
}

func (s *InstallFlowRuns) requestOwnRun(ctx context.Context, repository, user int64, input InstallFlowRunInput, key string) (jobs.RequestReceipt, error) {
	empty := jobs.RequestReceipt{}
	if s == nil || s.Pool == nil || s.Queries == nil || s.Dispatcher == nil {
		return empty, flowRunError(503, "flows_unavailable", "infra", "Flows unavailable")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback(context.Background())
	live, boundRepo, err := lockInstallWriteCredential(ctx, tx, middleware.AuthInfoFromContext(ctx))
	if err != nil {
		return empty, err
	}
	if repository != boundRepo || middleware.UserFromContext(live).ID != user {
		return empty, confirmationPermission()
	}
	q := db.New(tx)
	subject := InstallSubject{RepositoryID: repository, WorkspaceID: input.WorkspaceID}
	// The credential selects the parent. Body workspace is only an assertion
	// checked against that stored binding; no body field can select an attempt.
	parent, lookup := ResolveInstallExecutionSubject(live, q, repository)
	if lookup == nil {
		var number int64
		if err = tx.QueryRow(live, `SELECT number FROM mythical_items WHERE repository_id=$1 AND number=$2 FOR UPDATE`, repository, parent.TodoNumber).Scan(&number); err != nil {
			return empty, err
		}
		item, loadErr := q.GetMythicalItemByNumber(live, repository, number)
		if loadErr != nil {
			return empty, loadErr
		}
		subject.TodoNumber, subject.Attempt, subject.Generation, subject.RunID = number, item.Attempt, item.Generation, item.RequestRunID
	}
	if input.Input == nil {
		input.Input = map[string]any{}
	}
	canonical, encodeErr := json.Marshal(input)
	if encodeErr != nil {
		return empty, flowRunError(400, "invalid_flow_run", "user", "Invalid flow input")
	}
	digest := sha256.Sum256(canonical)
	subject.Resource, subject.PayloadDigest = input.Name, hex.EncodeToString(digest[:])
	execution, executionErr := ResolveTodoWorkspaceExecution(live, q, repository, input.WorkspaceID)
	if executionErr == nil && execution != nil {
		subject.Source, subject.Base = execution.Pin.SourceCommit, execution.Pin.ExecutionDigest
	}
	decision, err := Authorize(live, q, "flow.run", subject)
	if err != nil {
		return empty, err
	}
	if lookup != nil {
		return empty, lookup
	}
	live = WithInstallAuthorization(live, "flow.run", decision, subject)
	if strings.TrimSpace(key) == "" || len(key) > 255 || key != strings.TrimSpace(key) {
		return empty, flowRunError(400, "invalid_flow_run", "user", "Idempotency-Key is required")
	}
	if input.Name == "review" || flowdispatch.IsTodoFlow(input.Name) {
		return empty, confirmationPermission()
	}
	if executionErr != nil || execution == nil {
		return empty, confirmationPermission()
	}
	// Hold workspace liveness stable through admission as well as the TODO fence.
	var running bool
	if err = tx.QueryRow(live, `SELECT status='running' AND deleted_at IS NULL AND rebuild_required_at IS NULL FROM workspaces WHERE id=$1 FOR SHARE`, input.WorkspaceID).Scan(&running); err != nil {
		return empty, err
	}
	if !running {
		return empty, confirmationPermission()
	}
	binding := installRunFlowBinding{Credential: middleware.CredentialOf(middleware.AuthInfoFromContext(live)), Subject: subject}
	encoded, _ := json.Marshal(binding)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repository), PrincipalID: fmt.Sprintf("user:%d", user)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, BindingKind: InstallRunFlowBinding, BindingID: string(encoded), WorkspaceID: input.WorkspaceID}
	plan, _ := json.Marshal(map[string]string{"flowId": input.Name})
	if err = s.Dispatcher.RefuseRelay(live, target, "Plan", plan); err != nil {
		return empty, confirmationPermission()
	}
	payload, err := json.Marshal(input.Input)
	if err != nil {
		return empty, err
	}
	// Idempotency is credential scoped; parent replacement cannot disclose or
	// reuse a predecessor's child launch with the same caller-provided key.
	request := flowdispatch.LaunchRequest{Scope: scope, RequestID: "install-flow-run:" + binding.Credential.TokenHash + ":" + key, Target: target, FlowID: input.Name, Payload: payload, ApprovalPolicy: flowdispatch.ApprovalAuto}
	receipt, err := s.Dispatcher.AdmitInTx(live, tx, request)
	if errors.Is(err, jobs.ErrPayloadConflict) {
		return empty, flowRunError(409, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request")
	}
	if err != nil {
		return empty, err
	}
	if err = tx.Commit(live); err != nil {
		return empty, err
	}
	return receipt, nil
}

// ResolveInstallRunFlowTarget rechecks the persisted parent at worker delivery
// and recovery. A replacement attempt, paused TODO, dead sponsor or credential
// cannot resolve this launch to a different machine or acquire person powers.
func ResolveInstallRunFlowTarget(ctx context.Context, q *db.Queries, target flowruntime.Target) (flowhost.Authority, error) {
	deny := func() (flowhost.Authority, error) {
		return flowhost.Authority{}, mythicalFlowFailure{code: "permission"}
	}
	if q == nil || target.BindingKind != InstallRunFlowBinding {
		return deny()
	}
	var binding installRunFlowBinding
	if json.Unmarshal([]byte(target.BindingID), &binding) != nil || binding.Credential.TokenHash == "" || binding.Credential.SessionHash != "" {
		return deny()
	}
	subject := binding.Subject
	if target.TenantID != fmt.Sprintf("repository:%d", subject.RepositoryID) || target.WorkspaceID != subject.WorkspaceID {
		return deny()
	}
	info, err := middleware.ReloadCredential(ctx, q, binding.Credential, time.Now())
	if err != nil || !middleware.BindInstallCredential(info) || target.PrincipalID != fmt.Sprintf("user:%d", info.User.ID) {
		return deny()
	}
	ctx = middleware.ContextWithAuthInfo(ctx, info)
	if _, err = Authorize(ctx, q, "flow.run", subject); err != nil {
		return deny()
	}
	parent, err := ResolveInstallExecutionSubject(ctx, q, subject.RepositoryID)
	if err != nil || parent.WorkspaceID != subject.WorkspaceID || parent.TodoNumber != subject.TodoNumber {
		return deny()
	}
	execution, err := ResolveTodoWorkspaceExecution(ctx, q, subject.RepositoryID, subject.WorkspaceID)
	if err != nil || execution == nil || execution.Pin.SourceCommit != subject.Source || execution.Pin.ExecutionDigest != subject.Base {
		return deny()
	}
	return flowhost.Authority{Target: target, RepositoryID: subject.RepositoryID, UserID: info.User.ID, WorkspaceID: subject.WorkspaceID, CatalogKey: flowhost.CatalogCoding, SourceRevision: execution.Pin.SourceCommit, ExecutionPin: &execution.Pin}, nil
}
