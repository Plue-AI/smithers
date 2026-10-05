package compose

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// TestRootLayerInputsValidatedBeforeUse is the T-INS-06 R4 receipt (C-SEC-02;
// decision crit5-machine-r4 §4 item 1). The install composition binds its
// microVM runtime's layer builder to setup step 6, so guest root receives
// input from the repository. Root may receive only main's validated data:
// a hostile main is refused before any VM boots, and a branch never selects
// root input. Setup runs through the composed router on real PostgreSQL, the
// real repository host with its FFI mirror, and the GitHub fake. Microsandbox
// is the real runtime over a recording msb; with SMITHERS_REQUIRE_MICROVM_TESTS=1
// and SMITHERS_MICROSANDBOX_BIN, the recorder forwards every call to that msb
// and cases a, e and f build real layers.
func TestRootLayerInputsValidatedBeforeUse(t *testing.T) {
	if os.Getenv("SMITHERS_TEST_DATABASE_URL") == "" {
		t.Skip("set SMITHERS_TEST_DATABASE_URL: the R4 receipt needs real PostgreSQL and the FFI mirror")
	}
	t.Setenv("SMITHERS_REQUIRE_DATABASE_TESTS", "1")
	h := startRootLayerHarness(t)

	// Setup reaches Source ready on a main that already holds the first hostile
	// recipe; every later case moves main the way the GitHub sync does.
	hostile := rootLayerHostileCases()
	h.commitMain(hostile[0].files)
	h.runSetupThroughSource()

	for i, test := range hostile {
		t.Run("b "+test.name, func(t *testing.T) {
			if i > 0 {
				h.moveMain(t, test.files)
			}
			from := h.msb.mark()
			state, message := h.runMachine(t, "b-"+strconv.Itoa(i))
			require.Equal(t, "failed", state, "hostile main must never reach Machine ready")
			require.Contains(t, message, test.file, "the refusal names the file")
			require.Empty(t, bootCalls(h.msb.since(from)), "a refused recipe boots no VM")
		})
	}
	for i, test := range rootLayerSymlinkCases() {
		t.Run("c "+test.name, func(t *testing.T) {
			h.moveMain(t, test.files)
			from := h.msb.mark()
			state, message := h.runMachine(t, "c-"+strconv.Itoa(i))
			require.Equal(t, "failed", state)
			require.Contains(t, message, test.file, "a symlink on main is refused by its path, never read as absent")
			require.Empty(t, bootCalls(h.msb.since(from)))
		})
	}
	for i, test := range rootLayerOversizeCases() {
		t.Run("d "+test.name, func(t *testing.T) {
			h.moveMain(t, test.files)
			from := h.msb.mark()
			state, message := h.runMachine(t, "d-"+strconv.Itoa(i))
			require.Equal(t, "failed", state)
			require.Contains(t, message, test.file)
			require.Empty(t, bootCalls(h.msb.since(from)))
		})
	}

	// h: a runtime that builds no environment layers cannot certify an image.
	// Its seam is the readiness service the setup provider runs, bound the way
	// installMachineImages binds the composition's runtime.
	t.Run("h runtime without environment layers never reports Machine ready", func(t *testing.T) {
		bare := newRootLayerRuntime(t, h.msb.binary, false)
		builder, err := installMachineImages(Options{Workspace: bare})
		require.NoError(t, err)
		require.NotNil(t, builder)
		persistence := &rootLayerReadiness{}
		ready := services.InstallMachineReadyService{Sources: h.sources, Layers: builder, Persistence: persistence}
		_, err = ready.Prepare(t.Context(), h.slug)
		require.Error(t, err)
		require.ErrorIs(t, err, microsandbox.ErrUnavailable)
		require.Equal(t, services.InstallFailed, persistence.state.Machine.State)
		require.Empty(t, persistence.state.LayerKey)
		require.NotContains(t, persistence.states, services.InstallReady, "machine readiness was reported done")
	})

	// a: the C-J1-06 Node canary builds through the composed router.
	canary := rootLayerCanary()
	var mainEnvelope string
	t.Run("a valid Node canary reaches Machine ready with the literal root envelope", func(t *testing.T) {
		mainCommit := h.moveMain(t, canary)
		from := h.msb.mark()
		state, message := h.runMachine(t, "a")
		require.Equal(t, "done", state, message)
		step := h.machineStep(t)
		require.NotEmpty(t, step.LayerKey, "Machine ready carries the verified layer key")
		require.Equal(t, mainCommit, step.Revision)
		calls := h.msb.since(from)
		toolchain := rootRecipes(calls, "toolchain")
		require.Len(t, toolchain, 1, "exactly one privileged toolchain recipe")
		mainEnvelope = requireLiteralToolchainEnvelope(t, toolchain[0])
		t.Logf("layer %s at main %s; root envelope %s", step.LayerKey, mainCommit, mainEnvelope)
	})
	require.NotEmpty(t, mainEnvelope, "case a must pass before the branch cases run")

	// e: a branch that differs from main reaches root only through main.
	t.Run("e branch input never reaches root", func(t *testing.T) {
		branch := map[string]string{
			".node-version":               "26\n",
			"package.json":                canary["package.json"],
			"pnpm-lock.yaml":              canary["pnpm-lock.yaml"],
			".smithers/machine.json":      `{"packages":["evil"]}`,
			".smithers/target-index.json": rootLayerAttackerIndex(),
		}
		branchCommit := h.pushBranch(t, "r4-attacker", branch)
		h.reader.reset()
		from := h.msb.mark()
		created, err := h.runtime.CreateWorkspace(h.ctx(t), workspaceapi.WorkspaceSpec{ID: "r4-attacker-branch",
			Source: &workspaceapi.WorkspaceSource{Repository: h.slug, Revision: "r4-attacker"}})
		require.NoError(t, err)
		require.Equal(t, workspaceapi.WorkspaceRunning, created.State)
		calls := h.msb.since(from)
		toolchain := rootRecipes(calls, "toolchain")
		require.Len(t, toolchain, 1, "the branch's node 26 builds its own toolchain layer")
		require.Equal(t, mainEnvelope, requireLiteralToolchainEnvelope(t, toolchain[0]), "root envelope equals main's")
		for _, read := range h.reader.reads() {
			if read.path == ".smithers/machine.json" || read.path == ".smithers/target-index.json" {
				require.NotEqual(t, branchCommit, read.revision, "%s read at the branch commit", read.path)
			}
		}
		require.Contains(t, h.reader.reads(), sourceRead{revision: branchCommit, path: ".node-version"}, "detection reads the branch")
		allowed := rootLayerPinnedURLs(t)
		fetched := fetchedURLs(calls)
		require.NotEmpty(t, fetched)
		for _, fetchedURL := range fetched {
			require.Contains(t, allowed, fetchedURL, "fetched URL is not a toolchains.json pin")
		}
		for _, call := range calls {
			require.NotContains(t, call.Stdin, "attacker.example")
			require.NotContains(t, call.Stdin, `"evil"`)
		}
		require.NoError(t, h.runtime.DeleteWorkspace(h.ctx(t), "r4-attacker-branch"))
	})

	// f: with main's machine.json fixed, every §8.6.2 fixture sends root the
	// same bytes. g: every root recipe is a pinned script.
	t.Run("f root stdin is byte-identical across detected fixtures", func(t *testing.T) {
		mainFiles := map[string]string{"README.md": "# fixed main\n", ".smithers/machine.json": `{"packages":["jq"]}`}
		h.moveMain(t, mainFiles)
		var envelopes []string
		for name, files := range rootLayerFixtures() {
			if h.msb.real && (name == "go" || name == "python") {
				continue // real downloads of Go and Python exceed this receipt's budget
			}
			commit := h.pushBranch(t, "r4-fixture-"+name, files)
			from := h.msb.mark()
			_, err := h.runtime.ResolveWorkspaceLayer(h.ctx(t), workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: h.slug, Revision: commit}})
			require.NoError(t, err, name)
			toolchain := rootRecipes(h.msb.since(from), "toolchain")
			require.Len(t, toolchain, 1, name)
			envelopes = append(envelopes, toolchain[0].Stdin)
		}
		require.GreaterOrEqual(t, len(envelopes), 2)
		for _, envelope := range envelopes[1:] {
			require.Equal(t, envelopes[0], envelope, "root stdin differs between fixtures")
		}
		var fixed struct {
			Toolchain struct {
				Packages []string `json:"packages"`
			} `json:"toolchain"`
		}
		require.NoError(t, json.Unmarshal([]byte(envelopes[0]), &fixed))
		require.Equal(t, []string{"jq"}, fixed.Toolchain.Packages, "packages come from main's machine.json")
	})
	t.Run("g every root recipe is a pinned script and dependency VMs run only sync", func(t *testing.T) {
		calls := h.msb.since(0)
		pinned := pinnedRootDigests(t, calls)
		require.Equal(t, "sync", pinned[hexDigest("sync")])
		kinds := machineKinds(calls)
		sawSync, sawToolchain := false, false
		for _, call := range calls {
			machine, mode, sub := helperCall(call)
			if mode != "run" || len(sub) < 2 || sub[0] != "root-recipe" {
				continue
			}
			digest := sub[1]
			kind, ok := pinned[digest]
			require.True(t, ok, "root-recipe digest %s is not pinned", digest)
			var envelope map[string]json.RawMessage
			require.NoError(t, json.Unmarshal([]byte(call.Stdin), &envelope), call.Stdin)
			var script string
			require.NoError(t, json.Unmarshal(envelope["script"], &script))
			require.Equal(t, digest, hexDigest(script), "envelope script differs from its pinned digest")
			switch kind {
			case "sync":
				sawSync = true
				require.JSONEq(t, `{"script":"sync"}`, call.Stdin)
			case "toolchain":
				sawToolchain = true
				require.Equal(t, layerToolchainKind, kinds[machine], "toolchain recipe ran outside a toolchain prepare VM (%s)", machine)
			default:
				t.Fatalf("unknown pinned recipe %q", kind)
			}
		}
		require.True(t, sawSync && sawToolchain)
		dependencyVMs := 0
		for machine, kind := range kinds {
			if kind == layerDependencyKind {
				dependencyVMs++
				for _, call := range calls {
					if m, mode, sub := helperCall(call); m == machine && mode == "run" && len(sub) > 1 && sub[0] == "root-recipe" {
						require.Equal(t, hexDigest("sync"), sub[1], "dependency VM %s ran a toolchain recipe", machine)
					}
				}
			}
		}
		require.Positive(t, dependencyVMs)
	})
}

