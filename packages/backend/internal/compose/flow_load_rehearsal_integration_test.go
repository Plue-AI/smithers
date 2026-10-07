package compose

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This isolates T-FLW-03's real guest load and HTTP activation boundary from
// J5's TODO editing, attempt recovery and delivery dependencies. It composes
// the packaged host and native helper, not a fake loader. Process-mode evidence
// is supplemental; C-SEC-02 still requires the production microVM host.
func TestFlowLoadGuestRehearsal(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_FLOW_LOAD_REHEARSAL", "C-J5-load", "flow-load-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	original, err := r.flowCard("todo")
	if err != nil {
		t.Fatal(err)
	}
	builtin := original.version("active")
	var loaded string
	if !r.step("1 Repository flow activates", "GitHub main; POST /api/github/sync; GET /api/flows", "merged-syncing then Active with the guest's loaded version", "T-FLW-03", func() error {
		source, err := os.ReadFile(filepath.Join(r.root, "flows/todo/flow.ts"))
		if err != nil {
			return err
		}
		commit, err := r.pushGitHubMain("Copy the TODO flow", map[string]string{"flows/todo/flow.ts": string(source) + "\n// Repository version.\n"})
		if err != nil {
			return err
		}
		syncing := false
		for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(100 * time.Millisecond) {
			card, err := r.flowCard("todo")
			if err != nil {
				return err
			}
			syncing = syncing || card.version("merged-syncing") != ""
			if active := card.version("active"); active != "" && active != builtin {
				if !syncing {
					return fmt.Errorf("Active changed before merged-syncing was observed")
				}
				var source, status string
				if err := r.pool.QueryRow(r.ctx, `SELECT source_commit,status FROM workflow_definitions WHERE name='todo' AND digest=$1 AND is_active`, active).Scan(&source, &status); err != nil {
					return err
				}
				if source != commit || status != "loaded" || card.version("previous") != builtin {
					return fmt.Errorf("guest activation at %s: %s, card %+v", source, status, card)
				}
				loaded = active
				r.actual = "merged-syncing then Active; previous built-in retained"
				return nil
			}
			if failed := card.version("merged-failed"); failed != "" {
				return fmt.Errorf("healthy repository copy failed: %+v", card)
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("guest activation did not settle: %s", r.flowLoadState())
			}
		}
	}) {
		return
	}
	r.step("2 Broken flow retains Active", "GitHub main; POST /api/github/sync; GET /api/flows", "merged-failed with a file error; prior version stays Active", "T-FLW-03", func() error {
		commit, err := r.pushGitHubMain("Break the TODO flow", map[string]string{"flows/todo/flow.ts": "export default (\n"})
		if err != nil {
			return err
		}
		for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(100 * time.Millisecond) {
			card, err := r.flowCard("todo")
			if err != nil {
				return err
			}
			if card.version("active") != loaded {
				return fmt.Errorf("failed load changed Active: %+v", card)
			}
			for _, version := range card.Versions {
				if version.State != "merged-failed" {
					continue
				}
				if !strings.Contains(version.Error, "flows/todo/flow.ts") {
					return fmt.Errorf("failure has no source diagnostic: %+v", version)
				}
				var source, status string
				var active bool
				if err := r.pool.QueryRow(r.ctx, `SELECT source_commit,status,is_active FROM workflow_definitions WHERE name='todo' AND digest=$1`, version.ID).Scan(&source, &status, &active); err != nil {
					return err
				}
				if source != commit || status != "failed" || active {
					return fmt.Errorf("failure receipt at %s: %s, active %t", source, status, active)
				}
				r.actual = "merged-failed with source diagnostic; previous Active retained"
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("failed guest load did not settle: %s", r.flowLoadState())
			}
		}
	})
	r.step("3 Main sync provisions its bound wiki machine", "POST /api/github/sync; install workspace provisioning", "the current wiki workspace reaches running after main sync", "T-FLW-03", func() error {
		for deadline := time.Now().Add(time.Minute); ; time.Sleep(100 * time.Millisecond) {
			var id, status string
			err := r.pool.QueryRow(r.ctx, `SELECT w.id,w.status FROM mythical_wikis k JOIN workspaces w ON w.id::text=k.workspace_id`).Scan(&id, &status)
			if err == nil && status == "running" {
				r.actual = "main sync retained the wiki binding and provisioned its machine"
				return nil
			}
			if err == nil && status == "failed" {
				return fmt.Errorf("bound wiki workspace %s failed provisioning", id)
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("bound wiki workspace did not reach running: %s %s (%v)", id, status, err)
			}
		}
	})

}
