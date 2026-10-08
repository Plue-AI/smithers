package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const LearningAdmissionOperation = "learning.admission"

// learningWait is how long an admission parks before it looks again for the
// Active learning version or an execution provider.
const learningWait = time.Minute

// LearningMachines is the ephemeral background allocator's boundary. Ensure
// must deduplicate by item, import pin.SourceCommit, and refuse absent isolation
// or an unavailable Learning runtime target. It never reuses a TODO's machine.
type LearningMachines interface {
	EnsureLearningMachine(context.Context, int64, int64, string, flowruntime.Pin) (flowruntime.Target, error)
	RetireLearningMachine(context.Context, flowruntime.Target) error
}

func (s *MythicalService) EnableLearningAdmission(store *jobs.Store) { s.learningJobs = store }
func (s *MythicalService) SetLearningMachines(machines LearningMachines) {
	s.learningMachines = machines
}

type learningAdmission struct {
	Item       string           `json:"item"`
	Todo       int64            `json:"todo"`
	Repository int64            `json:"repository"`
	Actor      int64            `json:"actor"`
	Commit     string           `json:"commit"`
	Pin        *flowruntime.Pin `json:"pin,omitempty"`
}

// The confirmed GitHub transition and its intent commit together. A missing
// execution provider cannot veto a person's merge or erase the obligation.
func (s *MythicalService) admitLearningInTx(ctx context.Context, tx pgx.Tx, item db.MythicalItem) error {
	if s.learningJobs == nil || item.Source != "todo" {
		return nil
	}
	if todoState(item) != "merged" || item.PRState != "merged" || !flowCommitPattern.MatchString(item.PRMergeCommit) || !item.Number.Valid || !item.OwnerID.Valid || item.OwnerID.Int64 <= 0 {
		return ErrLearningBinding
	}
	var retained bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_requests WHERE operation=$1 AND request_id=$2 AND tenant_id=$3 AND principal_id=$4)`, LearningAdmissionOperation, "learning:"+uuidString(item.ID), learningOperationScope(item).TenantID, learningOperationScope(item).PrincipalID).Scan(&retained); err != nil {
		return err
	}
	if retained {
		return nil
	}
	input := learningAdmission{Item: uuidString(item.ID), Todo: item.Number.Int64, Repository: item.RepositoryID, Actor: item.OwnerID.Int64, Commit: item.PRMergeCommit}
	// Prefer the Active version at admission. If flow metadata is unavailable,
	// the worker retains the first qualified pin before it asks for a machine.
	if digest, err := ActiveFlowDigest(ctx, db.New(tx), item.RepositoryID, "learning"); err == nil {
		pin := flowruntime.Pin{Flow: "learning", SourceCommit: item.PRMergeCommit, ExecutionDigest: digest}
		if pin.Valid() {
			input.Pin = &pin
		}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	_, err = s.learningJobs.AdmitInTx(ctx, tx, jobs.Admission{Scope: learningOperationScope(item), Operation: LearningAdmissionOperation, RequestID: "learning:" + input.Item, Payload: raw, AuthorizationContext: json.RawMessage(`{"source":"confirmed-github-merge","class":"background"}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: "learning:" + input.Item})
	return err
}

func (s *MythicalService) HandleLearningAdmission(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var input learningAdmission
	if claim.Operation != LearningAdmissionOperation || json.Unmarshal(claim.Payload, &input) != nil {
		return ErrLearningBinding
	}
	item, err := s.queries().GetMythicalItemByNumber(ctx, input.Repository, input.Todo)
	if err != nil {
		return err
	}
	if uuidString(item.ID) != input.Item || todoState(item) != "merged" || item.PRState != "merged" || item.PRMergeCommit != input.Commit || !item.OwnerID.Valid || item.OwnerID.Int64 != input.Actor || claim.Scope != learningOperationScope(item) {
		return ErrLearningBinding
	}
	pin := input.Pin
	if len(claim.ExternalReceipt) > 0 {
		var saved struct {
			Pin *flowruntime.Pin `json:"pin"`
		}
		if json.Unmarshal(claim.ExternalReceipt, &saved) != nil {
			return ErrLearningBinding
		}
		if saved.Pin != nil {
			pin = saved.Pin
		}
	}
	// The job library parks only an operation whose external effect started
	// (jobs.Store.Park), so a wait opens it first, as install setup does while
	// it awaits the owner's claim. The effect is idempotent: a replay rereads
	// the retained pin and asks the allocator again. A wait never retries hot.
	wait := func(receipt json.RawMessage) error {
		if err := lease.StartExternal(ctx, receipt); err != nil {
			return err
		}
		return lease.Defer(ctx, receipt, learningWait)
	}
	if pin == nil {
		digest, err := ActiveFlowDigest(ctx, s.queries(), input.Repository, "learning")
		if err != nil {
			return wait(json.RawMessage(`{"reason":"learning_flow_unavailable"}`))
		}
		pin = &flowruntime.Pin{Flow: "learning", SourceCommit: input.Commit, ExecutionDigest: digest}
	}
	if !pin.Valid() || pin.Flow != "learning" || pin.SourceCommit != input.Commit {
		return ErrLearningBinding
	}
	checkpoint, _ := json.Marshal(map[string]any{"pin": pin, "reason": "learning_execution_unavailable"})
	if _, err := lease.Checkpoint(ctx, checkpoint); err != nil {
		return err
	}
	if s.learningMachines == nil || s.launcher == nil {
		return wait(checkpoint)
	}
	if err := lease.StartExternal(ctx, checkpoint); err != nil {
		return err
	}
	target, err := s.learningMachines.EnsureLearningMachine(ctx, input.Repository, input.Actor, input.Item, *pin)
	if err != nil {
		return err
	}
	if target.BindingKind != learningBindingKind || target.BindingID != input.Item || target.WorkspaceID == "" || target.TenantID != claim.Scope.TenantID || target.PrincipalID != claim.Scope.PrincipalID {
		return ErrLearningBinding
	}
	payload, _ := json.Marshal(map[string]int64{"todo": input.Todo})
	var receipt jobs.RequestReceipt
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		var err error
		receipt, err = s.launcher.AdmitInTx(ctx, tx, flowdispatch.LaunchRequest{Scope: claim.Scope, RequestID: "learning-run:" + input.Item, Target: target, FlowID: "learning", Payload: payload, Pin: pin, AuthorizationContext: claim.AuthorizationContext, Projection: json.RawMessage(fmt.Sprintf(`{"kind":"learning","todo":%d}`, input.Todo))})
		return err
	})
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(receipt)
	return lease.Complete(ctx, raw)
}

func learningOperationScope(item db.MythicalItem) jobs.Scope {
	return jobs.Scope{TenantID: fmt.Sprintf("repository:%d", item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", item.OwnerID.Int64)}
}