// ---- cases ----

type rootLayerCase struct {
	name  string
	file  string
	files map[string]string
}

func rootLayerCanary() map[string]string {
	return map[string]string{
		".node-version":  "22\n",
		"package.json":   `{"name":"canary","version":"1.0.0","private":true,"packageManager":"pnpm@9","scripts":{"test":"node --test"}}`,
		"pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
		"index.js":       "module.exports = (a, b) => a + b\n",
	}
}

func rootLayerToolchainIndex(postgres string) string {
	pin := func(host, version string) map[string]string {
		return map[string]string{"version": version, "url": "https://" + host + "/" + version, "sha256": strings.Repeat("a", 64)}
	}
	row := map[string]any{
		"label": "//:environmentToolchain", "package": "", "rule": "Environment.Toolchain", "inputs": []any{},
		"destinations": []string{"nodejs.org", "registry.npmjs.org", "www.postgresql.org", "apt.postgresql.org"},
		"toolchain": map[string]any{
			"downloads": map[string]any{"node": pin("nodejs.org", "26.5.0"), "pnpm": pin("registry.npmjs.org", "11.25.0")},
			"postgres":  postgres,
		},
	}
	encoded, _ := json.Marshal([]any{row})
	return string(encoded)
}

func rootLayerAttackerIndex() string {
	row := map[string]any{
		"label": "//:environmentToolchain", "package": "", "rule": "Environment.Toolchain", "inputs": []any{},
		"destinations": []string{"attacker.example"},
		"toolchain": map[string]any{
			"downloads": map[string]any{"node": map[string]string{"version": "26.5.0", "url": "https://attacker.example/root", "sha256": strings.Repeat("f", 64), "destination": "/usr/bin"}},
			"postgres":  "16",
		},
	}
	encoded, _ := json.Marshal([]any{row})
	return string(encoded)
}

