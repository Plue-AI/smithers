package compose

import (
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type invalidMachineMetrics struct {
	workspace.WorkspaceRuntime
}

func (invalidMachineMetrics) MachineMetrics() prometheus.Collector { return nil }

func TestRegisterInstallMachineMetrics(t *testing.T) {
	assertAbsent := func(t *testing.T, metrics *routes.SmithersMetrics) {
		t.Helper()
		response := httptest.NewRecorder()
		metrics.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
		require.NotContains(t, response.Body.String(), "smithers_machine_queue_depth")
		require.NotContains(t, response.Body.String(), "smithers_machine_wake_")
	}
	t.Run("absent runtime has no invented observations", func(t *testing.T) {
		metrics := routes.NewSmithersMetrics()
		require.NoError(t, registerInstallMachineMetrics(metrics, nil))
		assertAbsent(t, metrics)
	})
	t.Run("runtime without producer is supported", func(t *testing.T) {
		metrics := routes.NewSmithersMetrics()
		noProducer := struct{ workspace.WorkspaceRuntime }{}
		require.NoError(t, registerInstallMachineMetrics(metrics, noProducer))
		assertAbsent(t, metrics)
	})
	t.Run("invalid producer refuses startup", func(t *testing.T) {
		require.ErrorContains(t, registerInstallMachineMetrics(routes.NewSmithersMetrics(), invalidMachineMetrics{}), "no machine metrics collector")
	})
	t.Run("conflicting producer refuses startup", func(t *testing.T) {
		metrics := routes.NewSmithersMetrics()
		runtime := new(microsandbox.Runtime)
		require.NoError(t, registerInstallMachineMetrics(metrics, runtime))
		var duplicate prometheus.AlreadyRegisteredError
		require.ErrorAs(t, registerInstallMachineMetrics(metrics, runtime), &duplicate)
	})
}
