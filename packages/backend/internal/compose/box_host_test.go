package compose

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type recordingBoxes struct {
	prepared  []string
	retired   []string
	awake     []string
	restarted []string
	lost      error
	env       map[string]string
}

func (b *recordingBoxes) RestartLostBox(_ context.Context, workspaceID string, _, _ int64) error {
	b.restarted = append(b.restarted, workspaceID)
	return b.lost
}

func (b *recordingBoxes) KeepBoxAwake(_ context.Context, workspaceID string) {
	b.awake = append(b.awake, workspaceID)
}

func (b *recordingBoxes) PrepareBoxHost(_ context.Context, hostID, workspaceID string, _, _ int64) (map[string]string, error) {
	b.prepared = append(b.prepared, hostID+"@"+workspaceID)
	return b.env, nil
}
func (b *recordingBoxes) RetireBoxHostCredential(_ context.Context, hostID string, _ int64) {
	b.retired = append(b.retired, hostID)
}

type recordingHostTransport struct {
	refusingHostTransport
	started []flowhost.HostLaunch
	fail    error
}

func (r *recordingHostTransport) StartFlowHost(_ context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	r.started = append(r.started, launch)
	return flowhost.Connection{}, r.fail
}

// Every start of a box's coding host carries that start's landing credential;
// a failed start and every stop revoke it (#2198).
func TestBoxHostLauncherMintsPerStartAndRevokes(t *testing.T) {
	boxes := &recordingBoxes{env: map[string]string{"SMITHERS_JJHUB_TOKEN": "landing"}}
	transport := &recordingHostTransport{}
	launcher := newBoxHostLauncher(transport, boxes, nil)
	launch := flowhost.HostLaunch{Binding: flowhost.Binding{ID: "host-1", UserID: 9}, Authority: flowhost.Authority{WorkspaceID: "box", UserID: 9}}
	_, err := launcher.StartFlowHost(context.Background(), launch)
	require.NoError(t, err)
	require.Equal(t, []string{"host-1@box"}, boxes.prepared)
	require.Equal(t, "landing", transport.started[0].Environment["SMITHERS_JJHUB_TOKEN"])
	require.Empty(t, boxes.retired)

	transport.fail = errors.New("host did not become ready")
	_, err = launcher.StartFlowHost(context.Background(), launch)
	require.Error(t, err)
	require.Equal(t, []string{"host-1"}, boxes.retired)

	require.NoError(t, launcher.StopFlowHost(context.Background(), launch.Binding))
	require.Equal(t, []string{"host-1", "host-1"}, boxes.retired)
	// A start the resolver refuses after launch (identity, checkpoint) is revoked
	// through the admitting launcher too.
	admitted := &admittedFlowLauncher{Launcher: launcher}
	admitted.AbandonFlowHostStart(context.Background(), launch.Binding)
	require.Equal(t, []string{"host-1", "host-1", "host-1"}, boxes.retired)
	// A stop that fails (the box is gone) still revokes first.
	failing := newBoxHostLauncher(stopFailingTransport{}, boxes, nil)
	require.Error(t, failing.StopFlowHost(context.Background(), launch.Binding))
	require.Len(t, boxes.retired, 4)
	boxes.retired = []string{"host-1", "host-1"}

	// Using a live host keeps its box awake; a host that is not running does not.
	_, err = launcher.InspectFlowHost(context.Background(), launch)
	require.ErrorIs(t, err, flowhost.ErrHostNotRunning)
	require.Empty(t, boxes.awake)
	live := newBoxHostLauncher(liveHostTransport{}, boxes, nil)
	launch.Binding.WorkspaceID = "box"
	_, err = live.InspectFlowHost(context.Background(), launch)
	require.NoError(t, err)
	require.Equal(t, []string{"box"}, boxes.awake)
}

type liveHostTransport struct{ refusingHostTransport }

func (liveHostTransport) InspectFlowHost(context.Context, flowhost.HostLaunch) (flowhost.Connection, error) {
	return flowhost.Connection{Endpoint: "http://127.0.0.1:1"}, nil
}

type stopFailingTransport struct{ refusingHostTransport }

