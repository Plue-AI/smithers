package compose

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The journey rehearsals (j1_, j2_, j4_, j5_, j6_, j7_ and
// j11_rehearsal_integration_test.go) walk one composed install through its
// public routes: the GitHub fake, the install's repository engine, the
// composed backend with its packaged coding host on the trusted-process
// runtime, distribution/fake-todo-provider.mjs as the coding model (each
// TODO's prompt steers its run with that script's markers), and the owner's
// browser. Each prints one row per step (step, route, expected, actual,
// result, ticket), then its pass, fail and pending counts, and keeps its
// evidence under .artifacts/checks/<check>/rehearsal/<UTC>/. A row that waits
// on a lane is listed as pending with that lane's name (rehearsal.pending);
// the lane replaces it with a step when it lands.

// offlineGatewayHost is the composed model host, except that Model access
// does not send the rehearsal's placeholder AI Gateway key to the real
// Gateway. The coding key's test still runs through the model host.
type offlineGatewayHost struct{ *modelhost.Host }

func (h offlineGatewayHost) RunModelTest(ctx context.Context, owner int64, request json.RawMessage) (json.RawMessage, error) {
	var body struct {
		Model struct {
			Credential string `json:"credential"`
		} `json:"model"`
	}
	if json.Unmarshal(request, &body) == nil && body.Model.Credential == "AI_GATEWAY_API_KEY" {
		return json.RawMessage(`{"ok":true,"latencyMs":0,"sample":"","output":{"kind":"decision","answers":{}}}`), nil
	}
	return h.Host.RunModelTest(ctx, owner, request)
}

// rehearsal is one composed install a journey rehearsal walks.
type rehearsal struct {
	t        *testing.T
	ctx      context.Context
	root     string
	evidence string
	pool     *pgxpool.Pool
	fake     *githubfake.Server
	compute  *sandboxfake.Provider
	coder    rehearsalCodingModel
	// mainCommit is the repository's main as the fake's Git holds it, under
	// gitRoot (<owner>/<repo>.git).
	mainCommit string
	gitRoot    string
	origin     string
	jar        http.CookieJar
	client     *http.Client
	logs       *lockedBuffer
	stdout     *lockedBuffer
	provider   *httptest.Server
	// keyPrefix starts every request's Idempotency-Key and agent run id.
	keyPrefix string
	// check names the journey in the summary line.
	check string
	// mu guards exchanges: an agent turn may run beside a row's requests.
	mu        sync.Mutex
	exchanges strings.Builder
	table     string
	// counts are the table's rows by result; waiting the pending rows by lane.
	counts  map[string]int
	waiting map[string][]string
	// actual is the last response a row read, location its redirect.
	actual, location string
	continuing       bool
	sourceReady      bool
	// quiet rows run without a table row; quietFailed names those that failed.
	quiet       bool
	quietFailed []string
}

var rehearsalTokenField = regexp.MustCompile(`"token":"[^"]*"`)

// newRehearsal composes the install for check (C-J1-04, C-J2) and serves it;
// it is enabled only by the environment variable enable set to 1.
func newRehearsal(t *testing.T, enable, check, keyPrefix string) *rehearsal {
	if os.Getenv(enable) != "1" {
		t.Skip("enable explicitly with " + enable + "=1")
	}
	require.NotEmpty(t, os.Getenv("SMITHERS_TEST_DATABASE_URL"), "rehearsal requires real PostgreSQL")
	t.Setenv("SMITHERS_REQUIRE_DATABASE_TESTS", "1")
	// Each run gets its own TMPDIR: the stack's scratch repositories live at
	// $TMPDIR/smithers-mythical/repo-<id>.git and every install's first
	// repository is 1, so two rehearsals on one host would share them. The
	// directory is short, so socket paths under it stay within the OS limit.
	tmp, err := os.MkdirTemp("/tmp", "smr")
	require.NoError(t, err)
	tmp, err = filepath.EvalSymlinks(tmp)
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	t.Setenv("TMPDIR", tmp)
	_, source, _, _ := runtime.Caller(0)
	r := &rehearsal{t: t, keyPrefix: keyPrefix, check: check, continuing: os.Getenv("J1_REHEARSAL_CONTINUE") == "1",
		table: "step\troute\texpected\tactual\tresult\tticket\n", counts: map[string]int{}, waiting: map[string][]string{}}
	r.root = filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	r.evidence = filepath.Join(r.root, ".artifacts/checks", check, "rehearsal", time.Now().UTC().Format("20060102T150405.000000000Z"))
	require.NoError(t, os.MkdirAll(r.evidence, 0700))
	// The real path: a confined check's directory is canonical (macOS's /var is
	// /private/var) and confinement compares it with the workspace root.
	processRoot, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	r.pool = pool
	gitRoot := t.TempDir()
	r.gitRoot = gitRoot
	seed := filepath.Join(gitRoot, "seed")
	require.NoError(t, os.MkdirAll(seed, 0700))
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("/usr/bin/git", args...)
		output, err := cmd.CombinedOutput()
		require.NoError(t, err, string(output))
	}
	git("init", "-b", "main", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "JOURNEY.md"), []byte("Add a greeting to JOURNEY.md\n"), 0600))
	// A repository with no Smithers files gets one check per command the
	// detector finds: make build is a fast check and make test a slow one.
	// REHEARSAL_TEST_ONLY_REPOSITORY=1 seeds only make test, the one slow check
	// of a typical repository (mvp.md J1.4); with TODO_RELAY_URL
	// (distribution/fake-todo-provider.mjs) a real model then codes the TODO.
	makefile := "build:\n\ttest -s JOURNEY.md\n\ntest:\n\tgrep -q . JOURNEY.md\n"
	if os.Getenv("REHEARSAL_TEST_ONLY_REPOSITORY") == "1" {
		makefile = "test:\n\tgrep -q . JOURNEY.md\n"
	}
	require.NoError(t, os.WriteFile(filepath.Join(seed, "Makefile"), []byte(makefile), 0600))
	git("-C", seed, "add", "JOURNEY.md", "Makefile")
	git("-C", seed, "-c", "user.name=Rehearsal", "-c", "user.email=owner@example.test", "commit", "-m", "Canary")
	seedHead, err := exec.Command("/usr/bin/git", "-C", seed, "rev-parse", "HEAD").Output()
	require.NoError(t, err)
	r.mainCommit = strings.TrimSpace(string(seedHead))
	require.NoError(t, os.MkdirAll(filepath.Join(gitRoot, "rehearsal-owner"), 0700))
	git("clone", "--bare", seed, filepath.Join(gitRoot, "rehearsal-owner/app.git"))
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	// trunk-app's default branch is not main: the repository step refuses it.
	r.fake, err = githubfake.New(githubfake.Config{OAuthCode: "owner-code", GitRoot: gitRoot, AppID: 42, Slug: "j1-rehearsal", OwnerLogin: "rehearsal-owner", OwnerKind: "user", ClientID: "client", ClientSecret: "secret", WebhookSecret: "webhook", PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), ConversionCode: "manifest-code", Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: "rehearsal-owner/app", Private: true}, {ID: 101, FullName: "rehearsal-owner/trunk-app", Private: true, DefaultBranch: "trunk"}}}}})
	require.NoError(t, err)
	t.Cleanup(r.fake.Close)
	server := httptest.NewUnstartedServer(nil)
	r.origin = "http://" + server.Listener.Addr().String()
	// The real repository engine is reused; no fixture mounts a product route.
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		library = filepath.Join(r.root, "target/release/libsmithers_ffi.dylib")
		if runtime.GOOS == "linux" {
			library = filepath.Join(r.root, "target/release/libsmithers_ffi.so")
		}
	}
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	// The install's engine, composed as localbootstrap.Prepare composes it:
	// it reserves main for the GitHub sync, and every door reads that fact
	// from its in-process client. Source ready must import main through it.
	engine, err := repository.OpenLocal(repository.Config{StoragePath: t.TempDir(), AuthToken: "rehearsal-repo", FFILibraryPath: library, InstallMainMirror: true})
	require.NoError(t, err, "build the repository's smithers-ffi library first")
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	require.True(t, engine.Client().InstallMainMirror(), "the install engine's client must carry the install fact")
	repositoryServer := httptest.NewServer(engine.Handler())
	t.Cleanup(repositoryServer.Close)
	for name, value := range map[string]string{
		"SMITHERS_REPO_HOST_URL": repositoryServer.URL, "SMITHERS_AUTH_MODE": "selfhost", "SMITHERS_DATABASE_URL": databaseURL,
		"SMITHERS_PUBLIC_URL": r.origin, "SMITHERS_SERVER_ALLOWED_ORIGINS": r.origin, "SMITHERS_SERVER_ADDR": "127.0.0.1:0",
		"SMITHERS_AUTH_SESSION_SECRET": "rehearsal-session-secret", "SMITHERS_LFS_SIGNING_SECRET": "rehearsal-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "rehearsal-encryption-key", "SMITHERS_REPO_HOST_AUTH_TOKEN": "rehearsal-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN": "rehearsal-callback", "SMITHERS_BLOB_DATA_DIR": t.TempDir(),
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false", "SMITHERS_OTEL_EXPORTER": "none", "SMITHERS_METRICS_ADDR": "",
		"SMITHERS_AUTH_GITHUB_API_BASE_URL": r.fake.URL, "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL": r.fake.URL, "SMITHERS_GITHUB_APP_API_BASE_URL": r.fake.URL,
		// TODO branches are pushed to the fake's Git, never to github.com.
		"SMITHERS_GITHUB_GIT_BASE_URL": r.fake.URL,
		// The coding host binds its lane's checkout through the native helper
		// and implements on the platform seat the scripted model answers.
		"SMITHERS_WORKSPACE_CODING_DEFAULT_MODEL": "cerebras:gpt-oss-120b",
		// The platform's AI Gateway key below serves only Jev, so the
		// review's default second-vendor seat (vercel:...) would be refused;
		// the operator pins the review to the seat the scripted model answers.
		"SMITHERS_WORKSPACE_CODING_REVIEW_MODEL": "cerebras:gpt-oss-120b",
	} {
		t.Setenv(name, value)
	}
	r.provider = localChatProvider(make(chan string, 16), "JOURNEY.md", "../../etc/passwd")
	t.Cleanup(r.provider.Close)
	bundle := filepath.Join(t.TempDir(), "model-host")
	build := exec.Command(node, filepath.Join(r.root, "apps/model-host/build.mjs"), bundle)
	build.Dir = r.root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	processRuntime, err := process.New(process.Config{Root: processRoot})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, processRuntime.Close()) })
	var workspace workspaceapi.WorkspaceRuntime = processRuntime
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{Runtime: workspace, NodeBinary: node, BundlePath: bundle})
	require.NoError(t, err)
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return databaseURL }, func() string { return "rehearsal-encryption-key" })
	require.NoError(t, err)
	host, err := modelhost.New(resolver, launcher)
	require.NoError(t, err)
	// A TODO's coding run executes on the packaged coding host, served by the
	// trusted-process runtime as apps/backend's chat integration composes it.
	// It binds its lane's checkout through the native helper; without one the
	// rehearsal composes no flow host and no TODO starts.
	var registry *flowmanifest.Registry
	var platformKeys modelproxy.Keys
	var upstreams map[string]string
	if helper := rehearsalJJExport(r.root, library); helper == "" {
		fmt.Println("rehearsal: no smithers-jj-export (SMITHERS_WORKSPACE_JJ_EXPORT_BINARY, beside the FFI library, or target/release); the TODO's coding run is not composed")
	} else {
		t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", helper)
		// A helper built with trusted-process-binding imports the stack's
		// base and publishes the lane's result as a guest's does; any other
		// stays local-only, and the TODO stops at its base import.
		if capabilities, err := exec.Command(helper, "--capabilities").Output(); err == nil && bytes.Contains(capabilities, []byte(`"trusted-process-binding/v1"`)) {
			workspace = bindingProcessRuntime{processRuntime, r.evidence}
		} else {
			fmt.Println("rehearsal: smithers-jj-export lacks trusted-process-binding (cargo build --release -p smithers-ffi --bin smithers-jj-export --features trusted-process-binding); the TODO cannot import its base")
		}
		built := buildRehearsalCodingHost(t, node, r.root)
		registry = &built
		// The coding host's model is scripted: every turn it asks goes through
		// the composed install's metered model proxy to this provider.
		r.coder = startRehearsalCodingModel(t, node, r.root, r.evidence)
		platformKeys = modelproxy.NewStaticKeys(map[string]string{modelproxy.ProviderCerebras: "scripted-coding-key", modelproxy.ProviderVercel: "scripted-evaluator-key"})
		upstreams = map[string]string{modelproxy.ProviderCerebras: r.coder.url, modelproxy.ProviderVercel: r.coder.url}
	}
	// The question before Machine ready must start no machine.
	r.compute = sandboxfake.New()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	r.ctx = ctx
	ready := make(chan http.Handler, 1)
	done := make(chan error, 1)
	r.logs = &lockedBuffer{}
	r.stdout = &lockedBuffer{}
	// The coding run takes minutes: its log is also followed while it runs.
	live, err := os.OpenFile(filepath.Join(r.evidence, "backend.live.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	require.NoError(t, err)
	t.Cleanup(func() { _ = live.Close() })
	go func() {
		done <- StartWithOptions(ctx, nil, r.stdout, io.MultiWriter(r.logs, live), Options{Repository: engine.Client(), Workspace: workspace, MachineImages: trustedProcessImages{sources: repositorySourceFiles{client: engine.Client()}}, ComputeProvider: r.compute, ChatHost: offlineGatewayHost{host}, FlowHostProductAPIURL: r.origin,
			FlowHostRegistry: registry, FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true},
			PlatformModelKeys: platformKeys, ModelProxyUpstreams: upstreams, BranchMachines: rehearsalBranchMachines(pool),
			// A label on GitHub is read within seconds, not the product's 120 s.
			GitHubIssueEventsEvery: 2 * time.Second}, func(h http.Handler) { ready <- h })
	}()
	select {
	case h := <-ready:
		server.Config.Handler = h
	case err := <-done:
		t.Fatalf("composition: %v\n%s", err, r.logs.String())
	case <-time.After(45 * time.Second):
		t.Fatalf("composition timed out: %s", r.logs.String())
	}
	server.Start()
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(15 * time.Second):
			t.Error("composition shutdown timed out")
		}
		_ = os.WriteFile(filepath.Join(r.evidence, "backend.log"), []byte(r.logs.String()), 0600)
		// Each coding host's journal (control.db, engine.db) names why a run
		// failed; the runtime's directory is gone after the test.
		states, _ := filepath.Glob(filepath.Join(processRoot, "workspaces", "*", "state", "managed-hosts"))
		for n, state := range states {
			_ = exec.Command("/bin/cp", "-R", state, filepath.Join(r.evidence, fmt.Sprintf("host-state-%d", n))).Run()
		}
	})
	r.jar, err = cookiejar.New(nil)
	require.NoError(t, err)
	r.client = &http.Client{Jar: r.jar, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	t.Cleanup(func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "http.log"), []byte(r.exchanges.String()), 0600))
	})
	// The table prints first, while the scripted model still answers its
	// turn counts; cleanups run last-registered first.
	t.Cleanup(func() {
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "steps.tsv"), []byte(r.table), 0600))
		fmt.Print(r.table)
		lanes := make([]string, 0, len(r.waiting))
		for lane, rows := range r.waiting {
			lanes = append(lanes, fmt.Sprintf("%s %d", lane, len(rows)))
		}
		sort.Strings(lanes)
		fmt.Printf("%s rehearsal: %d pass, %d fail, %d pending (%s)\n", r.check, r.counts["pass"], r.counts["fail"], r.counts["pending"], strings.Join(lanes, ", "))
		if r.coder.url != "" {
			fmt.Println("scripted coding model turns:", r.coder.turns())
		}
		fmt.Println("rehearsal evidence:", r.evidence)
	})
	return r
}