func rootLayerHostileCases() []rootLayerCase {
	packages := make([]string, 65)
	for i := range packages {
		packages[i] = fmt.Sprintf("pkg%d", i)
	}
	sixtyFive, _ := json.Marshal(map[string]any{"packages": packages})
	return []rootLayerCase{
		{"packageManager command", "package.json", map[string]string{"package.json": `{"name":"x","version":"1.0.0","packageManager":"pnpm@9;id"}`}},
		{"node-version command", ".node-version", map[string]string{".node-version": "22\n$(id)\n"}},
		{"nvmrc alias", ".nvmrc", map[string]string{".nvmrc": "lts/*\n"}},
		{"go toolchain path", "go.mod", map[string]string{"go.mod": "module example.com/x\n\ngo 1.26\n\ntoolchain ../x\n"}},
		{"invalid package.json", "package.json", map[string]string{"package.json": "{not json"}},
		{"machine.json shell metacharacter", ".smithers/machine.json", map[string]string{".smithers/machine.json": `{"packages":["libssl-dev;id"]}`}},
		{"machine.json apt option", ".smithers/machine.json", map[string]string{".smithers/machine.json": `{"packages":["--force-yes"]}`}},
		{"machine.json 65 packages", ".smithers/machine.json", map[string]string{".smithers/machine.json": string(sixtyFive)}},
		{"machine.json second key", ".smithers/machine.json", map[string]string{".smithers/machine.json": `{"packages":[],"script":"id"}`}},
		{"index postgres command", ".smithers/target-index.json", map[string]string{".smithers/target-index.json": rootLayerToolchainIndex("16;id")}},
		{"index postgres three digits", ".smithers/target-index.json", map[string]string{".smithers/target-index.json": rootLayerToolchainIndex("160")}},
	}
}

// symlinkPrefix marks a file whose content is a symlink target. Each fixture
// carries an invalid .nvmrc: a symlink misread as absent still fails, naming
// .nvmrc instead of the link, so a red case cannot complete step 6.
const symlinkPrefix = "symlink:"

func rootLayerSymlinkCases() []rootLayerCase {
	return []rootLayerCase{
		{"node-version to passwd", ".node-version", map[string]string{".node-version": symlinkPrefix + "/etc/passwd", ".nvmrc": "lts/*\n"}},
		{"machine.json outside", ".smithers/machine.json", map[string]string{".smithers/machine.json": symlinkPrefix + "../x", ".nvmrc": "lts/*\n"}},
		{"target index", ".smithers/target-index.json", map[string]string{".smithers/target-index.json": symlinkPrefix + "x", "x": "[]", ".nvmrc": "lts/*\n"}},
	}
}

func rootLayerOversizeCases() []rootLayerCase {
	large := `{"name":"x","version":"1.0.0","description":"` + strings.Repeat("a", 17<<20) + `"}`
	requirements := map[string]string{".nvmrc": "lts/*\n"}
	line := "# " + strings.Repeat("r", 1022) + "\n"
	body := strings.Repeat(line, 15<<10) // 15 MiB, under the per-file cap
	for i := range 5 {
		requirements[fmt.Sprintf("requirements-%d.txt", i)] = body
	}
	return []rootLayerCase{
		{"17 MiB package.json", "package.json", map[string]string{"package.json": large}},
		{"requirements over 64 MiB in total", "requirements", requirements},
	}
}

// rootLayerFixtures are §8.6.2 repositories detected without a declaration.
func rootLayerFixtures() map[string]map[string]string {
	return map[string]map[string]string{
		"pnpm": rootLayerCanary(),
		"npm": {
			"package.json":      `{"name":"npm-fixture","version":"1.0.0","engines":{"node":"22"}}`,
			"package-lock.json": `{"name":"npm-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"npm-fixture","version":"1.0.0"}}}`,
		},
		"go": {
			"go.mod": "module example.com/fixture\n\ngo 1.26.8\n",
			"x.go":   "package fixture\n",
		},
		"python": {
			".python-version":  "3.13\n",
			"requirements.txt": "\n",
		},
	}
}

// ---- harness ----

type rootLayerHarness struct {
	t          *testing.T
	pool       *pgxpool.Pool
	origin     string
	client     *http.Client
	jar        *cookiejar.Jar
	stdout     *lockedBuffer
	logs       *lockedBuffer
	seed       string
	bare       string
	storage    repohostserver.Config
	repoClient *repohost.Client
	sources    repositorySourceFiles
	reader     *recordingSourceFiles
	msb        *recordingMSB
	runtime    *microsandbox.Runtime
	slug       string
	provider   *httptest.Server
}

