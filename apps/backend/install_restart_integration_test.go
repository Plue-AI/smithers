package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

// Uses the existing compiled test-backend entry and real production composition.
// The process runtime is tests-only; this never qualifies VM recipe isolation.
func TestInstallSetupCompiledHostRestart(t *testing.T) {
	for _, boundary := range []string{"running admission", "address effect", "owner claim", "owner claim configured origins", "owner claim sealed Gateway", "app conversion consumed"} {
		t.Run(boundary, func(t *testing.T) { testInstallSetupCompiledHostRestart(t, boundary) })
	}
}

func testInstallSetupCompiledHostRestart(t *testing.T, boundary string) {
	if os.Getenv("SMITHERS_FFI_LIBRARY_PATH") == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH required for compiled host restart")
	}
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	root := t.TempDir()
	// No flow/model executes during address setup. Pinned unused host fixtures
	// satisfy the ordinary composition without adding a production fault hook.
	host := []byte("#!/bin/sh\nexit 1\n")
	for _, name := range []string{"coding-host", "model-host"} {
		require.NoError(t, os.WriteFile(filepath.Join(root, name), host, 0700))
	}
	sum := sha256.Sum256(host)
	digest := hex.EncodeToString(sum[:])
	require.NoError(t, os.WriteFile(filepath.Join(root, "model-host.sha256"), []byte(digest+"  model-host\n"), 0600))
	manifest := `{"version":1,"hosts":{"coding":{"executable":"coding-host","sha256":"` + digest + `","flows":["coding/dispatch"]}}}`
	require.NoError(t, os.WriteFile(filepath.Join(root, "flow-hosts.json"), []byte(manifest), 0600))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close())
	origin := "http://" + addr
	state := filepath.Join(root, "state")
	nodeFixture, err := filepath.EvalSymlinks("/bin/sh")
	require.NoError(t, err)
	environment := map[string]string{
		testBackendServe: "1", "SMITHERS_WORKSPACE_ISOLATION": "process",
		"SMITHERS_DATABASE_URL": databaseURL, "SMITHERS_DATA_ROOT": state,
		"SMITHERS_NATIVE_POSTGRES_BIN": "", "SMITHERS_NATIVE_STATE_DIR": state,
		"SMITHERS_BLOB_DATA_DIR":       filepath.Join(state, "blobs"),
		"SMITHERS_AUTH_MODE":           "selfhost",
		"SMITHERS_AUTH_SESSION_SECRET": "restart-session-secret", "SMITHERS_LFS_SIGNING_SECRET": "restart-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "restart-encryption-secret",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "restart-repo-token", "SMITHERS_PUSH_HOOK_CALLBACK_TOKEN": "restart-push-token",
		"SMITHERS_SERVER_ADDR": addr, "SMITHERS_PUBLIC_URL": origin,
		"SMITHERS_FLOW_HOST_MANIFEST": filepath.Join(root, "flow-hosts.json"),
		"SMITHERS_MODEL_HOST_BUNDLE":  filepath.Join(root, "model-host"), "SMITHERS_NODE_BINARY": nodeFixture,
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false", "SMITHERS_FEATURE_FLAGS_SANDBOXES": "true",
		"SMITHERS_WORKSPACE_JJ_EXPORT_BINARY": filepath.Join(filepath.Dir(os.Getenv("SMITHERS_FFI_LIBRARY_PATH")), "smithers-jj-export"),
	}
	if boundary == "app conversion consumed" {
		github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/users/acme" {
				_, _ = w.Write([]byte(`{"type":"Organization"}`))
				return
			}
			t.Errorf("unexpected GitHub request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
		}))
		t.Cleanup(github.Close)
		environment["SMITHERS_GITHUB_APP_API_BASE_URL"] = github.URL
	}
	var traces setupProcessBuffer
	var tracedPaths sync.Map
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var reader io.Reader = r.Body
		if r.Header.Get("Content-Encoding") == "gzip" {
			decoded, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Error("invalid compressed trace batch")
				w.WriteHeader(400)
				return
			}
			defer decoded.Close()
			reader = decoded
		}
		payload, err := io.ReadAll(reader)
		if err != nil {
			t.Error("trace batch read failed")
			w.WriteHeader(400)
			return
		}
		traces.Write(payload)
		var batch collectortrace.ExportTraceServiceRequest
		if err := proto.Unmarshal(payload, &batch); err != nil {
			t.Error("invalid exported trace batch")
			w.WriteHeader(400)
			return
		}
		for _, resource := range batch.ResourceSpans {
			for _, scope := range resource.ScopeSpans {
				for _, span := range scope.Spans {
					for _, attribute := range span.Attributes {
						switch attribute.Key {
						case "url.path", "url.full", "http.target", "http.url":
							if parsed, err := url.Parse(attribute.Value.GetStringValue()); err == nil {
								tracedPaths.Store(parsed.Path, true)
							}
						}
					}
				}
			}
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(200)
	}))
	t.Cleanup(collector.Close)
	environment["SMITHERS_OTEL_EXPORTER"] = "otlp"
	environment["SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT"] = collector.URL
	environment["SMITHERS_TRACE_SAMPLE_RATE"] = "1"
	var gatewayCalls atomic.Int32
	if boundary == "owner claim sealed Gateway" {
		gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "Bearer sealed-restart-gateway-key", r.Header.Get("Authorization"))
			gatewayCalls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"answers":{"command1":{"type":"choice","choice":"none"}}}`))
		}))
		t.Cleanup(gateway.Close)
		environment["SMITHERS_JEV_ENDPOINT"] = gateway.URL
		environment["AI_GATEWAY_API_KEY"] = "hostile-env-key"
		platformFile := filepath.Join(root, "hostile-platform-keys.json")
		require.NoError(t, os.WriteFile(platformFile, []byte(`{"vercel":"hostile-file-key"}`), 0600))
		environment["SMITHERS_PLATFORM_MODEL_KEYS_FILE"] = platformFile
	}
	ownerClaim := strings.HasPrefix(boundary, "owner claim")
	if ownerClaim {
		environment["SMITHERS_PUBLIC_URL"] = "http://localhost:4000"
		githubURL := testkit.InstallOwnerOAuth(t, pool, "http://localhost:4000", "restart-encryption-secret")
		for _, key := range []string{"SMITHERS_AUTH_GITHUB_API_BASE_URL", "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL", "SMITHERS_GITHUB_APP_API_BASE_URL"} {
			environment[key] = githubURL
		}
		if boundary == "owner claim configured origins" {
			_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('public_origins','["http://lan-a:4000","https://box.example"]')`)
			require.NoError(t, err)
		}
	}
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	// This is a recovery fixture, not a latency check; the shared host may
	// be compiling other lanes while PostgreSQL resolves the status model.
	var responses setupProcessBuffer
	client := &http.Client{Jar: jar, Timeout: 15 * time.Second, Transport: setupTraceTransport{captured: &responses}}
	var captures []*setupProcessCapture
	secrets := []string{}
	t.Cleanup(func() {
		for _, secret := range secrets {
			require.False(t, strings.Contains(responses.String()+traces.String(), secret) || strings.Contains(responses.String()+traces.String(), url.QueryEscape(secret)), "credential leaked in HTTP response or exported trace")
		}
		for _, capture := range captures {
			require.False(t, capture.invalidMint.Load(), "invalid or duplicate setup mint line")
			// The only permitted plaintext copy is the complete mint line.
			for _, output := range []string{capture.logs.String(), capture.ordinary.String()} {
				for _, secret := range secrets {
					require.False(t, strings.Contains(output, secret) || strings.Contains(output, url.QueryEscape(secret)), "credential leaked outside the mint line")
				}
			}
		}
	})
	start := func() (*exec.Cmd, <-chan []string) {
		command := exec.Command(os.Args[0], "-test.run=^TestServeTrustedProcessBackend$", "-test.count=1", "-test.timeout=0")
		command.Env = os.Environ()
		for key, value := range environment {
			command.Env = append(command.Env, key+"="+value)
		}
		stdout, err := command.StdoutPipe()
		require.NoError(t, err)
		// Captures stay local: setup tokens must never enter test logs.
		capture := &setupProcessCapture{}
		captures = append(captures, capture)
		command.Stderr = &capture.logs
		bootFailure := make(chan string, 1)
		minted := make(chan []string, 1)
		drained := make(chan struct{})
		require.NoError(t, command.Start())
		go func() {
			defer close(drained)
			reader := bufio.NewReader(stdout)
			mintCount := 0
			for {
				lineBytes, readErr := reader.ReadBytes('\n')
				if len(lineBytes) == 0 {
					return
				}
				lineText := string(lineBytes)
				if strings.Contains(lineText, "test_backend_test.go:") {
					bootFailure <- lineText
				}
				var line struct {
					URLs []string `json:"setup_urls"`
				}
				if json.Unmarshal(lineBytes, &line) == nil && len(line.URLs) > 0 {
					mintCount++
					if mintCount != 1 || !bytes.HasSuffix(lineBytes, []byte("\n")) {
						capture.invalidMint.Store(true)
					}
					var fields map[string]json.RawMessage
					if json.Unmarshal(lineBytes, &fields) != nil || len(fields) != 1 {
						capture.invalidMint.Store(true)
					}
					select {
					case minted <- line.URLs:
					default:
					}
				} else {
					_, _ = capture.ordinary.Write(lineBytes)
				}
				if readErr != nil {
					return
				}
			}
		}()
		t.Cleanup(func() {
			_ = command.Process.Kill()
			_ = command.Wait()
			select {
			case <-drained:
			case <-time.After(5 * time.Second):
				t.Error("stdout capture did not drain")
			}
		})
		require.Eventually(t, func() bool {
			select {
			case failure := <-bootFailure:
				t.Fatalf("compiled host startup: %s", failure)
			default:
			}
			response, err := client.Get(origin + "/readyz")
			if err != nil {
				return false
			}
			response.Body.Close()
			return response.StatusCode == 200
		}, 60*time.Second, 100*time.Millisecond, "compiled host did not become ready")
		return command, minted
	}
	command, minted := start()
	var setupURLs []string
	select {
	case setupURLs = <-minted:
	case <-time.After(5 * time.Second):
		t.Fatal("setup URL was not emitted")
	}
	if ownerClaim {
		readMint := func(lines <-chan []string) []string {
			t.Helper()
			select {
			case urls := <-lines:
				return urls
			case <-time.After(5 * time.Second):
				t.Fatal("missing mint output")
				return nil
			}
		}
		tokenOf := func(urls []string) string {
			t.Helper()
			expected := []string{"http://localhost:4000/setup?token="}
			if boundary == "owner claim configured origins" {
				expected = append(expected, "http://lan-a:4000/setup?token=", "https://box.example/setup?token=")
			}
			require.Len(t, urls, len(expected))
			var token string
			for i, raw := range urls {
				require.True(t, strings.HasPrefix(raw, expected[i]), "unexpected setup origin")
				parsed, err := url.Parse(raw)
				require.NoError(t, err)
				if i == 0 {
					token = parsed.Query().Get("token")
					require.True(t, len(token) == 64, "setup token must have 64 bytes")
				}
				require.True(t, token == parsed.Query().Get("token"), "setup origins must share one token")
			}
			sum := sha256.Sum256([]byte(token))
			var stored string
			require.NoError(t, pool.QueryRow(ctx, `SELECT value #>> '{}' FROM install_settings WHERE key='setup.token'`).Scan(&stored))
			require.Equal(t, hex.EncodeToString(sum[:]), stored)
			return token
		}
		oldToken := tokenOf(setupURLs)
		secrets = append(secrets, oldToken)
		require.NoError(t, command.Process.Kill())
		require.Error(t, command.Wait())
		command, minted = start()
		token := tokenOf(readMint(minted))
		secrets = append(secrets, token)
		require.False(t, oldToken == token, "restart must rotate the token")
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		get := func(path string, status int) *http.Response {
			t.Helper()
			request, err := http.NewRequest("GET", origin+path, nil)
			require.NoError(t, err)
			request.Header.Set("X-Forwarded-Host", "localhost:4000")
			response, err := client.Do(request)
			require.NoError(t, err)
			if response.StatusCode != status {
				responseBody, _ := io.ReadAll(response.Body)
				response.Body.Close()
				diagnostic := string(responseBody) + "\n" + captures[len(captures)-1].logs.String()
				for _, secret := range secrets {
					diagnostic = strings.ReplaceAll(diagnostic, secret, "<redacted>")
				}
				t.Fatalf("%s: wanted %d, got %d; host logs: %s", request.URL.Path, status, response.StatusCode, diagnostic)
			}
			return response
		}
		get("/setup?token="+oldToken, 401).Body.Close()
		get("/api/auth/github", 401).Body.Close()
		exchanged := get("/setup?token="+token, 303)
		for _, cookie := range exchanged.Cookies() {
			if cookie.Name == "smithers_setup_session" {
				secrets = append(secrets, cookie.Value)
			}
		}
		exchanged.Body.Close()
		get("/api/install", 200).Body.Close()
		get("/api/status", 403).Body.Close()
		get("/setup/github/callback", 403).Body.Close()
		started := get("/api/auth/github", 302)
		target := started.Header.Get("Location")
		started.Body.Close()
		require.False(t, strings.Contains(target, token), "OAuth state must not contain the setup token")
		response, err := http.Get(target)
		require.NoError(t, err)
		page, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		callback, err := url.Parse(html.UnescapeString(strings.Split(strings.Split(string(page), `href="`)[1], `"`)[0]))
		require.NoError(t, err)
		get(callback.RequestURI(), 302).Body.Close()
		var owners, sessions int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM self_host_owners`).Scan(&owners))
		require.Equal(t, 1, owners)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='setup.token' OR key LIKE 'setup.session.%'`).Scan(&sessions))
		require.Zero(t, sessions)
		// Crash before repository verification: the owner remains provisional,
		// their real browser session and setup projection survive restart.
		before := get("/api/install", 200)
		require.Eventually(t, func() bool { return strings.Contains(traces.String(), "/api/auth/github/callback") }, 15*time.Second, 50*time.Millisecond, "trace capture must contain exported spans")
		beforeBody, err := io.ReadAll(before.Body)
		before.Body.Close()
		require.NoError(t, err)
		require.NoError(t, command.Process.Kill())
		require.Error(t, command.Wait())
		command, minted = start()
		select {
		case <-minted:
			t.Fatal("claimed install emitted setup authority")
		case <-time.After(250 * time.Millisecond):
		}
		after := get("/api/install", 200)
		afterBody, err := io.ReadAll(after.Body)
		after.Body.Close()
		require.NoError(t, err)
		var beforeModel, afterModel map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(beforeBody, &beforeModel))
		require.NoError(t, json.Unmarshal(afterBody, &afterModel))
		require.JSONEq(t, string(beforeModel["steps"]), string(afterModel["steps"]))
		refused := get("/api/todos", 403)
		body, err := io.ReadAll(refused.Body)
		refused.Body.Close()
		require.NoError(t, err)
		require.JSONEq(t, `{"class":"permission","code":"owner_unverified","fault":"user","message":"owner_unverified"}`, string(body))
		get("/api/members", 403).Body.Close()
		get("/api/status", 200).Body.Close()
		// Every mounted setup mutation refuses a malformed request before
		// admitting work. Capture each error surface without external effects.
		for _, step := range []string{"address", "app", "sign_in", "repository", "models", "source", "machine", "settings"} {
			method, path := "POST", "/api/install/setup/"+step
			if step == "settings" {
				method, path = "PUT", "/api/install"
			}
			request, err := http.NewRequest(method, origin+path, strings.NewReader("{"))
			require.NoError(t, err)
			request.Header.Set("X-Forwarded-Host", "localhost:4000")
			request.Header.Set("Origin", "http://localhost:4000")
			request.Header.Set("Content-Type", "application/json")
			for _, cookie := range jar.Cookies(request.URL) {
				if cookie.Name == "__csrf" {
					request.Header.Set("X-CSRF-Token", cookie.Value)
				}
			}
			response, err := client.Do(request)
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, 400, response.StatusCode, step)
		}
		require.Eventually(t, func() bool { return strings.Contains(traces.String(), "/api/install/setup/machine") }, 15*time.Second, 50*time.Millisecond, "setup mutation trace batch must be captured before another crash")
		post, err := http.NewRequest("POST", origin+"/api/todos", strings.NewReader(`{"title":"must not exist"}`))
		require.NoError(t, err)
		post.Header.Set("X-Forwarded-Host", "localhost:4000")
		post.Header.Set("Origin", "http://localhost:4000")
		post.Header.Set("Content-Type", "application/json")
		for _, cookie := range jar.Cookies(post.URL) {
			if cookie.Name == "__csrf" {
				post.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		refusedPost, err := client.Do(post)
		require.NoError(t, err)
		postBody, err := io.ReadAll(refusedPost.Body)
		refusedPost.Body.Close()
		require.NoError(t, err)
		require.Equal(t, 403, refusedPost.StatusCode)
		require.JSONEq(t, `{"class":"permission","code":"owner_unverified","fault":"user","message":"owner_unverified"}`, string(postBody))
		get("/setup?token="+token, 401).Body.Close()
		get("/setup/github/installed?installation_id=999999", 303).Body.Close()
		for _, route := range []string{"status", "bootstrap", "login", "token", "password"} {
			get("/api/auth/local/"+route, 404).Body.Close()
		}
		if boundary == "owner claim sealed Gateway" {
			secrets = append(secrets, "sealed-restart-gateway-key", "hostile-env-key", "hostile-file-key")
			call := func(path, body string, status int) []byte {
				t.Helper()
				request, err := http.NewRequest("POST", origin+path, strings.NewReader(body))
				require.NoError(t, err)
				request.Header.Set("X-Forwarded-Host", "localhost:4000")
				request.Header.Set("Origin", "http://localhost:4000")
				request.Header.Set("Content-Type", "application/json")
				for _, cookie := range jar.Cookies(request.URL) {
					if cookie.Name == "__csrf" {
						request.Header.Set("X-CSRF-Token", cookie.Value)
					}
				}
				response, err := client.Do(request)
				require.NoError(t, err)
				defer response.Body.Close()
				payload, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				diagnostic := string(payload)
				for _, secret := range secrets {
					diagnostic = strings.ReplaceAll(diagnostic, secret, "<redacted>")
				}
				require.Equal(t, status, response.StatusCode, "route %s: %s", path, diagnostic)
				for _, secret := range secrets {
					require.False(t, strings.Contains(string(payload), secret), "credential leaked in response")
				}
				return payload
			}
			// Seed verified repository authority; sign-in and enrollment use HTTP.
			var ownerID, repositoryID int64
			var login string
			require.NoError(t, pool.QueryRow(ctx, `SELECT o.user_id,u.username FROM self_host_owners o JOIN users u ON u.id=o.user_id`).Scan(&ownerID, &login))
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'gateway','gateway') RETURNING id`, ownerID).Scan(&repositoryID))
			_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repositoryID, ownerID)
			require.NoError(t, err)
			verified, err := json.Marshal(map[string]any{"owner_login": login, "repository_name": "gateway", "repository_id": repositoryID, "last_access_check_at": time.Now().UTC()})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('owner.access',$1),('github.repository',$1),('agent:jev','{"protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`, verified)
			require.NoError(t, err)
			payload := call("/api/model/credential", `{"action":"enroll","requestId":"restart-gateway-enroll","name":"AI_GATEWAY_API_KEY","origin":"https://ai-gateway.vercel.sh","value":"sealed-restart-gateway-key"}`, 200)
			var saved struct {
				OK bool `json:"ok"`
			}
			require.NoError(t, json.Unmarshal(payload, &saved))
			require.True(t, saved.OK)
			var creditEvents int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM credit_events`).Scan(&creditEvents))
			require.NoError(t, command.Process.Kill())
			require.Error(t, command.Wait())
			command, _ = start()
			call("/api/commands/select", `{"message":"hello","commands":[{"name":"help","summary":"Help"}]}`, 200)
			require.Equal(t, int32(1), gatewayCalls.Load())
			var afterCreditEvents int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM credit_events`).Scan(&afterCreditEvents))
			require.Equal(t, creditEvents, afterCreditEvents)
			payload = call("/api/model/credential", `{"action":"remove","requestId":"restart-gateway-remove","name":"AI_GATEWAY_API_KEY"}`, 200)
			require.NoError(t, json.Unmarshal(payload, &saved))
			require.True(t, saved.OK)
			payload = call("/api/commands/select", `{"message":"hello","commands":[{"name":"help","summary":"Help"}]}`, 503)
			require.Contains(t, string(payload), "credential_missing")
			require.Equal(t, int32(1), gatewayCalls.Load())
		}
		// Flush the final process's trace batch before scanning the captures.
		// The earlier process deaths remain abrupt crash-recovery checks.
		require.NoError(t, command.Process.Signal(syscall.SIGTERM))
		require.NoError(t, command.Wait())
		// A clean secret scan of an empty or partial export is not evidence.
		// Require each exercised setup/status surface in the flushed capture.
		for _, path := range []string{
			"/api/install", "/api/status", "/api/auth/github", "/api/auth/github/callback",
			"/api/install/setup/address", "/api/install/setup/app", "/api/install/setup/sign_in",
			"/api/install/setup/repository", "/api/install/setup/models",
			"/api/install/setup/source", "/api/install/setup/machine",
		} {
			_, exported := tracedPaths.Load(path)
			require.True(t, exported, "missing exported trace for %s", path)
		}
		return
	}
	// Exchange once, then use only the setup-session cookie, including after restart.
	setupURL, err := url.Parse(setupURLs[0])
	require.NoError(t, err)
	response, err := client.Get(origin + setupURL.RequestURI())
	require.NoError(t, err)
	response.Body.Close()
	// Hold the selected crash boundary using a test-owned PostgreSQL lock.
	// Running admission commits before either worker claim or completion.
	if boundary == "app conversion consumed" {
		_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('setup.step.address','{"status":"done"}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
		require.NoError(t, err)
		postApp := func() *http.Response {
			request, err := http.NewRequest("POST", origin+"/api/install/setup/app", strings.NewReader(`{"owner":"acme"}`))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", origin)
			for _, cookie := range jar.Cookies(request.URL) {
				if cookie.Name == "__csrf" {
					request.Header.Set("X-CSRF-Token", cookie.Value)
				}
			}
			response, err := client.Do(request)
			require.NoError(t, err)
			return response
		}
		response := postApp()
		require.Equal(t, 200, response.StatusCode)
		var attempt struct {
			State string `json:"state"`
		}
		require.NoError(t, json.NewDecoder(response.Body).Decode(&attempt))
		response.Body.Close()
		// Fixture the durable boundary after the single-use exchange starts;
		// no remote success or credential recovery is asserted by this case.
		_, err = pool.Exec(ctx, `UPDATE github_app_manifest_states SET used_at=now() WHERE digest=$1`, fmt.Sprintf("%x", sha256.Sum256([]byte(attempt.State))))
		require.NoError(t, err)
		require.NoError(t, command.Process.Kill())
		require.Error(t, command.Wait())
		_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(now()-interval '1 second')) WHERE key='setup.step.app_manifest'`)
		require.NoError(t, err)
		start()
		response, err = client.Get(origin + "/api/install")
		require.NoError(t, err)
		require.Equal(t, 200, response.StatusCode)
		payload, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		response.Body.Close()
		require.Contains(t, string(payload), `"id":"app_manifest","state":"failed"`)
		require.Contains(t, string(payload), `"code":"outcome_unknown"`)
		response = postApp()
		require.Equal(t, 409, response.StatusCode)
		response.Body.Close()
		var attempts int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM github_app_manifest_states`).Scan(&attempts))
		require.Equal(t, 1, attempts)
		return
	}
	lock, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer lock.Release()
	_, err = lock.Exec(ctx, `SELECT pg_advisory_lock(90345506)`)
	require.NoError(t, err)
	barrierTable := "install_settings"
	if boundary == "running admission" {
		barrierTable = "product_job_dispatches"
		_, err = pool.Exec(ctx, `CREATE FUNCTION hold_setup_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.claim_token IS NOT NULL THEN PERFORM pg_advisory_xact_lock(90345506); END IF; RETURN NEW; END $$; CREATE TRIGGER hold_setup_completion BEFORE UPDATE ON product_job_dispatches FOR EACH ROW EXECUTE FUNCTION hold_setup_completion()`)
	} else {
		_, err = pool.Exec(ctx, `CREATE FUNCTION hold_setup_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='setup.step.address' AND NEW.value->>'status'='done' THEN PERFORM pg_advisory_xact_lock(90345506); END IF; RETURN NEW; END $$; CREATE TRIGGER hold_setup_completion BEFORE UPDATE ON install_settings FOR EACH ROW EXECUTE FUNCTION hold_setup_completion()`)
	}
	require.NoError(t, err)
	post := func(key string) jobs.RequestReceipt {
		request, err := http.NewRequestWithContext(ctx, "POST", origin+"/api/install/setup/address", strings.NewReader(`{"bind":"","origins":["http://localhost:4000"]}`))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		request.Header.Set("Idempotency-Key", key)
		for _, cookie := range jar.Cookies(request.URL) {
			if cookie.Name == "__csrf" {
				request.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		response, err := client.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, 202, response.StatusCode)
		var receipt jobs.RequestReceipt
		require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
		return receipt
	}
	admitted := post("before-crash")
	require.Eventually(t, func() bool {
		var held bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=90345506 AND NOT granted)`).Scan(&held)
		return err == nil && held
	}, 10*time.Second, 20*time.Millisecond)
	var before struct {
		Status      string `json:"status"`
		OperationID string `json:"operation_id"`
	}
	var stored []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='setup.step.address'`).Scan(&stored))
	require.NoError(t, json.Unmarshal(stored, &before))
	require.Equal(t, "running", before.Status)
	require.Equal(t, admitted.OperationID, before.OperationID)
	var externalStarted bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT external_started_at IS NOT NULL FROM product_job_dispatches WHERE operation_id=$1`, admitted.OperationID).Scan(&externalStarted))
	require.Equal(t, boundary == "address effect", externalStarted)
	// Retain the actual pre-crash worker fence, rather than constructing a
	// deliberately invalid token. After restart it must no longer authorize
	// either a checkpoint or completion, even with the original operation id.
	var stale jobs.Claim
	if externalStarted {
		stale.OperationID = admitted.OperationID
		require.NoError(t, pool.QueryRow(ctx, `SELECT d.claim_token,d.generation,d.worker_id,r.tenant_id,r.principal_id
 FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id
 WHERE d.operation_id=$1`, admitted.OperationID).Scan(&stale.Token, &stale.Generation, &stale.WorkerID, &stale.Scope.TenantID, &stale.Scope.PrincipalID))
		require.NotEmpty(t, stale.Token)
	}
	require.NoError(t, command.Process.Kill())
	require.Error(t, command.Wait())
	_, err = lock.Exec(ctx, `SELECT pg_advisory_unlock(90345506)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DROP TRIGGER hold_setup_completion ON `+barrierTable+`; DROP FUNCTION hold_setup_completion()`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1 AND status='claimed'`, admitted.OperationID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key='setup.step.address'`)
	require.NoError(t, err)
	// Restart with identical state root and database; cookie remains valid.
	command, _ = start()
	// Recovery may finish before Retry. GET must eventually certify completion.
	require.Eventually(t, func() bool {
		response, err := client.Get(origin + "/api/install")
		if err != nil {
			return false
		}
		defer response.Body.Close()
		var model struct{ Steps []struct{ ID, State string } }
		return response.StatusCode == 200 && json.NewDecoder(response.Body).Decode(&model) == nil && len(model.Steps) == 7 && model.Steps[0].ID == "address" && model.Steps[0].State == "done"
	}, 15*time.Second, 50*time.Millisecond)
	var operation string
	var completions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT value->>'operation_id' FROM install_settings WHERE key='setup.step.address'`).Scan(&operation))
	require.Equal(t, admitted.OperationID, operation)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, operation).Scan(&completions))
	require.Equal(t, 1, completions)
	if externalStarted {
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		_, err = store.Checkpoint(ctx, stale, json.RawMessage(`{"stale":true}`))
		require.ErrorIs(t, err, jobs.ErrClaimLost)
		require.ErrorIs(t, store.Complete(ctx, stale, json.RawMessage(`{"stale":true}`)), jobs.ErrClaimLost)
		var generation int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT generation FROM product_job_dispatches WHERE operation_id=$1`, operation).Scan(&generation))
		require.Greater(t, generation, stale.Generation)
	}
	// Inspect the person-facing projection after the stale completion attempt.
	response, err = client.Get(origin + "/api/install")
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, 200, response.StatusCode)
	var recovered struct {
		Steps   []struct{ ID, State string }
		Address struct {
			Origins []string `json:"origins"`
		}
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&recovered))
	require.Len(t, recovered.Steps, 7)
	for i, id := range []string{"address", "app_manifest", "sign_in", "repository", "models", "source", "machine"} {
		require.Equal(t, id, recovered.Steps[i].ID)
		state := "pending"
		if i == 0 {
			state = "done"
		}
		require.Equal(t, state, recovered.Steps[i].State)
	}
	require.Equal(t, []string{"http://localhost:4000"}, recovered.Address.Origins)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, operation).Scan(&completions))
	require.Equal(t, 1, completions)

	// Exercise the owner setting through the compiled HTTP boundary, then
	// restart: existing hosts must observe the durable gate without rebuilding.
	var ownerID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('restart-owner','restart-owner') RETURNING id`).Scan(&ownerID))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, ownerID)
	require.NoError(t, err)
	// Repository choice has its own GitHub qualification. This setting test
	// starts with a chosen repository and never requests its remote inventory.
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('repository','"restart-owner/app"')`)
	require.NoError(t, err)
	ownerToken := "restart-owner-session"
	ownerHash := sha256.Sum256([]byte(ownerToken))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'restart-owner',$3)`, hex.EncodeToString(ownerHash[:]), ownerID, time.Now().Add(time.Hour))
	require.NoError(t, err)
	ownerURL, err := url.Parse(origin)
	require.NoError(t, err)
	jar.SetCookies(ownerURL, []*http.Cookie{
		{Name: "smithers_setup_session", Value: "", Path: "/", MaxAge: -1},
		{Name: "smithers_session", Value: ownerToken, Path: "/"},
	})
	setChatGPT := func(enabled bool) {
		t.Helper()
		body, err := json.Marshal(map[string]bool{"chatgpt": enabled})
		require.NoError(t, err)
		request, err := http.NewRequestWithContext(ctx, "PUT", origin+"/api/install", bytes.NewReader(body))
		require.NoError(t, err)
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		for _, cookie := range jar.Cookies(ownerURL) {
			if cookie.Name == "__csrf" {
				request.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		response, err := client.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		require.Equal(t, 200, response.StatusCode, string(raw))
		var status struct {
			ChatGPT bool `json:"chatgpt"`
		}
		require.NoError(t, json.Unmarshal(raw, &status))
		require.Equal(t, enabled, status.ChatGPT)
	}
	setChatGPT(true)
	// Only the test-owned child is killed. Its successor reads the same database.
	require.NoError(t, command.Process.Kill())
	require.Error(t, command.Wait())
	start()
	response, err = client.Get(origin + "/api/install")
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode)
	defer response.Body.Close()
	var status struct {
		ChatGPT bool `json:"chatgpt"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&status))
	require.True(t, status.ChatGPT)
	setChatGPT(false)
}

// Captures are read while the restarted process is serving. Synchronize writes
// rather than making credential scans race with ordinary request logging.
type setupProcessCapture struct {
	logs, ordinary setupProcessBuffer
	invalidMint    atomic.Bool
}
type setupProcessBuffer struct {
	mu sync.Mutex
	bytes.Buffer
}

func (b *setupProcessBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Write(p)
}
func (b *setupProcessBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.String()
}

// Capture actual responses before callers consume them. Set-Cookie is the
// intentional credential delivery surface; bodies and navigation headers must
// never carry the setup token or setup-session credential.
type setupTraceTransport struct{ captured *setupProcessBuffer }

func (transport setupTraceTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := http.DefaultTransport.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	transport.captured.Write(body)
	for name, values := range response.Header {
		if strings.EqualFold(name, "Set-Cookie") {
			continue
		}
		for _, value := range values {
			transport.captured.Write([]byte(name + ": " + value + "\n"))
		}
	}
	return response, nil
}