// request sends one request as the owner's browser, with an Idempotency-Key
// derived from the path.
func (r *rehearsal) request(method, path, body string) (int, []byte, error) {
	return r.keyed(method, path, body, r.keyPrefix+strings.Trim(strings.ReplaceAll(path, "/", "-"), "-"))
}

// keyed sends one request as the owner's browser with this Idempotency-Key.
func (r *rehearsal) keyed(method, path, body, key string) (int, []byte, error) {
	return r.keyedAs(r.jar, method, path, body, key)
}

// keyedAs sends one request as the browser that holds jar (another member's).
func (r *rehearsal) keyedAs(jar http.CookieJar, method, path, body, key string) (int, []byte, error) {
	req, err := http.NewRequest(method, r.origin+path, strings.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", r.origin)
	req.Header.Set("Idempotency-Key", key)
	for _, cookie := range jar.Cookies(req.URL) {
		if cookie.Name == "__csrf" {
			req.Header.Set("X-CSRF-Token", cookie.Value)
		}
	}
	client := &http.Client{Jar: jar, Timeout: r.client.Timeout, CheckRedirect: r.client.CheckRedirect}
	resp, err := client.Do(req)
	if err != nil {
		r.actual = err.Error()
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	r.location = resp.Header.Get("Location")
	// Evidence never keeps a minted credential.
	logged := rehearsalTokenField.ReplaceAll(data, []byte(`"token":"<redacted>"`))
	r.log("%s %s → %d %s\n", method, strings.Split(path, "?")[0], resp.StatusCode, logged)
	excerpt := string(logged)
	if path == "/api/install" {
		var projection struct {
			Steps json.RawMessage `json:"steps"`
		}
		if json.Unmarshal(data, &projection) == nil {
			excerpt = `{"steps":` + string(projection.Steps) + `}`
		}
	}
	r.actual = fmt.Sprintf("%d %s", resp.StatusCode, excerpt)
	return resp.StatusCode, data, err
}

// log appends one exchange to the evidence's HTTP log.
func (r *rehearsal) log(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fmt.Fprintf(&r.exchanges, format, args...)
}

// expect is request, failing unless the route answers status.
func (r *rehearsal) expect(method, path, body string, status int) ([]byte, error) {
	return r.expectAs(r.jar, method, path, body, status)
}

// expectAs is expect from the browser that holds jar.
func (r *rehearsal) expectAs(jar http.CookieJar, method, path, body string, status int) ([]byte, error) {
	code, data, err := r.keyedAs(jar, method, path, body, r.keyPrefix+strings.Trim(strings.ReplaceAll(path, "/", "-"), "-"))
	if err != nil {
		return data, err
	}
	if code != status {
		return data, fmt.Errorf("expected HTTP %d: %s", status, r.actual)
	}
	return data, nil
}

// waitStep waits for one setup step to finish in its background worker;
// Source waits out the durable importer's clone of main.
func (r *rehearsal) waitStep(id string) error {
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		data, err := r.expect("GET", "/api/install", "", 200)
		if err != nil {
			return err
		}
		var v struct {
			Steps []struct {
				ID    string          `json:"id"`
				State string          `json:"state"`
				Error json.RawMessage `json:"error"`
			}
		}
		if err = json.Unmarshal(data, &v); err != nil {
			return err
		}
		for _, s := range v.Steps {
			if s.ID == id {
				if s.State == "done" {
					return nil
				}
				if s.State == "failed" || s.State == "blocked" {
					return fmt.Errorf("%s: %s %s", id, s.State, s.Error)
				}
			}
		}
		time.Sleep(40 * time.Millisecond)
	}
	reason := r.actual
	if id == "source" {
		for _, line := range strings.Split(r.logs.String(), "\n") {
			var entry map[string]any
			if json.Unmarshal([]byte(line), &entry) == nil && entry["message"] == "mirror.import.reconcile_failed" {
				reason = fmt.Sprint(entry["error"])
			}
		}
	}
	return fmt.Errorf("%s did not complete: %s", id, reason)
}

// step runs one row as a subtest and records it; false stops the walk
// unless J1_REHEARSAL_CONTINUE=1.
func (r *rehearsal) step(name, route, expected, ticket string, run func() error) bool {
	r.actual = ""
	ok := r.t.Run(name, func(t *testing.T) {
		if err := run(); err != nil {
			r.actual = err.Error() + "; " + r.actual
			t.Error(err)
		}
	})
	result := "pass"
	if !ok {
		result = "fail"
	}
	excerpt := strings.Join(strings.Fields(r.actual), " ")
	if len(excerpt) > 220 {
		excerpt = excerpt[:220]
	}
	if r.quiet {
		if !ok {
			r.quietFailed = append(r.quietFailed, name+": "+excerpt)
		}
	} else {
		r.counts[result]++
		r.table += strings.Join([]string{name, route, expected, excerpt, result, ticket}, "\t") + "\n"
	}
	return ok || r.continuing
}

// pending lists a row that waits on lane: a subtest that names the lane and
// a table row whose result is pending, counted in the summary. It is never
// skipped silently; the lane replaces it with a step when it lands.
func (r *rehearsal) pending(name, route, expected, ticket, lane string) {
	r.t.Run(name, func(t *testing.T) {
		t.Skipf("pending: waits on lane %s", lane)
	})
	r.counts["pending"]++
	r.waiting[lane] = append(r.waiting[lane], name)
	r.table += strings.Join([]string{name, route, expected, "pending: waits on lane " + lane, "pending", ticket}, "\t") + "\n"
}

// install walks J1's setup rows, from the printed link through Machine
// ready, as one row: name, failing with each setup row that failed.
func (r *rehearsal) install(name string) bool {
	r.quiet = true
	ready := r.setupSource() && r.setupMachine()
	r.quiet = false
	return r.step(name, "J1 setup rows: setup URL token … 6 machine ready", "every J1 setup row passes; stack active", "T-INS-06", func() error {
		if len(r.quietFailed) > 0 {
			return errors.New(strings.Join(r.quietFailed, "; "))
		}
		return r.waitStackActive()
	}) && ready
}

// setupSource walks setup from the printed link through Source ready.
func (r *rehearsal) setupSource() bool {
	t := r.t
	var mint struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal([]byte(r.stdout.String()), &mint))
	require.NotEmpty(t, mint.URLs)
	setupURL, err := url.Parse(mint.URLs[0])
	require.NoError(t, err)
	if !r.step("setup URL token", "GET /setup?token=<printed>", "303; token removed; setup cookie", "T-INS-08, T-ACC-01", func() error {
		_, err := r.expect("GET", setupURL.RequestURI(), "", 303)
		if err != nil {
			return err
		}
		if r.location != "/" {
			return fmt.Errorf("redirect %q", r.location)
		}
		for _, cookie := range r.jar.Cookies(mustRehearsalURL(r.origin)) {
			if cookie.Name == "smithers_setup_session" {
				return nil
			}
		}
		return fmt.Errorf("setup cookie missing")
	}) {
		return false
	}
	if !r.step("setup session", "GET /api/install", "200; seven ordered pending steps", "T-INS-06", func() error {
		data, err := r.expect("GET", "/api/install", "", 200)
		if err != nil {
			return err
		}
		var v struct{ Steps []struct{ ID, State string } }
		if err = json.Unmarshal(data, &v); err != nil {
			return err
		}
		ids := []string{"address", "app_manifest", "sign_in", "repository", "models", "source", "machine"}
		if len(v.Steps) != len(ids) {
			return fmt.Errorf("expected seven steps")
		}
		for i, s := range v.Steps {
			if s.ID != ids[i] || s.State != "pending" {
				return fmt.Errorf("step %d: %+v", i, s)
			}
		}
		return nil
	}) {
		return false
	}
	if !r.step("1 Address", "POST /api/install/setup/address → GET /api/install", "202 → address done", "T-INS-06", func() error {
		body, _ := json.Marshal(map[string]any{"bind": "127.0.0.1:4000", "origins": []string{r.origin}})
		if _, err := r.expect("POST", "/api/install/setup/address", string(body), 202); err != nil {
			return err
		}
		return r.waitStep("address")
	}) {
		return false
	}
	if !r.step("2 GitHub App", "POST /api/install/setup/app → GET /setup/github/callback", "200 manifest out; 303 conversion back; app_manifest done", "T-GH-01", func() error {
		data, err := r.expect("POST", "/api/install/setup/app", `{"owner":"rehearsal-owner"}`, 200)
		if err != nil {
			return err
		}
		var v struct {
			State    string          `json:"state"`
			Action   string          `json:"action_url"`
			Manifest json.RawMessage `json:"manifest"`
		}
		if err = json.Unmarshal(data, &v); err != nil {
			return err
		}
		if v.State == "" || v.Action == "" || len(v.Manifest) == 0 {
			return fmt.Errorf("manifest handoff missing")
		}
		if _, err = r.expect("GET", "/setup/github/callback?code=manifest-code&state="+url.QueryEscape(v.State), "", 303); err != nil {
			return err
		}
		return r.waitStep("app_manifest")
	}) {
		return false
	}
	if !r.step("3 Owner sign-in", "GET /api/auth/github → GET /api/auth/github/callback", "302 → 302; sign_in done; browser session", "T-ACC-01", func() error {
		if _, err := r.expect("GET", "/api/auth/github", "", 302); err != nil {
			return err
		}
		u, err := url.Parse(r.location)
		if err != nil {
			return err
		}
		if _, err = r.expect("GET", "/api/auth/github/callback?code=owner-code&state="+url.QueryEscape(u.Query().Get("state")), "", 302); err != nil {
			return err
		}
		return r.waitStep("sign_in")
	}) {
		return false
	}
	if !r.step("4 Repository", "POST /api/install/setup/repository → GET /api/install", "202 → repository done; owner verified; squash enabled; a default other than main blocked", "T-INS-06, T-ACC-01", func() error {
		// A repository whose GitHub default branch is not main is blocked
		// with its fix before anything is imported (spec §16.2).
		if _, err := r.expect("POST", "/api/install/setup/repository?attempt=trunk", `{"repository":"rehearsal-owner/trunk-app"}`, 202); err != nil {
			return err
		}
		if err := r.waitStep("repository"); err == nil || !strings.Contains(err.Error(), "blocked") {
			return fmt.Errorf("a trunk default was not blocked: %v", err)
		}
		data, err := r.expect("GET", "/api/install", "", 200)
		if err != nil {
			return err
		}
		if !strings.Contains(string(data), "Rename the default branch to main on GitHub") || !strings.Contains(string(data), "https://github.com/rehearsal-owner/trunk-app/settings") {
			return fmt.Errorf("blocked step names no fix: %s", data)
		}
		if _, err := r.expect("POST", "/api/install/setup/repository", `{"repository":"rehearsal-owner/app"}`, 202); err != nil {
			return err
		}
		return r.waitStep("repository")
	}) {
		return false
	}
	if !r.step("5 Model access", "POST /api/model/credential; PUT /api/model/default; POST /api/install/setup/models", "sealed coding/Gateway keys; models done", "T-INS-06", func() error {
		for _, c := range []struct{ Name, Origin string }{{"TEST_PROVIDER", r.provider.URL}, {"AI_GATEWAY_API_KEY", "https://ai-gateway.vercel.sh"}} {
			body, _ := json.Marshal(map[string]string{"action": "enroll", "requestId": uuid.NewString(), "name": c.Name, "origin": c.Origin, "value": "rehearsal-key"})
			data, err := r.expect("POST", "/api/model/credential", string(body), 200)
			if err != nil {
				return err
			}
			if !strings.Contains(string(data), `"ok":true`) {
				return fmt.Errorf("credential refused: %s", data)
			}
		}
		body, _ := json.Marshal(map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": "TEST_PROVIDER", "baseUrl": r.provider.URL}})
		if _, err := r.expect("PUT", "/api/model/default", string(body), 200); err != nil {
			return err
		}
		if _, err := r.expect("POST", "/api/install/setup/models", `{}`, 202); err != nil {
			return err
		}
		return r.waitStep("models")
	}) {
		return false
	}
	return r.step("6 source ready", "POST /api/install/setup/source → GET /api/install", "202 → source done (separate readiness)", "T-INS-06, T-MCH-10", func() error {
		if _, err := r.expect("POST", "/api/install/setup/source", `{}`, 202); err != nil {
			return err
		}
		err := r.waitStep("source")
		r.sourceReady = err == nil
		if err != nil {
			return err
		}
		return r.refuseMainAtDoors()
	})
}

// refuseMainAtDoors checks that the composed doors read the engine's
// install fact: the owner's bookmark write and Git push of main are
// refused, so only the GitHub sync moves the mirror's main.
func (r *rehearsal) refuseMainAtDoors() error {
	data, err := r.expect("POST", "/api/repos/rehearsal-owner/app/bookmarks", `{"name":"main","target_change_id":"main"}`, 403)
	if err != nil {
		return err
	}
	if !strings.Contains(string(data), `"permission"`) {
		return fmt.Errorf("bookmark door answered no permission refusal: %s", data)
	}
	data, err = r.expect("POST", "/api/user/tokens", `{"name":"`+r.keyPrefix+`main-door","scopes":["write:repository"]}`, 201)
	if err != nil {
		return err
	}
	var created struct {
		Token string `json:"token"`
	}
	if err = json.Unmarshal(data, &created); err != nil || created.Token == "" {
		return fmt.Errorf("token create answered no token: %v", err)
	}
	work := filepath.Join(r.t.TempDir(), "door")
	run := func(args ...string) (string, error) {
		cmd := exec.Command("/usr/bin/git", append([]string{"-c", "http.extraHeader=Authorization: Bearer " + created.Token, "-c", "user.name=Owner", "-c", "user.email=owner@example.test"}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	if out, err := run("clone", "-q", r.origin+"/rehearsal-owner/app.git", work); err != nil {
		return fmt.Errorf("clone through the Git door: %v: %s", err, out)
	}
	if err = os.WriteFile(filepath.Join(work, "door.txt"), []byte("owner push\n"), 0600); err != nil {
		return err
	}
	if out, err := run("-C", work, "add", "door.txt"); err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	if out, err := run("-C", work, "commit", "-q", "-m", "owner push"); err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	if out, err := run("-C", work, "push", "-q", "origin", "HEAD:refs/heads/main"); err == nil || !strings.Contains(out, "403") {
		return fmt.Errorf("the Git door let the owner push main: %v: %s", err, out)
	}
	return nil
}

// setupMachine walks Machine ready. The TODO's coding run then reaches the
// scripted model through the metered platform-key proxy, which charges the
// owner's credit; the deployment grants none at signup, so the owner gets a
// grant, as an operator's would.
func (r *rehearsal) setupMachine() bool {
	if !r.step("6 machine ready", "POST /api/install/setup/machine → GET /api/install", "202 → machine done (separate readiness)", "T-INS-06, T-MCH-10", func() error {
		if _, err := r.expect("POST", "/api/install/setup/machine", `{}`, 202); err != nil {
			return err
		}
		return r.waitStep("machine")
	}) {
		return false
	}
	if r.coder.url != "" {
		ledger := credits.Ledger{DB: r.pool}
		var owner int64
		require.NoError(r.t, r.pool.QueryRow(r.ctx, `SELECT id FROM users WHERE lower_username = 'rehearsal-owner'`).Scan(&owner))
		account, err := ledger.EnsureAccount(r.ctx, "user", owner)
		require.NoError(r.t, err)
		require.NoError(r.t, ledger.Grant(r.ctx, account, r.keyPrefix+"rehearsal", 100_000_000_000, nil))
	}
	return true
}

// waitStackActive waits for the stack Source ready asked for (§8.6.3): the
// stack worker activates it, and a TODO is accepted only then.
func (r *rehearsal) waitStackActive() error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		data, err := r.expect("GET", "/api/repos/rehearsal-owner/app/mythical", "", 200)
		if err != nil {
			return err
		}
		var stack struct {
			State     string `json:"state"`
			Reason    string `json:"reason"`
			LastError string `json:"lastError"`
		}
		if err = json.Unmarshal(data, &stack); err != nil {
			return err
		}
		if stack.State == "active" {
			return nil
		}
		if stack.State == "frozen" || !time.Now().Before(deadline) {
			return fmt.Errorf("stack not active: state=%s reason=%q last_error=%q", stack.State, stack.Reason, stack.LastError)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// rehearsalTodoWaits are how long each TODO state may take to arrive: each
// lasts as long as the work behind it. Starting lasts until the lane's coding
// host accepts the run, Working for the scripted coding/request, In review
// once coding/vibe delivered and the PR opened. The stack takes its own
// steps to In review at once, so a TODO left for the stale sweep (5 to 10
// minutes) fails. Needs you lasts until planning asks its question.
var rehearsalTodoWaits = map[string]time.Duration{"queued": 3 * time.Second, "starting": 2 * time.Minute, "working": 3 * time.Minute, "needs_you": 2 * time.Minute, "in_review": 2 * time.Minute}

// rehearsalTodo is what the TODO rows read of GET /api/todos/{n}.
type rehearsalTodo struct {
	N      int64  `json:"n"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Place  int64  `json:"place"`
	Branch *struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Machine struct {
			State string `json:"state"`
		} `json:"machine"`
	} `json:"branch"`
	Run *struct {
		ID      string `json:"id"`
		Attempt int    `json:"attempt"`
	} `json:"run"`
	PR struct {
		Number int64  `json:"number"`
		Head   string `json:"head"`
		Draft  bool   `json:"draft"`
	} `json:"pr"`
	Merge struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	} `json:"merge"`
	Waits []struct {
		ID      string `json:"id"`
		Kind    string `json:"kind"`
		Prompt  string `json:"prompt"`
		Actions []struct {
			Tag string `json:"tag"`
		} `json:"actions"`
	} `json:"waits"`
	Issue *struct {
		Number int64  `json:"number"`
		URL    string `json:"url"`
		Fixes  bool   `json:"fixes"`
	} `json:"issue"`
	// Evidence is each attempt's: its checks, its review and its flow.
	Evidence []struct {
		Attempt int32            `json:"attempt"`
		Items   []map[string]any `json:"items"`
	} `json:"evidence"`
}

// waitTodo polls TODO n until it is in state, within rehearsalTodoWaits.
func (r *rehearsal) waitTodo(number int64, state string) (rehearsalTodo, error) {
	within := rehearsalTodoWaits[state]
	if os.Getenv("TODO_RELAY_URL") != "" {
		// A real model behind the scripted provider's relay takes minutes a step.
		within *= 10
	}
	return r.waitTodoWithin(number, within, state)
}

// waitTodoWithin polls TODO n until it is in one of states. The stack's own
// record says why it did not move: an attempt that failed or stopped does
// not reach the state in this run, unless the state waited for is failed.
func (r *rehearsal) waitTodoWithin(number int64, within time.Duration, states ...string) (rehearsalTodo, error) {
	if number <= 0 {
		return rehearsalTodo{}, fmt.Errorf("blocked by First TODO: no TODO number from public creation receipt")
	}
	path := fmt.Sprintf("/api/todos/%d", number)
	state := strings.Join(states, " or ")
	began := time.Now()
	deadline := began.Add(within)
	for {
		data, err := r.expect("GET", path, "", 200)
		if err != nil {
			return rehearsalTodo{}, err
		}
		var v rehearsalTodo
		if err = json.Unmarshal(data, &v); err != nil {
			return v, err
		}
		if slices.Contains(states, v.State) {
			return v, nil
		}
		var itemState, reason string
		_ = r.pool.QueryRow(r.ctx, `SELECT state, reason FROM mythical_items WHERE number=$1`, number).Scan(&itemState, &reason)
		settled := !slices.Contains(states, "failed") && (itemState == "retrying" || itemState == "failed" || itemState == "stopped" || itemState == "blocked")
		if settled || time.Now().After(deadline) {
			return v, fmt.Errorf("state %q, expected %q (item %s: %q)", v.State, state, itemState, reason)
		}
		// Fast while a short state may pass, then within the API's rate
		// limit for a wait that lasts minutes.
		if time.Since(began) < 5*time.Second {
			time.Sleep(40 * time.Millisecond)
		} else {
			time.Sleep(500 * time.Millisecond)
		}
	}
}

// readFakePull reads pull request number as the install's App reads it.
func (r *rehearsal) readFakePull(number int64) (githubfake.Pull, error) {
	codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
	if err != nil {
		return githubfake.Pull{}, err
	}
	credentials := services.NewGitHubAppCredentialStore(r.pool, codec)
	tokens := services.NewRepoConnectionService(r.pool, credentials)
	access, err := tokens.CreateGitHubInstallationToken(r.ctx, 91, services.GitHubTokenScope{AllRepositories: true, Permissions: map[string]string{"pull_requests": "read"}})
	if err != nil {
		return githubfake.Pull{}, err
	}
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/repos/rehearsal-owner/app/pulls/%d", r.fake.URL, number), nil)
	if err != nil {
		return githubfake.Pull{}, err
	}
	req.Header.Set("Authorization", "Bearer "+access.Token)
	resp, err := r.fake.Client().Do(req)
	if err != nil {
		return githubfake.Pull{}, err
	}
	defer resp.Body.Close()
	var p githubfake.Pull
	if err = json.NewDecoder(resp.Body).Decode(&p); err != nil {
		return githubfake.Pull{}, err
	}
	if resp.StatusCode != 200 {
		return githubfake.Pull{}, fmt.Errorf("fake PR HTTP %d", resp.StatusCode)
	}
	return p, nil
}

// checkPull checks the TODO's pull request on GitHub: its smithers/ branch
// at the TODO's reviewed head, based on main.
func (r *rehearsal) checkPull(number int64, head string) (githubfake.Pull, error) {
	if number <= 0 {
		return githubfake.Pull{}, fmt.Errorf("no PR number from TODO")
	}
	p, err := r.readFakePull(number)
	if err != nil {
		return p, err
	}
	r.actual = fmt.Sprintf("200 head=%s sha=%s base=%s", p.Head.Ref, p.Head.SHA, p.Base.Ref)
	if !strings.HasPrefix(p.Head.Ref, "smithers/") || p.Base.Ref != "main" || p.Head.SHA != head {
		return p, fmt.Errorf("PR contract mismatch")
	}
	return p, nil
}

// merge is the owner's Merge of TODO n at the reviewed head, from the
// browser session: the route records one session-bound checks.Land.
func (r *rehearsal) merge(number int64, head string) error {
	return r.mergeAs(r.jar, number, head)
}

// mergeAs is Merge from the browser that holds jar (a maintainer's).
func (r *rehearsal) mergeAs(jar http.CookieJar, number int64, head string) error {
	if number <= 0 || head == "" {
		return fmt.Errorf("blocked by First TODO/PR: no reviewed head from public routes")
	}
	body, _ := json.Marshal(map[string]string{"reviewed_head_sha": head})
	if _, err := r.expectAs(jar, "POST", fmt.Sprintf("/api/todos/%d/merge", number), string(body), 202); err != nil {
		return err
	}
	session := ""
	for _, cookie := range jar.Cookies(mustRehearsalURL(r.origin)) {
		if cookie.Name == "smithers_session" {
			digest := sha256.Sum256([]byte(cookie.Value))
			session = hex.EncodeToString(digest[:])
		}
	}
	if session == "" {
		return fmt.Errorf("browser session credential absent")
	}
	var count int
	err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE number=$1 AND checks->'land'->>'head'=$2 AND checks->'land'->>'session'=$3`, number, head, session).Scan(&count)
	if err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("expected one session-bound checks.Land, got %d", count)
	}
	return nil
}

// waitMerged waits for TODO n to turn merged, which it may only after
// GitHub's head-bound squash merge of its pull request, and then for the
// install's main to follow GitHub's squash commit with the GitHub sync fresh.
func (r *rehearsal) waitMerged(number, pull int64, head string) error {
	if number <= 0 {
		return fmt.Errorf("blocked by First TODO: no TODO number from public creation receipt")
	}
	// The merge worker polls every 3 s, and GitHub's main is the fake's
	// real squash commit, which only the GitHub sync brings into the
	// install's main (the merge asks it to read at once; its poll is
	// 30 s) for the stack to fold. 60 s spans both.
	deadline := time.Now().Add(60 * time.Second)
	merged, squash := false, ""
	for {
		if !merged {
			data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
			if err != nil {
				return err
			}
			var v struct {
				State string `json:"state"`
			}
			if err = json.Unmarshal(data, &v); err != nil {
				return err
			}
			if v.State == "merged" {
				p, err := r.readFakePull(pull)
				if err != nil {
					return err
				}
				if !p.Merged || p.MergedAt == nil || len(p.MergeCommitSHA) != 40 {
					return fmt.Errorf("TODO merged before GitHub reported a merge")
				}
				receipt := false
				for _, write := range r.fake.Writes() {
					if write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge") && write.Status == 200 {
						var input struct {
							SHA    string `json:"sha"`
							Method string `json:"merge_method"`
						}
						if json.Unmarshal(write.Body, &input) == nil && input.Method == "squash" && input.SHA == head {
							receipt = true
						}
					}
				}
				if !receipt {
					return fmt.Errorf("no successful head-bound squash GitHub receipt")
				}
				githubMain, err := exec.Command("/usr/bin/git", "--git-dir", filepath.Join(r.gitRoot, "rehearsal-owner/app.git"), "rev-parse", "refs/heads/main").Output()
				if err != nil {
					return err
				}
				if strings.TrimSpace(string(githubMain)) != p.MergeCommitSHA {
					return fmt.Errorf("GitHub's main %s is not the squash commit %s", strings.TrimSpace(string(githubMain)), p.MergeCommitSHA)
				}
				squash, merged = p.MergeCommitSHA, true
			} else if time.Now().After(deadline) {
				return fmt.Errorf("TODO state %q, expected merged", v.State)
			}
		}
		if merged {
			data, err := r.expect("GET", "/api/repos/rehearsal-owner/app/mythical", "", 200)
			if err != nil {
				return err
			}
			var stack struct {
				LandedMain string `json:"landedMain"`
				MainBehind bool   `json:"mainBehind"`
			}
			if err = json.Unmarshal(data, &stack); err != nil {
				return err
			}
			if stack.LandedMain == squash && !stack.MainBehind {
				data, err = r.expect("GET", "/api/github/sync", "", 200)
				if err != nil {
					return err
				}
				var health struct {
					State         string     `json:"state"`
					LastSuccessAt *time.Time `json:"last_success_at"`
				}
				if err = json.Unmarshal(data, &health); err != nil {
					return err
				}
				if health.State != "fresh" || health.LastSuccessAt == nil {
					return fmt.Errorf("GitHub sync %q after the follow", health.State)
				}
				r.actual = fmt.Sprintf("200 merged; install main %s = GitHub's squash commit; sync fresh", squash)
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("the install's main did not follow GitHub's squash commit %s: stack folded %s (behind=%t)", squash, stack.LandedMain, stack.MainBehind)
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// rehearsalTurnFrame is what the agent rows read of a turn's frames.
type rehearsalTurnFrame struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Text    string `json:"text"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Card    struct {
		ID       string  `json:"id"`
		Kind     string  `json:"kind"`
		Audience *string `json:"audience_member_id"`
		Payload  struct {
			Name    string `json:"name"`
			Context string `json:"context"`
			Path    string `json:"path"`
			Content string `json:"content"`
			ReadAt  struct {
				CommitID string `json:"commitId"`
			} `json:"readAt"`
			N       int64  `json:"n"`
			Prompt  string `json:"prompt"`
			Private bool   `json:"private"`
			Model   *struct {
				Title string `json:"title"`
				State string `json:"state"`
			} `json:"model"`
		} `json:"payload"`
	} `json:"card"`
}

// ask posts one question from the composer's wire, with no tools of its own,
// so the host runs the turn's reads. A bearer token asks as that token
// instead of the owner's browser session.
func (r *rehearsal) ask(bearer, question string) (string, []rehearsalTurnFrame, bool, error) {
	body, _ := json.Marshal(map[string]any{"runId": r.keyPrefix + uuid.NewString(), "journal": map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("a", 48)}, "instructions": "Answer briefly using file cards.", "messages": []any{map[string]string{"role": "user", "content": question}}})
	var data []byte
	var err error
	if bearer == "" {
		data, err = r.expect("POST", chat.TurnPath, string(body), 200)
	} else {
		req, reqErr := http.NewRequest("POST", r.origin+chat.TurnPath, bytes.NewReader(body))
		if reqErr != nil {
			return "", nil, false, reqErr
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+bearer)
		resp, doErr := (&http.Client{Timeout: 30 * time.Second}).Do(req)
		if doErr != nil {
			return "", nil, false, doErr
		}
		data, err = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		r.log("POST %s (bearer) → %d %s\n", chat.TurnPath, resp.StatusCode, data)
		if err == nil && resp.StatusCode != 200 {
			err = fmt.Errorf("bearer turn: HTTP %d %s", resp.StatusCode, data)
		}
	}
	if err != nil {
		return "", nil, false, err
	}
	var answer strings.Builder
	var frames []rehearsalTurnFrame
	terminal := false
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		var delivery chat.Delivery
		if err = json.Unmarshal(scanner.Bytes(), &delivery); err != nil {
			return "", nil, false, err
		}
		if delivery.Terminal != nil {
			terminal = *delivery.Terminal
		}
		if delivery.Batch == nil {
			continue
		}
		for _, raw := range delivery.Batch.Frames {
			var frame rehearsalTurnFrame
			if err = json.Unmarshal(raw, &frame); err != nil {
				return "", nil, false, err
			}
			if frame.Type == "delta" && frame.Kind == "text" {
				answer.WriteString(frame.Text)
			}
			frames = append(frames, frame)
		}
	}
	return answer.String(), frames, terminal, scanner.Err()
}

// token mints a personal access token through the production route.
func (r *rehearsal) token(scopes ...string) (string, error) {
	body, _ := json.Marshal(map[string]any{"name": r.keyPrefix + strings.Join(scopes, "-") + "-" + uuid.NewString()[:8], "scopes": scopes})
	data, err := r.expect("POST", "/api/user/tokens", string(body), 201)
	if err != nil {
		return "", err
	}
	var created struct {
		Token string `json:"token"`
	}
	if err = json.Unmarshal(data, &created); err != nil || created.Token == "" {
		return "", fmt.Errorf("token create answered no token: %v", err)
	}
	return created.Token, nil
}

// file files one TODO appended to the stack as the owner's Draft commits it
// and answers its number. Each TODO is its own request: its Idempotency-Key
// names its title.
func (r *rehearsal) file(title, prompt string, context ...string) (int64, error) {
	value := map[string]any{"title": title, "prompt": prompt, "place": map[string]string{"mode": "append"}}
	if len(context) > 0 {
		value["context"] = context[0]
	}
	body, _ := json.Marshal(value)
	code, data, err := r.keyed("POST", "/api/todos", string(body), r.keyPrefix+"todo-"+strings.ReplaceAll(strings.ToLower(title), " ", "-"))
	if err != nil {
		return 0, err
	}
	if code != 202 {
		return 0, fmt.Errorf("expected HTTP 202: %s", r.actual)
	}
	var v struct {
		N     int64  `json:"n"`
		State string `json:"state"`
	}
	if err = json.Unmarshal(data, &v); err != nil {
		return 0, err
	}
	if v.N <= 0 || v.State != "accepted" {
		return 0, fmt.Errorf("invalid TODO receipt: %s", data)
	}
	return v.N, nil
}

// todoList reads GET /api/todos, the Home card's rows, in its order.
func (r *rehearsal) todoList() ([]rehearsalTodo, error) {
	data, err := r.expect("GET", "/api/todos", "", 200)
	if err != nil {
		return nil, err
	}
	var list []rehearsalTodo
	return list, json.Unmarshal(data, &list)
}

// todo reads TODO n's card.
func (r *rehearsal) todo(number int64) (rehearsalTodo, error) {
	var v rehearsalTodo
	data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	if err == nil {
		err = json.Unmarshal(data, &v)
	}
	return v, err
}

// answer answers TODO n's open wait as the owner's browser session.
func (r *rehearsal) answer(number int64, wait, text string) (int, []byte, error) {
	body, _ := json.Marshal(map[string]string{"wait": wait, "answer": text})
	return r.request("POST", fmt.Sprintf("/api/todos/%d/answer", number), string(body))
}

// release answers every coding turn held on the [HOLD key] marker.
func (r *rehearsal) release(key string) error {
	resp, err := http.Post(r.coder.url+"/release/"+key, "application/json", nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("release %s: HTTP %d", key, resp.StatusCode)
	}
	return nil
}

// waitHeld waits until a coding turn is held on the [HOLD key] marker: its
// TODO is Working, at its edit.
func (r *rehearsal) waitHeld(key string, within time.Duration) error {
	for deadline := time.Now().Add(within); ; time.Sleep(250 * time.Millisecond) {
		resp, err := http.Get(r.coder.url + "/held")
		if err != nil {
			return err
		}
		var keys []string
		err = json.NewDecoder(resp.Body).Decode(&keys)
		resp.Body.Close()
		if err != nil || slices.Contains(keys, key) {
			return err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no coding turn held on [HOLD %s] after %s (held: %v)", key, within, keys)
		}
	}
}

// member adds login to the roster with permission on GitHub and signs them
// in with GitHub in a browser of their own (J1 step 8).
func (r *rehearsal) member(login string, id int64, permission string) (http.CookieJar, error) {
	r.fake.SetCollaborator(id, login, permission)
	if _, err := r.expect("POST", "/api/members", `{"login":"`+login+`"}`, 204); err != nil {
		return nil, err
	}
	browser, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	if _, err := r.expectAs(browser, "GET", "/api/auth/github", "", 302); err != nil {
		return nil, err
	}
	start, err := url.Parse(r.location)
	if err != nil {
		return nil, err
	}
	code := login + "-code"
	r.fake.SignInAs(code, id)
	if _, err = r.expectAs(browser, "GET", "/api/auth/github/callback?code="+code+"&state="+url.QueryEscape(start.Query().Get("state")), "", 302); err != nil {
		return nil, err
	}
	return browser, nil
}

// pushGitHubMain commits files onto GitHub's main, as a merge on GitHub
// would, asks the install's sync to read now, and waits until the stack has
// folded that commit as the install's main. It answers the commit.
func (r *rehearsal) pushGitHubMain(message string, files map[string]string) (string, error) {
	work := r.t.TempDir()
	run := func(args ...string) (string, error) {
		cmd := exec.Command("/usr/bin/git", args...)
		cmd.Dir = work
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Ben", "GIT_AUTHOR_EMAIL=ben@example.test", "GIT_COMMITTER_NAME=GitHub", "GIT_COMMITTER_EMAIL=noreply@github.test")
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out)), nil
	}
	if _, err := run("clone", "-q", "--branch", "main", filepath.Join(r.gitRoot, "rehearsal-owner/app.git"), "."); err != nil {
		return "", err
	}
	for path, content := range files {
		if err := os.MkdirAll(filepath.Join(work, filepath.Dir(path)), 0700); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(work, path), []byte(content), 0600); err != nil {
			return "", err
		}
	}
	if _, err := run("add", "-A"); err != nil {
		return "", err
	}
	if _, err := run("commit", "-q", "-m", message); err != nil {
		return "", err
	}
	if _, err := run("push", "-q", "origin", "HEAD:refs/heads/main"); err != nil {
		return "", err
	}
	commit, err := run("rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if code, _, err := r.keyed("POST", "/api/github/sync", "", r.keyPrefix+"sync-"+commit[:12]); err != nil || code != 202 {
		return commit, fmt.Errorf("the sync was not asked to read GitHub's main: %d %v %s", code, err, r.actual)
	}
	for deadline := time.Now().Add(90 * time.Second); ; time.Sleep(250 * time.Millisecond) {
		data, err := r.expect("GET", "/api/repos/rehearsal-owner/app/mythical", "", 200)
		if err != nil {
			return commit, err
		}
		var stack struct {
			LandedMain string `json:"landedMain"`
		}
		if err = json.Unmarshal(data, &stack); err != nil {
			return commit, err
		}
		if stack.LandedMain == commit {
			return commit, nil
		}
		if time.Now().After(deadline) {
			return commit, fmt.Errorf("the install's main did not follow GitHub's %s: stack folded %s", commit, stack.LandedMain)
		}
	}
}

// githubGit runs git on the GitHub fake's copy of the repository.
func (r *rehearsal) githubGit(args ...string) (string, error) {
	out, err := exec.Command("/usr/bin/git", append([]string{"--git-dir", filepath.Join(r.gitRoot, "rehearsal-owner/app.git")}, args...)...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out)), nil
}

// prFiles are the paths a pull request's head changes against its base on
// GitHub.
func (r *rehearsal) prFiles(p githubfake.Pull) ([]string, error) {
	base, err := r.githubGit("merge-base", "refs/heads/"+p.Base.Ref, p.Head.SHA)
	if err != nil {
		return nil, err
	}
	out, err := r.githubGit("diff", "--name-only", base, p.Head.SHA)
	return strings.Fields(out), err
}

// besideChat asks the app agent what JOURNEY.md holds, as the owner's
// browser session, beside a row's own requests: it records its exchange but
// never the row's actual. The channel answers the turn's outcome: the File
// card with main's bytes, quoted in a finished answer.
func (r *rehearsal) besideChat() <-chan error {
	settled := make(chan error, 1)
	body, _ := json.Marshal(map[string]any{"runId": r.keyPrefix + uuid.NewString(), "journal": map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("a", 48)}, "instructions": "Answer briefly using file cards.", "messages": []any{map[string]string{"role": "user", "content": "What is in JOURNEY.md? Show the file."}}})
	req, err := http.NewRequest("POST", r.origin+chat.TurnPath, bytes.NewReader(body))
	if err != nil {
		settled <- err
		return settled
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", r.origin)
	req.Header.Set("Idempotency-Key", r.keyPrefix+"beside-"+uuid.NewString())
	for _, cookie := range r.jar.Cookies(req.URL) {
		if cookie.Name == "__csrf" {
			req.Header.Set("X-CSRF-Token", cookie.Value)
		}
	}
	go func() {
		settled <- func() error {
			resp, err := (&http.Client{Jar: r.jar, Timeout: time.Minute}).Do(req)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			r.log("POST %s (beside) → %d %s\n", chat.TurnPath, resp.StatusCode, data)
			if err != nil || resp.StatusCode != 200 {
				return fmt.Errorf("turn: HTTP %d: %v", resp.StatusCode, err)
			}
			var answer strings.Builder
			card, terminal := false, false
			scanner := bufio.NewScanner(bytes.NewReader(data))
			scanner.Buffer(make([]byte, 4096), 1<<20)
			for scanner.Scan() {
				var delivery chat.Delivery
				if err = json.Unmarshal(scanner.Bytes(), &delivery); err != nil {
					return err
				}
				if delivery.Terminal != nil {
					terminal = *delivery.Terminal
				}
				if delivery.Batch == nil {
					continue
				}
				for _, raw := range delivery.Batch.Frames {
					var frame rehearsalTurnFrame
					if err = json.Unmarshal(raw, &frame); err != nil {
						return err
					}
					if frame.Type == "delta" && frame.Kind == "text" {
						answer.WriteString(frame.Text)
					}
					card = card || frame.Type == "card" && frame.Card.Kind == "file" && frame.Card.Payload.Path == "JOURNEY.md" && strings.Contains(frame.Card.Payload.Content, "Add a greeting to JOURNEY.md")
				}
			}
			if !terminal || !card || !strings.Contains(answer.String(), "Add a greeting to JOURNEY.md") {
				return fmt.Errorf("no File card answer (terminal=%t card=%t): %q", terminal, card, answer.String())
			}
			return nil
		}()
	}()
	return settled
}

func mustRehearsalURL(raw string) *url.URL { u, _ := url.Parse(raw); return u }

// buildRehearsalCodingHost builds the packaged coding host from source and
// pins it the way the install bundle's flow-hosts.json does.
func buildRehearsalCodingHost(t *testing.T, node, root string) flowmanifest.Registry {
	t.Helper()
	coding := filepath.Join(t.TempDir(), "smithers-coding-host")
	build := exec.Command(node, filepath.Join(root, "flows/coding/build.mjs"), coding)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	data, err := os.ReadFile(coding)
	require.NoError(t, err)
	// Pin the fixture's Node interpreter as the packaged host does; the digest
	// measures the exact executable bytes, banner included.
	newline := bytes.IndexByte(data, '\n')
	require.GreaterOrEqual(t, newline, 0)
	quoted := "'" + strings.ReplaceAll(node, "'", `'"'"'`) + "'"
	data = append([]byte(fmt.Sprintf("#!/bin/sh\n':' //; exec %s \"$0\" \"$@\"\n", quoted)), data[newline+1:]...)
	require.NoError(t, os.WriteFile(coding, data, 0700))
	sum := sha256.Sum256(data)
	return flowmanifest.Registry{Coding: flowmanifest.Host{Executable: coding, SHA256: hex.EncodeToString(sum[:])}}
}

// rehearsalJJExport is the native source helper a lane's coding host binds
// its checkout with: SMITHERS_WORKSPACE_JJ_EXPORT_BINARY, else the one built
// beside the repository engine's library.
func rehearsalJJExport(root, library string) string {
	for _, candidate := range []string{os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"), filepath.Join(filepath.Dir(library), "smithers-jj-export"), filepath.Join(root, "target/release/smithers-jj-export")} {
		if !filepath.IsAbs(candidate) {
			continue
		}
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return candidate
		}
	}
	return ""
}

// rehearsalCodingModel is distribution/fake-todo-provider.mjs on a loopback
// port: the scripted model every coding turn of the TODO reaches.
type rehearsalCodingModel struct{ url string }

func startRehearsalCodingModel(t *testing.T, node, root, evidence string) rehearsalCodingModel {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	require.NoError(t, err)
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	require.NoError(t, listener.Close())
	logs := &lockedBuffer{}
	command := exec.Command(node, filepath.Join(root, "distribution/fake-todo-provider.mjs"))
	// The trace keeps each turn's role and request shape, never a credential.
	command.Env = append(os.Environ(), "PORT="+port, "HOST=127.0.0.1", "TRACE_FILE="+filepath.Join(evidence, "model-turns.jsonl"))
	command.Stdout, command.Stderr = logs, logs
	require.NoError(t, command.Start())
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_ = command.Wait()
		_ = os.WriteFile(filepath.Join(evidence, "model.log"), []byte(logs.String()), 0600)
	})
	model := rehearsalCodingModel{url: "http://127.0.0.1:" + port}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if response, err := http.Get(model.url + "/health"); err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return model
			}
		}
	}
	t.Fatalf("scripted coding model did not start\n%s", logs.String())
	return model
}