func (h *rootLayerHarness) ctx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func startRootLayerHarness(t *testing.T) *rootLayerHarness {
	_, source, _, _ := goruntime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		library = filepath.Join(root, "target/release/libsmithers_ffi.dylib")
		if goruntime.GOOS == "linux" {
			library = filepath.Join(root, "target/release/libsmithers_ffi.so")
		}
	}
	_, err := os.Stat(library)
	require.NoError(t, err, "build the repository's smithers-ffi library first or set SMITHERS_FFI_LIBRARY_PATH")
	h := &rootLayerHarness{t: t, stdout: &lockedBuffer{}, logs: &lockedBuffer{}}
	var databaseURL string
	h.pool, databaseURL = postgresfixture.NewProductDatabase(t)
	gitRoot := t.TempDir()
	h.seed = filepath.Join(gitRoot, "seed")
	h.bare = filepath.Join(gitRoot, "rehearsal-owner/app.git")
	require.NoError(t, os.MkdirAll(h.seed, 0o700))
	h.git("init", "-q", "-b", "main", h.seed)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	fake, err := githubfake.New(githubfake.Config{OAuthCode: "owner-code", GitRoot: gitRoot, AppID: 42, Slug: "r4-root-inputs", OwnerLogin: "rehearsal-owner", OwnerKind: "user", ClientID: "client", ClientSecret: "secret", WebhookSecret: "webhook", PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), ConversionCode: "manifest-code", Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: "rehearsal-owner/app", Private: true}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	h.storage = repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "r4-repo", FFILibraryPath: library}
	repository, err := repohostserver.New(h.storage)
	require.NoError(t, err, "build the repository's smithers-ffi library first")
	t.Cleanup(func() { require.NoError(t, repository.Shutdown(context.Background())) })
	repositoryServer := httptest.NewServer(repository.Handler())
	t.Cleanup(repositoryServer.Close)
	h.repoClient = repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryServer.URL}, "r4-repo")
	h.sources = repositorySourceFiles{client: h.repoClient}
	server := httptest.NewUnstartedServer(nil)
	h.origin = "http://" + server.Listener.Addr().String()
	for name, value := range map[string]string{
		"SMITHERS_REPO_HOST_URL": repositoryServer.URL, "SMITHERS_AUTH_MODE": "selfhost", "SMITHERS_DATABASE_URL": databaseURL,
		"SMITHERS_PUBLIC_URL": h.origin, "SMITHERS_SERVER_ALLOWED_ORIGINS": h.origin, "SMITHERS_SERVER_ADDR": "127.0.0.1:0",
		"SMITHERS_AUTH_SESSION_SECRET": "r4-session-secret", "SMITHERS_LFS_SIGNING_SECRET": "r4-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "r4-encryption-key", "SMITHERS_REPO_HOST_AUTH_TOKEN": "r4-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN": "r4-callback", "SMITHERS_BLOB_DATA_DIR": t.TempDir(),
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false", "SMITHERS_OTEL_EXPORTER": "none", "SMITHERS_METRICS_ADDR": "",
		"SMITHERS_AUTH_GITHUB_API_BASE_URL": fake.URL, "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL": fake.URL, "SMITHERS_GITHUB_APP_API_BASE_URL": fake.URL,
		"SMITHERS_GITHUB_GIT_BASE_URL": fake.URL,
	} {
		t.Setenv(name, value)
	}
	h.provider = localChatProvider(make(chan string, 16))
	t.Cleanup(h.provider.Close)
	real := ""
	if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
		real = os.Getenv("SMITHERS_MICROSANDBOX_BIN")
		require.NotEmpty(t, real, "SMITHERS_REQUIRE_MICROVM_TESTS=1 needs SMITHERS_MICROSANDBOX_BIN")
	}
	h.msb = newRecordingMSB(t, real)
	h.runtime = newRootLayerRuntime(t, h.msb.binary, true)
	// Model access (step 5) needs the composed chat host, as in the J1
	// rehearsal: the trusted model host runs on a process runtime, never in
	// the workspace microVM runtime under test.
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	bundle := filepath.Join(t.TempDir(), "model-host")
	build := exec.Command(node, filepath.Join(root, "apps/model-host/build.mjs"), bundle)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	control, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { _ = control.Close() })
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{Runtime: control, NodeBinary: node, BundlePath: bundle})
	require.NoError(t, err)
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return databaseURL }, func() string { return "r4-encryption-key" })
	require.NoError(t, err)
	chatHost, err := modelhost.New(resolver, launcher)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	ready := make(chan http.Handler, 1)
	done := make(chan error, 1)
	go func() {
		// No MachineImages: step 6 binds the microVM runtime's own builder.
		done <- StartWithOptions(ctx, nil, h.stdout, h.logs, Options{Repository: h.repoClient, Workspace: h.runtime, ComputeProvider: sandboxfake.New(), ChatHost: chatHost, FlowHostProductAPIURL: h.origin}, func(handler http.Handler) { ready <- handler })
	}()
	select {
	case handler := <-ready:
		server.Config.Handler = handler
	case err := <-done:
		cancel()
		t.Fatalf("composition: %v\n%s", err, h.logs.String())
	case <-time.After(60 * time.Second):
		cancel()
		t.Fatalf("composition timed out: %s", h.logs.String())
	}
	server.Start()
	t.Cleanup(func() {
		server.Close()
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(20 * time.Second):
			t.Error("composition shutdown timed out")
		}
		if t.Failed() {
			t.Logf("backend log tail:\n%s", tailText(h.logs.String(), 6000))
		}
	})
	// The composition bound its mirror reader at startup. Wrap the same reader
	// so the receipt can show which revision each root-relevant path came from.
	h.reader = &recordingSourceFiles{inner: h.sources}
	h.runtime.BindSourceFiles(h.reader)
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	h.jar = jar
	h.client = &http.Client{Jar: jar, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return h
}

func newRootLayerRuntime(t *testing.T, binary string, environments bool) *microsandbox.Runtime {
	config := microsandbox.Config{Binary: binary, Root: t.TempDir(), CPUs: 1, MemoryMiB: 1024, DiskMiB: 4096, MaxRunningVMs: 2,
		SkipQualification: os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") != "1"}
	if environments {
		config.Environments = &microsandbox.EnvironmentConfig{PrepareCPUs: 1, PrepareMemoryMiB: 1024, PrepareDiskMiB: 4096, MinFreeBytes: 1 << 30, LayerBudgetBytes: 8 << 30}
	}
	runtime, err := microsandbox.New(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = runtime.Close()
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			sweepRealOwner(t, os.Getenv("SMITHERS_MICROSANDBOX_BIN"), runtime.Owner())
		}
	})
	return runtime
}

// sweepRealOwner removes the machines and layer snapshots this test's
// installation owner left in the real Microsandbox; nothing else is touched.
func sweepRealOwner(t *testing.T, binary, owner string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Errorf("sweep: %v", err)
		return
	}
	msb := func(args ...string) []byte {
		cmd := exec.CommandContext(ctx, binary, args...)
		cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
		output, _ := cmd.Output()
		return output
	}
	mark := "-" + strings.TrimPrefix(owner, "smithers-backend-")[:8] + "-"
	var machines []struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(msb("list", "--format", "json", "--label", "smithers.owner="+owner), &machines)
	for _, machine := range machines {
		msb("remove", "--force", "-q", machine.Name)
	}
	var snapshots []struct {
		Name *string `json:"name"`
	}
	_ = json.Unmarshal(msb("snapshot", "list", "--format", "json"), &snapshots)
	for _, snapshot := range snapshots {
		if snapshot.Name != nil && strings.HasPrefix(*snapshot.Name, "smthrs-") && strings.Contains(*snapshot.Name, mark) {
			msb("snapshot", "remove", "-q", *snapshot.Name)
		}
	}
}

