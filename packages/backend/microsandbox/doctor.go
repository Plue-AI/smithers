package microsandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// DoctorLine is one read-only check of the microVM installation.
type DoctorLine struct {
	Name   string
	OK     bool
	Detail string
}

// Doctor inspects Microsandbox and this installation's machines, layers and
// disk without changing anything: no reap, no GC, no boot.
func Doctor(ctx context.Context, config Config) []DoctorLine {
	var lines []DoctorLine
	add := func(name string, ok bool, format string, args ...any) {
		lines = append(lines, DoctorLine{Name: name, OK: ok, Detail: fmt.Sprintf(format, args...)})
	}
	binary, verify, err := startupChecks(config)
	if err != nil {
		add("bundle", false, "%v", err)
		return lines
	}
	if bundle := config.Bundle; bundle != nil {
		add("bundle", true, "%s revision %s, manifest sha256 %s", bundle.Root(), bundle.Revision(), bundle.ManifestSHA256())
		// The state New would refuse, the doctor reports.
		if err := protectedState(config.Root); err != nil {
			add("state", false, "%v", err)
			return lines
		}
	}
	client, err := runtimeCLI(binary, verify)
	if err != nil {
		add("msb", false, "%v", err)
		return lines
	}
	qualifyCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if err := client.qualify(qualifyCtx); err != nil {
		add("msb", false, "%v", err)
		return lines
	}
	add("msb", true, "%s %s, host ready, local backend", client.binary, RequiredVersion)
	image := config.Image
	if image == "" {
		image = DefaultImage
	}
	add("image", true, "%s", image)

	owner := "(no installation yet)"
	if contents, err := os.ReadFile(filepath.Join(config.Root, "owner")); err == nil {
		owner = strings.TrimSpace(string(contents))
	}
	add("owner", true, "%s (state %s)", owner, config.Root)
	if strings.HasPrefix(owner, "smithers-backend-") {
		machines, err := client.listSandboxes(ctx, map[string]string{providerLabel: providerName, ownerLabel: owner})
		if err != nil {
			add("microVMs", false, "%v", err)
		} else {
			states := map[string]int{}
			for _, machine := range machines {
				states[strings.ToLower(machine.Status)]++
			}
			add("microVMs", true, "%d owned %v", len(machines), states)
			var stopped int
			var unique, allocated int64
			for _, machine := range machines {
				if strings.ToLower(machine.Status) == "running" {
					continue
				}
				stopped++
				directory := machineDirectory(client.home, machine.Name)
				unique += privateBytes(directory)
				allocated += allocatedBytes(directory)
			}
			add("stopped", true, "%d stopped microVMs, %.1f GiB unique (%.1f GiB allocated, clone-inclusive); %d reclaimed workspaces",
				stopped, float64(unique)/(1<<30), float64(allocated)/(1<<30), reclaimedWorkspaces(config.Root))
		}
		prefix := "-" + strings.TrimPrefix(owner, "smithers-backend-")[:8] + "-"
		snapshots, err := client.listSnapshots(ctx)
		if err != nil {
			add("layers", false, "%v", err)
		} else {
			var names []string
			var bytes int64
			for _, snapshot := range snapshots {
				if snapshot.Name != nil && strings.Contains(*snapshot.Name, prefix) {
					names = append(names, *snapshot.Name)
					bytes += allocatedBytes(snapshot.ArtifactPath)
				}
			}
			sort.Strings(names)
			add("layers", true, "%d snapshots, %.1f GiB allocated (clone-inclusive): %s", len(names), float64(bytes)/(1<<30), strings.Join(names, " "))
		}
	}
	floor := MinFreeDiskBytes
	if config.Environments != nil && config.Environments.MinFreeBytes > 0 {
		floor = config.Environments.MinFreeBytes
	}
	runtime := &Runtime{cli: client}
	if free, err := runtime.freeBytes(); err != nil {
		add("disk", false, "%v", err)
	} else {
		add("disk", free >= floor, "%.1f GiB free, floor %.1f GiB", float64(free)/(1<<30), float64(floor)/(1<<30))
	}
	return lines
}

// reclaimedWorkspaces counts workspaces whose disk was reclaimed: they hold
// no machine until their next start.
func reclaimedWorkspaces(root string) int {
	directories, _ := filepath.Glob(filepath.Join(root, "workspaces", "*", "metadata.json"))
	count := 0
	for _, path := range directories {
		contents, err := os.ReadFile(path)
		var stored metadata
		if err == nil && json.Unmarshal(contents, &stored) == nil && stored.Reclaimed {
			count++
		}
	}
	return count
}