// turns answers the scripted model's served turns by role.
func (model rehearsalCodingModel) turns() string {
	response, err := http.Get(model.url + "/turns")
	if err != nil {
		return err.Error()
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	return string(data)
}

// rehearsalBranchMachines are the install's branch machine providers
// (services.InstallBranchMachineProviders): its roster, the one member
// authorizer and the stack's lane binding, read in the creating transaction.
// The trusted-process runtime the rehearsal composes isolates nothing, so its
// microVM (R1-R5) and guest identity providers admit; the bundle's microVM
// install composes the real ones (app.Config.BranchMachines).
func rehearsalBranchMachines(pool *pgxpool.Pool) *services.BranchMachineProviders {
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(db.New(pool)), nil)
	providers.MicroVM = func(context.Context) error { return nil }
	providers.SessionIdentity = func(context.Context) error { return nil }
	return &providers
}

// bindingProcessRuntime is the trusted-process runtime with the source binding
// a guest gets (installRuntimeBoxCodingBinding): the binding is written as this
// user in the checkout's .jj directory, and each coding host the
// workspace starts names it in SMITHERS_WORKSPACE_CODING_CONFIG. Only a
// smithers-jj-export built with trusted-process-binding reads that file; the
// credential is the head publisher's Git cache, as in a guest.
// A host that exits before it is ready leaves its stderr in the evidence.
type bindingProcessRuntime struct {
	*process.Runtime
	evidence string
}

