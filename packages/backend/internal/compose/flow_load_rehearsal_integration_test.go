package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFlowLoadLargeResultComposedInstall(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_FLOW_LOAD_REHEARSAL", "C-STK-06-large-result", "large-flow-")
	if !r.install("Install through Machine ready") {
		return
	}
	const source = `import { Flow, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("todo", {
 description: "A large inspected repository flow", capabilities: [], modelInvocable: false,
 effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
 payload: Schema.Struct({}), success: Schema.Void, error: Sleep.SleepRequestInvalid,
 body: () => Node.all(Object.fromEntries(Array.from({ length: 1030 }, (_, i) =>
   ["step" + i, Sleep.action.call({ until: i + 1 })]
 ))).pipe(Node.andThen(Sleep.action.call({ millis: 3600000 })))
})
`
	r.step("Large typed load result activates", "GitHub main sync; GET /api/flows", "the exact large root result activates the repository version", "T-FLW-11", func() error {
		commit, digest := activateWatchdogOverride(t, r, source)
		var result []byte
		var loaded string
		if err := r.pool.QueryRow(r.ctx, `SELECT versions,loaded_commit FROM flow_loads WHERE commit_id=$1 AND state='idle'`, commit).Scan(&result, &loaded); err != nil {
			return err
		}
		var output []struct{ Name, Digest, Status string }
		if err := json.Unmarshal(result, &output); err != nil {
			return err
		}
		if len(result) <= 16384 || loaded != commit || len(output) != 1 ||
			output[0].Name != "todo" || output[0].Digest != digest || output[0].Status != "loaded" ||
			!strings.Contains(string(result), "step1029") {
			return fmt.Errorf("large result was lost or changed: bytes=%d commit=%s flows=%d", len(result), loaded, len(output))
		}
		r.actual = "the complete large result and final step reach Active through the install router"
		return nil
	})
}

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
	if !r.flowLoadBrowser(loaded, false) {
		return
	}
	if !r.step("2 Broken flow retains Active", "GitHub main; POST /api/github/sync; GET /api/flows", "merged-failed with a file error; prior version stays Active", "T-FLW-03", func() error {
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
	}) {
		return
	}
	r.flowLoadBrowser(loaded, true)
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

func (r *rehearsal) flowLoadBrowser(active string, failed bool) bool {
	if os.Getenv("SMITHERS_FLOW_LOAD_BROWSER") != "1" {
		return true
	}
	return r.step(fmt.Sprintf("Browser Flow card failed=%t", failed), "Chromium /flow todo; reload", "real served Active and load diagnostic survive reload", "T-FLW-03", func() error {
		// Cookie's Go JSON fields differ from Playwright's; expose only the
		// name and value of this owned fixture's authenticated session.
		var wire []map[string]string
		for _, cookie := range r.jar.Cookies(mustRehearsalURL(r.origin)) {
			wire = append(wire, map[string]string{"name": cookie.Name, "value": cookie.Value})
		}
		cookies, err := json.Marshal(wire)
		if err != nil {
			return err
		}
		command := exec.CommandContext(r.ctx, "bun", "e2e/real/flow-load.browser.ts")
		command.Dir = filepath.Join(r.root, "apps/app")
		failure := "0"
		if failed {
			failure = "1"
		}
		command.Env = append(os.Environ(), "SMITHERS_FLOW_BROWSER_ORIGIN="+r.origin,
			"SMITHERS_FLOW_BROWSER_ACTIVE="+active, "SMITHERS_FLOW_BROWSER_FAILED="+failure,
			"SMITHERS_FLOW_BROWSER_COOKIES="+string(cookies))
		output, err := command.CombinedOutput()
		r.t.Log(string(output))
		if err != nil {
			return fmt.Errorf("composed Flow card browser: %w", err)
		}
		return nil
	})

}
