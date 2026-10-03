package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"

	workspace "github.com/smithersai/smithers/packages/backend/workspace"
)

func (h *harness) snapshots(dir string, cpus int) (retErr error) {
	// Copy every available receipt even when preparation, measurement, or a
	// threshold fails. Cancellation of the run must not cancel evidence reads.
	defer func() {
		copyCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		completed := retErr == nil
		for destination, source := range map[string]string{
			"snapshot-prepare.json": "snapshot-prepare.json",
			"snapshot-samples.csv":  "jj-snapshot-output/samples.csv",
			"snapshot-summary.json": "jj-snapshot-output/summary.json",
			"snapshot-env.json":     "jj-snapshot-output/env.json",
			"snapshot-failure.json": "jj-snapshot-output/failure.json",
		} {
			data, err := h.runtime.ReadFile(copyCtx, h.id, source)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) && (!completed || destination == "snapshot-failure.json") {
					continue
				}
				retErr = errors.Join(retErr, fmt.Errorf("preserve snapshot artifact %s: %w", source, err))
				continue
			}
			if err = os.WriteFile(filepath.Join(dir, destination), data, 0600); err != nil {
				retErr = errors.Join(retErr, err)
			}
			if completed && destination == "snapshot-failure.json" {
				retErr = errors.Join(retErr, errors.New("snapshot failure receipt exists despite command success"))
			}
		}
	}()
	seed := os.Getenv("SPIKE_SNAPSHOT_STORE_ARCHIVE")
	if seed == "" {
		return errors.New("snapshot blocked: set SPIKE_SNAPSHOT_STORE_ARCHIVE to a complete pnpm 11 Linux ARM64 store tar archive; no network install is permitted")
	}
	store, err := os.ReadFile(seed)
	if err != nil {
		return fmt.Errorf("snapshot store archive: %w", err)
	}
	if err := h.runtime.WriteFile(h.ctx, h.id, "snapshot-store.tar", store, 0600); err != nil {
		return err
	}
	// Preparation alone needs GitHub/npm/Node downloads. This exact loopback
	// bridge is already admitted by the runtime; VM network rules stay intact.
	server := &http.Server{Handler: snapshotProxy(), ReadHeaderTimeout: 10 * time.Second}
	go server.Serve(h.rttBridge)
	defer server.Close()
	for destination, source := range map[string]string{
		"col01-jj":            filepath.Join(h.build, "col01-jj"),
		"snapshot-prepare.py": "scripts/spikes/col-01/jj-snapshot/prepare.py",
		"snapshot-measure.py": "scripts/spikes/col-01/jj-snapshot/snapshot.py",
	} {
		data, err := os.ReadFile(source)
		if err != nil {
			return err
		}
		if err = h.runtime.WriteFile(h.ctx, h.id, destination, data, 0755); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithCancel(h.ctx)
	defer cancel()
	spaceErr := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				var s syscall.Statfs_t
				if err := syscall.Statfs(h.build, &s); err == nil && uint64(s.Bavail)*uint64(s.Bsize) < 8<<30 {
					spaceErr <- errors.New("snapshot preparation stopped: host free disk below 8 GiB")
					cancel()
					return
				}
			}
		}
	}()
	commands := [][]string{
		{"python3", "/workspace/snapshot-prepare.py", "http://" + h.rttBridge.Addr().String()},
		{"python3", "/workspace/snapshot-measure.py", "/workspace/snapshot-repo", "/workspace/jj-snapshot-output", "--jj", "/workspace/col01-jj", "--busy-workers", fmt.Sprint(cpus), "--samples", "100"},
	}
	for i, args := range commands {
		fmt.Println("SNAPSHOT", args)
		result, err := h.runtime.ExecuteCommand(ctx, h.id, workspace.Command{Args: args})
		_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("snapshot-command-%d.log", i)), []byte(result.Stdout+"\n"+result.Stderr), 0600)
		select {
		case e := <-spaceErr:
			return e
		default:
		}
		if err != nil {
			return err
		}
		if result.ExitCode != 0 {
			return fmt.Errorf("snapshot command %d exit %d: %s", i, result.ExitCode, result.Stderr)
		}
		fmt.Println(result.Stdout)
	}
	return nil
}
