//go:build !smithers_preview

package compose

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"testing"
)

func TestInstallRejectsDisabledMachinesBeforeStartup(t *testing.T) {
	t.Setenv("SMITHERS_AUTH_MODE", "selfhost")
	ready := false
	err := StartWithOptions(context.Background(), nil, io.Discard, io.Discard, Options{Workspace: workspace.NewDisabled()}, func(http.Handler) { ready = true })
	require.EqualError(t, err, "disabled machines require a single-owner preview build")
	require.False(t, ready)
}