func (h *rootLayerHarness) git(args ...string) string {
	h.t.Helper()
	cmd := exec.Command("/usr/bin/git", args...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	output, err := cmd.CombinedOutput()
	require.NoError(h.t, err, "git %s: %s", strings.Join(args, " "), output)
	return strings.TrimSpace(string(output))
}

// writeTree replaces the seed's tracked files with files and commits them on
// the current branch.
func (h *rootLayerHarness) writeTree(files map[string]string, message string) string {
	entries, err := os.ReadDir(h.seed)
	require.NoError(h.t, err)
	for _, entry := range entries {
		if entry.Name() != ".git" {
			require.NoError(h.t, os.RemoveAll(filepath.Join(h.seed, entry.Name())))
		}
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		target := filepath.Join(h.seed, name)
		require.NoError(h.t, os.MkdirAll(filepath.Dir(target), 0o700))
		if link, ok := strings.CutPrefix(files[name], symlinkPrefix); ok {
			require.NoError(h.t, os.Symlink(link, target))
		} else {
			require.NoError(h.t, os.WriteFile(target, []byte(files[name]), 0o600))
		}
	}
	h.git("-C", h.seed, "add", "-A")
	h.git("-C", h.seed, "-c", "user.name=R4", "-c", "user.email=owner@example.test", "commit", "-q", "--allow-empty", "-m", message)
	return h.git("-C", h.seed, "rev-parse", "HEAD")
}

// commitMain makes files main on the GitHub fake before setup mirrors it.
func (h *rootLayerHarness) commitMain(files map[string]string) string {
	commit := h.writeTree(files, "main")
	if _, err := os.Stat(h.bare); err != nil {
		h.git("clone", "-q", "--bare", h.seed, h.bare)
	} else {
		h.git("-C", h.seed, "push", "-q", "--force", h.bare, "main:main")
	}
	return commit
}

// moveMain commits files on main, moves the GitHub fake's main and mirrors it
// the way the GitHub sync does (refreshMirrorFromGitHub): a non-pruning push
// into the mirror's git store, then ImportRefs. It returns main's commit after
// checking that the mirror resolves main to it.
func (h *rootLayerHarness) moveMain(t *testing.T, files map[string]string) string {
	t.Helper()
	h.git("-C", h.seed, "checkout", "-q", "main")
	commit := h.commitMain(files)
	h.mirror(t, "main")
	resolved, err := h.sources.ResolveSourceRevision(t.Context(), h.slug, "main")
	require.NoError(t, err)
	require.Equal(t, commit, resolved, "the mirror did not move main")
	return commit
}

// pushBranch commits files on a branch off main and mirrors only that branch.
func (h *rootLayerHarness) pushBranch(t *testing.T, branch string, files map[string]string) string {
	t.Helper()
	h.git("-C", h.seed, "checkout", "-q", "-B", branch, "main")
	commit := h.writeTree(files, branch)
	h.git("-C", h.seed, "push", "-q", "--force", h.bare, branch+":"+branch)
	h.git("-C", h.seed, "checkout", "-q", "main")
	h.mirror(t, branch)
	resolved, err := h.sources.ResolveSourceRevision(t.Context(), h.slug, branch)
	require.NoError(t, err)
	require.Equal(t, commit, resolved, "the mirror did not import %s", branch)
	return commit
}

func (h *rootLayerHarness) mirror(t *testing.T, branch string) {
	t.Helper()
	owner, name, err := splitRepositorySlug(h.slug)
	require.NoError(t, err)
	store := h.storage.GitBackendPath(owner, name)
	h.git("--git-dir", h.bare, "push", "-q", "--force", store, "refs/heads/"+branch+":refs/heads/"+branch)
	require.NoError(t, h.repoClient.ImportRefs(t.Context(), owner, name))
}

func (h *rootLayerHarness) request(method, path, body, key string) (int, []byte) {
	code, data, _ := h.requestHeaders(method, path, body, key)
	return code, data
}

func (h *rootLayerHarness) requestHeaders(method, path, body, key string) (int, []byte, http.Header) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.origin+path, strings.NewReader(body))
	require.NoError(h.t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", h.origin)
	if key == "" {
		key = "r4-" + strings.Trim(strings.ReplaceAll(path, "/", "-"), "-")
	}
	req.Header.Set("Idempotency-Key", key)
	for _, cookie := range h.jar.Cookies(req.URL) {
		if cookie.Name == "__csrf" {
			req.Header.Set("X-CSRF-Token", cookie.Value)
		}
	}
	resp, err := h.client.Do(req)
	require.NoError(h.t, err)
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	require.NoError(h.t, err)
	return resp.StatusCode, data, resp.Header
}

func (h *rootLayerHarness) expect(method, path, body string, status int) []byte {
	h.t.Helper()
	code, data := h.request(method, path, body, "")
	require.Equal(h.t, status, code, "%s %s: %s", method, path, data)
	return data
}

type rootLayerStep struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (h *rootLayerHarness) steps() map[string]rootLayerStep {
	h.t.Helper()
	data := h.expect("GET", "/api/install", "", 200)
	var projection struct {
		Steps []rootLayerStep `json:"steps"`
	}
	require.NoError(h.t, json.Unmarshal(data, &projection))
	steps := map[string]rootLayerStep{}
	for _, step := range projection.Steps {
		steps[step.ID] = step
	}
	return steps
}

