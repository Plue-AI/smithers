package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// csec02Repository is the fake GitHub repository the lifecycle installs.
const csec02Repository = "isolation-owner/app"

// csec02BundledLifecycle drives C-SEC-02 steps 1-5 and 7 through the shipped
// CLI and launchd, on the approved bundle's microVM runtime and its own
// PostgreSQL. GitHub is the fake behind the owner's HTTPS proxy and CA file.
// Every flow of the fixture repository imports a beacon that, on import,
// marks $HOME/.smithers-canary/<nonce> and dials a host listener: the marker
// must exist only inside the TODO's machine and the listener must see nothing.
// The Models setup step is seeded: this check qualifies isolation, and the
// repository's TODO flow calls no model.
func csec02BundledLifecycle(t *testing.T, approved *installbundle.Bundle) {
	require.NotZero(t, os.Getuid(), "qualification requires an unprivileged login")
	cli, err := approved.Expect("shipped CLI", approved.Path("bin/smthrs"), "bin/smthrs", true)
	require.NoError(t, err)
	msb, err := approved.Expect("bundled msb", approved.Path("bin/msb"), "bin/msb", true)
	require.NoError(t, err)
	domain := fmt.Sprintf("gui/%d/sh.smithers.host", os.Getuid())
	// Never stop or replace a service this test did not start.
	require.Error(t, exec.Command("/bin/launchctl", "print", domain).Run(), "stop the existing install before qualification")
	listener, err := net.Listen("tcp", "127.0.0.1:4000")
	require.NoError(t, err, "reference-host install port must be unoccupied")
	require.NoError(t, listener.Close())
	// The backend runs microVMs with the account's passwd home, not the
	// launcher's HOME; both are host locations the beacon must never reach.
	account, err := user.Current()
	require.NoError(t, err)
	evidence := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR")
	save := func(name string, data []byte) {
		t.Helper()
		if evidence == "" {
			return
		}
		require.NoError(t, os.MkdirAll(evidence, 0700))
		require.NoError(t, os.WriteFile(filepath.Join(evidence, name), data, 0600))
	}
	// launchd's setup socket path is limited to 104 bytes; keep the private
	// home in the checkout, as TestCSEC02LaunchdServedClaim does.
	checkout, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	home, err := os.MkdirTemp(checkout, ".c2l-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(home)) })
	home, err = filepath.EvalSymlinks(home)
	require.NoError(t, err)
	_, err = installbundle.ProtectedDirectory("qualification home", home)
	require.NoError(t, err)
	state := filepath.Join(home, "Library", "Application Support", "Smithers")
	require.LessOrEqual(t, len(filepath.Join(state, "run", "host.sock")), 103, "reference-host checkout path is too long for the Unix setup socket")

	nonce := strings.ReplaceAll(uuid.NewString(), "-", "")
	canary := newIsolationCanaryListener(t)
	hostMarkers := []string{filepath.Join(account.HomeDir, ".smithers-canary", nonce), filepath.Join(home, ".smithers-canary", nonce)}
	for _, marker := range hostMarkers {
		_, err := os.Lstat(marker)
		require.ErrorIs(t, err, os.ErrNotExist, "host marker must start absent")
	}
	gitRoot := t.TempDir()
	fixtureCommit := csec02FixtureRepository(t, gitRoot, nonce, canary.listener.Addr().(*net.TCPAddr).Port)
	proxy, ca := isolationGitHubProxyFor(t, home, gitRoot, []githubfake.Installation{{ID: 93001, Repositories: []githubfake.Repository{{ID: 100, FullName: csec02Repository, Private: true}}}})
	// Hostile shell selections the launcher must ignore (step 6's last clause).
	environment := []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HTTPS_PROXY=" + proxy, "NO_PROXY=localhost,127.0.0.1", "SSL_CERT_FILE=" + ca, "SMITHERS_WORKSPACE_ISOLATION=process", "SMITHERS_MICROSANDBOX_BIN=/bin/false", "SMITHERS_BACKEND_MODE=plue"}
	host := func(args ...string) ([]byte, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, cli, append([]string{"host"}, args...)...)
		command.Env = environment
		// Never put raw setup URLs or CLI output into failure messages.
		return command.Output()
	}
	// Callers poll from other goroutines and cleanups: it reports, never fails.
	runMSB := func(timeout time.Duration, args ...string) ([]byte, error) {
		if err := approved.Program("bin/msb").Check(); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		command := exec.CommandContext(ctx, msb, args...)
		command.Env = []string{"HOME=" + account.HomeDir, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
		return command.CombinedOutput()
	}
	// Registered first so it runs last: only this install's machines and
	// layer snapshots, named by its own state, are removed, after it stopped.
	t.Cleanup(func() {
		for _, machine := range csec02InstallMachines(state) {
			output, err := runMSB(time.Minute, "remove", "--force", machine)
			assert.NoError(t, err, "remove machine %s: %s", machine, output)
		}
		for _, snapshot := range csec02LayerSnapshots(filepath.Join(state, "microvm", "layers")) {
			output, err := runMSB(time.Minute, "snapshot", "remove", "-q", snapshot)
			assert.NoError(t, err, "remove snapshot %s: %s", snapshot, output)
		}
	})
	// Registered before start so partial bootstraps are stopped too.
	t.Cleanup(func() { _, err := host("stop", "--json"); require.NoError(t, err) })

	// Step 1: the sampler follows the launchd job's descendants throughout.
	sampler := startCSEC02Sampler(domain, nonce, "beacon.ts")
	t.Cleanup(sampler.stop)
	output, err := host("start", "--bundle", approved.Root(), "--json")
	require.NoError(t, err)
	var printed struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal(output, &printed))
	require.Len(t, printed.URLs, 1)
	setup, err := url.Parse(printed.URLs[0])
	require.NoError(t, err)
	token := setup.Query().Get("token")
	require.Len(t, token, 64)
	sampler.redact(token)
	ctx := t.Context()
	isolationChildInventory(t, ctx, csec02LaunchdPID(domain), approved.Root())

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	r := &rehearsal{t: t, ctx: ctx, origin: "http://localhost:4000", jar: jar, keyPrefix: "csec02-" + nonce[:8] + "-",
		client:     &http.Client{Jar: jar, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		logs:       &lockedBuffer{},
		stdout:     &lockedBuffer{},
		stepBudget: 15 * time.Minute,
		counts:     map[string]int{}, waiting: map[string][]string{}}
	r.pool = csec02Database(t, state)
	var major string
	require.NoError(t, r.pool.QueryRow(ctx, `SHOW server_version_num`).Scan(&major))
	require.True(t, strings.HasPrefix(major, "18"), "the install's PostgreSQL is major 18, got %s", major)
	csec02Setup(t, r, token)

	// The fixture's flows load in a machine: todo and canary become Active,
	// and merge shows its reserved_name refusal.
	cards := map[string]rehearsalFlowCard{}
	var projection []byte
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		data, err := r.expect("GET", "/api/flows", "", 200)
		require.NoError(c, err)
		var listed []rehearsalFlowCard
		require.NoError(c, json.Unmarshal(data, &listed))
		for _, card := range listed {
			cards[card.Name] = card
		}
		projection = data
		require.NotEmpty(c, cards["todo"].version("active"), r.flowLoadState())
		require.NotEmpty(c, cards["canary"].version("active"), r.flowLoadState())
		require.NotEmpty(c, cards["merge"].Versions, r.flowLoadState())
	}, 15*time.Minute, time.Second, "the fixture's flows must load in a machine")
	var activeSource string
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT source_commit FROM workflow_definitions WHERE name='todo' AND digest=$1 AND is_active`, cards["todo"].version("active")).Scan(&activeSource))
	require.Equal(t, fixtureCommit, activeSource, "the repository's TODO flow must be Active")

	// Step 2: a TODO runs the repository's TODO flow, which marks and holds.
	first, err := r.file("add a README line", "Add one line to README.md.")
	require.NoError(t, err)
	firstWorkspace, firstMachine := csec02HeldMachine(t, r, state, first, runMSB)
	sampler.track(firstMachine)

	// Step 3: /flow.run canary on that TODO's machine.
	status, data, err := r.keyed("POST", "/api/flows", fmt.Sprintf(`{"name":"canary","workspaceId":%q,"input":{}}`, firstWorkspace), r.keyPrefix+"canary")
	require.NoError(t, err)
	require.Equal(t, 202, status, string(data))
	var launched struct {
		OperationID string `json:"operationId"`
	}
	require.NoError(t, json.Unmarshal(data, &launched))
	require.NotEmpty(t, launched.OperationID)
	var run struct {
		State string `json:"state"`
		RunID string `json:"runId"`
		Code  string `json:"code"`
		Class string `json:"class"`
	}
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		data, err := r.expect("GET", "/api/flows/runs/"+launched.OperationID, "", 200)
		require.NoError(c, err)
		require.NoError(c, json.Unmarshal(data, &run))
		require.Contains(c, []string{"completed", "failed", "cancelled", "uncertain"}, run.State)
	}, 10*time.Minute, time.Second, "the canary run must settle")
	require.Equal(t, "completed", run.State, "canary run %s: %s %s", run.RunID, run.Code, run.Class)
	// The install runs only its own merge; the repository's never.
	status, data, err = r.keyed("POST", "/api/flows", fmt.Sprintf(`{"name":"merge","workspaceId":%q,"input":{}}`, firstWorkspace), r.keyPrefix+"merge")
	require.NoError(t, err)
	require.Equal(t, 403, status, string(data))
	require.Contains(t, string(data), "reserved_name")

	debugAPIQualifiedInvocation(t, r, state, runMSB, save)

	// Step 4: the Flow card and the flows projection for merge.
	data, err = r.expect("GET", "/api/flows/merge", "", 200)
	require.NoError(t, err)
	var merge struct {
		System   bool `json:"system"`
		Versions []struct {
			State string `json:"state"`
			Error string `json:"error"`
		} `json:"versions"`
	}
	require.NoError(t, json.Unmarshal(data, &merge))
	require.True(t, merge.System, "merge stays install-owned")
	require.NotEmpty(t, merge.Versions)
	require.Equal(t, "merged-failed", merge.Versions[0].State)
	require.Equal(t, "reserved_name", merge.Versions[0].Error)
	save("flows.json", projection)
	save("flow-merge.json", data)

	// Step 5: the marker exists in the machine, as an unprivileged guest
	// account, and on no host path.
	guest := csec02GuestMarkers(t, runMSB, firstMachine)
	for _, name := range []string{nonce, "todo", "canary-run"} {
		require.Contains(t, guest, name, "the guest ran %s's import or body", name)
		require.NotEqual(t, "0", guest[name], "repository code must not run as root in the guest")
	}
	require.NotContains(t, guest, "merge-run", "the repository's merge must never run")
	save("guest-markers.json", mustJSON(t, guest))
	csec02HostMarkersAbsent(t, hostMarkers, save)

	// Step 7: restart normally, start a TODO, and kill its machine mid-run.
	status, data, err = r.keyed("POST", fmt.Sprintf("/api/todos/%d", first), `{"op":"drop"}`, r.keyPrefix+"drop-first")
	require.NoError(t, err)
	require.Equal(t, 202, status, string(data))
	_, err = host("stop", "--json")
	require.NoError(t, err)
	r.pool.Close()
	output, err = host("start", "--bundle", approved.Root(), "--json")
	// A claimed install reports exit 3 and publishes no setup authority.
	var exit *exec.ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, 3, exit.ExitCode())
	require.NotContains(t, string(output), "setup_urls")
	require.Eventually(t, func() bool {
		response, err := r.client.Get("http://127.0.0.1:4000/readyz")
		if err != nil {
			return false
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		return response.StatusCode == http.StatusOK
	}, 2*time.Minute, 250*time.Millisecond, "the restarted install must become ready")
	isolationChildInventory(t, ctx, csec02LaunchdPID(domain), approved.Root())
	r.pool = csec02Database(t, state)
	second, err := r.file("hold for an interruption", "Hold until the machine stops.")
	require.NoError(t, err)
	_, secondMachine := csec02HeldMachine(t, r, state, second, runMSB)
	sampler.track(secondMachine)
	before, err := r.todo(second)
	require.NoError(t, err)
	require.NotNil(t, before.Run)
	// The reference abrupt-stop control (TestTodoMachineKillThroughInstall)
	// stops the machine's VM with no grace period.
	stopped, err := runMSB(time.Minute, "stop", "-t", "0", "-q", secondMachine)
	require.NoError(t, err, string(stopped))
	failed, err := r.waitTodoWithin(second, 5*time.Minute, "failed")
	require.NoError(t, err)
	require.NotNil(t, failed.Run)
	card, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", second), "", 200)
	require.NoError(t, err)
	var interrupted struct {
		Failure struct {
			Class     string `json:"class"`
			Retryable bool   `json:"retryable"`
		} `json:"failure"`
	}
	require.NoError(t, json.Unmarshal(card, &interrupted))
	require.Equal(t, "interrupted", interrupted.Failure.Class, "the killed run must show interrupted, never continue on the host")

	statusOutput, statusErr := host("status", "--json")
	save("host-status.json", append(statusOutput, []byte(fmt.Sprintf("\nerror=%v\n", statusErr))...))
	csec02HostMarkersAbsent(t, hostMarkers, save)
	sampler.stop()
	save("process-samples.jsonl", sampler.processes())
	save("lsof-samples.jsonl", sampler.files())
	require.Empty(t, sampler.violations(), "a host process carried repository code or its nonce")
	require.NoError(t, canary.listener.Close())
	<-canary.done
	canary.mu.Lock()
	connections := slices.Clone(canary.connections)
	canary.mu.Unlock()
	save("canary-listener.log", []byte(strings.Join(connections, "\n")+"\n"))
	require.Empty(t, connections, "the host canary listener received a connection")
	save("lifecycle.json", mustJSON(t, map[string]any{"revision": approved.Revision(), "manifestSHA256": approved.ManifestSHA256(),
		"fixtureCommit": fixtureCommit, "postgresVersionNum": major, "heldTodo": first, "canaryRun": run.RunID, "mergeRefused": "reserved_name",
		"guestMarkers": guest, "hostMarkersAbsent": true, "canaryConnections": len(connections), "killedTodo": second, "killedRunClass": interrupted.Failure.Class}))
}

// csec02FixtureRepository commits the C-SEC-02 repository as the fake
// GitHub's isolation-owner/app main and answers its commit.
func csec02FixtureRepository(t *testing.T, gitRoot, nonce string, port int) string {
	t.Helper()
	seed := filepath.Join(t.TempDir(), "seed")
	git := func(args ...string) string {
		t.Helper()
		command := exec.Command("/usr/bin/git", args...)
		command.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + seed, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull}
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		return strings.TrimSpace(string(output))
	}
	git("init", "-q", "-b", "main", seed)
	for path, content := range csec02FlowSources(nonce, port) {
		require.NoError(t, os.MkdirAll(filepath.Join(seed, filepath.Dir(path)), 0700))
		require.NoError(t, os.WriteFile(filepath.Join(seed, path), []byte(content), 0600))
	}
	git("-C", seed, "add", ".")
	git("-C", seed, "-c", "user.name=C-SEC-02", "-c", "user.email=owner@example.test", "commit", "-q", "-m", "Isolation canary")
	commit := git("-C", seed, "rev-parse", "HEAD")
	owner, name, _ := strings.Cut(csec02Repository, "/")
	require.NoError(t, os.MkdirAll(filepath.Join(gitRoot, owner), 0700))
	git("clone", "-q", "--bare", seed, filepath.Join(gitRoot, owner, name+".git"))
	return commit
}

// csec02FlowSources is the check's repository: flows/canary/beacon.ts, on
// import, writes $HOME/.smithers-canary/<nonce> and dials the host listener;
// todo, canary and merge each import it. mark records where a body ran, with
// the account's uid as the file's content.
func csec02FlowSources(nonce string, port int) map[string]string {
	sealed := `effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }`
	marked := func(name, from, run string) string {
		return fmt.Sprintf(`import { mark } from %q
