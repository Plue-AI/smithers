package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"time"
)

const reviewBindingKind = "review"

// Ephemeral reviews share the runtime's one admission queue and slot accounting.
// Retirement relies on runtime-confirmed deletion, never a job's completion.
type reviewMachineAdmission interface {
	FreeDisk(context.Context) (int64, error)
	WaitAdmission(context.Context, microsandbox.AdmissionProviders, string, string, string, string) (context.Context, error)
	CancelFailedAdmission(string, string)
	AdmissionSnapshot() []microsandbox.AdmissionRequest
}

// machineIdentityRuntime names a workspace's VM as the runtime boots it. The
// daemon registry links under that name, and agent admission and actor
// references match workspaces.vm_id with it. A row holding the workspace ID
// refuses every coding host spawn as unauthorized.
type machineIdentityRuntime interface {
	WorkspaceMachineIdentity(context.Context, string) (string, error)
}

// reviewSource is the shared pinned-loader/read-credential boundary, not a
// second loader. Prepare verifies availability, digest, and the qualified root
// boundary without allocating. Restore installs the pinned closure separately
// from the PR head and base, as the guest's unprivileged user. It supplies no
// GitHub, write, landing, branch-publishing or provider-key credential. Replays
// of Restore and Retire must be idempotent for the workspace ID.
type reviewSource interface {
	Prepare(context.Context, services.ReviewAdmission) error
	Restore(context.Context, string, services.ReviewAdmission) error
	Retire(context.Context, string, services.ReviewAdmission) error
}

// reviewMachine owns a fresh, operation-addressed microVM and the ordinary
// flow engine in it. It never uses the TODO lane or PrepareBoxHost.
type reviewMachine struct {
	pool      *pgxpool.Pool
	jobs      *jobs.Store
	workspace workspace.WorkspaceLifecycle
	source    reviewSource
	resolver  flowruntime.Resolver
	existing  flowruntime.ExistingResolver
	archive   *runArchive
}

func reviewRefusal(code string) error {
	return &services.TodoControlError{Status: 503, Class: "infra", Code: code, Message: "Review unavailable"}
}

func (m *reviewMachine) Isolation() workspace.IsolationLevel {
	if m.workspace == nil {
		return ""
	}
	return m.workspace.Isolation()
}

func (m *reviewMachine) Prepare(ctx context.Context, a services.ReviewAdmission) error {
	if m.Isolation() != workspace.IsolationSandboxed {
		return reviewRefusal("review_isolation_unavailable")
	}
	if !a.Pin.Valid() || a.Pin.Flow != "review" {
		return reviewRefusal("review_binding_unavailable")
	}
	if m.resolver == nil || m.existing == nil {
		return reviewRefusal("review_runtime_unavailable")
	}
	if m.source == nil {
		return reviewRefusal("review_source_unavailable")
	}
	if _, ok := m.workspace.(workspace.WorkspaceSourceRevisionResolver); !ok {
		return reviewRefusal("review_source_unavailable")
	}
	if err := m.source.Prepare(ctx, a); err != nil {
		return err
	}
	if _, ok := m.workspace.(reviewMachineAdmission); !ok {
		return reviewRefusal("review_admission_unavailable")
	}
	if _, ok := m.workspace.(machineIdentityRuntime); !ok {
		return reviewRefusal("review_machine_unavailable")
	}
	return nil
}

func reviewWorkspaceID(operation string) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("review-machine:"+operation)).String()
}

func reviewTarget(operation string, a services.ReviewAdmission) flowruntime.Target {
	return flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", a.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", a.RequesterID), WorkspaceID: reviewWorkspaceID(operation), BindingKind: reviewBindingKind, BindingID: operation}
}

func reviewMachineContext(ctx context.Context, operation, action string, a services.ReviewAdmission) context.Context {
	user := strconv.FormatInt(a.RequesterID, 10)
	return workspace.WithOperation(ctx, workspace.Operation{TenantID: user, PrincipalID: user, OperationID: "review:" + operation + ":" + action})
}

