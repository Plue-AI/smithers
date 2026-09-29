package services

import (
	"context"
	"errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestResolveLegacyWorkspacePreview(t *testing.T) {
	calls := 0
	vm := &mockWorkspaceSandboxVMClient{publishIngressFn: func(_ context.Context, domain string, p sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
		calls++
		require.Equal(t, "3000-ws-1.preview.jjhub.tech", domain)
		require.Equal(t, "vm-source-1", p.SandboxID)
		require.EqualValues(t, 3000, p.Port)
		return sandbox.IngressRoute{Hostname: domain}, nil
	}}
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
	access, err := s.ResolveWorkspacePreview(context.Background(), "ws-1", 101, 1, 3000, "")
	require.NoError(t, err)
	require.Equal(t, "https://3000-ws-1.preview.jjhub.tech", access.URL)
	require.False(t, access.Proxy)
	require.Equal(t, 1, calls)
	_, err = s.ResolveWorkspacePreview(context.Background(), "ws-1", 101, 99, 3000, "")
	require.Error(t, err)
	require.Equal(t, 1, calls)
	_, err = s.ResolveWorkspacePreview(context.Background(), "ws-1", 101, 1, 0, "")
	require.Error(t, err)
	require.Equal(t, 1, calls)
	vm.publishIngressFn = func(context.Context, string, sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
		return sandbox.IngressRoute{}, errors.New("down")
	}
	_, err = s.ResolveWorkspacePreview(context.Background(), "ws-1", 101, 1, 3000, "")
	require.Error(t, err)
}