// waitStep polls the public projection until the step settles.
func (h *rootLayerHarness) waitStep(id string, timeout time.Duration) rootLayerStep {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		step := h.steps()[id]
		if step.State == "done" || step.State == "failed" || step.State == "blocked" {
			return step
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("setup step %s did not settle: %+v\n%s", id, step, tailText(h.logs.String(), 4000))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (h *rootLayerHarness) requireDone(id string) {
	h.t.Helper()
	step := h.waitStep(id, 90*time.Second)
	require.Equal(h.t, "done", step.State, "%s: %+v", id, step.Error)
}

func (h *rootLayerHarness) runSetupThroughSource() {
	t := h.t
	var mint struct {
		URLs []string `json:"setup_urls"`
	}
	require.Eventually(t, func() bool { return json.Unmarshal([]byte(h.stdout.String()), &mint) == nil && len(mint.URLs) > 0 }, 10*time.Second, 50*time.Millisecond, "no setup handoff: %s", h.stdout.String())
	setupURL, err := url.Parse(mint.URLs[0])
	require.NoError(t, err)
	h.expect("GET", setupURL.RequestURI(), "", 303)
	address, _ := json.Marshal(map[string]any{"bind": "127.0.0.1:4000", "origins": []string{h.origin}})
	h.expect("POST", "/api/install/setup/address", string(address), 202)
	h.requireDone("address")
	data := h.expect("POST", "/api/install/setup/app", `{"owner":"rehearsal-owner"}`, 200)
	var manifest struct {
		State string `json:"state"`
	}
	require.NoError(t, json.Unmarshal(data, &manifest))
	h.expect("GET", "/setup/github/callback?code=manifest-code&state="+url.QueryEscape(manifest.State), "", 303)
	h.requireDone("app_manifest")
	code, _, header := h.requestHeaders("GET", "/api/auth/github", "", "")
	require.Equal(t, 302, code)
	authorize, err := url.Parse(header.Get("Location"))
	require.NoError(t, err)
	h.expect("GET", "/api/auth/github/callback?code=owner-code&state="+url.QueryEscape(authorize.Query().Get("state")), "", 302)
	h.requireDone("sign_in")
	h.expect("POST", "/api/install/setup/repository", `{"repository":"rehearsal-owner/app"}`, 202)
	h.requireDone("repository")
	for _, c := range []struct{ Name, Origin string }{{"TEST_PROVIDER", h.provider.URL}, {"AI_GATEWAY_API_KEY", "https://ai-gateway.vercel.sh"}} {
		body, _ := json.Marshal(map[string]string{"action": "enroll", "requestId": uuid.NewString(), "name": c.Name, "origin": c.Origin, "value": "r4-key"})
		data := h.expect("POST", "/api/model/credential", string(body), 200)
		require.Contains(t, string(data), `"ok":true`)
	}
	model, _ := json.Marshal(map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": "TEST_PROVIDER", "baseUrl": h.provider.URL}})
	h.expect("PUT", "/api/model/default", string(model), 200)
	h.expect("POST", "/api/install/setup/models", `{}`, 202)
	h.requireDone("models")
	h.expect("POST", "/api/install/setup/source", `{}`, 202)
	h.requireDone("source")
	var slug string
	var raw []byte
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT value FROM install_settings WHERE key = 'setup.source.repository'`).Scan(&raw))
	require.NoError(t, json.Unmarshal(raw, &slug))
	h.slug = slug
	t.Logf("source ready; mirror %s", slug)
}

// runMachine requests setup step 6 and returns its settled state and message.
func (h *rootLayerHarness) runMachine(t *testing.T, key string) (string, string) {
	t.Helper()
	code, data := h.request("POST", "/api/install/setup/machine", `{}`, "r4-machine-"+key)
	require.Equal(t, 202, code, string(data))
	step := h.waitStep("machine", 15*time.Minute)
	message := ""
	if step.Error != nil {
		message = step.Error.Code + ": " + step.Error.Message
	}
	t.Logf("machine %s %s", step.State, message)
	return step.State, message
}

func (h *rootLayerHarness) machineStep(t *testing.T) services.InstallStep {
	t.Helper()
	var raw []byte
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT value FROM install_settings WHERE key = 'setup.step.machine'`).Scan(&raw))
	var step services.InstallStep
	require.NoError(t, json.Unmarshal(raw, &step))
	return step
}

// ---- readiness persistence for the seam case ----

type rootLayerReadiness struct {
	mu     sync.Mutex
	state  services.InstallReadiness
	states []services.InstallStepState
}

func (p *rootLayerReadiness) Update(_ context.Context, _ string, mutate func(services.InstallReadiness) (services.InstallReadiness, error)) (services.InstallReadiness, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	next, err := mutate(p.state)
	if err != nil {
		return p.state, err
	}
	p.state = next
	p.states = append(p.states, next.Machine.State)
	return next, nil
}

// ---- recording source reader ----

type sourceRead struct{ revision, path string }

type recordingSourceFiles struct {
	inner workspaceapi.SourceFiles
	mu    sync.Mutex
	log   []sourceRead
}

func (r *recordingSourceFiles) ResolveSourceRevision(ctx context.Context, repository, revision string) (string, error) {
	return r.inner.ResolveSourceRevision(ctx, repository, revision)
}

func (r *recordingSourceFiles) ReadSourceFile(ctx context.Context, source workspaceapi.WorkspaceSource, name string) ([]byte, error) {
	r.mu.Lock()
	r.log = append(r.log, sourceRead{revision: source.Revision, path: name})
	r.mu.Unlock()
	return r.inner.ReadSourceFile(ctx, source, name)
}

func (r *recordingSourceFiles) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.log = nil
}

func (r *recordingSourceFiles) reads() []sourceRead {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]sourceRead(nil), r.log...)
}

// ---- recording msb ----

// recordingMSB is an msb that appends every call (argv and stdin) to a log.
// With real set, it forwards the call to that msb; otherwise it answers as a
// minimal Microsandbox: machines and snapshots are directories holding the
// layer markers a build writes, so verification reads back what was prepared.
type recordingMSB struct {
	real   bool
	binary string
	log    string
	mu     sync.Mutex
	calls  []msbCall
	offset int64
}

type msbCall struct {
	Argv       []string `json:"argv"`
	Stdin      string   `json:"stdin"`
	StdinBytes int      `json:"stdin_bytes"`
}

