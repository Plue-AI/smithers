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

	"github.com/smithersai/smithers/packages/backend/egressrelay"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Workspace isolation modes. `process` is retained for tests only and cannot
// bind an overridable flow without explicit test configuration. `microvm`
// runs every workspace in a local Microsandbox microVM and refuses to start
// when microVMs are unavailable; it never falls back.
const (
	isolationProcess = "process"
	isolationMicroVM = "microvm"
)

type executionRuntimes struct {
	profile *microsandbox.HostProfile
	// workspace executes every workspace, command, service and Flow host.
	workspace workspaceapi.WorkspaceRuntime
	// control is the trusted runtime for the fixed chat model host, which
	// holds owner model credentials and runs no repository code or tools.
	control workspaceapi.WorkspaceRuntime
	// relay is the workspace runtime's egress secret channel.
	relay *egressrelay.Relay
}

func (r executionRuntimes) Close() error {
	err := r.workspace.Close()
	if r.control != r.workspace {
		err = errors.Join(err, r.control.Close())
	}
	if r.relay != nil {
		err = errors.Join(err, r.relay.Close())
	}
	return err
}

// openEgressRelay starts the workspace runtime's egress secret relay on
// loopback at port (0 picks one). It may dial the backend's own listener, so
// a bound backend credential reaches it through the relay.
func openEgressRelay(port uint16) (*egressrelay.Relay, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))))
	if err != nil {
		return nil, fmt.Errorf("egress relay: %w", err)
	}
	var local []string
	if backend, err := backendPort(); err == nil {
		for _, host := range []string{"127.0.0.1", "localhost"} {
			local = append(local, net.JoinHostPort(host, strconv.Itoa(int(backend))))
		}
	}
	relay, err := egressrelay.New(egressrelay.Config{Listener: listener, Local: local})
	if err != nil {
		return nil, errors.Join(err, listener.Close())
	}
	return relay, nil
}

// egressRelayPort is the relay port microVM guests reach through their
// bridge. Machines keep the route they were built with, so it must not change
// between restarts: SMITHERS_EGRESS_RELAY_PORT, else the backend port + 1.
func egressRelayPort(backend uint16) (uint16, error) {
	raw := strings.TrimSpace(os.Getenv("SMITHERS_EGRESS_RELAY_PORT"))
	if raw == "" {
		if backend == 65535 {
			return 0, errors.New("SMITHERS_EGRESS_RELAY_PORT is required when the backend listens on port 65535")
		}
		return backend + 1, nil
	}
	port, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || port == 0 || uint16(port) == backend {
		return 0, errors.New("SMITHERS_EGRESS_RELAY_PORT must be a free port other than the backend's")
	}
	return uint16(port), nil
}

func workspaceIsolation(allowProcessForTests bool) (string, error) {
	if allowProcessForTests {
		return isolationProcess, nil
	}
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_ISOLATION")))
	switch mode {
	case isolationMicroVM:
		return isolationMicroVM, nil
	default:
		return "", fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION must be %q; process isolation is tests-only", isolationMicroVM)
	}
}

