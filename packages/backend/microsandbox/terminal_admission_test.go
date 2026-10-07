package microsandbox

import (
	"context"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestUnboundTerminalCannotSpawn(t *testing.T) {
	// No CLI, machine or host process provider: refusal must precede any effect.
	runtime := &Runtime{}
	for _, command := range []workspaceapi.Command{{}, {Args: []string{"/bin/sh"}}, {Environment: map[string]string{"SMITHERS_TOKEN_FILE": "/tmp/forged", "SMITHERS_URL": "http://localhost"}}} {
		terminal, err := runtime.OpenWorkspaceTerminal(t.Context(), "branch", command)
		require.Nil(t, terminal)
		require.ErrorIs(t, err, ErrUnavailable)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	terminal, err := runtime.OpenWorkspaceTerminal(ctx, "branch", workspaceapi.Command{})
	require.Nil(t, terminal)
	require.ErrorIs(t, err, context.Canceled)
}