import { Flow, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make(%q, {
  description: "C-SEC-02 isolation canary",
  capabilities: [],
  %s,
  modelInvocable: false,
  payload: Schema.Struct({}),
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: () => Sleep.action.call({ until: 1 }).pipe(Node.map(() => {
    mark(%q)
    return %q
  }))
})
`, from, name, sealed, run, "guest-"+name)
	}
	return map[string]string{
		"README.md": "C-SEC-02 isolation fixture\n",
		"flows/canary/beacon.ts": fmt.Sprintf(`import { mkdirSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
const directory = join(process.env.HOME || homedir(), ".smithers-canary")
export const mark = (name: string): void => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), String(process.getuid ? process.getuid() : -1))
}
mark(%q)
const beacon = connect({ host: "127.0.0.1", port: %d })
beacon.on("error", () => {})
beacon.on("connect", () => beacon.end(%q))
beacon.setTimeout(250, () => beacon.destroy())
`, nonce, port, nonce),
		"flows/canary/flow.ts": marked("canary", "./beacon.ts", "canary-run"),
		"flows/debug-canary/flow.ts": `import { mark } from "../canary/beacon.ts"
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
const Probe = Action.make("cui10/probe", {
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 tier: "sealed", idempotencyKey: "cui10-probe/v1", implementationVersion: "1"
})
export const layer = Probe.toLayer(() => Effect.sync(() => mark("debug-api-run")).pipe(
 Effect.andThen(Effect.sleep("1 minute")), Effect.as("guest-debug-api")
), { implementationVersion: "1" })
export default Flow.make("debug-canary", {
 description: "Debug API isolation canary", capabilities: [], modelInvocable: false,
 effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 body: () => Probe.call({})
})
`,
		"flows/merge/flow.ts": marked("merge", "../canary/beacon.ts", "merge-run"),
		// The TODO marks, then holds in an irreversible keyless step, so its
		// machine stays running for the canary and can be stopped mid-run.
		"flows/todo/flow.ts": `import { mark } from "../canary/beacon.ts"
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
const Hold = Action.make("csec02/hold", {
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 tier: "sealed", idempotencyKey: "csec02-hold/v1", implementationVersion: "1"
})
export const layer = Hold.toLayer(() => Effect.gen(function*() {
 return yield* Action.make({ name: "csec02/held", success: Schema.String,
  error: Action.IrreversibleRetryRequiresIdempotencyKey,
  tier: "irreversible", idempotencyKey: undefined, implementationVersion: "1",
  execute: Effect.sync(() => { mark("todo") }).pipe(Effect.andThen(Effect.never)) })
}), { implementationVersion: "1" })
export default Flow.make("todo", {
 description: "C-SEC-02 isolation canary", capabilities: ["*"], modelInvocable: false,
 effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 body: () => Hold.call({})
})
`,
	}
}

// csec02Setup walks setup through the install router from the printed
// token to Machine ready and an active stack.
func csec02Setup(t *testing.T, r *rehearsal, token string) {
	t.Helper()
	_, err := r.expect("GET", "/setup?token="+url.QueryEscape(token), "", 303)
	require.NoError(t, err, "setup URL")
	_, err = r.expect("GET", "/api/install", "", 200)
	require.NoError(t, err)
	body, err := json.Marshal(map[string]any{"bind": "127.0.0.1:4000", "origins": []string{r.origin}})
	require.NoError(t, err)
	_, err = r.expect("POST", "/api/install/setup/address", string(body), 202)
	require.NoError(t, err)
	require.NoError(t, r.waitStep("address"))
	data, err := r.expect("POST", "/api/install/setup/app", `{"owner":"isolation-owner"}`, 200)
	require.NoError(t, err)
	var manifest struct {
		State string `json:"state"`
	}
	require.NoError(t, json.Unmarshal(data, &manifest))
	require.NotEmpty(t, manifest.State)
	_, err = r.expect("GET", "/setup/github/callback?code=manifest-code&state="+url.QueryEscape(manifest.State), "", 303)
	require.NoError(t, err)
	require.NoError(t, r.waitStep("app_manifest"))
	_, err = r.expect("GET", "/api/auth/github", "", 302)
	require.NoError(t, err)
	redirect, err := url.Parse(r.location)
	require.NoError(t, err)
	_, err = r.expect("GET", "/api/auth/github/callback?code=owner-code&state="+url.QueryEscape(redirect.Query().Get("state")), "", 302)
	require.NoError(t, err)
	require.NoError(t, r.waitStep("sign_in"))
	// Sign-in settles in a background job; Repository may answer 409 until then.
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		status, data, err := r.request("POST", "/api/install/setup/repository", `{"repository":"`+csec02Repository+`"}`)
		require.NoError(c, err)
		require.Equal(c, 202, status, string(data))
	}, 30*time.Second, 250*time.Millisecond)
	require.NoError(t, r.waitStep("repository"))
	// Isolation is qualified without a model: seed only Models completion, as
	// TestCSEC02BundledLauncherSetupRotation seeds Address.
	_, err = r.pool.Exec(r.ctx, `UPDATE install_settings SET value='{"status":"done"}'::jsonb WHERE key='setup.step.models'`)
	require.NoError(t, err)
	_, err = r.expect("POST", "/api/install/setup/source", `{}`, 202)
	require.NoError(t, err)
	require.NoError(t, r.waitStep("source"))
	_, err = r.expect("POST", "/api/install/setup/machine", `{}`, 202)
	require.NoError(t, err)
	require.NoError(t, r.waitStep("machine"))
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		data, err := r.expect("GET", "/api/repos/"+csec02Repository+"/mythical", "", 200)
		require.NoError(c, err)
		var stack struct {
			State     string `json:"state"`
			LastError string `json:"lastError"`
		}
		require.NoError(c, json.Unmarshal(data, &stack))
		require.Equal(c, "active", stack.State, stack.LastError)
	}, 2*time.Minute, 250*time.Millisecond, "the stack must become active")
}

// csec02HeldMachine waits until TODO number's run holds in its machine and
// answers the workspace and the msb machine name.
func csec02HeldMachine(t *testing.T, r *rehearsal, state string, number int64, runMSB func(time.Duration, ...string) ([]byte, error)) (string, string) {
	t.Helper()
	var workspace, machine string
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number=$1`, number).Scan(&workspace))
		require.NotEmpty(c, workspace)
		raw, err := os.ReadFile(filepath.Join(state, "microvm", "workspaces", workspace, "metadata.json"))
		require.NoError(c, err)
		var metadata struct {
			Machine string `json:"machine"`
		}
		require.NoError(c, json.Unmarshal(raw, &metadata))
		require.NotEmpty(c, metadata.Machine)
		machine = metadata.Machine
		markers, err := csec02ReadGuestMarkers(runMSB, machine)
		require.NoError(c, err)
		require.Contains(c, markers, "todo", "the TODO flow has not reached its hold")
	}, 15*time.Minute, 2*time.Second, "TODO %d never held in its machine", number)
	return workspace, machine
}