// openExecutionRuntimes composes the workspace runtime. In microvm mode the
// backend runs from the installed bundle it pinned (installedInputs); msb,
// the guest kernel and the coding Flow host and Linux workspace helper it
// plants are verified against that bundle's manifest.
func openExecutionRuntimes(ctx context.Context, dataRoot string, bundle *installbundle.Bundle, codingHost string, allowProcessForTests bool) (executionRuntimes, error) {
	mode, err := workspaceIsolation(allowProcessForTests)
	if err != nil {
		return executionRuntimes{}, err
	}
	if mode == isolationProcess {
		relay, err := openEgressRelay(0)
		if err != nil {
			return executionRuntimes{}, err
		}
		runtime, err := process.New(process.Config{Root: filepath.Join(dataRoot, "workspaces"), EgressRelay: relay})
		if err != nil {
			return executionRuntimes{}, errors.Join(fmt.Errorf("start local workspace runtime: %w", err), relay.Close())
		}
		return executionRuntimes{workspace: runtime, control: runtime, relay: relay}, nil
	}
	config, err := microVMConfig(dataRoot, bundle, codingHost)
	if err != nil {
		return executionRuntimes{}, err
	}
	relayPort, err := egressRelayPort(config.HostPorts[0])
	if err != nil {
		return executionRuntimes{}, err
	}
	relay, err := openEgressRelay(relayPort)
	if err != nil {
		return executionRuntimes{}, err
	}
	config.EgressRelay = relay
	isolated, err := microsandbox.New(ctx, config)
	if err != nil {
		return executionRuntimes{}, errors.Join(fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: %w", err), relay.Close())
	}
	control, err := process.New(process.Config{Root: filepath.Join(dataRoot, "control")})
	if err != nil {
		return executionRuntimes{}, errors.Join(fmt.Errorf("start control runtime: %w", err), isolated.Close(), relay.Close())
	}
	return executionRuntimes{workspace: isolated, control: control, relay: relay, profile: config.HostProfile}, nil
}

func microVMConfig(dataRoot string, bundle *installbundle.Bundle, codingHost string) (microsandbox.Config, error) {
	return microVMConfigWithProfile(dataRoot, bundle, codingHost, microsandbox.Detect)
}

func microVMConfigWithProfile(dataRoot string, bundle *installbundle.Bundle, codingHost string, detect func(string) (microsandbox.HostProfile, error)) (microsandbox.Config, error) {
	port, err := backendPort()
	if err != nil {
		return microsandbox.Config{}, err
	}
	config := microsandbox.Config{
		Root:         filepath.Join(dataRoot, "microvm"),
		HostPorts:    []uint16{port},
		Environments: &microsandbox.EnvironmentConfig{},
	}
	// microsandbox.New refuses to start unless the pinned bundle approves its
	// bin/msb (the only msb it runs), the guest kernel, and the coding host
	// and Linux helper it plants.
	if bundle == nil {
		return config, errors.New("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: the backend does not run from an installed bundle")
	}
	config.Bundle = bundle
	config.BundlePrograms = []string{codingHost}
	profile, err := detect(dataRoot)
	if err != nil {
		var typed *microsandbox.HostProfileError
		if !errors.As(err, &typed) {
			err = &microsandbox.HostProfileError{Field: "detection", Cause: err}
		}
		return config, fmt.Errorf("microVM refuses to start: %w", err)
	}
	if !profile.Hypervisor {
		return config, fmt.Errorf("%w: Hypervisor.framework unavailable", microsandbox.ErrUnavailable)
	}
	sizing := microsandbox.ComputeSizing(profile)
	config.HostProfile = &profile
	config.CPUs, config.MemoryMiB, config.DiskMiB, config.MaxRunningVMs = sizing.CPUs, sizing.MemoryMiB, int(microsandbox.MachineDiskBytes>>20), sizing.Capacity
	config.Environments = &microsandbox.EnvironmentConfig{PrepareCPUs: config.CPUs, PrepareMemoryMiB: config.MemoryMiB, PrepareDiskMiB: config.DiskMiB, LayerBudgetBytes: sizing.LayerBudgetBytes, MinFreeBytes: microsandbox.MinFreeDiskBytes}
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
func runMicroVM(ctx context.Context, args []string, executable func() (string, error)) error {
	if len(args) != 1 || args[0] != "doctor" {
		return errors.New("usage: smithers-backend microvm doctor")
	}
	// The doctor holds itself to a running backend's rules: no loader or git
	// injection variable, the hardened runtime, only the msb of the bundle
	// it runs from, and a data root on a protected chain.
	if err := refuseInjected(os.Environ()); err != nil {
		return err
	}
	path, err := executable()
	if err != nil {
		return fmt.Errorf("locate the backend executable: %w", err)
	}
	bundle, err := installbundle.OpenRunning(path)
	if err != nil {
		return err
	}
	if err := requireHardenedRuntime(bundle); err != nil {
		return err
	}
	dataRoot, err := protectedState("SMITHERS_DATA_ROOT", os.Getenv("SMITHERS_DATA_ROOT"), false)
	if err != nil {
		return err
	}
	config := microsandbox.Config{Bundle: bundle, Root: filepath.Join(dataRoot, "microvm"),
		Environments: &microsandbox.EnvironmentConfig{}}
	config.Environments.MinFreeBytes = microsandbox.MinFreeDiskBytes
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
