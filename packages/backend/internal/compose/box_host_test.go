package compose

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type recordingBoxes struct {
	prepared []string
	retired  []string
	env      map[string]string
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
}

type fixedCallbacks struct {
	target services.RepoGatewayRelayTarget
	err    error
	calls  int
}

func (f *fixedCallbacks) AuthorizeRelay(context.Context, string, string) (services.RepoGatewayRelayTarget, error) {
	f.calls++
	return f.target, f.err
}

// A callback the box host's binding does not know is still accepted from a box
// gateway started before it; any other refusal is final.
func TestBoxHostCallbacksFallBackOnlyForAnUnknownHost(t *testing.T) {
	gateways := &fixedCallbacks{target: services.RepoGatewayRelayTarget{GatewayID: "gateway"}}
	callbacks := boxHostCallbacks{hosts: services.NewFlowHostCallbacks(nil, nil), gateways: gateways}
	target, err := callbacks.AuthorizeRelay(context.Background(), "not-a-binding", "token")
	require.NoError(t, err)
	require.Equal(t, "gateway", target.GatewayID)
	require.Equal(t, 1, gateways.calls)

	_, err = boxHostCallbacks{hosts: services.NewFlowHostCallbacks(nil, nil)}.AuthorizeRelay(context.Background(), "not-a-binding", "token")
	var refusal *pkgerrors.APIError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, pkgerrors.CodeUnauthorized, refusal.Code)
}