func (m *reviewMachine) Start(ctx context.Context, operation string, a services.ReviewAdmission) (runRef string, startErr error) {
	defer func() {
		var refusal *services.TodoControlError
		if errors.As(startErr, &refusal) {
			slog.WarnContext(ctx, "review machine refused", "operation", operation, "code", refusal.Code)
		}
	}()
	if err := m.Prepare(ctx, a); err != nil {
		return "", err
	}
	if _, err := uuid.Parse(operation); err != nil {
		return "", reviewRefusal("review_record_invalid")
	}
	target := reviewTarget(operation, a)
	ctx = reviewMachineContext(ctx, operation, "start", a)
	// The row is only lifecycle authority for this ephemeral machine. It has
	// no bookmark, stack item, source publisher or workspace share.
	_, err := m.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,status) VALUES($1,$2,$3,$4,'starting') ON CONFLICT(id) DO NOTHING`, target.WorkspaceID, a.RepositoryID, a.RequesterID, "review-"+operation)
	if err != nil {
		return "", err
	}
	queue := m.workspace.(reviewMachineAdmission) // Prepare checked the shared runtime.
	holder := "workspace:" + target.WorkspaceID
	ctx, err = queue.WaitAdmission(ctx, microsandbox.AdmissionProviders{
		FreeDisk: queue.FreeDisk,
		Ready: func(ctx context.Context, request microsandbox.AdmissionRequest) error {
			// A different caller must validate its own authority. A review's
			// source qualification cannot grant a person's or TODO's demand.
			if request.Holder != holder || request.Actor != operation || request.Class != "background" {
				return microsandbox.ErrAdmissionNotReady
			}
			if _, err := m.ResolveFlowHostTarget(ctx, target); err != nil {
				return err
			}
			// A person may be removed while this background request waits.
			// Reload the accepted credential at the actual grant boundary.
			job, err := m.jobs.Get(ctx, jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, operation)
			if err != nil {
				return err
			}
			var credential middleware.Credential
			if err := json.Unmarshal(job.AuthorizationContext, &credential); err != nil {
				return err
			}
			q := db.New(m.pool)
			info, err := middleware.ReloadCredential(ctx, q, credential, time.Now())
			if err != nil {
				return err
			}
			if !middleware.BindInstallCredential(info) || info.User.ID != a.RequesterID {
				return reviewRefusal("review_credential_unavailable")
			}
			if _, err := services.Authorize(middleware.ContextWithAuthInfo(ctx, info), q, "review"); err != nil {
				return err
			}
			role, err := services.InstallRoleOf(ctx, q, a.AuthorID)
			if err != nil {
				return err
			}
			if role == "" {
				return reviewRefusal("review_non_member")
			}
			return m.Prepare(ctx, a)
		},
	}, "background", holder, operation, "review")
	if err != nil {
		return "", err
	}
	defer func() {
		if startErr == nil {
			return
		}
		// Only a proven absent VM permits abandoning an unused grant. Lost
		// launch replies retain their slot and reconnect the same operation.
		if _, err := m.workspace.InspectWorkspace(context.WithoutCancel(ctx), target.WorkspaceID); errors.Is(err, workspace.ErrWorkspaceNotFound) {
			queue.CancelFailedAdmission(holder, operation)
		}
	}()
	current, err := m.workspace.InspectWorkspace(ctx, target.WorkspaceID)
	if errors.Is(err, workspace.ErrWorkspaceNotFound) {
		spec, specErr := services.CodingMachineSpec(ctx, db.New(m.pool), target.WorkspaceID, a.RepositoryID, a.Pin.SourceCommit)
		if specErr != nil {
			return "", specErr
		}
		current, err = m.workspace.CreateWorkspace(ctx, spec)
	}
	if err != nil {
		return "", err
	}
	if current.ID != target.WorkspaceID {
		return "", reviewRefusal("review_machine_mismatch")
	}
	if current.State != workspace.WorkspaceRunning {
		current, err = m.workspace.StartWorkspace(ctx, target.WorkspaceID)
		if err != nil {
			return "", err
		}
	}
	if current.ID != target.WorkspaceID || current.State != workspace.WorkspaceRunning {
		return "", reviewRefusal("review_machine_unavailable")
	}
	if err = m.source.Restore(ctx, target.WorkspaceID, a); err != nil {
		return "", err
	}
	head, err := m.workspace.(workspace.WorkspaceSourceRevisionResolver).ResolveWorkspaceSourceRevision(ctx, target.WorkspaceID)
	if err != nil {
		return "", err
	}
	if head != a.Head {
		return "", reviewRefusal("review_head_mismatch")
	}
	machine, err := m.workspace.(machineIdentityRuntime).WorkspaceMachineIdentity(ctx, target.WorkspaceID) // Prepare checked the runtime.
	if err != nil {
		return "", err
	}
	if machine == "" {
		return "", reviewRefusal("review_machine_unavailable")
	}
	// The Flow host start seeds the machine's branch head from source_commit
	// (machineBranchHead): the restored PR head, retained on the host.
	if _, err = m.pool.Exec(ctx, `UPDATE workspaces SET status='running',vm_id=$4,source_commit=$5 WHERE id=$1 AND repository_id=$2 AND user_id=$3`, target.WorkspaceID, a.RepositoryID, a.RequesterID, machine, a.Head); err != nil {
		return "", err
	}
	host, err := m.resolver.ResolveFlowRuntime(ctx, target)
	if err != nil {
		return "", err
	}
	identity, err := host.Identity(ctx)
	if err != nil {
		return "", err
	}
	if identity.Protocol != flowruntime.Protocol || identity.SourceRevision != a.Pin.SourceCommit {
		return "", reviewRefusal("review_source_mismatch")
	}
	payload, _ := json.Marshal(map[string]any{"repo": ".", "from": a.Base, "to": a.Head, "verify": true, "narrate": false})
	launch := flowruntime.Launch{ApplicationRequestID: operation, Attempt: 1, OwnerGeneration: identity.OwnerGeneration, RuntimeArtifactDigest: identity.RuntimeArtifactDigest, SourceRevision: a.Pin.SourceCommit, FlowID: "review", Payload: payload, Pin: &a.Pin}
	result, err := host.Launch(ctx, launch)
	if err != nil {
		return "", err
	}
	if result.Receipt.Tag == "Parked" && result.Receipt.Status == "waiting-approval" {
		// The requesting person authorized this exact pinned review at admission.
		// Carry that authority through the shared engine, never GitHub approval.
		var approval struct {
			Target struct {
				Tag    string `json:"_tag"`
				PlanID string `json:"planId"`
				Digest string `json:"digest"`
			} `json:"target"`
			Scope string `json:"scope"`
		}
		if result.ApplicationRequestID != operation || result.SourceRevision != a.Pin.SourceCommit || result.RuntimeArtifactDigest != identity.RuntimeArtifactDigest || result.OwnerGeneration != identity.OwnerGeneration || result.ExecutionDigest != a.Pin.ExecutionDigest || result.PlanID == "" || len(result.PlanDigest) != 64 || result.Receipt.PlanID != result.PlanID || json.Unmarshal(result.Approval, &approval) != nil || approval.Target.Tag != "Plan" || approval.Target.PlanID != result.PlanID || approval.Target.Digest != result.PlanDigest || approval.Scope != "run" {
			return "", reviewRefusal("review_plan_mismatch")
		}
		decisionID := operation + ":review-plan"
		decision, err := host.Approve(ctx, flowruntime.Decision{ApplicationRequestID: decisionID, OwnerGeneration: identity.OwnerGeneration, Approval: result.Approval})
		if err != nil {
			return "", err
		}
		if decision.ApplicationRequestID != decisionID || decision.Operation != "approve" || (decision.Receipt.Tag != "Accepted" && decision.Receipt.Tag != "AlreadyApplied") {
			return "", reviewRefusal("review_approval_mismatch")
		}
		launch.Attempt = 2
		result, err = host.Launch(ctx, launch)
		if err != nil {
			return "", err
		}
	}
	if result.ApplicationRequestID != operation || result.SourceRevision != a.Pin.SourceCommit || result.RuntimeArtifactDigest != identity.RuntimeArtifactDigest || result.OwnerGeneration != identity.OwnerGeneration || result.ExecutionDigest != a.Pin.ExecutionDigest || result.Receipt.RunID == "" {
		return "", reviewRefusal("review_launch_mismatch")
	}
	// Retain both identities in the worker checkpoint, never a mutable lookup.
	run, _ := json.Marshal(struct{ Operation, Run string }{operation, result.Receipt.RunID})
	return string(run), nil
}

func (m *reviewMachine) Observe(ctx context.Context, run string, a services.ReviewAdmission) (services.ReviewObservation, error) {
	var ref struct{ Operation, Run string }
	if json.Unmarshal([]byte(run), &ref) != nil || ref.Operation == "" || ref.Run == "" {
		return services.ReviewObservation{}, reviewRefusal("review_record_invalid")
	}
	host, err := m.existing.ResolveExistingFlowRuntime(ctx, reviewTarget(ref.Operation, a))
	if err != nil {
		return services.ReviewObservation{}, err
	}
	result, err := host.Observe(ctx, ref.Run, "", archivedEventsPage)
	if err != nil {
		return services.ReviewObservation{}, err
	}
	if result.Run.RunID != ref.Run || result.Run.FlowID != "review" {
		return services.ReviewObservation{}, reviewRefusal("review_observation_mismatch")
	}
	cp := flowdispatch.RuntimeCheckpoint{Target: reviewTarget(ref.Operation, a), RunID: ref.Run, FlowID: "review", Run: &result.Run}
	if m.archive != nil {
		if err := m.archive.keep(ctx, flowdispatch.ProjectionUpdate{Checkpoint: cp, Events: result.Events}); err != nil {
			return services.ReviewObservation{}, err
		}
		cursor := result.NextCursor
		more := result.HasMore
		for more {
			page, err := host.Observe(ctx, ref.Run, cursor, archivedEventsPage)
			if err != nil {
				return services.ReviewObservation{}, err
			}
			if page.HasMore && page.NextCursor == cursor {
				return services.ReviewObservation{}, errors.New("review archive cursor did not advance")
			}
			if err := m.archive.keep(ctx, flowdispatch.ProjectionUpdate{Checkpoint: cp, Events: page.Events}); err != nil {
				return services.ReviewObservation{}, err
			}
			cursor, more = page.NextCursor, page.HasMore
		}
		if result.Terminal {
			if err := m.archive.capture(ctx, cp); err != nil {
				return services.ReviewObservation{}, err
			}
		}
	}
	if !result.Terminal {
		return services.ReviewObservation{State: jobs.StateRunning}, nil
	}
	if result.Run.Status == "cancelled" {
		return services.ReviewObservation{State: jobs.StateCancelled}, nil
	}
	if result.Run.Status != "completed" || result.Run.FinalOutput == nil {
		cause := result.Run.FailureMessage
		if cause == "" {
			cause = result.Run.FailureTag
		}
		if cause == "" {
			cause = "review_failed"
		}
		return services.ReviewObservation{State: jobs.StateFailed, Error: cause}, nil
	}
	change, err := reviewChange(a, *result.Run.FinalOutput)
	if err != nil {
		return services.ReviewObservation{State: jobs.StateFailed, Error: "review_findings_invalid"}, nil
	}
	return services.ReviewObservation{State: jobs.StateCompleted, Change: change}, nil
}

func (m *reviewMachine) Retire(ctx context.Context, operation string, a services.ReviewAdmission) error {
	ctx = reviewMachineContext(ctx, operation, "retire", a)
	id := reviewWorkspaceID(operation)
	// Revoke read authority even when a launch reply was lost. Only confirmed
	// runtime deletion permits removal of the lifecycle row and terminal job.
	if m.source != nil {
		if err := m.source.Retire(ctx, id, a); err != nil {
			return err
		}
	}
	if err := m.workspace.DeleteWorkspace(ctx, id); err != nil && !errors.Is(err, workspace.ErrWorkspaceNotFound) {
		return err
	}
	if queue, ok := m.workspace.(reviewMachineAdmission); ok {
		for _, row := range queue.AdmissionSnapshot() {
			if row.Holder == "workspace:"+id && row.Actor == operation && (row.State == "waiting" || row.State == "granted") {
				queue.CancelFailedAdmission(row.Holder, row.Actor)
			}
		}
	}
	_, err := m.pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1 AND repository_id=$2 AND user_id=$3`, id, a.RepositoryID, a.RequesterID)
	return err
}

