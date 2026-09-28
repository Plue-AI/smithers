package flowdispatch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
)

// The project flow the box's coding host serves from the fixture repository.
// Its one model turn is answered by distribution/fake-coding-provider.mjs, the
// same scripted provider the image acceptance uses: it writes and reads back
// flow-proof.txt. The provider also answers the completion judge through the
// host's Anthropic subscription route, so neither request needs a real model.
const realHostFlow = `import { Action, Flow } from "@smthrs/flow"
import { Schema } from "effect"

// The packaged host registers this action with its real agent runtime.
const DispatchTurn = Action.make("coding/dispatch-turn", {
  payload: {
    turnId: Schema.String,
    prompt: Schema.String,
    history: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
    role: Schema.String
  },
  success: Schema.Struct({ messages: Schema.Array(Schema.String) }),
  error: Schema.Unknown
})

export default Flow.make("proof", {
  description: "Write the proof file.",
  capabilities: ["fs:read:**", "fs:write:**"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: {},
  success: Schema.Struct({ messages: Schema.Array(Schema.String) }),
  error: Schema.Unknown,
  body: () => DispatchTurn.call({
    turnId: "proof",
    prompt: "Write flow-proof.txt and read it back.",
    history: [],
    role: "coding/implement"
  })
})
`

// A file flow in the one shape every repository flow has (flows/<name>/flow.ts
// with Flow.make): it imports @smthrs/flow, @smthrs/plan and effect from the
// repository's own node_modules, not from the host's bundle (#2197).
const realHostFileFlow = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("echo", {
  description: "Echo",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: { text: Schema.String },
  success: Schema.String,
  body: ({ text }) => Node.succeed(text)
})
`

type codingHostProcess struct {
	command  *exec.Cmd
	done     chan error
	logs     *bytes.Buffer
	stopOnce sync.Once
	stopped  chan struct{}
}

type observedAcceptanceRuntime struct {
	flowruntime.Runtime
	t *testing.T
}

func (runtime observedAcceptanceRuntime) Observe(ctx context.Context, runID, cursor string, limit int) (flowruntime.Observation, error) {
	observation, err := runtime.Runtime.Observe(ctx, runID, cursor, limit)
	if err == nil && (!validObservationPage(cursor, observation) || (observation.Run.FlowID != "proof" && observation.Run.FlowID != "echo") || observation.Run.RunID != runID || observation.Terminal != terminalStatus(observation.Run.Status)) {
		runtime.t.Logf("invalid real-host observation: run=%+v after=%s next=%s terminal=%t", observation.Run, cursor, observation.NextCursor, observation.Terminal)
	}
	return observation, err
}

type realHostFixture struct {
	node, artifact, digest, root, stateDir, revision, exporter, jj, provider string
}

func startCodingHost(t *testing.T, fixture realHostFixture, port int, generation int64) (*codingHostProcess, *runtimebridge.Client) {
	t.Helper()
	logs := &bytes.Buffer{}
	command := exec.Command(fixture.node, fixture.artifact, "serve", "--root", fixture.root, "--state-dir", fixture.stateDir,
		"--host", "127.0.0.1", "--port", strconv.Itoa(port), "--listen")
	command.Dir = fixture.root
	command.Env = append(os.Environ(),
		"SMITHERS_API_KEY=fixture",
		"SMITHERS_GATEWAY_ID=11111111-1111-4111-8111-111111111111",
		"SMITHERS_CODING_IMPLEMENT_MODEL=openai:scripted",
		"OPENAI_API_KEY=scripted-provider-key",
		"SMITHERS_OPENAI_AUTH=api-key",
		"SMITHERS_ACCOUNT_POOL_URL=",
		"ANTHROPIC_AUTH_TOKEN=scripted-evaluator-key",
		"SMITHERS_MODEL_PROXY_URL="+fixture.provider,
		"SMITHERS_MODEL_PROXY_PROVIDERS=anthropic",
		"SMITHERS_OPENAI_COMPATIBLE_BASE_URL="+fixture.provider,
		"SMITHERS_CODING_LOCAL_OWNER=1",
		"SMITHERS_OWNER_GENERATION="+strconv.FormatInt(generation, 10),
		"SMITHERS_SOURCE_REVISION="+fixture.revision,
		"SMITHERS_FLOW_ARTIFACT_SHA256="+fixture.digest,
		"SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="+fixture.exporter,
		"SMITHERS_JJ_PATH="+fixture.jj,
	)
	command.Stdout = logs
	command.Stderr = logs
	require.NoError(t, command.Start())
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("coding host generation %d log:\n%s", generation, logs.String())
		}
	})
	host := &codingHostProcess{command: command, done: make(chan error, 1), logs: logs, stopped: make(chan struct{})}
	go func() { host.done <- command.Wait() }()
	client, err := runtimebridge.New(runtimebridge.Config{
		Endpoint: "http://127.0.0.1:" + strconv.Itoa(port), Credential: "fixture",
	})
	require.NoError(t, err)
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		identity, identityErr := client.Identity(context.Background())
		if identityErr == nil {
			require.Equal(t, flowruntime.Protocol, identity.Protocol)
			require.Equal(t, fixture.digest, identity.RuntimeArtifactDigest)
			require.Equal(t, fixture.revision, identity.SourceRevision)
			require.Equal(t, generation, identity.OwnerGeneration)
			return host, client
		}
		select {
		case waitErr := <-host.done:
			t.Fatalf("coding host exited before readiness: %v\n%s", waitErr, logs.String())
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("coding host did not become ready\n%s", logs.String())
	return nil, nil
}

func (host *codingHostProcess) stop(t *testing.T) {
	t.Helper()
	if host == nil || host.command == nil || host.command.Process == nil {
		return
	}
	host.stopOnce.Do(func() {
		_ = host.command.Process.Signal(syscall.SIGTERM)
		select {
		case <-host.done:
		case <-time.After(10 * time.Second):
			_ = host.command.Process.Kill()
			<-host.done
		}
		close(host.stopped)
	})
	select {
	case <-host.stopped:
	case <-time.After(11 * time.Second):
		t.Fatalf("coding host did not stop\n%s", host.logs.String())
	}
}

func runCommand(t *testing.T, directory, name string, arguments ...string) string {
	t.Helper()
	command := exec.Command(name, arguments...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	require.NoError(t, err, "%s %v: %s", name, arguments, output)
	return strings.TrimSpace(string(output))
}

func startAcceptanceWorker(service *Service, workerID string) (context.CancelFunc, <-chan error) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		defer close(done)
		done <- service.RunWorker(ctx, jobs.WorkerConfig{
			WorkerID: workerID, Capacity: 2, Lease: 5 * time.Second,
			PollInterval: 10 * time.Millisecond, RetryDelay: 20 * time.Millisecond,
		})
	}()
	return cancel, done
}

func stopAcceptanceWorker(t *testing.T, cancel context.CancelFunc, done <-chan error) {
	t.Helper()
	cancel()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("Flow acceptance worker did not stop")
	}
}

// startScriptedProvider serves the scripted model provider on a free loopback
// port and returns its origin.
func startScriptedProvider(t *testing.T, node, repositoryRoot string) string {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	logs := &bytes.Buffer{}
	command := exec.Command(node, filepath.Join(repositoryRoot, "distribution", "fake-coding-provider.mjs"))
	command.Env = append(os.Environ(), "PORT="+strconv.Itoa(port), "HOST=127.0.0.1")
	command.Stdout = logs
	command.Stderr = logs
	require.NoError(t, command.Start())
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_ = command.Wait()
		if t.Failed() {
			t.Logf("scripted provider log:\n%s", logs.String())
		}
	})
	origin := "http://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if response, err := http.Get(origin + "/health"); err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return origin
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("scripted provider did not start\n%s", logs.String())
	return ""
}

// realHostFixtureFor builds the packaged coding host from source, a JJ
// repository whose project flow the host serves, and the scripted provider
// that answers the flow's model turn.
func realHostFixtureFor(t *testing.T) realHostFixture {
	t.Helper()
	exporter := os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY")
	if exporter == "" || !filepath.IsAbs(exporter) {
		t.Fatal("set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to an absolute smithers-jj-export (cargo build --release -p smithers-ffi)")
	}
	jj, err := exec.LookPath("jj")
	if configured := os.Getenv("SMITHERS_JJ_PATH"); configured != "" {
		jj, err = configured, nil
	}
	require.NoError(t, err)
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	require.NoError(t, err)
	node, err := exec.LookPath("node")
	require.NoError(t, err)

	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "flows", "proof"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "flows", "proof", "flow.ts"), []byte(realHostFlow), 0o644))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "flows", "echo"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "flows", "echo", "flow.ts"), []byte(realHostFileFlow), 0o644))
	require.NoError(t, os.Symlink(filepath.Join(repositoryRoot, "node_modules"), filepath.Join(root, "node_modules")))
	require.NoError(t, os.WriteFile(filepath.Join(root, ".gitignore"), []byte("node_modules\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("# Fixture\n"), 0o644))
	runCommand(t, root, "git", "init", "-b", "main")
	runCommand(t, root, "git", "config", "user.name", "Fixture")
	runCommand(t, root, "git", "config", "user.email", "fixture@example.invalid")
	runCommand(t, root, "git", "add", ".")
	runCommand(t, root, "git", "commit", "-m", "Fixture")
	runCommand(t, root, jj, "git", "init", "--colocate")
	revision := runCommand(t, root, jj, "log", "--no-graph", "-r", "@", "-T", "commit_id")
	require.Len(t, revision, 40)

	artifact := filepath.Join(t.TempDir(), "smithers-coding-host")
	build := exec.Command(node, "flows/coding/build.mjs", artifact)
	build.Dir = repositoryRoot
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	artifactBytes, err := os.ReadFile(artifact)
	require.NoError(t, err)
	digestBytes := sha256.Sum256(artifactBytes)
	return realHostFixture{
		node: node, artifact: artifact, digest: hex.EncodeToString(digestBytes[:]), root: root,
		stateDir: filepath.Join(t.TempDir(), "state"), revision: revision, exporter: exporter, jj: jj,
		provider: startScriptedProvider(t, node, repositoryRoot),
	}
}

// This opt-in acceptance crosses the complete production boundary through
// the box's packaged coding host (#2194): shared Go admission, canonical
// Control receipts/journal, PostgreSQL reconnect, owner replacement, terminal
// projection, and durable cancellation. It never downloads a runtime artifact.
func TestRealBundledHostAdmissionReconnectCompletionAndCancellation(t *testing.T) {
	if os.Getenv("SMITHERS_FLOWDISPATCH_REAL_HOST") != "1" {
		t.Skip("set SMITHERS_FLOWDISPATCH_REAL_HOST=1 to build and execute the bundled coding host")
	}
	store, _ := newFlowDispatchStore(t)
	fixture := realHostFixtureFor(t)

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	var client flowruntime.Runtime
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			if client == nil {
				return nil, &testRuntimeFailure{code: "runtime_not_started", retryable: true}
			}
			return observedAcceptanceRuntime{Runtime: client, t: t}, nil
		}), ObservationDelay: 10 * time.Millisecond,
	})
	require.NoError(t, err)
	request := LaunchRequest{
		Scope: jobs.Scope{TenantID: "owner", PrincipalID: "owner"}, RequestID: "real-host-proof",
		Target: flowruntime.Target{BindingKind: "trusted-owner", BindingID: "owner"},
		FlowID: "proof", Payload: []byte(`{}`),
		AuthorizationContext: []byte(`{"role":"owner"}`), Projection: []byte(`{"kind":"acceptance"}`),
		ApprovalPolicy: ApprovalManual,
	}
	admittedAt := time.Now()
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	require.Less(t, time.Since(admittedAt), time.Second)
	joined, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	require.True(t, joined.Joined)
	require.Equal(t, receipt.OperationID, joined.OperationID)
	pending, err := store.Get(context.Background(), request.Scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateAccepted, pending.State)
	require.Empty(t, pending.ExternalReceipt)

	// The product request exists before the packaged host. Starting and
	// reaching the canonical runtime are worker concerns, never part of the
	// caller's launch latency.
	host, runtimeClient := startCodingHost(t, fixture, port, 1)
	client = runtimeClient
	t.Cleanup(func() { host.stop(t) })

	stopFirst, firstDone := startAcceptanceWorker(service, "real-host-owner-1")
	t.Cleanup(func() { stopAcceptanceWorker(t, stopFirst, firstDone) })
	parked := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State.Terminal() || operation.State == jobs.StateWaiting && bytes.Contains(operation.ExternalReceipt, []byte(`"Parked"`))
	})
	require.Equal(t, jobs.StateWaiting, parked.State, "terminal receipt: %s", parked.TerminalReceipt)
	require.Empty(t, parked.TerminalReceipt)
	stopAcceptanceWorker(t, stopFirst, firstDone)
	host.stop(t)
	approval, err := service.Approve(context.Background(), request.Scope, receipt.OperationID, "real-host-approval", []byte(`{"role":"owner"}`))
	require.NoError(t, err)
	require.Equal(t, jobs.StateAccepted, approval.State)

	host, client = startCodingHost(t, fixture, port, 2)
	stopSecond, secondDone := startAcceptanceWorker(service, "real-host-owner-2")
	t.Cleanup(func() { stopAcceptanceWorker(t, stopSecond, secondDone) })
	completed := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State.Terminal()
	})
	require.Equal(t, jobs.StateCompleted, completed.State, "terminal receipt: %s", completed.TerminalReceipt)
	var terminal terminalReceipt
	require.NoError(t, json.Unmarshal(completed.TerminalReceipt, &terminal))
	require.NotNil(t, terminal.Run)
	require.Equal(t, "completed", terminal.Run.Status)
	proof, err := os.ReadFile(filepath.Join(fixture.root, "flow-proof.txt"))
	require.NoError(t, err, "the run must have written through the box's host")
	require.Equal(t, "The coding Flow wrote this file through the packaged host.\n", string(proof))
	page, err := store.Replay(context.Background(), request.Scope, 0, 1000)
	require.NoError(t, err)
	require.NotEmpty(t, page.Events)
	require.Equal(t, "operation.completed", page.Events[len(page.Events)-1].Type)

	cancelRequest := request
	cancelRequest.RequestID = "real-host-cancel"
	cancelReceipt, err := service.Admit(context.Background(), cancelRequest)
	require.NoError(t, err)
	waitOperation(t, store, request.Scope, cancelReceipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateWaiting && bytes.Contains(operation.ExternalReceipt, []byte(`"Parked"`))
	})
	pending, err = service.CancelRequest(context.Background(), request.Scope, cancelRequest.RequestID)
	require.NoError(t, err)
	require.True(t, pending.CancellationRequested)
	waitOperation(t, store, request.Scope, cancelReceipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCancelled
	})
	stopAcceptanceWorker(t, stopSecond, secondDone)
	host.stop(t)
}

// A repository's .ts file flow runs to completion on the box's packaged host:
// the host decodes the flow's declared success value with the same Effect
// instance the flow declared it with (#2197).
func TestRealBundledHostRunsRepositoryFileFlow(t *testing.T) {
	if os.Getenv("SMITHERS_FLOWDISPATCH_REAL_HOST") != "1" {
		t.Skip("set SMITHERS_FLOWDISPATCH_REAL_HOST=1 to build and execute the bundled coding host")
	}
	store, _ := newFlowDispatchStore(t)
	fixture := realHostFixtureFor(t)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	host, client := startCodingHost(t, fixture, port, 1)
	t.Cleanup(func() { host.stop(t) })
	projector := &recordingProjector{}
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return observedAcceptanceRuntime{Runtime: client, t: t}, nil
		}), Projector: projector, ObservationDelay: 10 * time.Millisecond,
	})
	require.NoError(t, err)
	request := LaunchRequest{
		Scope: jobs.Scope{TenantID: "owner", PrincipalID: "owner"}, RequestID: "real-host-file-flow",
		Target: flowruntime.Target{BindingKind: "trusted-owner", BindingID: "owner"},
		FlowID: "echo", Payload: []byte(`{"text":"echoed"}`),
		AuthorizationContext: []byte(`{"role":"owner"}`), Projection: []byte(`{"kind":"acceptance"}`),
		ApprovalPolicy: ApprovalManual,
	}
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	stop, done := startAcceptanceWorker(service, "real-host-file-flow")
	t.Cleanup(func() { stopAcceptanceWorker(t, stop, done) })
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateWaiting && bytes.Contains(operation.ExternalReceipt, []byte(`"Parked"`))
	})
	_, err = service.Approve(context.Background(), request.Scope, receipt.OperationID, "real-host-file-flow-approval", []byte(`{"role":"owner"}`))
	require.NoError(t, err)
	finished := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCompleted || operation.State == jobs.StateFailed
	})
	var terminal terminalReceipt
	require.NoError(t, json.Unmarshal(finished.TerminalReceipt, &terminal))
	require.Equal(t, jobs.StateCompleted, finished.State, "terminal receipt: %s", finished.TerminalReceipt)
	require.NotNil(t, terminal.Run)
	require.Equal(t, "completed", terminal.Run.Status)
	require.NotContains(t, host.logs.String(), "SchemaError")

	// The run's journal reaches the projection page by page, each page read
	// after the cursor the previous one ended at (the invoked run's log).
	projector.mu.Lock()
	defer projector.mu.Unlock()
	cursor, events := "", 0
	for _, update := range projector.updates {
		if len(update.Events) == 0 {
			continue
		}
		require.Equal(t, cursor, update.EventsAfter)
		cursor = update.Checkpoint.Cursor
		events += len(update.Events)
	}
	require.NotZero(t, events, "the live host's journal must reach the projection")
	require.Equal(t, terminal.Cursor, cursor, "every journal page up to the terminal cursor was projected")
}

func Example_realHostAcceptanceCommand() {
	fmt.Println("SMITHERS_FLOWDISPATCH_REAL_HOST=1 SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=$PWD/target/release/smithers-jj-export GOMAXPROCS=2 go test -p 2 ./packages/backend/flowdispatch -run RealBundledHost -v")
	// Output: SMITHERS_FLOWDISPATCH_REAL_HOST=1 SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=$PWD/target/release/smithers-jj-export GOMAXPROCS=2 go test -p 2 ./packages/backend/flowdispatch -run RealBundledHost -v
}