// csec02GuestMarkers lists the guest's canary markers as name to uid.
func csec02GuestMarkers(t *testing.T, runMSB func(time.Duration, ...string) ([]byte, error), machine string) map[string]string {
	t.Helper()
	markers, err := csec02ReadGuestMarkers(runMSB, machine)
	require.NoError(t, err)
	return markers
}

// The observation runs the guest image's shell as root, so every account's
// home (/home/<login>, mode 0700) is readable: a read, not repository code.
func csec02ReadGuestMarkers(runMSB func(time.Duration, ...string) ([]byte, error), machine string) (map[string]string, error) {
	output, err := runMSB(time.Minute, "exec", "--stream", "--user", "root", machine, "--", "/bin/sh", "-c",
		`for f in /.smithers-canary/* /root/.smithers-canary/* /home/*/.smithers-canary/*; do [ -f "$f" ] && printf '%s %s\n' "$(basename "$f")" "$(cat "$f")"; done; true`)
	if err != nil {
		return nil, fmt.Errorf("guest observation: %w: %s", err, output)
	}
	markers := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if name, uid, ok := strings.Cut(line, " "); ok {
			markers[name] = uid
		}
	}
	return markers, nil
}

func csec02HostMarkersAbsent(t *testing.T, markers []string, save func(string, []byte)) {
	t.Helper()
	var listing bytes.Buffer
	for _, marker := range markers {
		entries, err := os.ReadDir(filepath.Dir(marker))
		fmt.Fprintf(&listing, "%s: %d entries, %v\n", filepath.Dir(marker), len(entries), err)
		_, err = os.Lstat(marker)
		require.ErrorIs(t, err, os.ErrNotExist, "repository code ran on the host: %s", marker)
	}
	save("host-markers.txt", listing.Bytes())
}

