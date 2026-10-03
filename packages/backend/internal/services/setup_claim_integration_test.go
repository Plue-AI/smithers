package services

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type setupProcessBuffer struct {
	sync.Mutex
	bytes.Buffer
}

func (b *setupProcessBuffer) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(p)
}
func (b *setupProcessBuffer) text() string { b.Lock(); defer b.Unlock(); return b.Buffer.String() }

// T-ACC-07/C-SEC-04: the production entrypoint, real PG and served OAuth;
// fixture hosts are inert because this check must never execute repository work.
func TestSetupNativeProcessHandoff(t *testing.T) {
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
	dir := t.TempDir()
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		suffix := ".so"
		if runtime.GOOS == "darwin" {
			suffix = ".dylib"
		}
		ffi = filepath.Join(root, "target", "debug", "libsmithers_ffi"+suffix)
	}
	require.FileExists(t, ffi, "the declared backendGo target builds nativeFfi before this test")
	binary := filepath.Join(dir, "smithers-backend")
	build := exec.Command("sh", "scripts/build-backend.sh", binary, "acc7-test")
	build.Dir = root
	build.Env = append(os.Environ(), "GOFLAGS=-buildvcs=false")
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	fixture := []byte("#!/bin/sh\nexit 0\n")
	coding := filepath.Join(dir, "smithers-coding-host")
	require.NoError(t, os.WriteFile(coding, fixture, 0700))
	sum := sha256.Sum256(fixture)
	manifest := fmt.Sprintf(`{"version":1,"hosts":{"coding":{"executable":"smithers-coding-host","sha256":"%x","flows":["coding/dispatch"]}}}`, sum)
	manifestPath := filepath.Join(dir, "flow-hosts.json")
	require.NoError(t, os.WriteFile(manifestPath, []byte(manifest), 0600))
	bundle := filepath.Join(dir, "model-host.cjs")
	require.NoError(t, os.WriteFile(bundle, fixture, 0700))
	require.NoError(t, os.WriteFile(bundle+".sha256", []byte(fmt.Sprintf("%x model-host.cjs\n", sum)), 0600))
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/login/oauth/access_token":
			io.WriteString(w, `{"access_token":"fake-oauth","token_type":"bearer"}`)
		case "/user":
			io.WriteString(w, `{"id":7007,"login":"owner","name":"Owner"}`)
		case "/user/emails":
			io.WriteString(w, `[]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()
	var traces setupProcessBuffer
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, e := io.ReadAll(r.Body)
		if e != nil {
			http.Error(w, "read trace", 500)
			return
		}
		traces.Write(body)
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close())
	origin := "http://" + addr
	env := []string{"OTEL_BSP_SCHEDULE_DELAY=100"}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "SMITHERS_") && !strings.HasPrefix(entry, "DATABASE_URL=") && !strings.HasPrefix(entry, "OTEL_") {
			env = append(env, entry)
		}
	}
	for key, value := range map[string]string{
		"SMITHERS_FFI_LIBRARY_PATH": ffi, "SMITHERS_DATABASE_URL": databaseURL, "SMITHERS_AUTH_MODE": "selfhost", "SMITHERS_SERVER_ADDR": addr,
		"SMITHERS_PUBLIC_URL": origin, "SMITHERS_SERVER_ALLOWED_ORIGINS": origin, "SMITHERS_DATA_ROOT": filepath.Join(dir, "state"),
		"SMITHERS_FLOW_HOST_MANIFEST": manifestPath, "SMITHERS_WORKSPACE_ISOLATION": "process",
		"SMITHERS_NODE_BINARY": node, "SMITHERS_MODEL_HOST_BUNDLE": bundle, "SMITHERS_OTEL_EXPORTER": "otlp", "SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT": collector.URL, "SMITHERS_TRACE_SAMPLE_RATE": "1",
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false", "SMITHERS_FEATURE_FLAGS_SANDBOXES": "false", "SMITHERS_FEATURE_FLAGS_WORKSPACES": "false",
		"SMITHERS_METRICS_ADDR": "", "SMITHERS_AUTH_COOKIE_SECURE": "false",
		"SMITHERS_AUTH_GITHUB_CLIENT_ID": "fixture", "SMITHERS_AUTH_GITHUB_CLIENT_SECRET": "fixture-secret",
		"SMITHERS_AUTH_GITHUB_REDIRECT_URL":   origin + "/api/auth/github/callback",
		"SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL": github.URL, "SMITHERS_AUTH_GITHUB_API_BASE_URL": github.URL,
	} {
		env = append(env, key+"="+value)
	}
	type capture struct {
		line           string
		stdout, stderr string
		token          string
		digest         string
	}
	var responses strings.Builder
	var dumps [][]byte
	snapshot := func() {
		t.Helper()
		dump := exec.Command("pg_dump", "--data-only", databaseURL)
		data, e := dump.Output()
		require.NoError(t, e)
		dumps = append(dumps, data)
	}
	launchNumber := 0
	configuredOrigins := false
	launch := func(wantLine bool, act func(string)) capture {
		t.Helper()
		launchNumber++
		command := exec.Command(binary)
		command.Env = env
		command.Dir = root
		var stdout, stderr setupProcessBuffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		defer func() {
			if t.Failed() {
				t.Logf("backend stderr (redacted): %s", regexp.MustCompile(`[A-Za-z0-9_-]{43,}`).ReplaceAllString(stderr.text(), "[redacted]"))
			}
		}()
		require.NoError(t, command.Start())
		stopped := false
		exited := make(chan error, 1)
		go func() { exited <- command.Wait() }()
		var startupError error
		defer func() {
			if !stopped {
				_ = command.Process.Kill()
				<-exited
			}
		}()
		require.Eventually(t, func() bool {
			select {
			case startupError = <-exited:
				stopped = true
				return true
			default:
			}
			response, e := (&http.Client{Timeout: time.Second}).Get(origin + "/health")
			if e != nil {
				return false
			}
			response.Body.Close()
			return response.StatusCode == 200
		}, 60*time.Second, 25*time.Millisecond, "backend readiness failed (captured output withheld to protect tokens)")
		require.NoError(t, startupError, "backend exited before readiness")
		require.False(t, stopped, "backend exited before readiness")
		text := stdout.text()
		line := ""
		token := ""
		storedDigest := ""
		scanner := bufio.NewScanner(strings.NewReader(text))
		count := 0
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), `{"setup_urls":`) {
				count++
				line = scanner.Text() + "\n"
			}
		}
		if wantLine {
			require.Equal(t, 1, count)
			// Literal fixtures from spec §5.1.0; no production oracle.
			var parsed map[string][]string
			require.NoError(t, json.Unmarshal([]byte(line), &parsed))
			require.Len(t, parsed, 1)
			require.Contains(t, parsed, "setup_urls")
			require.True(t, strings.HasPrefix(parsed["setup_urls"][0], "http://localhost:4000/setup?token="))
			token = strings.TrimPrefix(parsed["setup_urls"][0], "http://localhost:4000/setup?token=")
			require.NotEmpty(t, token)
			expected := []string{"http://localhost:4000/setup?token=" + token}
			if configuredOrigins {
				expected = append(expected, "http://lan-a:4000/setup?token="+token, "https://box.example/setup?token="+token)
			}
			require.Equal(t, expected, parsed["setup_urls"])
			digest := sha256.Sum256([]byte(token))
			storedDigest = hex.EncodeToString(digest[:])
			stored, e := db.New(pool).GetInstallSetting(ctx, "setup_token")
			require.NoError(t, e)
			require.JSONEq(t, fmt.Sprintf(`{"digest":"%s"}`, hex.EncodeToString(digest[:])), string(stored))
		} else {
			require.Zero(t, count)
		}
		response, e := http.Get(origin + "/api/install")
		require.NoError(t, e)
		body, e := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, e)
		require.NoError(t, response.Header.Write(&responses))
		responses.Write(body)
		snapshot()
		if act != nil {
			act(token)
		}
		// Export a later, distinct request before killing the process. The collector
		// receipt proves preceding OAuth requests reached the real trace pipeline.
		marker := fmt.Sprintf("/api/acc7-trace-flush/%d", launchNumber)
		receipt, e := http.Get(origin + marker)
		require.NoError(t, e)
		io.Copy(io.Discard, receipt.Body)
		receipt.Body.Close()
		require.NoError(t, receipt.Header.Write(&responses))
		require.Eventually(t, func() bool { return strings.Contains(traces.text(), marker) }, 5*time.Second, 10*time.Millisecond, "no real OTLP trace receipt")
		require.NoError(t, command.Process.Kill())
		<-exited
		stopped = true
		return capture{line, stdout.text(), stderr.text(), token, storedDigest}
	}
	first := launch(true, nil)
	require.NoError(t, db.New(pool).PutInstallSetting(ctx, db.PutInstallSettingParams{Key: InstallPublicOriginsKey, Value: []byte(`["http://lan-a:4000","https://box.example"]`)}))
	configuredOrigins = true
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	second := launch(true, func(token string) {
		// Frozen ACC-01 exposes /api/auth/github (Ready ticket spells /start).
		start := func(raw string) (*http.Response, string) {
			r, e := client.Get(origin + "/api/auth/github?setup_token=" + url.QueryEscape(raw))
			require.NoError(t, e)
			b, e := io.ReadAll(r.Body)
			r.Body.Close()
			require.NoError(t, e)
			require.NoError(t, r.Header.Write(&responses))
			responses.Write(b)
			snapshot()
			return r, string(b)
		}
		// spec §5.1.0 retires the old URL; frozen ACC-01 refuses its raw
		// token at OAuth start with 403 setup_token_invalid.
		r, body := start(first.token)
		require.Equal(t, http.StatusForbidden, r.StatusCode)
		require.Contains(t, body, `"code":"setup_token_invalid"`)
		r, _ = start(token)
		require.Equal(t, http.StatusFound, r.StatusCode)
		stateURL, e := url.Parse(r.Header.Get("Location"))
		require.NoError(t, e)
		callback, e := client.Get(origin + "/api/auth/github/callback?code=owner&state=" + url.QueryEscape(stateURL.Query().Get("state")))
		require.NoError(t, e)
		b, e := io.ReadAll(callback.Body)
		callback.Body.Close()
		require.NoError(t, e)
		require.NoError(t, callback.Header.Write(&responses))
		responses.Write(b)
		require.Equal(t, http.StatusFound, callback.StatusCode)
	})
	require.NotEqual(t, first.token, second.token)
	require.NotEqual(t, first.digest, second.digest)
	third := launch(false, nil)
	snapshot()
	var stateFiles [][]byte
	require.NoError(t, filepath.Walk(filepath.Join(dir, "state"), func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode().IsRegular() {
			data, e := os.ReadFile(path)
			if e != nil {
				return e
			}
			stateFiles = append(stateFiles, data)
		}
		return nil
	}))
	for _, token := range []string{first.token, second.token} {
		for _, copy := range []string{token, url.QueryEscape(token)} {
			for _, c := range []capture{first, second, third} {
				// Exclude exactly the one accepted byte range, never every setup_urls line.
				outside := c.stdout
				if c.line != "" {
					at := strings.Index(outside, c.line)
					require.GreaterOrEqual(t, at, 0)
					outside = outside[:at] + outside[at+len(c.line):]
				}
				require.False(t, strings.Contains(outside, copy), "token copied outside stdout handoff")
				require.False(t, strings.Contains(c.stderr, copy), "token copied to stderr")
			}
			require.False(t, strings.Contains(responses.String(), copy), "token copied to response")
			require.False(t, strings.Contains(traces.text(), copy), "token copied to trace")
			for _, data := range stateFiles {
				require.False(t, bytes.Contains(data, []byte(copy)), "setup token copied to native state or log file")
			}
			for _, dumpBytes := range dumps {
				require.False(t, bytes.Contains(dumpBytes, []byte(copy)), "plaintext token persisted")
			}
		}
	}
}
