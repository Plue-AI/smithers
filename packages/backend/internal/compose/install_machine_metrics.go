package compose

import (
	"errors"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// Register the install runtime's existing admission and boot observations;
// runtimes without a producer leave these metric families absent.
func registerInstallMachineMetrics(metrics *routes.SmithersMetrics, runtime workspace.WorkspaceRuntime) error {
	producer, ok := runtime.(interface{ MachineMetrics() prometheus.Collector })
	if !ok {
		return nil
	}
	collector := producer.MachineMetrics()
	if collector == nil {
		return errors.New("workspace runtime returned no machine metrics collector")
	}
	return metrics.Register(collector)
}