var _ workspaceapi.WorkspaceCodingBindingInstaller = bindingProcessRuntime{}

func (r bindingProcessRuntime) binding(ctx context.Context, workspaceID string) (string, workspaceapi.Workspace, error) {
	observed, err := r.InspectWorkspace(ctx, workspaceID)
	if err != nil {
		return "", observed, err
	}
	// The coding host runs its helper confined to the checkout's reads, so
	// the binding sits in the checkout's .jj directory, which no source holds.
	return filepath.Join(observed.Root, ".jj", "workspace-coding.json"), observed, nil
}

func (r bindingProcessRuntime) InstallWorkspaceCodingBinding(ctx context.Context, workspaceID string, binding workspaceapi.WorkspaceCodingBinding) error {
	if err := binding.Validate(); err != nil {
		return err
	}
	file, observed, err := r.binding(ctx, workspaceID)
	if err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		workspaceapi.WorkspaceCodingBinding
		Version          int    `json:"version"`
		WorkspaceID      string `json:"workspaceId"`
		RepositoryPath   string `json:"repositoryPath"`
		CredentialSocket string `json:"credentialSocket"`
	}{binding, 1, workspaceID, observed.Root, filepath.Join(observed.Home, ".cache", "smithers", "git-credential", "socket")})
	if err != nil {
		return err
	}
	temporary := file + ".tmp"
	if err = os.WriteFile(temporary, data, 0600); err != nil {
		return err
	}
	return os.Rename(temporary, file)
}

