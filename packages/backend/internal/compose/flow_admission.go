package compose

import (
	"context"
	"errors"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Admission is rechecked by the worker immediately before a managed host start.
// A durable launch can outlive the subscription that authorized its request.
// Existing-host reads/inspection and retirement do not acquire a new slot.
type admittedFlowLauncher struct {
	flowhost.Launcher
	flowhost.SourceResolver
	flowhost.RetirementStopper
	queries *db.Queries
	policy  admission.Policy
}

// Preserve the runtime boundary through both admission and box preparation.
// An adapter without an isolation report is refused by the resolver.
func launcherIsolation(launcher flowhost.Launcher) workspaceapi.IsolationLevel {
	if isolated, ok := launcher.(interface {
		Isolation() workspaceapi.IsolationLevel
	}); ok {
		return isolated.Isolation()
	}
	return ""
}

func (l *admittedFlowLauncher) Isolation() workspaceapi.IsolationLevel {
	return launcherIsolation(l.Launcher)
}

func (l *boxHostLauncher) Isolation() workspaceapi.IsolationLevel {
	return launcherIsolation(l.Launcher)
}

func newAdmittedFlowLauncher(launcher flowhost.Launcher, queries *db.Queries, policy admission.Policy) (*admittedFlowLauncher, error) {
	source, sourceOK := launcher.(flowhost.SourceResolver)
	stopper, stopOK := launcher.(flowhost.RetirementStopper)
	if queries == nil || policy == nil || !sourceOK || !stopOK {
		return nil, errors.New("Flow launch requires admission, workspace queries, source and retirement authority")
	}
	return &admittedFlowLauncher{Launcher: launcher, SourceResolver: source, RetirementStopper: stopper, queries: queries, policy: policy}, nil
}

func (l *admittedFlowLauncher) StartFlowHost(ctx context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	workspace, err := l.queries.GetWorkspace(ctx, launch.Authority.WorkspaceID)
	if err != nil {
		return flowhost.Connection{}, err
	}
	if workspace.UserID != launch.Authority.UserID || workspace.RepositoryID != launch.Authority.RepositoryID || workspace.DeletedAt.Valid {
		return flowhost.Connection{}, errors.New("Flow workspace authority changed before launch")
	}
	if err := l.policy.AuthorizeCountedSandboxResume(ctx, workspace.UserID, workspace.ID, workspace.VmID); err != nil {
		return flowhost.Connection{}, err
	}
	return l.Launcher.StartFlowHost(ctx, launch)
}

// AbandonFlowHostStart forwards a refused start to the launcher it admitted.
func (l *admittedFlowLauncher) AbandonFlowHostStart(ctx context.Context, binding flowhost.Binding) {
	if abandoner, ok := l.Launcher.(flowhost.StartAbandoner); ok {
		abandoner.AbandonFlowHostStart(ctx, binding)
	}
}

// boxHostPreparer readies a box for its coding host and holds the host's
// per-start credential (services.WorkspaceService).
type boxHostPreparer interface {
	PrepareBoxHost(ctx context.Context, hostID, workspaceID string, repositoryID, userID int64) (map[string]string, error)
	RetireBoxHostCredential(ctx context.Context, hostID string, userID int64)
	KeepBoxAwake(ctx context.Context, workspaceID string)
	RestartLostBox(ctx context.Context, workspaceID string, repositoryID, userID int64) error
}

// boxHostLauncher gives the box's coding host what the box's own services
// need before it starts (#2198): the source publisher, the landing binding
// and a landing credential minted for this start. Every stop, replacement and
// failed start revokes the credential.
type boxHostLauncher struct {
	flowhost.Launcher
	flowhost.SourceResolver
	stopper flowhost.RetirementStopper
	boxes   boxHostPreparer
	// targets adds a target's own start environment over the box's
	// (services.InvokedFlowService: an invoked run's workflow variables and
	// secrets).
	targets flowHostEnvironment
}

type flowHostEnvironment interface {
	FlowHostEnvironment(context.Context, flowhost.Authority) (map[string]string, error)
}

// boxHostBase is the workspace runtime's host launcher.
type boxHostBase interface {
	flowhost.Launcher
	flowhost.SourceResolver
	flowhost.RetirementStopper
}

func newBoxHostLauncher(launcher boxHostBase, boxes boxHostPreparer, targets flowHostEnvironment) *boxHostLauncher {
	return &boxHostLauncher{Launcher: launcher, SourceResolver: launcher, stopper: launcher, boxes: boxes, targets: targets}
}

// InspectFlowHost keeps the box awake while its host is in use: every call to
// the host, and every observation of a progressing run, inspects it first.
//
// A box the product holds running but whose runtime lost it (the backend
// restarted, which stops every workspace) is started again, and its host
// reported not running, so the resolver restarts the host on the same state
// and the run carries on (#2131). A box stopped or suspended on purpose stays so.
// A box the runtime lost outright is replaced the same way when its journals
// live outside it (#1868).
func (l *boxHostLauncher) InspectFlowHost(ctx context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	connection, err := l.Launcher.InspectFlowHost(ctx, launch)
	if err == nil {
		l.boxes.KeepBoxAwake(ctx, launch.Binding.WorkspaceID)
	}
	if (errors.Is(err, workspaceapi.ErrWorkspaceStopped) || errors.Is(err, workspaceapi.ErrWorkspaceNotFound)) &&
		l.boxes.RestartLostBox(ctx, launch.Authority.WorkspaceID, launch.Authority.RepositoryID, launch.Authority.UserID) == nil {
		return flowhost.Connection{}, flowhost.ErrHostNotRunning
	}
	return connection, err
}

// staleRoleSource is a permanent dispatch refusal: retrying the same pinned
// registration cannot move the owner's box to that revision.
type staleRoleSource struct{}

func (staleRoleSource) Error() string {
	return "role run refused: owner's box source revision differs from the registered revision"
}
func (staleRoleSource) FlowRuntimeCode() string    { return "runtime_source_revision_mismatch" }
func (staleRoleSource) FlowRuntimeRetryable() bool { return false }

func (l *boxHostLauncher) StartFlowHost(ctx context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	if launch.Authority.Target.BindingKind == "repository-job-dispatch" {
		revision, err := l.SourceResolver.ResolveFlowHostSource(ctx, launch.Authority)
		if err != nil {
			return flowhost.Connection{}, err
		}
		if revision != launch.Binding.SourceRevision {
			return flowhost.Connection{}, staleRoleSource{}
		}
	}
	var targetEnvironment map[string]string
	if l.targets != nil {
		var err error
		if targetEnvironment, err = l.targets.FlowHostEnvironment(ctx, launch.Authority); err != nil {
			return flowhost.Connection{}, err
		}
	}
	environment, err := l.boxes.PrepareBoxHost(ctx, launch.Binding.ID, launch.Authority.WorkspaceID, launch.Authority.RepositoryID, launch.Authority.UserID)
	if err != nil {
		return flowhost.Connection{}, err
	}
	// The target's variables win over the box's agent variables; a name the
	// catalog, host or Smithers owns stays theirs.
	for name, value := range targetEnvironment {
		if _, configured := launch.Catalog.Environment[name]; !configured && flowhost.RepositoryVariable(name) {
			environment[name] = value
		}
	}
	launch.Environment = environment
	connection, err := l.Launcher.StartFlowHost(ctx, launch)
	if err != nil {
		l.boxes.RetireBoxHostCredential(context.WithoutCancel(ctx), launch.Binding.ID, launch.Authority.UserID)
	}
	return connection, err
}

// StopFlowHost revokes the host's credential before stopping it, so a stop
// that fails (a box that is gone) leaves no live credential behind.
func (l *boxHostLauncher) StopFlowHost(ctx context.Context, binding flowhost.Binding) error {
	l.boxes.RetireBoxHostCredential(ctx, binding.ID, binding.UserID)
	return l.stopper.StopFlowHost(ctx, binding)
}

// AbandonFlowHostStart revokes the credential of a start the resolver refused
// after the launcher succeeded (identity or checkpoint failure).
func (l *boxHostLauncher) AbandonFlowHostStart(ctx context.Context, binding flowhost.Binding) {
	l.boxes.RetireBoxHostCredential(ctx, binding.ID, binding.UserID)
}
