package microsandbox

import "fmt"

func validateSizing(c Config) error {
	if c.CPUs <= 0 || c.MemoryMiB <= 0 || c.DiskMiB <= 0 || c.MaxRunningVMs < 0 {
		return fmt.Errorf("microVM sizing is required: CPUs, memory, disk and capacity")
	}
	if c.MaxRunningVMs == 0 && (c.HostProfile == nil || ComputeSizing(*c.HostProfile).Capacity != 0) {
		return fmt.Errorf("zero microVM capacity needs a detected zero-capacity profile")
	}
	return nil
}

func (e EnvironmentConfig) validate(c Config) error {
	if e.PrepareCPUs != c.CPUs || e.PrepareMemoryMiB != c.MemoryMiB || e.PrepareDiskMiB != c.DiskMiB {
		return fmt.Errorf("layer prepare sizing must equal one machine")
	}
	if e.MinFreeBytes <= 0 || e.LayerBudgetBytes < 0 || e.LayerBudgetBytes == 0 && (c.HostProfile == nil || ComputeSizing(*c.HostProfile).LayerBudgetBytes != 0) {
		return fmt.Errorf("layer budget and disk floor are required")
	}
	return nil
}