func (r bindingProcessRuntime) StartManagedHost(ctx context.Context, workspaceID string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	file, _, err := r.binding(ctx, workspaceID)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	build := spec.Builder
	spec.Builder = workspaceapi.ManagedHostBuilderFunc(func(ctx context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
		command, err := build.BuildManagedHost(ctx, placement)
		if err != nil {
			return command, err
		}
		environment := make(map[string]string, len(command.Environment)+1)
		for name, value := range command.Environment {
			environment[name] = value
		}
		environment["SMITHERS_WORKSPACE_CODING_CONFIG"] = file
		command.Environment = environment
		return command, nil
	})
	connection, err := r.Runtime.StartManagedHost(ctx, workspaceID, spec)
	if err != nil {
		if service, inspectErr := r.InspectService(context.WithoutCancel(ctx), workspaceID, spec.Name); inspectErr == nil && service.Stderr != "" {
			stderr, _ := os.OpenFile(filepath.Join(r.evidence, "coding-host.stderr.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
			if stderr != nil {
				fmt.Fprintf(stderr, "--- %s %s: %v\n%s\n", time.Now().UTC().Format(time.RFC3339), spec.Name, err, service.Stderr)
				_ = stderr.Close()
			}
		}
	}
	return connection, err
}

// trustedProcessImages is the machine image adapter for the trusted-process
// runtime the rehearsal composes. Its machines run on the host toolchain, so it
// can provide only the base image: it reads main's recipe through the mirror
// and refuses one that needs a layer (a target index, image additions or a
// detected toolchain). "6 machine ready" therefore proves setup admission,
// persistence and fencing, not an image build. The install bundle binds its
// microVM runtime's builder instead (installMachineImages).
type trustedProcessImages struct{ sources workspaceapi.SourceFiles }

func (images trustedProcessImages) ResolveWorkspaceLayer(ctx context.Context, spec workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
	if spec.Source == nil || spec.Source.Repository == "" || len(spec.Source.Revision) != 40 {
		return microsandbox.Layer{}, fmt.Errorf("a machine image needs main's resolved revision")
	}
	read := func(path string) ([]byte, bool, error) {
		data, err := images.sources.ReadSourceFile(ctx, *spec.Source, path)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return data, err == nil, err
	}
	_, indexed, err := read(".smithers/target-index.json")
	if err != nil {
		return microsandbox.Layer{}, err
	}
	machine, err := microsandbox.ReadMachineJSON(read)
	if err != nil {
		return microsandbox.Layer{}, err
	}
	recipe, err := microsandbox.DetectRecipe(read)
	if err != nil {
		return microsandbox.Layer{}, err
	}
	if indexed || len(machine.Packages) > 0 || len(recipe.Tools) > 0 {
		return microsandbox.Layer{}, fmt.Errorf("main's recipe needs an image layer; the trusted-process runtime provides only the base image")
	}
	return microsandbox.Layer{}, nil
}

// drop is a person's Drop of TODO n (J7.3b, §10.7.2) as the owner's browser
// sends it, and its proof: 202 within 1 s and again for the same press; the
// TODO dropped; no run of it left live, and one cancelled when running says
// it had one; a pull request it had closed on GitHub, unmerged, with the
// comment "Dropped in Smithers by @x"; its lane released; a new press 409.
// A TODO starting, working or needing you has a run, which is cancelled.
func (r *rehearsal) drop(number int64) error {
	before, err := r.todo(number)
	if err != nil {
		return err
	}
	running := slices.Contains([]string{"starting", "working", "needs_you"}, before.State)
	path, key := fmt.Sprintf("/api/todos/%d", number), fmt.Sprintf("%sdrop-%d", r.keyPrefix, number)
	began := time.Now()
	code, data, err := r.keyed("POST", path, `{"op":"drop"}`, key)
	took := time.Since(began)
	if err != nil {
		return err
	}
	if code != 202 || !strings.Contains(string(data), `"accepted"`) {
		return fmt.Errorf("expected 202 accepted: %s", r.actual)
	}
	if took > time.Second {
		return fmt.Errorf("Drop answered in %s, want within 1 s", took)
	}
	if code, _, err = r.keyed("POST", path, `{"op":"drop"}`, key); err != nil || code != 202 {
		return fmt.Errorf("the same press again: %s", r.actual)
	}
	if _, err = r.waitTodoWithin(number, 30*time.Second, "dropped"); err != nil {
		return err
	}
	var live, cancelled int
	if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FILTER (WHERE state IN ('accepted','dispatching','running','waiting') AND NOT cancellation_requested),
		count(*) FILTER (WHERE cancellation_requested OR state = 'cancelled')
		FROM product_job_requests WHERE request_id LIKE 'mythical:' || (SELECT id::text FROM mythical_items WHERE number = $1) || ':%'`, number).Scan(&live, &cancelled); err != nil {
		return err
	}
	if live != 0 || running && cancelled == 0 {
		return fmt.Errorf("T%d dropped with %d live runs and %d cancelled", number, live, cancelled)
	}
	closed := "no PR"
	if pr := before.PR.Number; pr > 0 {
		for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(500 * time.Millisecond) {
			p, err := r.readFakePull(pr)
			if err != nil {
				return err
			}
			if p.State == "closed" {
				if p.Merged {
					return fmt.Errorf("the dropped TODO's PR #%d merged", pr)
				}
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("the dropped TODO's PR #%d is still %s after 60 s", pr, p.State)
			}
		}
		comment := ""
		for _, write := range r.fake.Writes() {
			if write.Method == "POST" && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/comments", pr) && write.Status < 300 {
				var body struct{ Body string }
				if json.Unmarshal(write.Body, &body) == nil && strings.HasPrefix(body.Body, "Dropped in Smithers by @") {
					comment = strings.SplitN(body.Body, "\n", 2)[0]
				}
			}
		}
		if comment == "" {
			return fmt.Errorf("PR #%d closed without the Drop comment", pr)
		}
		closed = fmt.Sprintf("PR #%d closed with %q", pr, comment)
	}
	for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(500 * time.Millisecond) {
		var workspace string
		if err = r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number = $1`, number).Scan(&workspace); err != nil {
			return err
		}
		if workspace == "" {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("T%d dropped, but its lane %s is still bound after 60 s", number, workspace)
		}
	}
	code, _, err = r.keyed("POST", path, `{"op":"drop"}`, key+"-again")
	if err != nil {
		return err
	}
	if code != 409 {
		return fmt.Errorf("a new press on a dropped TODO: %s", r.actual)
	}
	r.actual = fmt.Sprintf("202 in %dms; again 202; T%d dropped; %s; live runs 0, cancelled %d; lane released; new press 409", took.Milliseconds(), number, closed, cancelled)
	return nil
}