// csec02Database connects to the install's own PostgreSQL through its
// postmaster.pid port and generated password.
func csec02Database(t *testing.T, state string) *pgxpool.Pool {
	t.Helper()
	var pool *pgxpool.Pool
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		pid, err := os.ReadFile(filepath.Join(state, "postgres", "data", "postmaster.pid"))
		require.NoError(c, err)
		fields := strings.Split(string(pid), "\n")
		require.GreaterOrEqual(c, len(fields), 4)
		password, err := os.ReadFile(filepath.Join(state, "postgres", "password"))
		require.NoError(c, err)
		connection := url.URL{Scheme: "postgres", User: url.UserPassword("smithers", string(password)), Host: net.JoinHostPort("127.0.0.1", strings.TrimSpace(fields[3])), Path: "/postgres", RawQuery: "sslmode=disable"}
		opened, err := pgxpool.New(t.Context(), connection.String())
		require.NoError(c, err)
		if err := opened.Ping(t.Context()); err != nil {
			opened.Close()
			require.NoError(c, err)
		}
		pool = opened
	}, time.Minute, 500*time.Millisecond, "the install's PostgreSQL must accept connections")
	t.Cleanup(pool.Close)
	return pool
}

// csec02InstallMachines names the msb machines this install's state records.
func csec02InstallMachines(state string) []string {
	paths, _ := filepath.Glob(filepath.Join(state, "microvm", "workspaces", "*", "metadata.json"))
	var machines []string
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var metadata struct {
			Machine string `json:"machine"`
		}
		if json.Unmarshal(raw, &metadata) == nil && metadata.Machine != "" {
			machines = append(machines, metadata.Machine)
		}
	}
	return machines
}

