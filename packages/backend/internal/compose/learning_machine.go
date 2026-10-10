package compose

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// learningSource is the pinned-source boundary (services.LearningSource).
// Prepare checks, without allocating, that Restore can run. Restore makes the
// pinned merge the machine's working copy; replays are idempotent.
type learningSource interface {
	Prepare(context.Context, int64, flowruntime.Pin) error
	Restore(context.Context, string, int64, int64, flowruntime.Pin) error
}

// learningMachine allocates the ephemeral machine a learning run executes in
// (services.LearningMachines). It waits in the runtime's one admission queue
// as class background (T-MCH-06), so it counts against capacity, goes behind
// people and TODOs, and never holds a TODO's machine. Its workspace is
// addressed by the merged TODO's item, so a replay finds the same machine.
type learningMachine struct {
	pool      *pgxpool.Pool
	workspace workspace.WorkspaceLifecycle
	source    learningSource
}

// bindLearningMachines gives the install's learning admission its allocator
// and reports whether it did. Without a sandboxed runtime that shares the
// admission queue there is none: an admitted learning run waits, parked, and
// never runs on the host or a working copy.
func bindLearningMachines(service *services.MythicalService, cfg *config.Config, pool *pgxpool.Pool, runtime workspace.WorkspaceLifecycle, source learningSource) bool {
	if service == nil || cfg == nil || !config.IsSingleOwner(cfg.Auth) || pool == nil || runtime == nil || runtime.Isolation() != workspace.IsolationSandboxed {
		return false
	}
	if _, ok := runtime.(reviewMachineAdmission); !ok {
		return false
	}
	if _, ok := runtime.(workspace.WorkspaceSourceRevisionResolver); !ok {
		return false
	}
	if _, ok := runtime.(machineIdentityRuntime); !ok {
		return false
	}
	service.SetLearningMachines(&learningMachine{pool: pool, workspace: runtime, source: source})
	return true
}

func learningRefusal(code string) error {
	return &services.TodoControlError{Status: 503, Class: "infra", Code: code, Message: "Learning unavailable"}
}

func learningWorkspaceID(item string) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("learning-machine:"+item)).String()
}

// The admission actor is the merged TODO's learning obligation.
func learningAdmissionActor(item string) string { return "learning:" + item }

func (m *learningMachine) prepare(ctx context.Context, repository int64, pin flowruntime.Pin) (reviewMachineAdmission, error) {
	if m == nil || m.workspace == nil || m.workspace.Isolation() != workspace.IsolationSandboxed {
		return nil, learningRefusal("learning_isolation_unavailable")
	}
	if !pin.Valid() || pin.Flow != "learning" {
		return nil, learningRefusal("learning_binding_unavailable")
	}
	queue, ok := m.workspace.(reviewMachineAdmission)
	if !ok {
		return nil, learningRefusal("learning_admission_unavailable")
	}
	if _, ok := m.workspace.(workspace.WorkspaceSourceRevisionResolver); !ok || m.source == nil {
		return nil, learningRefusal("learning_source_unavailable")
	}
	if _, ok := m.workspace.(machineIdentityRuntime); !ok {
		return nil, learningRefusal("learning_machine_unavailable")
	}
	return queue, m.source.Prepare(ctx, repository, pin)
}

