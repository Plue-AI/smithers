package control

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// This disposable provider uses the provider's fixed working-copy root
// shared with the real microsandbox root. It does not synthesize runtime observations,
// command output, write completion, repository receipts, or database results.
type runtimeProvider struct {
	runtime *microsandbox.Runtime
}

func (p *runtimeProvider) InspectSandbox(ctx context.Context, id string) (sandbox.Sandbox, error) {
	w, err := p.runtime.InspectWorkspace(ctx, id)
	return sandbox.Sandbox{ID: w.ID, State: sandbox.State(w.State)}, err
}

func (p *runtimeProvider) Execute(ctx context.Context, id string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
	if len(request.Secrets) != 0 || request.Terminal != "" {
		return sandbox.ExecResult{}, errors.New("control provider accepts ordinary nonsecret exec only")
	}
	if request.TimeoutMS != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(*request.TimeoutMS)*time.Millisecond)
		defer cancel()
	}
	r, err := p.runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh", "-c", request.Command}})
	code := int32(r.ExitCode)
	return sandbox.ExecResult{Stdout: r.Stdout, Stderr: r.Stderr, StatusCode: &code}, err
}

func (p *runtimeProvider) WriteFile(ctx context.Context, id, path string, request sandbox.WriteFileRequest) error {
	const root = "/workspace/"
	if !strings.HasPrefix(path, root) {
		return fmt.Errorf("control provider refuses path %q", path)
	}
	return p.runtime.WriteFile(ctx, id, strings.TrimPrefix(path, root), []byte(request.Content), 0644)
}

// Lifecycle calls are outside this already-running-VM control and fail closed.
var errLifecycle = errors.New("control provider refuses VM lifecycle mutation")

func (*runtimeProvider) CreateSandbox(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
	return sandbox.CreateResult{}, errLifecycle
}
func (*runtimeProvider) ForkSandbox(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
	return sandbox.CreateResult{}, errLifecycle
}
func (*runtimeProvider) CreateService(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	return sandbox.CreateServiceResult{}, errLifecycle
}
func (*runtimeProvider) DeleteSandbox(context.Context, string) error { return errLifecycle }
func (*runtimeProvider) StartSandbox(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
	return sandbox.StartResult{}, errLifecycle
}
func (*runtimeProvider) SuspendSandbox(context.Context, string) (sandbox.SuspendResult, error) {
	return sandbox.SuspendResult{}, errLifecycle
}
func (*runtimeProvider) SnapshotSandbox(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	return sandbox.SnapshotResult{}, errLifecycle
}
func (*runtimeProvider) DeleteSnapshot(context.Context, string) error { return errLifecycle }
func (*runtimeProvider) CreateIdentity(context.Context) (sandbox.Identity, error) {
	return sandbox.Identity{}, errLifecycle
}
func (*runtimeProvider) GrantAccess(context.Context, string, string, sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	return sandbox.AccessGrant{}, errLifecycle
}
func (*runtimeProvider) CreateIdentityToken(context.Context, string) (sandbox.CreatedToken, error) {
	return sandbox.CreatedToken{}, errLifecycle
}
