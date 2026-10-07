package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

const pinnedMicroVMRehearsal = "SMITHERS_PINNED_CLOSURE_MICROVM"

func pinnedMicroVMRegistry(t *testing.T) *flowmanifest.Registry {
	t.Helper()
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err, "qualification requires an approved installed bundle")
	data, _, err := bundle.Read("bin/flow-hosts.json", 1<<20)
	require.NoError(t, err)
	registry, err := flowmanifest.Parse(data, bundle.Path("bin"))
	require.NoError(t, err)
	return &registry
}

// Keep the rehearsal's control-plane model fixture on its process runtime,
// but replace every workspace and admission provider with the install's real
// microVM composition. No SkipQualification or trusted-process permission.
func configurePinnedMicroVMRehearsal(t *testing.T, r *rehearsal, options *Options) {
	t.Helper()
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err)
	state := bundletest.ProtectedTempDir(t)
	profile, err := microsandbox.Detect(state)
	require.NoError(t, err)
	sizing := microsandbox.ComputeSizing(profile)
	require.Positive(t, sizing.Capacity)
	address, err := url.Parse(r.origin)
	require.NoError(t, err)
	port, err := strconv.ParseUint(address.Port(), 10, 16)
	require.NoError(t, err)
	vm, err := microsandbox.New(t.Context(), microsandbox.Config{
		Root: state, Bundle: bundle, BundlePrograms: []string{options.FlowHostRegistry.Coding.Executable},
		HostProfile: &profile, HostPorts: []uint16{uint16(port)},
		CPUs: sizing.CPUs, MemoryMiB: sizing.MemoryMiB,
		DiskMiB: int(microsandbox.MachineDiskBytes >> 20), MaxRunningVMs: sizing.Capacity,
		Environments: &microsandbox.EnvironmentConfig{PrepareCPUs: sizing.CPUs, PrepareMemoryMiB: sizing.MemoryMiB,
			PrepareDiskMiB: int(microsandbox.MachineDiskBytes >> 20), LayerBudgetBytes: sizing.LayerBudgetBytes, MinFreeBytes: microsandbox.MinFreeDiskBytes},
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, vm.Close()) })
	r.workspaceRuntime = vm
	options.Workspace, options.MachineImages = vm, nil
	options.BranchMachines, options.InstallBranchMachines = nil, true
	options.HostProfile = &profile
	options.FlowHostConfig = flowhost.WorkspaceLauncherConfig{}
	provenance, err := json.Marshal(map[string]any{"bundle_revision": bundle.Revision(), "manifest_sha256": bundle.ManifestSHA256(), "profile": profile, "sizing": sizing})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "microvm-provenance.json"), provenance, 0600))
}

