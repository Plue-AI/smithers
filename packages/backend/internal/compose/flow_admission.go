package compose

import (
	"context"
	"errors"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
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
}

// boxHostBase is the workspace runtime's host launcher.
type boxHostBase interface {
	flowhost.Launcher
	flowhost.SourceResolver
	flowhost.RetirementStopper
}

func newBoxHostLauncher(launcher boxHostBase, boxes boxHostPreparer) *boxHostLauncher {
	return &boxHostLauncher{Launcher: launcher, SourceResolver: launcher, stopper: launcher, boxes: boxes}
}

// InspectFlowHost keeps the box awake while its host is in use: every call to
// the host, and every observation of a progressing run, inspects it first.
func (l *boxHostLauncher) InspectFlowHost(ctx context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	connection, err := l.Launcher.InspectFlowHost(ctx, launch)
	if err == nil {
		l.boxes.KeepBoxAwake(ctx, launch.Binding.WorkspaceID)
	}
	return connection, err
}

func (l *boxHostLauncher) StartFlowHost(ctx context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	environment, err := l.boxes.PrepareBoxHost(ctx, launch.Binding.ID, launch.Authority.WorkspaceID, launch.Authority.RepositoryID, launch.Authority.UserID)
	if err != nil {
		return flowhost.Connection{}, err
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

// boxHostCallbacks authorizes a repository-job callback from the box's coding
// host, then from a box gateway started before it.
type boxHostCallbacks struct {
	hosts    *services.FlowHostCallbacks
	gateways services.RepositoryJobGateway
}

func (callbacks boxHostCallbacks) AuthorizeRelay(ctx context.Context, id, token string) (services.RepoGatewayRelayTarget, error) {
	target, err := callbacks.hosts.AuthorizeRelay(ctx, id, token)
	var refusal *pkgerrors.APIError
	if err == nil || callbacks.gateways == nil || !errors.As(err, &refusal) || refusal.Code != pkgerrors.CodeUnauthorized {
		return target, err
	}
	return callbacks.gateways.AuthorizeRelay(ctx, id, token)
}
