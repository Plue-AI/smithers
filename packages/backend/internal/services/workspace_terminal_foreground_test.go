package services

import (
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"testing"
)

type observedForegroundTerminal struct {
	workspaceapi.Terminal
	command string
}

func (t *observedForegroundTerminal) ForegroundCommand() string { return t.command }

func TestSignedInTerminalPreservesNativeForegroundCommand(t *testing.T) {
	native := &observedForegroundTerminal{command: "sleep"}
	terminal := &signedInTerminal{Terminal: native}
	require.Equal(t, "sleep", workspaceapi.ForegroundCommand(terminal))
	native.command = "cat"
	require.Equal(t, "cat", workspaceapi.ForegroundCommand(terminal))
	native.command = ""
	require.Empty(t, workspaceapi.ForegroundCommand(terminal))
	terminal.Terminal = nil
	require.Empty(t, workspaceapi.ForegroundCommand(terminal), "an unavailable provider never invents a shell command")
}