// csec02LayerSnapshots names the layer snapshots this install's records built
// (apps/app/scripts/run-local-no-github.ts layerSnapshots).
func csec02LayerSnapshots(records string) []string {
	paths, _ := filepath.Glob(filepath.Join(records, "*.json"))
	pattern := regexp.MustCompile(`^smthrs-(tc|dp)-[0-9a-f]{8}-[0-9a-f]{20}$`)
	var names []string
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var record struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &record) == nil && pattern.MatchString(record.Name) {
			names = append(names, record.Name)
		}
	}
	return names
}

// csec02LaunchdPID answers the launchd job's pid, or 0 while it has none.
func csec02LaunchdPID(domain string) int {
	output, err := exec.Command("/bin/launchctl", "print", domain).Output()
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(output))
	for index := 0; index+2 < len(fields); index++ {
		if fields[index] == "pid" && fields[index+1] == "=" {
			pid, _ := strconv.Atoi(fields[index+2])
			return pid
		}
	}
	return 0
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	require.NoError(t, err)
	return append(data, '\n')
}

// csec02Sampler records, every 250 ms, ps rows for every descendant of the
// launchd job and lsof names for its node, bun and smithers-* processes, plus
// the processes naming a tracked machine. A host command line carrying the
// nonce, or an interpreter's naming the beacon, is a violation; reading
// source as data (git) or an open file alone is evidence only.
type csec02Sampler struct {
	domain        string
	nonce, source string
	halt          chan struct{}
	done          chan struct{}
	once          sync.Once

	mu        sync.Mutex
	machines  []string
	secrets   []string
	rows      bytes.Buffer
	names     bytes.Buffer
	violation []string
}

