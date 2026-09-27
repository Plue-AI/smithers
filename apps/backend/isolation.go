package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Workspace isolation modes. `process` is the documented trusted single-owner
// edition. `microvm` runs every workspace in a local Microsandbox microVM and
// refuses to start when microVMs are unavailable; it never falls back.
const (
	isolationProcess = "process"
	isolationMicroVM = "microvm"
)

type executionRuntimes struct {
	// workspace executes every workspace, command, service and Flow host.
	workspace workspaceapi.WorkspaceRuntime
	// control is the trusted runtime for the fixed chat model host, which
	// holds owner model credentials and runs no repository code or tools.
	control workspaceapi.WorkspaceRuntime
}

func (r executionRuntimes) Close() error {
	err := r.workspace.Close()
	if r.control != r.workspace {
		err = errors.Join(err, r.control.Close())
	}
	return err
}

func workspaceIsolation() (string, error) {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_ISOLATION")))
	switch mode {
	case "", isolationProcess:
		return isolationProcess, nil
	case isolationMicroVM:
		return isolationMicroVM, nil
	default:
		return "", fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION must be %q or %q", isolationProcess, isolationMicroVM)
	}
}

func openExecutionRuntimes(ctx context.Context, dataRoot string) (executionRuntimes, error) {
	mode, err := workspaceIsolation()
	if err != nil {
		return executionRuntimes{}, err
	}
	if mode == isolationProcess {
		runtime, err := process.New(process.Config{Root: filepath.Join(dataRoot, "workspaces")})
		if err != nil {
			return executionRuntimes{}, fmt.Errorf("start local workspace runtime: %w", err)
		}
		return executionRuntimes{workspace: runtime, control: runtime}, nil
	}
	config, err := microVMConfig(dataRoot)
	if err != nil {
		return executionRuntimes{}, err
	}
	isolated, err := microsandbox.New(ctx, config)
	if err != nil {
		return executionRuntimes{}, fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: %w", err)
	}
	control, err := process.New(process.Config{Root: filepath.Join(dataRoot, "control")})
	if err != nil {
		return executionRuntimes{}, errors.Join(fmt.Errorf("start control runtime: %w", err), isolated.Close())
	}
	return executionRuntimes{workspace: isolated, control: control}, nil
}

func microVMConfig(dataRoot string) (microsandbox.Config, error) {
	port, err := backendPort()
	if err != nil {
		return microsandbox.Config{}, err
	}
	config := microsandbox.Config{
		Binary:       strings.TrimSpace(os.Getenv("SMITHERS_MICROSANDBOX_BIN")),
		Root:         filepath.Join(dataRoot, "microvm"),
		HostPorts:    []uint16{port},
		Environments: &microsandbox.EnvironmentConfig{},
	}
	if config.Binary == "" {
		return config, fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: %w: set SMITHERS_MICROSANDBOX_BIN to the msb %s binary",
			microsandbox.ErrUnavailable, microsandbox.RequiredVersion)
	}
	integers := []struct {
		name   string
		target *int
	}{
		{"SMITHERS_MICROVM_CPUS", &config.CPUs},
		{"SMITHERS_MICROVM_MEMORY_MIB", &config.MemoryMiB},
		{"SMITHERS_MICROVM_DISK_MIB", &config.DiskMiB},
		{"SMITHERS_MICROVM_MAX_RUNNING", &config.MaxRunningVMs},
	}
	for _, setting := range integers {
		if raw := strings.TrimSpace(os.Getenv(setting.name)); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value <= 0 {
				return config, fmt.Errorf("%s must be a positive integer", setting.name)
			}
			*setting.target = value
		}
	}
	for name, target := range map[string]*int64{
		"SMITHERS_MICROVM_LAYER_BUDGET_GIB": &config.Environments.LayerBudgetBytes,
		"SMITHERS_MICROVM_MIN_FREE_GIB":     &config.Environments.MinFreeBytes,
	} {
		if raw := strings.TrimSpace(os.Getenv(name)); raw != "" {
			value, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || value <= 0 {
				return config, fmt.Errorf("%s must be a positive integer", name)
			}
			*target = value << 30
		}
	}
	return config, nil
}

// backendPort is the port guests reach at 127.0.0.1 through the bridge: the
// product API, Git origin and model proxy the local Flow composition uses.
func backendPort() (uint16, error) {
	address := strings.TrimSpace(os.Getenv("SMITHERS_SERVER_ADDR"))
	if address == "" {
		address = ":4000"
	}
	_, raw, err := net.SplitHostPort(address)
	if err != nil {
		return 0, fmt.Errorf("SMITHERS_SERVER_ADDR: %w", err)
	}
	port, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || port == 0 {
		return 0, errors.New("SMITHERS_WORKSPACE_ISOLATION=microvm needs a fixed SMITHERS_SERVER_ADDR port")
	}
	return uint16(port), nil
}

// runMicroVM serves `smithers-backend microvm doctor`: read-only checks of
// Microsandbox, this installation's machines and layers, and the disk floor.
func runMicroVM(ctx context.Context, args []string) error {
	if len(args) != 1 || args[0] != "doctor" {
		return errors.New("usage: smithers-backend microvm doctor")
	}
	dataRoot := strings.TrimSpace(os.Getenv("SMITHERS_DATA_ROOT"))
	if dataRoot == "" {
		return errors.New("SMITHERS_DATA_ROOT is required")
	}
	config := microsandbox.Config{Binary: strings.TrimSpace(os.Getenv("SMITHERS_MICROSANDBOX_BIN")), Root: filepath.Join(dataRoot, "microvm"),
		Environments: &microsandbox.EnvironmentConfig{}}
	if raw := strings.TrimSpace(os.Getenv("SMITHERS_MICROVM_MIN_FREE_GIB")); raw != "" {
		if value, err := strconv.ParseInt(raw, 10, 64); err == nil && value > 0 {
			config.Environments.MinFreeBytes = value << 30
		}
	}
	failed := false
	for _, line := range microsandbox.Doctor(ctx, config) {
		status := "ok  "
		if !line.OK {
			status, failed = "FAIL", true
		}
		fmt.Printf("%s %-9s %s\n", status, line.Name, line.Detail)
	}
	if failed {
		return errors.New("microVM isolation is not ready")
	}
	return nil
}