func (stopFailingTransport) StopFlowHost(context.Context, flowhost.Binding) error {
	return errors.New("box is unreachable")
}

type stoppedBoxTransport struct{ refusingHostTransport }

func (stoppedBoxTransport) InspectFlowHost(context.Context, flowhost.HostLaunch) (flowhost.Connection, error) {
	return flowhost.Connection{}, fmt.Errorf("%w: box", workspaceapi.ErrWorkspaceStopped)
}

// After a backend restart the runtime holds no workspace running. Inspecting
// a progressing run's host starts the box the product still holds running
// and reports the host not running, so the resolver restarts it and the run
// carries on; a box stopped on purpose keeps its refusal (#2131).
func TestBoxHostLauncherRestartsALostBox(t *testing.T) {
	boxes := &recordingBoxes{}
	launcher := newBoxHostLauncher(stoppedBoxTransport{}, boxes, nil)
	launch := flowhost.HostLaunch{Binding: flowhost.Binding{ID: "host-1", UserID: 9, WorkspaceID: "box"}, Authority: flowhost.Authority{WorkspaceID: "box", RepositoryID: 3, UserID: 9}}
	_, err := launcher.InspectFlowHost(context.Background(), launch)
	require.ErrorIs(t, err, flowhost.ErrHostNotRunning)
	require.Equal(t, []string{"box"}, boxes.restarted)

	boxes.lost = errors.New("workspace is not held running")
	_, err = launcher.InspectFlowHost(context.Background(), launch)
	require.ErrorIs(t, err, workspaceapi.ErrWorkspaceStopped)
	require.NotErrorIs(t, err, flowhost.ErrHostNotRunning)
	require.Empty(t, boxes.awake)
}

type recordingTargetEnvironment struct {
	environment map[string]string
	err         error
	asked       []flowhost.Authority
}

func (r *recordingTargetEnvironment) FlowHostEnvironment(_ context.Context, authority flowhost.Authority) (map[string]string, error) {
	r.asked = append(r.asked, authority)
	return r.environment, r.err
}

// An invoked run's host starts with its workflow variables and secrets over
// the box's agent variables, while every name the catalog, host or Smithers
// owns stays theirs; a refused workflow environment refuses the start before
// the box mints a credential.
func TestBoxHostLauncherAddsTheTargetEnvironment(t *testing.T) {
	boxes := &recordingBoxes{env: map[string]string{"SMITHERS_JJHUB_TOKEN": "landing", "REGION": "agent-region", "AGENT_ONLY": "agent"}}
	targets := &recordingTargetEnvironment{environment: map[string]string{
		"REGION": "workflow-region", "DEPLOY_TOKEN": "secret", "SMITHERS_JJHUB_TOKEN": "forged", "PATH": "/evil", "CATALOG_SET": "forged",
	}}
	transport := &recordingHostTransport{}
	launcher := newBoxHostLauncher(transport, boxes, targets)
	launch := flowhost.HostLaunch{
		Binding:   flowhost.Binding{ID: "host-1", UserID: 9},
		Authority: flowhost.Authority{WorkspaceID: "box", UserID: 9},
		Catalog:   flowhost.Catalog{Environment: map[string]string{"CATALOG_SET": "catalog"}},
	}
	launch.Authority.Target.BindingKind = "workflow-invoke"
	_, err := launcher.StartFlowHost(context.Background(), launch)
	require.NoError(t, err)
	require.Len(t, targets.asked, 1)
	require.Equal(t, "workflow-invoke", targets.asked[0].Target.BindingKind)
	require.Equal(t, map[string]string{
		"SMITHERS_JJHUB_TOKEN": "landing", "REGION": "workflow-region", "AGENT_ONLY": "agent", "DEPLOY_TOKEN": "secret",
	}, transport.started[0].Environment)

	targets.err = errors.New("runtime_workspace_shared")
	_, err = launcher.StartFlowHost(context.Background(), launch)
	require.ErrorIs(t, err, targets.err)
	require.Len(t, boxes.prepared, 1, "a refused environment never prepares the box")
	require.Len(t, transport.started, 1)
}