func startCSEC02Sampler(domain, nonce, source string) *csec02Sampler {
	s := &csec02Sampler{domain: domain, nonce: nonce, source: source, halt: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-s.halt:
				return
			case <-ticker.C:
				s.sample()
			}
		}
	}()
	return s
}

func (s *csec02Sampler) stop() {
	s.once.Do(func() { close(s.halt) })
	<-s.done
}

func (s *csec02Sampler) track(machine string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.machines = append(s.machines, machine)
}

// redact keeps a credential out of retained samples.
func (s *csec02Sampler) redact(secret string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.secrets = append(s.secrets, secret)
}

func (s *csec02Sampler) processes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.rows.Bytes())
}

func (s *csec02Sampler) files() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.names.Bytes())
}

func (s *csec02Sampler) violations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.violation)
}

type csec02Process struct {
	PID     int    `json:"pid"`
	Parent  int    `json:"ppid"`
	UID     int    `json:"uid"`
	Command string `json:"command"`
}

func (s *csec02Sampler) sample() {
	root := csec02LaunchdPID(s.domain)
	output, err := exec.Command("/bin/ps", "-axww", "-o", "pid=,ppid=,uid=,command=").Output()
	if err != nil {
		return
	}
	var all []csec02Process
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		pid, e1 := strconv.Atoi(fields[0])
		parent, e2 := strconv.Atoi(fields[1])
		uid, e3 := strconv.Atoi(fields[2])
		if e1 != nil || e2 != nil || e3 != nil {
			continue
		}
		all = append(all, csec02Process{PID: pid, Parent: parent, UID: uid, Command: strings.Join(fields[3:], " ")})
	}
	s.mu.Lock()
	machines := slices.Clone(s.machines)
	secrets := slices.Clone(s.secrets)
	s.mu.Unlock()
	owned := map[int]bool{}
	if root > 0 {
		owned[root] = true
		for changed := true; changed; {
			changed = false
			for _, process := range all {
				if owned[process.Parent] && !owned[process.PID] {
					owned[process.PID], changed = true, true
				}
			}
		}
	}
	at := time.Now().UTC()
	var sampled []csec02Process
	var violations []string
	type opened struct {
		At    time.Time `json:"at"`
		PID   int       `json:"pid"`
		Names []string  `json:"names"`
	}
	var files []opened
	for _, process := range all {
		machine := false
		for _, name := range machines {
			machine = machine || strings.Contains(process.Command, name)
		}
		if !owned[process.PID] && !machine {
			continue
		}
		for _, secret := range secrets {
			process.Command = strings.ReplaceAll(process.Command, secret, "<redacted>")
		}
		sampled = append(sampled, process)
		executable := filepath.Base(strings.Fields(process.Command)[0])
		interpreter := slices.Contains([]string{"node", "bun", "deno", "tsx", "sh", "bash", "zsh", "python3"}, executable)
		if strings.Contains(process.Command, s.nonce) || interpreter && strings.Contains(process.Command, s.source) {
			violations = append(violations, fmt.Sprintf("%s pid %d: %s", at.Format(time.RFC3339Nano), process.PID, process.Command))
		}
		if executable != "node" && executable != "bun" && !strings.HasPrefix(executable, "smithers-") {
			continue
		}
		listing, err := exec.Command("/usr/sbin/lsof", "-p", strconv.Itoa(process.PID), "-Fn").Output()
		if err != nil && len(listing) == 0 {
			continue // Short-lived processes exit between samples.
		}
		var names []string
		for _, line := range strings.Split(string(listing), "\n") {
			if strings.HasPrefix(line, "n") {
				names = append(names, strings.TrimPrefix(line, "n"))
			}
		}
		files = append(files, opened{At: at, PID: process.PID, Names: names})
	}
	row, _ := json.Marshal(map[string]any{"at": at, "root": root, "processes": sampled})
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows.Write(append(row, '\n'))
	for _, file := range files {
		line, _ := json.Marshal(file)
		s.names.Write(append(line, '\n'))
	}
	s.violation = append(s.violation, violations...)
}