const recordingMSBScript = `#!/usr/bin/python3 -I
import fcntl, json, os, re, shutil, subprocess, sys
STATE = __STATE__
LOG = __LOG__
REAL = __REAL__
args = sys.argv[1:]
data = sys.stdin.buffer.read()
entry = {"argv": args}
if len(data) > (1 << 20) or (len(args) > 0 and args[-1] == "install"):
    entry["stdin_bytes"] = len(data)
else:
    entry["stdin"] = data.decode("utf-8", "replace")
with open(LOG, "a") as log:
    fcntl.flock(log, fcntl.LOCK_EX)
    log.write(json.dumps(entry) + "\n")
if REAL:
    done = subprocess.run([REAL] + args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    sys.stdout.buffer.write(done.stdout)
    sys.stderr.buffer.write(done.stderr)
    sys.exit(done.returncode)
def flag(name):
    if name in args and args.index(name) + 1 < len(args):
        return args[args.index(name) + 1]
    return ""
def machine(name): return os.path.join(STATE, "machines", name)
def snapshot(name): return os.path.join(STATE, "snapshots", name)
def clone(source, target):
    shutil.rmtree(target, ignore_errors=True)
    if os.path.isdir(source):
        shutil.copytree(source, target)
    else:
        os.makedirs(target, exist_ok=True)
command = args[0] if args else ""
if command == "--version":
    print("msb 0.6.16")
elif command == "list":
    print("[]")
elif command == "snapshot" and len(args) > 1:
    if args[1] == "list":
        rows = []
        if os.path.isdir(os.path.join(STATE, "snapshots")):
            for name in sorted(os.listdir(os.path.join(STATE, "snapshots"))):
                rows.append({"name": name, "digest": "sha256:" + "0" * 64, "artifact_path": "", "created_at": "2026-10-05T00:00:00Z", "parent_digest": None, "size_bytes": 0})
        print(json.dumps(rows))
    elif args[1] == "create":
        clone(machine(flag("--from")), snapshot(args[2]))
    elif args[1] == "remove":
        shutil.rmtree(snapshot(args[-1]), ignore_errors=True)
elif command == "create":
    clone("", machine(flag("-n")))
elif command == "run" and "--from-snapshot" in args:
    clone(snapshot(flag("--from-snapshot")), machine(flag("-n")))
elif command == "remove":
    shutil.rmtree(machine(args[-1]), ignore_errors=True)
elif command == "exec" and "--" in args:
    split = args.index("--")
    name, rest = args[split - 1], args[split + 1:]
    if "-c" in rest and len(rest) > rest.index("-c") + 3 and rest[rest.index("-c") + 3] == "run":
        sub = rest[rest.index("-c") + 4:]
        out = ""
        if sub and sub[0] == "exec":
            request = json.loads(data or b"{}")
            argv = request.get("argv") or []
            script = argv[2] if len(argv) > 2 else ""
            kind = re.search(r"/var/cache/smithers/layers/([a-z]+)\.json", script)
            marker = re.search(r"printf '%s' '(.*)' > '/var/cache/smithers/layers/", script)
            if marker and kind:
                os.makedirs(machine(name), exist_ok=True)
                with open(os.path.join(machine(name), kind.group(1) + ".json"), "w") as f:
                    f.write(marker.group(1))
            elif kind and script.startswith("cat "):
                path = os.path.join(machine(name), kind.group(1) + ".json")
                if not os.path.exists(path):
                    sys.stderr.write("cat: no marker\0SMITHERS-EXIT 1\0")
                    sys.exit(0)
                out = open(path).read()
            elif kind and script.startswith("if [ -e "):
                out = "present" if os.path.exists(os.path.join(machine(name), kind.group(1) + ".json")) else "missing"
        sys.stdout.write(out)
        sys.stderr.write("\0SMITHERS-EXIT 0\0")
`

func newRecordingMSB(t *testing.T, real string) *recordingMSB {
	dir := t.TempDir()
	quote := func(value string) string { encoded, _ := json.Marshal(value); return string(encoded) }
	script := strings.NewReplacer("__STATE__", quote(filepath.Join(dir, "state")), "__LOG__", quote(filepath.Join(dir, "calls.jsonl")), "__REAL__", quote(real)).Replace(recordingMSBScript)
	binary := filepath.Join(dir, "msb")
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "calls.jsonl"), nil, 0o600))
	return &recordingMSB{real: real != "", binary: binary, log: filepath.Join(dir, "calls.jsonl")}
}

// load appends calls written since the last read.
func (m *recordingMSB) load() []msbCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	file, err := os.Open(m.log)
	if err != nil {
		return m.calls
	}
	defer file.Close()
	if _, err := file.Seek(m.offset, io.SeekStart); err != nil {
		return m.calls
	}
	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		m.offset += int64(len(line))
		var call msbCall
		if json.Unmarshal([]byte(line), &call) == nil {
			m.calls = append(m.calls, call)
		}
	}
	return m.calls
}

func (m *recordingMSB) mark() int { return len(m.load()) }

func (m *recordingMSB) since(mark int) []msbCall {
	calls := m.load()
	return append([]msbCall(nil), calls[mark:]...)
}

// helperCall returns the machine, helper mode (install or run) and helper
// subcommand of an msb exec of the pinned guest helper.
func helperCall(call msbCall) (string, string, []string) {
	args := call.Argv
	if len(args) == 0 || args[0] != "exec" {
		return "", "", nil
	}
	for i, arg := range args {
		if arg != "--" {
			continue
		}
		rest := args[i+1:]
		for j, value := range rest {
			if value == "-c" && j+3 < len(rest) {
				return args[i-1], rest[j+3], rest[j+4:]
			}
		}
		return args[i-1], "", nil
	}
	return "", "", nil
}

func bootCalls(calls []msbCall) []string {
	var boots []string
	for _, call := range calls {
		if len(call.Argv) > 0 && (call.Argv[0] == "create" || call.Argv[0] == "run") {
			boots = append(boots, strings.Join(call.Argv, " "))
		}
	}
	return boots
}

