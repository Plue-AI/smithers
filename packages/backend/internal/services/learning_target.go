package services

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

// ResolveFlowHostTarget gives Learning its existing coding catalog only for
// the exact durable admission's ephemeral workspace and immutable source pin.
func (r *LearningRuntime) ResolveFlowHostTarget(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
	refuse := func() (flowhost.Authority, error) {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_forbidden"}
	}
	if r == nil || r.service == nil || target.BindingKind != learningBindingKind {
		return refuse()
	}
	repository, ok := scopedFlowRuntimeID(target.TenantID, "repository:")
	if !ok {
		return refuse()
	}
	actor, ok := scopedFlowRuntimeID(target.PrincipalID, "user:")
	if !ok {
		return refuse()
	}
	id, err := uuid.Parse(target.BindingID)
	if err != nil || target.WorkspaceID == "" {
		return refuse()
	}
	q := r.service.queries()
	item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
	if err != nil {
		return refuse()
	}
	if item.Source != "todo" || item.RepositoryID != repository || !item.OwnerID.Valid || item.OwnerID.Int64 != actor || todoState(item) != "merged" || item.PRState != "merged" {
		return refuse()
	}
	role, err := InstallRoleOf(ctx, q, actor)
	if err != nil {
		return flowhost.Authority{}, err
	}
	if role == "" {
		return refuse()
	}
	var raw []byte
	var attempt int
	err = r.service.store.QueryRow(ctx, `SELECT payload,d.external_attempt FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE operation='flow.runtime.launch' AND tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND state NOT IN ('completed','failed','cancelled','uncertain')`, target.TenantID, target.PrincipalID, "learning-run:"+target.BindingID).Scan(&raw, &attempt)
	if err != nil {
		return refuse()
	}
	var launch struct {
		Target  flowruntime.Target `json:"target"`
		Flow    string             `json:"flowId"`
		Pin     *flowruntime.Pin   `json:"pin"`
		Payload struct {
			Todo int64 `json:"todo"`
		} `json:"payload"`
	}
	if json.Unmarshal(raw, &launch) != nil || launch.Flow != "learning" || launch.Target != target || launch.Payload.Todo != item.Number.Int64 || launch.Pin == nil || !launch.Pin.Valid() || launch.Pin.Flow != "learning" {
		return refuse()
	}
	// A runtime launch must be the handoff of the confirmed-merge obligation;
	// arbitrary member/browser launches cannot manufacture this authority.
	var retained bool
	err = r.service.store.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.operation='learning.admission' AND r.tenant_id=$1 AND r.principal_id=$2 AND r.request_id=$3 AND r.payload->>'item'=$4 AND r.payload->>'commit'=$5 AND COALESCE(d.external_receipt->'pin',r.payload->'pin')=$6::jsonb)`, target.TenantID, target.PrincipalID, "learning:"+target.BindingID, target.BindingID, item.PRMergeCommit, mustLearningPinJSON(*launch.Pin)).Scan(&retained)
	if err != nil {
		return flowhost.Authority{}, err
	}
	if !retained {
		return refuse()
	}
	// A Home Retry reuses the stored binding and pin after terminal cleanup.
	// Allocation stays in the existing background worker, never the HTTP request.
	if _, missing := q.GetWorkspace(ctx, target.WorkspaceID); errors.Is(missing, pgx.ErrNoRows) && attempt > 1 && r.service.learningMachines != nil {
		ensured, err := r.service.learningMachines.EnsureLearningMachine(ctx, repository, actor, target.BindingID, *launch.Pin)
		if err != nil {
			return flowhost.Authority{}, err
		}
		if ensured != target {
			return refuse()
		}
	}
	workspace, err := q.GetWorkspace(ctx, target.WorkspaceID)
	if err != nil || workspace.RepositoryID != repository || workspace.UserID != actor || workspace.DeletedAt.Valid {
		return refuse()
	}
	if workspace.Status != "running" {
		return flowhost.Authority{}, mythicalLaneNotRunning(workspace, nil)
	}
	if workspace.VmID == "" {
		return refuse()
	}
	return flowhost.Authority{Target: target, RepositoryID: repository, UserID: actor, WorkspaceID: target.WorkspaceID, CatalogKey: flowhost.CatalogCoding, SourceRevision: launch.Pin.SourceCommit, ExecutionPin: launch.Pin}, nil
}
func mustLearningPinJSON(pin flowruntime.Pin) string {
	raw, _ := json.Marshal(pin)
	return string(raw)
}