func (m *reviewMachine) ResolveFlowHostTarget(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
	if target.BindingKind != reviewBindingKind {
		return flowhost.Authority{}, reviewRefusal("review_binding_unavailable")
	}
	op, err := m.jobs.Get(ctx, jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, target.BindingID)
	if err != nil {
		return flowhost.Authority{}, err
	}
	var job struct {
		Admission services.ReviewAdmission `json:"admission"`
	}
	if op.Operation != "install.review" || op.State.Terminal() || json.Unmarshal(op.Payload, &job) != nil || target != reviewTarget(op.ID, job.Admission) {
		return flowhost.Authority{}, reviewRefusal("review_binding_unavailable")
	}
	a := job.Admission
	return flowhost.Authority{Target: target, RepositoryID: a.RepositoryID, UserID: a.RequesterID, WorkspaceID: target.WorkspaceID, CatalogKey: flowhost.CatalogCoding, SourceRevision: a.Pin.SourceCommit, ExecutionPin: &a.Pin}, nil
}

var _ services.ReviewMachine = (*reviewMachine)(nil)

// QueuePosition uses the same allocator as terminals and TODO attempts.
func (m *reviewMachine) QueuePosition(operation string) int {
	if queue, ok := m.workspace.(reviewMachineAdmission); ok {
		for _, request := range queue.AdmissionSnapshot() {
			if request.Actor == operation && request.Class == "background" && request.State == "waiting" {
				return request.Position
			}
		}
	}
	return 0
}