func rootRecipes(calls []msbCall, kind string) []msbCall {
	var recipes []msbCall
	for _, call := range calls {
		if _, mode, sub := helperCall(call); mode == "run" && len(sub) > 1 && sub[0] == "root-recipe" {
			var envelope map[string]json.RawMessage
			if json.Unmarshal([]byte(call.Stdin), &envelope) != nil {
				continue
			}
			_, toolchain := envelope["toolchain"]
			if (kind == "toolchain") == toolchain {
				recipes = append(recipes, call)
			}
		}
	}
	return recipes
}

// requireLiteralToolchainEnvelope checks the one variable root input against
// its literal value for a main with no machine.json and no target index, and
// returns the envelope without its pinned script for comparison.
func requireLiteralToolchainEnvelope(t *testing.T, call msbCall) string {
	t.Helper()
	var envelope struct {
		Script    string          `json:"script"`
		Toolchain json.RawMessage `json:"toolchain"`
	}
	require.NoError(t, json.Unmarshal([]byte(call.Stdin), &envelope))
	_, _, sub := helperCall(call)
	require.Equal(t, sub[1], hexDigest(envelope.Script))
	const literal = `{"environment":{"BUN_INSTALL_CACHE_DIR":"/var/cache/smithers/bun","CARGO_HOME":"/var/cache/smithers/cargo","CI":"1","COREPACK_ENABLE_DOWNLOAD_PROMPT":"0","DPRINT_CACHE_DIR":"/var/cache/smithers/dprint","GOCACHE":"/var/cache/smithers/gocache","GOFLAGS":"-mod=readonly","GOMODCACHE":"/var/cache/smithers/gomod","GOPROXY":"off","GOTOOLCHAIN":"local","LANG":"C.UTF-8","PATH":"/opt/smithers/toolchain/bin:/opt/smithers/toolchain/node/bin:/opt/smithers/toolchain/go/bin:/opt/smithers/toolchain/rust/bin:/opt/smithers/toolchain/python/bin:/var/cache/smithers/python-site/bin:/opt/smithers/rust/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","PIP_CACHE_DIR":"/var/cache/smithers/pip","PIP_FIND_LINKS":"/var/cache/smithers/wheels","PIP_TARGET":"/var/cache/smithers/python-site","PLAYWRIGHT_BROWSERS_PATH":"/var/cache/smithers/ms-playwright","PYTHONPATH":"/var/cache/smithers/python-site","RUSTUP_HOME":"/opt/smithers/rust/rustup","UV_CACHE_DIR":"/var/cache/smithers/uv","UV_PYTHON_DOWNLOADS":"never","YARN_CACHE_FOLDER":"/var/cache/smithers/yarn","npm_config_cache":"/var/cache/smithers/npm","npm_config_store_dir":"/var/cache/smithers/pnpm-store","pnpm_config_cache_dir":"/var/cache/smithers/pnpm-cache","pnpm_config_store_dir":"/var/cache/smithers/pnpm-store"},"packages":null,"postgres":""}`
	require.JSONEq(t, literal, string(envelope.Toolchain), "no detected or branch field reaches root")
	return string(envelope.Toolchain)
}

// pinnedRootDigests reads the digest table the host embeds in the guest
// bootstrap it sends with every helper call.
func pinnedRootDigests(t *testing.T, calls []msbCall) map[string]string {
	t.Helper()
	pattern := regexp.MustCompile(`ROOT_RECIPE_DIGESTS=json\.loads\(("(?:[^"\\]|\\.)*")\)`)
	for _, call := range calls {
		for _, arg := range call.Argv {
			if match := pattern.FindStringSubmatch(arg); match != nil {
				quoted, err := strconv.Unquote(match[1])
				require.NoError(t, err)
				pins := map[string]string{}
				require.NoError(t, json.Unmarshal([]byte(quoted), &pins))
				return pins
			}
		}
	}
	t.Fatal("no guest bootstrap call recorded")
	return nil
}

const (
	layerToolchainKind  = "toolchain"
	layerDependencyKind = "dependencies"
)

// machineKinds classifies prepare VMs: a toolchain layer boots the base image;
// a dependency layer boots a toolchain or dependency snapshot.
func machineKinds(calls []msbCall) map[string]string {
	kinds := map[string]string{}
	for _, call := range calls {
		args := call.Argv
		if len(args) == 0 || !containsValue(args, "smithers.layer=prepare") || len(args) < 2 {
			continue
		}
		name := ""
		for i, arg := range args {
			if arg == "-n" && i+1 < len(args) {
				name = args[i+1]
			}
		}
		switch args[0] {
		case "create":
			kinds[name] = layerToolchainKind
		case "run":
			kinds[name] = layerDependencyKind
		}
	}
	return kinds
}

func containsValue(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

var urlPattern = regexp.MustCompile(`https://[^\s'"\\]+`)

// fetchedURLs lists the URLs in recipes that toolchain prepare VMs ran.
func fetchedURLs(calls []msbCall) []string {
	seen := map[string]bool{}
	kinds := machineKinds(calls)
	for _, call := range calls {
		if machine, mode, sub := helperCall(call); kinds[machine] == layerToolchainKind && mode == "run" && len(sub) > 0 && sub[0] == "exec" {
			for _, found := range urlPattern.FindAllString(call.Stdin, -1) {
				seen[found] = true
			}
		}
	}
	urls := make([]string, 0, len(seen))
	for found := range seen {
		urls = append(urls, found)
	}
	sort.Strings(urls)
	return urls
}

func rootLayerPinnedURLs(t *testing.T) []string {
	t.Helper()
	_, source, _, _ := goruntime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(source), "../../microsandbox/toolchains.json"))
	require.NoError(t, err)
	var pins struct {
		Tools map[string]map[string]struct {
			URL string `json:"url"`
		} `json:"tools"`
	}
	require.NoError(t, json.Unmarshal(data, &pins))
	var urls []string
	for _, versions := range pins.Tools {
		for _, pin := range versions {
			urls = append(urls, pin.URL)
		}
	}
	return urls
}

func hexDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func tailText(text string, n int) string {
	if len(text) > n {
		return text[len(text)-n:]
	}
	return text
}
