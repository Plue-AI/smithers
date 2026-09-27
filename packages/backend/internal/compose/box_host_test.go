package compose

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
)

type recordingBoxes struct {
	prepared []string
	retired  []string
	awake    []string
	env      map[string]string
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
	launcher := newBoxHostLauncher(transport, boxes)
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
	failing := newBoxHostLauncher(stopFailingTransport{}, boxes)
	require.Error(t, failing.StopFlowHost(context.Background(), launch.Binding))
	require.Len(t, boxes.retired, 4)
	boxes.retired = []string{"host-1", "host-1"}

	// Using a live host keeps its box awake; a host that is not running does not.
	_, err = launcher.InspectFlowHost(context.Background(), launch)
	require.ErrorIs(t, err, flowhost.ErrHostNotRunning)
	require.Empty(t, boxes.awake)
	live := newBoxHostLauncher(liveHostTransport{}, boxes)
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