func (m *learningMachine) EnsureLearningMachine(ctx context.Context, repository, actor int64, item string, pin flowruntime.Pin) (target flowruntime.Target, ensureErr error) {
	queue, err := m.prepare(ctx, repository, pin)
	if err != nil {
		return flowruntime.Target{}, err
	}
	if _, err := uuid.Parse(item); err != nil || repository <= 0 || actor <= 0 {
		return flowruntime.Target{}, learningRefusal("learning_binding_unavailable")
	}
	target = flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repository), PrincipalID: fmt.Sprintf("user:%d", actor), WorkspaceID: learningWorkspaceID(item), BindingKind: "learning", BindingID: item}
	user := strconv.FormatInt(actor, 10)
	ctx = workspace.WithOperation(ctx, workspace.Operation{TenantID: user, PrincipalID: user, OperationID: "learning:" + item + ":ensure"})
	// The row is lifecycle authority for this machine only: no bookmark,
	// stack item, source publisher or workspace share.
	if _, err := m.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,status) VALUES($1,$2,$3,$4,'starting') ON CONFLICT(id) DO NOTHING`, target.WorkspaceID, repository, actor, "learning-"+item); err != nil {
		return flowruntime.Target{}, err
	}
	row, err := db.New(m.pool).GetWorkspace(ctx, target.WorkspaceID)
	if err != nil || row.RepositoryID != repository || row.UserID != actor || row.DeletedAt.Valid {
		return flowruntime.Target{}, learningRefusal("learning_machine_mismatch")
	}
	holder, demand := "workspace:"+target.WorkspaceID, learningAdmissionActor(item)
	ctx, err = queue.WaitAdmission(ctx, microsandbox.AdmissionProviders{
		FreeDisk: queue.FreeDisk,
		Ready: func(ctx context.Context, request microsandbox.AdmissionRequest) error {
			// Another caller validates its own authority; learning's cannot
			// grant a person's or a TODO's demand.
			if request.Holder != holder || request.Actor != demand || request.Class != "background" {
				return microsandbox.ErrAdmissionNotReady
			}
			// The owner may leave the install while this request waits.
			role, err := services.InstallRoleOf(ctx, db.New(m.pool), actor)
			if err != nil {
				return err
			}
			if role == "" {
				return learningRefusal("learning_non_member")
			}
			_, err = m.prepare(ctx, repository, pin)
			return err
		},
	}, "background", holder, demand, "learning")
	if err != nil {
		return flowruntime.Target{}, err
	}
	defer func() {
		if ensureErr == nil {
			return
		}
		// Only a proven absent VM gives up an unused grant. A lost reply keeps
		// its slot and the replay reconnects the same machine.
		if _, err := m.workspace.InspectWorkspace(context.WithoutCancel(ctx), target.WorkspaceID); errors.Is(err, workspace.ErrWorkspaceNotFound) {
			queue.CancelFailedAdmission(holder, demand)
		}
	}()
	current, err := m.workspace.InspectWorkspace(ctx, target.WorkspaceID)
	if errors.Is(err, workspace.ErrWorkspaceNotFound) {
		current, err = m.workspace.CreateWorkspace(ctx, workspace.WorkspaceSpec{ID: target.WorkspaceID})
	}
	if err != nil {
		return flowruntime.Target{}, err
	}
	if current.ID != target.WorkspaceID {
		return flowruntime.Target{}, learningRefusal("learning_machine_mismatch")
	}
	if current.State != workspace.WorkspaceRunning {
		if current, err = m.workspace.StartWorkspace(ctx, target.WorkspaceID); err != nil {
			return flowruntime.Target{}, err
		}
	}
	if current.ID != target.WorkspaceID || current.State != workspace.WorkspaceRunning {
		return flowruntime.Target{}, learningRefusal("learning_machine_unavailable")
	}
	if err := m.source.Restore(ctx, target.WorkspaceID, repository, actor, pin); err != nil {
		return flowruntime.Target{}, err
	}
	head, err := m.workspace.(workspace.WorkspaceSourceRevisionResolver).ResolveWorkspaceSourceRevision(ctx, target.WorkspaceID)
	if err != nil {
		return flowruntime.Target{}, err
	}
	if head != pin.SourceCommit {
		return flowruntime.Target{}, learningRefusal("learning_source_mismatch")
	}
	machine, err := m.workspace.(machineIdentityRuntime).WorkspaceMachineIdentity(ctx, target.WorkspaceID) // prepare checked the runtime.
	if err != nil {
		return flowruntime.Target{}, err
	}
	if machine == "" {
		return flowruntime.Target{}, learningRefusal("learning_machine_unavailable")
	}
	// The learning target resolver requires a running row bound to its VM.
	// The Flow host start seeds the machine's branch head from source_commit
	// (machineBranchHead); without it EnsureMachined refuses step "head".
	if _, err := m.pool.Exec(ctx, `UPDATE workspaces SET status='running', vm_id=$4, source_commit=$5 WHERE id=$1 AND repository_id=$2 AND user_id=$3 AND deleted_at IS NULL`, target.WorkspaceID, repository, actor, machine, pin.SourceCommit); err != nil {
		return flowruntime.Target{}, err
	}
	return target, nil
}

// RetireLearningMachine deletes the machine after a committed receipt or a
// verified terminal failure. Only confirmed runtime deletion releases its
// slot and removes its row; a failed deletion is retried by the caller.
func (m *learningMachine) RetireLearningMachine(ctx context.Context, target flowruntime.Target) error {
	if m == nil || m.workspace == nil || target.BindingKind != "learning" || target.WorkspaceID != learningWorkspaceID(target.BindingID) {
		return services.ErrLearningBinding
	}
	tenant, tenantOK := strings.CutPrefix(target.TenantID, "repository:")
	principal, principalOK := strings.CutPrefix(target.PrincipalID, "user:")
	repository, repositoryErr := strconv.ParseInt(tenant, 10, 64)
	actor, actorErr := strconv.ParseInt(principal, 10, 64)
	if !tenantOK || !principalOK || repositoryErr != nil || actorErr != nil {
		return services.ErrLearningBinding
	}
	user := strconv.FormatInt(actor, 10)
	ctx = workspace.WithOperation(ctx, workspace.Operation{TenantID: user, PrincipalID: user, OperationID: "learning:" + target.BindingID + ":retire"})
	if err := m.workspace.DeleteWorkspace(ctx, target.WorkspaceID); err != nil && !errors.Is(err, workspace.ErrWorkspaceNotFound) {
		return err
	}
	if queue, ok := m.workspace.(reviewMachineAdmission); ok {
		holder, demand := "workspace:"+target.WorkspaceID, learningAdmissionActor(target.BindingID)
		for _, row := range queue.AdmissionSnapshot() {
			if row.Holder == holder && row.Actor == demand && (row.State == "waiting" || row.State == "granted") {
				queue.CancelFailedAdmission(holder, demand)
			}
		}
	}
	_, err := m.pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1 AND repository_id=$2 AND user_id=$3`, target.WorkspaceID, repository, actor)
	return err
}

var _ services.LearningMachines = (*learningMachine)(nil)

// QueuePosition reads Learning's existing holder; Home reads never enqueue it.
func (m *learningMachine) QueuePosition(item string) int {
	if m == nil || item == "" {
		return 0
	}
	if _, err := uuid.Parse(item); err != nil {
		return 0
	}
	if queue, ok := m.workspace.(reviewMachineAdmission); ok {
		for _, row := range queue.AdmissionSnapshot() {
			if row.Holder == "workspace:"+learningWorkspaceID(item) && row.Actor == learningAdmissionActor(item) && row.Class == "background" && row.State == "waiting" {
				return row.Position
			}
		}
	}
	return 0
}
