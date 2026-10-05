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
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This is an opt-in diagnostic, not a C-J1-04 reference-host passing receipt.
// New orchestration is necessary: isolated setup/TODO tests seed past the journey.
func TestJ1Rehearsal(t *testing.T) {
	if os.Getenv("SMITHERS_J1_REHEARSAL") != "1" {
		t.Skip("enable explicitly with SMITHERS_J1_REHEARSAL=1")
	}
	require.NotEmpty(t, os.Getenv("SMITHERS_TEST_DATABASE_URL"), "rehearsal requires real PostgreSQL")
	t.Setenv("SMITHERS_REQUIRE_DATABASE_TESTS", "1")
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	evidence := filepath.Join(root, ".artifacts/checks/C-J1-04/rehearsal", time.Now().UTC().Format("20060102T150405.000000000Z"))
	require.NoError(t, os.MkdirAll(evidence, 0700))
	table := "step\troute\texpected\tactual\tresult\tticket\n"
	defer func() {
		require.NoError(t, os.WriteFile(filepath.Join(evidence, "steps.tsv"), []byte(table), 0600))
		fmt.Print(table)
		fmt.Println("rehearsal evidence:", evidence)
	}()
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	gitRoot := t.TempDir()
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
	git("-C", seed, "add", "JOURNEY.md")
	git("-C", seed, "-c", "user.name=Rehearsal", "-c", "user.email=owner@example.test", "commit", "-m", "Canary")
	seedHead, err := exec.Command("/usr/bin/git", "-C", seed, "rev-parse", "HEAD").Output()
	require.NoError(t, err)
	mainCommit := strings.TrimSpace(string(seedHead))
	require.NoError(t, os.MkdirAll(filepath.Join(gitRoot, "rehearsal-owner"), 0700))
	git("clone", "--bare", seed, filepath.Join(gitRoot, "rehearsal-owner/app.git"))
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	fake, err := githubfake.New(githubfake.Config{OAuthCode: "owner-code", GitRoot: gitRoot, AppID: 42, Slug: "j1-rehearsal", OwnerLogin: "rehearsal-owner", OwnerKind: "user", ClientID: "client", ClientSecret: "secret", WebhookSecret: "webhook", PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), ConversionCode: "manifest-code", Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: "rehearsal-owner/app", Private: true}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	// The real repository engine is reused; no fixture mounts a product route.
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		library = filepath.Join(root, "target/release/libsmithers_ffi.dylib")
		if runtime.GOOS == "linux" {
			library = filepath.Join(root, "target/release/libsmithers_ffi.so")
		}
	}
	repository, err := repohostserver.New(repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "rehearsal-repo", FFILibraryPath: library})
	require.NoError(t, err, "build the repository's smithers-ffi library first")
	t.Cleanup(func() { require.NoError(t, repository.Shutdown(context.Background())) })
	repositoryServer := httptest.NewServer(repository.Handler())
	t.Cleanup(repositoryServer.Close)
	for name, value := range map[string]string{
		"SMITHERS_REPO_HOST_URL": repositoryServer.URL, "SMITHERS_AUTH_MODE": "selfhost", "SMITHERS_DATABASE_URL": databaseURL,
		"SMITHERS_PUBLIC_URL": origin, "SMITHERS_SERVER_ALLOWED_ORIGINS": origin, "SMITHERS_SERVER_ADDR": "127.0.0.1:0",
		"SMITHERS_AUTH_SESSION_SECRET": "rehearsal-session-secret", "SMITHERS_LFS_SIGNING_SECRET": "rehearsal-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "rehearsal-encryption-key", "SMITHERS_REPO_HOST_AUTH_TOKEN": "rehearsal-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN": "rehearsal-callback", "SMITHERS_BLOB_DATA_DIR": t.TempDir(),
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false", "SMITHERS_OTEL_EXPORTER": "none", "SMITHERS_METRICS_ADDR": "",
		"SMITHERS_AUTH_GITHUB_API_BASE_URL": fake.URL, "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL": fake.URL, "SMITHERS_GITHUB_APP_API_BASE_URL": fake.URL,
		// TODO branches are pushed to the fake's Git, never to github.com.
		"SMITHERS_GITHUB_GIT_BASE_URL": fake.URL,
	} {
		t.Setenv(name, value)
	}
	provider := localChatProvider(make(chan string, 16), "JOURNEY.md", "../../etc/passwd")
	t.Cleanup(provider.Close)
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	bundle := filepath.Join(t.TempDir(), "model-host")
	build := exec.Command(node, filepath.Join(root, "apps/model-host/build.mjs"), bundle)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	workspace, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, workspace.Close()) })
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{Runtime: workspace, NodeBinary: node, BundlePath: bundle})
	require.NoError(t, err)
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return databaseURL }, func() string { return "rehearsal-encryption-key" })
	require.NoError(t, err)
	host, err := modelhost.New(resolver, launcher)
	require.NoError(t, err)
	// The question before Machine ready must start no machine.
	compute := sandboxfake.New()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ready := make(chan http.Handler, 1)
	done := make(chan error, 1)
	logs := &lockedBuffer{}
	stdout := &lockedBuffer{}
	go func() {
		done <- StartWithOptions(ctx, nil, stdout, logs, Options{Repository: repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryServer.URL}, "rehearsal-repo"), Workspace: workspace, MachineImages: trustedProcessImages{sources: repositorySourceFiles{client: repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryServer.URL}, "rehearsal-repo")}}, ComputeProvider: compute, ChatHost: host, FlowHostProductAPIURL: origin}, func(h http.Handler) { ready <- h })
	}()
	select {
	case h := <-ready:
		server.Config.Handler = h
	case err := <-done:
		t.Fatalf("composition: %v\n%s", err, logs.String())
	case <-time.After(45 * time.Second):
		t.Fatalf("composition timed out: %s", logs.String())
	}
	server.Start()
	defer server.Close()
	defer func() {
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(15 * time.Second):
			t.Error("composition shutdown timed out")
		}
		_ = os.WriteFile(filepath.Join(evidence, "backend.log"), []byte(logs.String()), 0600)
	}()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var exchanges strings.Builder
	defer func() {
		require.NoError(t, os.WriteFile(filepath.Join(evidence, "http.log"), []byte(exchanges.String()), 0600))
	}()
	actual := ""
	location := ""
	tokenField := regexp.MustCompile(`"token":"[^"]*"`)
	request := func(method, path, body string) (int, []byte, error) {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("Idempotency-Key", "j1-"+strings.Trim(strings.ReplaceAll(path, "/", "-"), "-"))
		for _, cookie := range jar.Cookies(req.URL) {
			if cookie.Name == "__csrf" {
				req.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		resp, err := client.Do(req)
		if err != nil {
			actual = err.Error()
			return 0, nil, err
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		location = resp.Header.Get("Location")
		// Evidence never keeps a minted credential.
		logged := tokenField.ReplaceAll(data, []byte(`"token":"<redacted>"`))
		fmt.Fprintf(&exchanges, "%s %s → %d %s\n", method, strings.Split(path, "?")[0], resp.StatusCode, logged)
		excerpt := string(logged)
		if path == "/api/install" {
			var projection struct {
				Steps json.RawMessage `json:"steps"`
			}
			if json.Unmarshal(data, &projection) == nil {
				excerpt = `{"steps":` + string(projection.Steps) + `}`
			}
		}
		actual = fmt.Sprintf("%d %s", resp.StatusCode, excerpt)
		return resp.StatusCode, data, err
	}
	expect := func(method, path, body string, status int) ([]byte, error) {
		code, data, err := request(method, path, body)
		if err != nil {
			return data, err
		}
		if code != status {
			return data, fmt.Errorf("expected HTTP %d: %s", status, actual)
		}
		return data, nil
	}
	waitStep := func(id string) error {
		// Steps finish in background workers; Source waits out the durable
		// importer's clone of main.
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			data, err := expect("GET", "/api/install", "", 200)
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
		reason := actual
		if id == "source" {
			for _, line := range strings.Split(logs.String(), "\n") {
				var entry map[string]any
				if json.Unmarshal([]byte(line), &entry) == nil && entry["message"] == "mirror.import.reconcile_failed" {
					reason = fmt.Sprint(entry["error"])
				}
			}
		}
		return fmt.Errorf("%s did not complete: %s", id, reason)
	}
	sourceReady := false
	continuing := os.Getenv("J1_REHEARSAL_CONTINUE") == "1"
	step := func(name, route, expected, ticket string, run func() error) bool {
		actual = ""
		ok := t.Run(name, func(t *testing.T) {
			if err := run(); err != nil {
				actual = err.Error() + "; " + actual
				t.Error(err)
			}
		})
		result := "pass"
		if !ok {
			result = "fail"
		}
		excerpt := strings.Join(strings.Fields(actual), " ")
		if len(excerpt) > 220 {
			excerpt = excerpt[:220]
		}
		table += strings.Join([]string{name, route, expected, excerpt, result, ticket}, "\t") + "\n"
		return ok || continuing
	}
	var mint struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal([]byte(stdout.String()), &mint))
	require.NotEmpty(t, mint.URLs)
	setupURL, err := url.Parse(mint.URLs[0])
	require.NoError(t, err)
	if !step("setup URL token", "GET /setup?token=<printed>", "303; token removed; setup cookie", "T-INS-08, T-ACC-01", func() error {
		_, err := expect("GET", setupURL.RequestURI(), "", 303)
		if err != nil {
			return err
		}
		if location != "/" {
			return fmt.Errorf("redirect %q", location)
		}
		for _, cookie := range jar.Cookies(mustRehearsalURL(origin)) {
			if cookie.Name == "smithers_setup_session" {
				return nil
			}
		}
		return fmt.Errorf("setup cookie missing")
	}) {
		return
	}
	if !step("setup session", "GET /api/install", "200; seven ordered pending steps", "T-INS-06", func() error {
		data, err := expect("GET", "/api/install", "", 200)
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
		return
	}
	if !step("1 Address", "POST /api/install/setup/address → GET /api/install", "202 → address done", "T-INS-06", func() error {
		body, _ := json.Marshal(map[string]any{"bind": "127.0.0.1:4000", "origins": []string{origin}})
		if _, err := expect("POST", "/api/install/setup/address", string(body), 202); err != nil {
			return err
		}
		return waitStep("address")
	}) {
		return
	}
	if !step("2 GitHub App", "POST /api/install/setup/app → GET /setup/github/callback", "200 manifest out; 303 conversion back; app_manifest done", "T-GH-01", func() error {
		data, err := expect("POST", "/api/install/setup/app", `{"owner":"rehearsal-owner"}`, 200)
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
		if _, err = expect("GET", "/setup/github/callback?code=manifest-code&state="+url.QueryEscape(v.State), "", 303); err != nil {
			return err
		}
		return waitStep("app_manifest")
	}) {
		return
	}
	if !step("3 Owner sign-in", "GET /api/auth/github → GET /api/auth/github/callback", "302 → 302; sign_in done; browser session", "T-ACC-01", func() error {
		if _, err := expect("GET", "/api/auth/github", "", 302); err != nil {
			return err
		}
		u, err := url.Parse(location)
		if err != nil {
			return err
		}
		if _, err = expect("GET", "/api/auth/github/callback?code=owner-code&state="+url.QueryEscape(u.Query().Get("state")), "", 302); err != nil {
			return err
		}
		return waitStep("sign_in")
	}) {
		return
	}
	if !step("4 Repository", "POST /api/install/setup/repository → GET /api/install", "202 → repository done; owner verified; squash enabled", "T-INS-06, T-ACC-01", func() error {
		if _, err := expect("POST", "/api/install/setup/repository", `{"repository":"rehearsal-owner/app"}`, 202); err != nil {
			return err
		}
		return waitStep("repository")
	}) {
		return
	}
	if !step("5 Model access", "POST /api/model/credential; PUT /api/model/default; POST /api/install/setup/models", "sealed coding/Gateway keys; models done", "T-INS-06", func() error {
		for _, c := range []struct{ Name, Origin string }{{"TEST_PROVIDER", provider.URL}, {"AI_GATEWAY_API_KEY", "https://ai-gateway.vercel.sh"}} {
			body, _ := json.Marshal(map[string]string{"action": "enroll", "requestId": uuid.NewString(), "name": c.Name, "origin": c.Origin, "value": "rehearsal-key"})
			data, err := expect("POST", "/api/model/credential", string(body), 200)
			if err != nil {
				return err
			}
			if !strings.Contains(string(data), `"ok":true`) {
				return fmt.Errorf("credential refused: %s", data)
			}
		}
		body, _ := json.Marshal(map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": "TEST_PROVIDER", "baseUrl": provider.URL}})
		if _, err := expect("PUT", "/api/model/default", string(body), 200); err != nil {
			return err
		}
		if _, err := expect("POST", "/api/install/setup/models", `{}`, 202); err != nil {
			return err
		}
		return waitStep("models")
	}) {
		return
	}
	if !step("6 source ready", "POST /api/install/setup/source → GET /api/install", "202 → source done (separate readiness)", "T-INS-06, T-MCH-10", func() error {
		if _, err := expect("POST", "/api/install/setup/source", `{}`, 202); err != nil {
			return err
		}
		err := waitStep("source")
		sourceReady = err == nil
		return err
	}) {
		return
	}
	if !step("App agent question", "POST "+chat.TurnPath, "200; answer with file cards after Source ready", "T-INS-06, T-APP-03, T-FLW-01", func() error {
		type turnFrame struct {
			Type    string `json:"type"`
			Name    string `json:"name"`
			Text    string `json:"text"`
			Kind    string `json:"kind"`
			Message string `json:"message"`
			Card    struct {
				Kind    string `json:"kind"`
				Payload struct {
					Path    string `json:"path"`
					Content string `json:"content"`
					ReadAt  struct {
						CommitID string `json:"commitId"`
					} `json:"readAt"`
				} `json:"payload"`
			} `json:"card"`
		}
		// ask posts one question from the composer's wire, with no tools of
		// its own, so the host runs the turn's reads. A bearer token asks as
		// that token instead of the owner's browser session.
		ask := func(bearer, question string) (string, []turnFrame, bool, error) {
			body, _ := json.Marshal(map[string]any{"runId": "j1-" + uuid.NewString(), "journal": map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("a", 48)}, "instructions": "Answer briefly using file cards.", "messages": []any{map[string]string{"role": "user", "content": question}}})
			var data []byte
			var err error
			if bearer == "" {
				data, err = expect("POST", chat.TurnPath, string(body), 200)
			} else {
				req, reqErr := http.NewRequest("POST", origin+chat.TurnPath, bytes.NewReader(body))
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
				fmt.Fprintf(&exchanges, "POST %s (bearer) → %d %s\n", chat.TurnPath, resp.StatusCode, data)
				if err == nil && resp.StatusCode != 200 {
					err = fmt.Errorf("bearer turn: HTTP %d %s", resp.StatusCode, data)
				}
			}
			if err != nil {
				return "", nil, false, err
			}
			var answer strings.Builder
			var frames []turnFrame
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
					var frame turnFrame
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
		token := func(scopes ...string) (string, error) {
			body, _ := json.Marshal(map[string]any{"name": "j1-" + strings.Join(scopes, "-"), "scopes": scopes})
			data, err := expect("POST", "/api/user/tokens", string(body), 201)
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
		// Tokens are minted first, so the row's evidence ends on a question.
		chatOnly, err := token("write:user")
		if err != nil {
			return err
		}
		reader, err := token("write:user", "read:repository")
		if err != nil {
			return err
		}
		creates, live := len(compute.Creates()), len(compute.Live())
		answer, frames, terminal, err := ask("", "What is in JOURNEY.md? Show the file.")
		if err != nil {
			return err
		}
		if !sourceReady {
			return fmt.Errorf("Source ready absent before the answer; file-card journey remains blocked")
		}
		fileRead, fileCard, toolCall := false, false, false
		for _, frame := range frames {
			fileRead = fileRead || (frame.Type == "call.settled" && frame.Name == "files.read")
			toolCall = toolCall || frame.Type == "tool_call"
			if frame.Type == "card" && frame.Card.Kind == "file" && frame.Card.Payload.Path == "JOURNEY.md" {
				// The card holds main's bytes at the mirrored commit.
				if frame.Card.Payload.Content != "Add a greeting to JOURNEY.md\n" || frame.Card.Payload.ReadAt.CommitID != mainCommit {
					return fmt.Errorf("file card is not main at %s: %q at %q", mainCommit, frame.Card.Payload.Content, frame.Card.Payload.ReadAt.CommitID)
				}
				fileCard = true
			}
		}
		// The answer quotes the file, which only the host's read put in its context.
		if !terminal || !fileRead || !fileCard || toolCall || !strings.Contains(answer, "Add a greeting to JOURNEY.md") {
			return fmt.Errorf("answer/file card missing (terminal=%t file_read=%t file_card=%t renderer_tool_call=%t) answer=%q", terminal, fileRead, fileCard, toolCall, answer)
		}
		// A path out of the repository is refused, stated and answered; no card.
		answer, frames, terminal, err = ask("", "Show ../../etc/passwd")
		if err != nil {
			return err
		}
		refused := false
		for _, frame := range frames {
			if frame.Type == "card" {
				return fmt.Errorf("traversal read rendered a %s card", frame.Card.Kind)
			}
			refused = refused || (frame.Type == "gate.rejected" && frame.Kind == "call_failed" && strings.Contains(frame.Message, "is not a path inside this repository"))
		}
		if !terminal || !refused || !strings.Contains(answer, "failed: ../../etc/passwd is not a path inside this repository") {
			return fmt.Errorf("traversal refusal missing (terminal=%t refused=%t) answer=%q", terminal, refused, answer)
		}
		// A token that may chat but not read repositories reads nothing
		// through the agent: no tool is offered, a call made anyway runs
		// nothing, and no byte of the file reaches the answer. A token that
		// reads repositories gets the File card.
		for _, question := range []string{"What is in JOURNEY.md? Show the file.", "What is in JOURNEY.md? (forced)"} {
			answer, frames, terminal, err = ask(chatOnly, question)
			if err != nil {
				return err
			}
			for _, frame := range frames {
				if frame.Type == "card" || frame.Type == "call.started" || frame.Type == "call.settled" || frame.Type == "gate.rejected" {
					return fmt.Errorf("a write:user token's question ran %s %s", frame.Type, frame.Name)
				}
			}
			if !terminal || strings.Contains(answer, "Add a greeting") {
				return fmt.Errorf("a write:user token's question read source (terminal=%t) answer=%q", terminal, answer)
			}
		}
		if !strings.Contains(answer, "unknown-tool: commands") {
			return fmt.Errorf("a forced call by a write:user token was not refused: %q", answer)
		}
		answer, frames, terminal, err = ask(reader, "What is in JOURNEY.md? Show the file.")
		if err != nil {
			return err
		}
		fileCard = false
		for _, frame := range frames {
			fileCard = fileCard || (frame.Type == "card" && frame.Card.Kind == "file" && frame.Card.Payload.Content == "Add a greeting to JOURNEY.md\n")
		}
		if !terminal || !fileCard || !strings.Contains(answer, "Add a greeting to JOURNEY.md") {
			return fmt.Errorf("a read:repository token's question got no File card (terminal=%t card=%t) answer=%q", terminal, fileCard, answer)
		}
		if len(compute.Creates()) != creates || len(compute.Live()) != live {
			return fmt.Errorf("a question started a machine: creates %d→%d, live %d→%d", creates, len(compute.Creates()), live, len(compute.Live()))
		}
		return nil
	}) {
		return
	}
	if !step("6 machine ready", "POST /api/install/setup/machine → GET /api/install", "202 → machine done (separate readiness)", "T-INS-06, T-MCH-10", func() error {
		if _, err := expect("POST", "/api/install/setup/machine", `{}`, 202); err != nil {
			return err
		}
		return waitStep("machine")
	}) {
		return
	}
	var number int64
	if !step("First TODO", "GET /api/repos/{o}/{r}/mythical; POST /api/todos", "stack active; 202 accepted; positive n; exact app place body", "T-STK-01", func() error {
		// Source ready asked for the stack and did not wait for it (§8.6.3); the
		// stack worker activates it, and a TODO is accepted only then.
		deadline := time.Now().Add(30 * time.Second)
		for {
			data, err := expect("GET", "/api/repos/rehearsal-owner/app/mythical", "", 200)
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
				break
			}
			if stack.State == "frozen" || !time.Now().Before(deadline) {
				return fmt.Errorf("stack not active: state=%s reason=%q last_error=%q", stack.State, stack.Reason, stack.LastError)
			}
			time.Sleep(100 * time.Millisecond)
		}
		data, err := expect("POST", "/api/todos", `{"title":"First TODO","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, 202)
		if err != nil {
			return err
		}
		var v struct {
			N     int64  `json:"n"`
			State string `json:"state"`
		}
		if err = json.Unmarshal(data, &v); err != nil {
			return err
		}
		number = v.N
		if number <= 0 || v.State != "accepted" {
			return fmt.Errorf("invalid TODO receipt")
		}
		return nil
	}) {
		return
	}
	todoPath := "/api/todos/{n}"
	if number > 0 {
		todoPath = fmt.Sprintf("/api/todos/%d", number)
	}
	head := ""
	var prNumber int64
	for _, state := range []string{"queued", "starting", "working", "in_review"} {
		if !step("TODO "+state, "GET "+todoPath, "200 state="+state, "T-STK-01", func() error {
			if number <= 0 {
				return fmt.Errorf("blocked by First TODO: no TODO number from public creation receipt")
			}
			deadline := time.Now().Add(3 * time.Second)
			for {
				data, err := expect("GET", todoPath, "", 200)
				if err != nil {
					return err
				}
				var v struct {
					State string `json:"state"`
					PR    struct {
						Number int64  `json:"number"`
						Head   string `json:"head"`
					} `json:"pr"`
				}
				if err = json.Unmarshal(data, &v); err != nil {
					return err
				}
				if v.State == state {
					head = v.PR.Head
					prNumber = v.PR.Number
					return nil
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("state %q, expected %q", v.State, state)
				}
				time.Sleep(40 * time.Millisecond)
			}
		}) {
			return
		}
	}
	readFakePull := func() (githubfake.Pull, error) {
		codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
		if err != nil {
			return githubfake.Pull{}, err
		}
		credentials := services.NewGitHubAppCredentialStore(pool, codec)
		tokens := services.NewRepoConnectionService(pool, credentials)
		access, err := tokens.CreateGitHubInstallationTokenForInternalInstallation(ctx, 91)
		if err != nil {
			return githubfake.Pull{}, err
		}
		jwt := access.Token
		req, err := http.NewRequest("GET", fmt.Sprintf("%s/repos/rehearsal-owner/app/pulls/%d", fake.URL, prNumber), nil)
		if err != nil {
			return githubfake.Pull{}, err
		}
		req.Header.Set("Authorization", "Bearer "+jwt)
		resp, err := fake.Client().Do(req)
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
	if !step("PR", "GET GitHub fake /repos/rehearsal-owner/app/pulls/{n}", "head smithers/<slug>; base main; reviewed head", "T-STK-01", func() error {
		if prNumber <= 0 {
			return fmt.Errorf("no PR number from TODO")
		}
		p, err := readFakePull()
		if err != nil {
			return err
		}
		actual = fmt.Sprintf("200 head=%s sha=%s base=%s", p.Head.Ref, p.Head.SHA, p.Base.Ref)
		if !strings.HasPrefix(p.Head.Ref, "smithers/") || p.Base.Ref != "main" || p.Head.SHA != head {
			return fmt.Errorf("PR contract mismatch")
		}
		return nil
	}) {
		return
	}
	if !step("Merge in Smithers", "POST "+todoPath+"/merge", "202; reviewed head; browser session; one checks.Land", "T-STK-04", func() error {
		if number <= 0 || head == "" {
			return fmt.Errorf("blocked by First TODO/PR: no reviewed head from public routes")
		}
		body, _ := json.Marshal(map[string]string{"reviewed_head_sha": head})
		if _, err := expect("POST", todoPath+"/merge", string(body), 202); err != nil {
			return err
		}
		session := ""
		for _, cookie := range jar.Cookies(mustRehearsalURL(origin)) {
			if cookie.Name == "smithers_session" {
				digest := sha256.Sum256([]byte(cookie.Value))
				session = hex.EncodeToString(digest[:])
			}
		}
		if session == "" {
			return fmt.Errorf("browser session credential absent")
		}
		var count int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE number=$1 AND checks->'land'->>'head'=$2 AND checks->'land'->>'session'=$3`, number, head, session).Scan(&count)
		if err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("expected one session-bound checks.Land, got %d", count)
		}
		return nil
	}) {
		return
	}
	step("Merged", "GET "+todoPath, "merged only after GitHub merge receipt", "T-STK-04", func() error {
		if number <= 0 {
			return fmt.Errorf("blocked by First TODO: no TODO number from public creation receipt")
		}
		deadline := time.Now().Add(3 * time.Second)
		for {
			data, err := expect("GET", todoPath, "", 200)
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
				p, err := readFakePull()
				if err != nil {
					return err
				}
				if !p.Merged || p.MergedAt == nil || len(p.MergeCommitSHA) != 40 {
					return fmt.Errorf("TODO merged before GitHub reported a merge")
				}
				for _, write := range fake.Writes() {
					if write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge") && write.Status == 200 {
						var input struct {
							SHA    string `json:"sha"`
							Method string `json:"merge_method"`
						}
						if json.Unmarshal(write.Body, &input) == nil && input.Method == "squash" && input.SHA == head {
							return nil
						}
					}
				}
				return fmt.Errorf("no successful head-bound squash GitHub receipt")
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("TODO state %q, expected merged", v.State)
			}
			time.Sleep(40 * time.Millisecond)
		}
	})
}

func mustRehearsalURL(raw string) *url.URL { u, _ := url.Parse(raw); return u }

// trustedProcessImages is the machine image adapter for the trusted-process
// runtime the rehearsal composes. Its machines run on the host toolchain, so it
// can provide only the base image: it reads main's recipe through the mirror
// and refuses one that needs a layer (a target index, image additions or a
// detected toolchain). "6 machine ready" therefore proves setup admission,
// persistence and fencing, not an image build; the install bundle leaves step
// 6 unbound until R4 passes (installMachineImages).
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