// Run on the reference Mac with SMITHERS_PINNED_CLOSURE_MICROVM=1,
// SMITHERS_CHECK_BUNDLE and the rehearsal's native repository prerequisites.
// Admission, activation, dispatch and live projections are production paths;
// GitHub and model responses are local test dependencies, never real writes.
func TestPinnedClosureAdmissionMicroVMLive(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, pinnedMicroVMRehearsal, "T-FLW-04", "pinned-vm-")
	require.True(t, r.install("Install through Machine ready"))
	source := func(value string) string {
		return fmt.Sprintf(`import { Flow, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { value } from "../../lib/pinned-value.ts"
export default Flow.make("todo", {
 description: %q, capabilities: [], modelInvocable: false,
 effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
 payload: {}, success: Schema.String, error: Sleep.SleepRequestInvalid,
 body: () => Sleep.action.call({ until: Date.now() + 120000 }).pipe(Node.map(() => value))
})`, value)
	}
	_, err := r.pushGitHubMain("Install pinned helper", map[string]string{"lib/pinned-value.ts": `export const value = "approved-v1"`, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"})
	require.NoError(t, err)
	commit1, digest1 := activateWatchdogOverride(t, r, source("v1"))
	a, err := r.file("Pinned A", "Return the pinned helper value.")
	require.NoError(t, err)
	first, err := r.waitTodoWithin(a, 5*time.Minute, "working")
	require.NoError(t, err)
	require.NotNil(t, first.Run)
	require.NotNil(t, first.FlowVersion)
	require.Equal(t, digest1, first.FlowVersion.Digest)
	require.Equal(t, commit1, first.FlowVersion.SourceCommit)
	// Poison the editable branch after admission. Both direct flow imports
	// and transitive helper imports must continue using the immutable checkout.
	workspace, _, err := r.todoHostBinding(a)
	require.NoError(t, err)
	edited, err := r.workspaceRuntime.ExecuteCommand(r.ctx, workspace, workspaceapi.Command{Args: []string{"node", "-e", `const fs = require("node:fs");
 fs.mkdirSync("/workspace/lib", {recursive:true});
 fs.mkdirSync("/workspace/flows/todo", {recursive:true});
 const poison = 'import { writeFileSync } from "node:fs"; writeFileSync("/workspace/branch-imported", "bad"); throw new Error("editable branch imported");';
 fs.writeFileSync("/workspace/lib/pinned-value.ts", poison);
 fs.writeFileSync("/workspace/flows/todo/flow.ts", poison);
 fs.writeFileSync("/workspace/pnpm-lock.yaml", "edited branch lockfile");`}})
	require.NoError(t, err)
	require.Zero(t, edited.ExitCode, edited.Stderr)
	// Changing main's imported helper cannot change A's already admitted root.
	_, err = r.pushGitHubMain("Change Active helper", map[string]string{"lib/pinned-value.ts": `export const value = "approved-v2"`})
	require.NoError(t, err)
	commit2, digest2 := activateWatchdogOverride(t, r, source("v2"))
	require.NotEqual(t, digest1, digest2)
	socket, err := r.openLive(r.jar)
	require.NoError(t, err)
	defer socket.stop()
	assertLivePin := func(number int64, card rehearsalTodo, commit, digest string) {
		t.Helper()
		require.NotNil(t, card.Run)
		for _, topic := range []string{fmt.Sprintf("todo:%d", number), "run:" + card.Run.ID} {
			_, err := socket.subscribe(topic)
			require.NoError(t, err)
			frame, err := socket.wait(topic, 30*time.Second, func(frame liveFrame) bool {
				var view struct {
					Version struct {
						Name   string `json:"flow_name"`
						Commit string `json:"source_commit"`
						Digest string `json:"digest"`
					} `json:"flow_version"`
				}
				return json.Unmarshal(frame.Data, &view) == nil && view.Version.Name == "todo" && view.Version.Commit == commit && view.Version.Digest == digest
			})
			require.NoError(t, err, "topic %s", topic)
			require.NoError(t, os.WriteFile(filepath.Join(r.evidence, fmt.Sprintf("pin-%d-%d-%s.json", number, card.Run.Attempt, topic[:3])), frame.Data, 0600))
		}
	}
	assertLivePin(a, first, commit1, digest1)
	failed, err := r.waitTodoWithin(a, 5*time.Minute, "failed")
	require.NoError(t, err) // early success must fail no_proposal, never propose
	require.NotNil(t, failed.Run)
	_, err = socket.wait("run:"+first.Run.ID, 30*time.Second, func(frame liveFrame) bool {
		return strings.Contains(string(frame.Data), "approved-v1")
	})
	require.NoError(t, err, "the guest must execute the literal v1 helper, not just report its digest")
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", a), `{"op":"retry"}`, 202)
	require.NoError(t, err)
	retried, err := r.waitTodoWithin(a, 5*time.Minute, "working")
	require.NoError(t, err)
	require.Equal(t, first.Run.Attempt+1, retried.Run.Attempt)
	require.NotEqual(t, first.Run.ID, retried.Run.ID)
	assertLivePin(a, retried, commit1, digest1)
	b, err := r.file("Pinned B", "Return the new helper value.")
	require.NoError(t, err)
	second, err := r.waitTodoWithin(b, 5*time.Minute, "working")
	require.NoError(t, err)
	assertLivePin(b, second, commit2, digest2)
	_, err = r.waitTodoWithin(a, 5*time.Minute, "failed")
	require.NoError(t, err)
	_, err = socket.wait("run:"+retried.Run.ID, 30*time.Second, func(frame liveFrame) bool {
		return strings.Contains(string(frame.Data), "approved-v1")
	})
	require.NoError(t, err, "ordinary Retry must restore v1 helper despite editable lockfile and helper changes")
	inspected, err := r.workspaceRuntime.ExecuteCommand(r.ctx, workspace, workspaceapi.Command{Args: []string{"node", "-e", `process.exit(require("node:fs").existsSync("/workspace/branch-imported") ? 1 : 0)`}})
	require.NoError(t, err)
	require.Zero(t, inspected.ExitCode, "editable repository code was imported")
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", a), `{"op":"retry-current-flow"}`, 202)
	require.NoError(t, err)
	current, err := r.waitTodoWithin(a, 5*time.Minute, "working")
	require.NoError(t, err)
	require.Equal(t, retried.Run.Attempt+1, current.Run.Attempt)
	assertLivePin(a, current, commit2, digest2)
	// Pin metadata alone cannot prove that Retry-current loaded the new
	// immutable helper. Require the literal result from both v2 machines.
	for _, card := range []rehearsalTodo{second, current} {
		_, err = socket.wait("run:"+card.Run.ID, 5*time.Minute, func(frame liveFrame) bool {
			return strings.Contains(string(frame.Data), "approved-v2")
		})
		require.NoError(t, err, "new admission and Retry-current must execute the v2 helper")
	}
	preserved := false
	for _, evidence := range current.Evidence {
		if evidence.Attempt == int32(first.Run.Attempt) && evidence.FlowDigest == digest1 && evidence.SourceCommit == commit1 {
			preserved = true
		}
	}
	require.True(t, preserved, "Retry-current must retain earlier attempt evidence")
}

// The built-in composition contains the qualified pause boundary. Use it
// rather than relaxing production Stop's digest allowlist for an override.
func TestPinnedClosureMicroVMStopResume(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, pinnedMicroVMRehearsal, "T-FLW-04", "pinned-controls-vm-")
	require.True(t, r.install("Install through Machine ready"))
	number, err := r.file("Keep the stopped version", "[HOLD pinned-stop] [FILE pinned-resume.md] Add a greeting to pinned-resume.md")
	require.NoError(t, err)
	require.NoError(t, r.waitHeld("pinned-stop", 8*time.Minute))
	waiting, err := r.waitTodoWithin(number, time.Minute, "working")
	require.NoError(t, err)
	require.NotNil(t, waiting.Run)
	require.NotNil(t, waiting.FlowVersion)
	require.Empty(t, waiting.Waits)
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"stop"}`, 202)
	require.NoError(t, err)
	// Stop is cooperative. Release the held model turn so the original
	// composition reaches its next durable boundary inside the real guest.
	require.NoError(t, r.release("pinned-stop"))
	paused, err := r.waitTodoWithin(number, 8*time.Minute, "paused")
	require.NoError(t, err)
	require.NotNil(t, paused.Run)
	require.Equal(t, waiting.Run.ID, paused.Run.ID)
	require.Equal(t, waiting.FlowVersion, paused.FlowVersion)
	commit2, digest2 := activateWatchdogOverride(t, r, `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("todo", {
 description: "New Active must not replace a paused run", capabilities: [], modelInvocable: false,
 effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
 payload: {}, success: Schema.String,
 body: () => Node.succeed("wrong-active-version")
})`)
	require.NotEqual(t, waiting.FlowVersion.Digest, digest2)
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"resume"}`, 202)
	require.NoError(t, err)
	finished, err := r.waitTodoWithin(number, 8*time.Minute, "in_review")
	require.NoError(t, err)
	require.NotNil(t, finished.Run)
	require.NotNil(t, finished.PR)
	require.Equal(t, waiting.Run.ID, finished.Run.ID)
	require.Equal(t, waiting.Run.Attempt, finished.Run.Attempt)
	require.Equal(t, waiting.FlowVersion, finished.FlowVersion)
	pull, err := r.checkPull(finished.PR.Number, finished.PR.Head)
	require.NoError(t, err)
	files, err := r.prFiles(pull)
	require.NoError(t, err)
	require.Equal(t, []string{"pinned-resume.md"}, files, "Resume must execute the original coding composition")
	socket, err := r.openLive(r.jar)
	require.NoError(t, err)
	defer socket.stop()
	for _, topic := range []string{fmt.Sprintf("todo:%d", number), "run:" + finished.Run.ID} {
		_, err = socket.subscribe(topic)
		require.NoError(t, err)
		frame, err := socket.wait(topic, 30*time.Second, func(frame liveFrame) bool {
			var view struct {
				Version struct {
					Digest string `json:"digest"`
					Commit string `json:"source_commit"`
				} `json:"flow_version"`
			}
			return json.Unmarshal(frame.Data, &view) == nil && view.Version.Digest == waiting.FlowVersion.Digest && view.Version.Commit == waiting.FlowVersion.SourceCommit
		})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "resumed-"+topic[:3]+".json"), frame.Data, 0600))
	}
	// A fresh TODO is the positive control for the newer Active provider.
	newNumber, err := r.file("Use the new Active", "Return the new version")
	require.NoError(t, err)
	newTodo, err := r.waitTodoWithin(newNumber, 8*time.Minute, "failed")
	require.NoError(t, err)
	require.NotNil(t, newTodo.FlowVersion)
	require.Equal(t, digest2, newTodo.FlowVersion.Digest)
	require.Equal(t, commit2, newTodo.FlowVersion.SourceCommit)
}
