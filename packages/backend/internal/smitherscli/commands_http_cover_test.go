package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsHTTPCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	root := t.TempDir()
	configHome := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(root, "auth.json"))
	setTestCredentialStoreFile(t, filepath.Join(root, "credentials.json"))
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "commands_http_cov_token")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsHTTPCovServe(t *testing.T, cli *incur.Cli, argv []string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(%v) returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsHTTPCovWithStdin(t *testing.T, text string, fn func()) {
	t.Helper()
	oldStdin := os.Stdin
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(writer, text); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	os.Stdin = reader
	defer func() {
		os.Stdin = oldStdin
		_ = reader.Close()
	}()
	fn()
}

func commandsHTTPCovRequireSeen(t *testing.T, seen []string, want string) {
	t.Helper()
	for _, got := range seen {
		if strings.HasPrefix(got, want) {
			return
		}
	}
	t.Fatalf("server did not see %q; saw %v", want, seen)
}

func TestCommandsHttp_Cov_RawAPIRequestAndAPICommand(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token commands_http_cov_token" {
			t.Errorf("Authorization header = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/raw-get":
			if r.Header.Get("X-Cov") == "" {
				t.Errorf("missing X-Cov header")
			}
			fmt.Fprintf(w, `{"method":%q,"accept":%q}`, r.Method, r.Header.Get("Accept"))
		case "/raw-post":
			if got := r.Header.Get("Content-Type"); got != "application/json" {
				t.Errorf("Content-Type = %q", got)
			}
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("invalid raw body: %v", err)
			}
			fmt.Fprintf(w, `{"name":%q,"header":%q}`, body["name"], r.Header.Get("X-Cov"))
		case "/raw-empty":
			w.WriteHeader(http.StatusNoContent)
		case "/raw-error-json":
			w.WriteHeader(http.StatusTeapot)
			fmt.Fprint(w, `{"message":"short and stout"}`)
		case "/raw-error-text":
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, "gateway unavailable")
		default:
			t.Errorf("unexpected raw request: %s %s", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsHTTPCovSetConfig(t, server.URL)

	result, err := rawAPIRequest(http.MethodGet, "/raw-get", nil, map[string]string{"X-Cov": "direct"})
	if err != nil || objectValue(result)["method"] != http.MethodGet || objectValue(result)["accept"] != "application/json" {
		t.Fatalf("rawAPIRequest GET = %#v, %v", result, err)
	}
	result, err = rawAPIRequest(http.MethodPost, "/raw-post", map[string]string{"name": "direct"}, map[string]string{"X-Cov": "post"})
	if err != nil || objectValue(result)["name"] != "direct" || objectValue(result)["header"] != "post" {
		t.Fatalf("rawAPIRequest POST = %#v, %v", result, err)
	}
	result, err = rawAPIRequest(http.MethodDelete, "/raw-empty", nil, nil)
	if err != nil || result != nil {
		t.Fatalf("rawAPIRequest empty = %#v, %v", result, err)
	}
	if _, err = rawAPIRequest(http.MethodGet, "/raw-error-json", nil, nil); err == nil || !strings.Contains(err.Error(), "short and stout") {
		t.Fatalf("rawAPIRequest JSON error = %v", err)
	}
	if _, err = rawAPIRequest(http.MethodGet, "/raw-error-text", nil, nil); err == nil || !strings.Contains(err.Error(), "gateway unavailable") {
		t.Fatalf("rawAPIRequest text error = %v", err)
	}

	commandsHTTPCovServe(t, apiCommand(), []string{"/raw-get", "--header", "X-Cov: cli", "--json"})
	commandsHTTPCovServe(t, apiCommand(), []string{"/raw-post", "--method", "post", "--field", "name=from-cli", "--header", "X-Cov: cli-post", "--json"})
	for _, tc := range []struct {
		argv []string
		want string
	}{
		{[]string{"/raw-get", "--method", "TRACE"}, "Invalid HTTP method"},
		{[]string{"raw-get"}, "Endpoint must begin with '/'"},
		{[]string{"/raw-post", "--method", "POST", "--field", "bad-field"}, "Field must be in key=value format"},
		{[]string{"/raw-post", "--header", "bad-header"}, "Header must be in key:value format"},
	} {
		var stdout bytes.Buffer
		err := apiCommand().ServeWithOptions(tc.argv, incur.ServeOptions{Stdout: &stdout})
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("apiCommand(%v) error = %v stdout=%s, want %q", tc.argv, err, stdout.String(), tc.want)
		}
	}

	commandsHTTPCovRequireSeen(t, seen, "GET /raw-get")
	commandsHTTPCovRequireSeen(t, seen, "POST /raw-post")
}

func TestCommandsHttp_Cov_ResourceCommandsAndHelpers(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token commands_http_cov_token" {
			t.Errorf("Authorization header = %q for %s", got, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/search/repositories":
			if r.URL.Query().Get("q") != "bug fix" || r.URL.Query().Get("page") != "2" || r.URL.Query().Get("per_page") != "5" {
				t.Errorf("search query = %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `[{"name":"demo"}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/labels":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "bug" || body["color"] != "ff0000" || body["description"] != "broken" {
				t.Errorf("label create body = %#v", body)
			}
			fmt.Fprint(w, `{"id":7,"name":"bug"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/labels":
			fmt.Fprint(w, `[{"id":7,"name":"bug"}]`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/labels/7":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/secrets":
			fmt.Fprint(w, `[{"name":"API_KEY"}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/secrets":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "API_KEY" || body["value"] != "super-secret" {
				t.Errorf("secret set body = %#v", body)
			}
			if mainOnly, marked := body["main_only"]; marked && mainOnly != true {
				t.Errorf("secret set main_only = %#v", mainOnly)
			}
			fmt.Fprint(w, `{"name":"API_KEY"}`)
		case r.Method == http.MethodPatch && r.URL.Path == "/api/repos/alice/demo/secrets/API_KEY":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["main_only"] != false {
				t.Errorf("secret scope body = %#v", body)
			}
			fmt.Fprint(w, `{"name":"API_KEY","main_only":false}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/secrets/API_KEY":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/variables":
			fmt.Fprint(w, `[{"name":"FEATURE"}]`)
		case r.Method == http.MethodGet && r.URL.EscapedPath() == "/api/repos/alice/demo/variables/feature%20flag":
			fmt.Fprint(w, `{"name":"feature flag","value":"on"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/variables":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "FEATURE" || body["value"] != "enabled" {
				t.Errorf("variable set body = %#v", body)
			}
			fmt.Fprint(w, `{"name":"FEATURE"}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/variables/FEATURE":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/keys":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["title"] != "laptop" || !strings.Contains(stringValue(body["key"]), "ssh-ed25519") {
				t.Errorf("ssh key add body = %#v", body)
			}
			fmt.Fprint(w, `{"id":5}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/keys":
			fmt.Fprint(w, `[{"id":5}]`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/user/keys/5":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/api/notifications/list":
			if r.URL.Query().Get("status") != "unread" || r.URL.Query().Get("cursor") != "c1" || r.URL.Query().Get("limit") != "2" {
				t.Errorf("notification list query = %s", r.URL.RawQuery)
			}
			w.Header().Set("Link", `<http://example.test/api/notifications/list?cursor=n2>; rel="next"`)
			fmt.Fprint(w, `[{"id":"note-1"}]`)
		case r.Method == http.MethodPut && r.URL.Path == "/api/notifications/mark-read":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPatch && r.URL.Path == "/api/notifications/note-1":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["read"] != true {
				t.Errorf("notification read body = %#v", body)
			}
			fmt.Fprint(w, `{"id":"note-1","read":true}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/caches":
			if r.URL.Query().Get("page") != "3" || r.URL.Query().Get("per_page") != "4" || r.URL.Query().Get("bookmark") != "main" || r.URL.Query().Get("key") != "linux" {
				t.Errorf("cache list query = %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `[{"key":"linux"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/caches/stats":
			fmt.Fprint(w, `{"count":1}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/caches":
			if r.URL.Query().Get("page") != "" || r.URL.Query().Get("per_page") != "" || r.URL.Query().Get("bookmark") != "main" || r.URL.Query().Get("key") != "linux" {
				t.Errorf("cache clear query = %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `{"cleared":true}`)
		default:
			t.Errorf("unexpected resource request: %s %s", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsHTTPCovSetConfig(t, server.URL)

	commandsHTTPCovServe(t, searchCommand(), []string{"repos", "bug fix", "--page", "2", "--limit", "5", "--json"})
	commandsHTTPCovServe(t, labelCommand(), []string{"create", "bug", "--repo", "alice/demo", "--color", "ff0000", "--description", "broken", "--json"})
	commandsHTTPCovServe(t, labelCommand(), []string{"list", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, labelCommand(), []string{"delete", "7", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, secretCommand(), []string{"list", "--repo", "alice/demo", "--json"})
	commandsHTTPCovWithStdin(t, "super-secret", func() {
		commandsHTTPCovServe(t, secretCommand(), []string{"set", "API_KEY", "--repo", "alice/demo", "--body-stdin", "--json"})
	})
	commandsHTTPCovWithStdin(t, "super-secret", func() {
		commandsHTTPCovServe(t, secretCommand(), []string{"set", "API_KEY", "--repo", "alice/demo", "--body-stdin", "--main-only", "--json"})
	})
	commandsHTTPCovServe(t, secretCommand(), []string{"scope", "API_KEY", "all", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, secretCommand(), []string{"delete", "API_KEY", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, variableCommand(), []string{"list", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, variableCommand(), []string{"get", "feature flag", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, variableCommand(), []string{"set", "FEATURE", "--body", "enabled", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, variableCommand(), []string{"delete", "FEATURE", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, sshKeyCommand(), []string{"add", "--title", "laptop", "--key", "ssh-ed25519 AAA", "--json"})
	commandsHTTPCovServe(t, sshKeyCommand(), []string{"list", "--json"})
	commandsHTTPCovServe(t, sshKeyCommand(), []string{"delete", "5", "--json"})
	commandsHTTPCovServe(t, notificationCommand(), []string{"list", "--unread", "--limit", "2", "--cursor", "c1", "--json"})
	commandsHTTPCovServe(t, notificationCommand(), []string{"read", "--all", "--json"})
	commandsHTTPCovServe(t, notificationCommand(), []string{"read", "note-1", "--json"})
	commandsHTTPCovServe(t, cacheCommand(), []string{"list", "--repo", "alice/demo", "--bookmark", "main", "--key", "linux", "--page", "3", "--limit", "4", "--json"})
	commandsHTTPCovServe(t, cacheCommand(), []string{"stats", "--repo", "alice/demo", "--json"})
	commandsHTTPCovServe(t, cacheCommand(), []string{"clear", "--repo", "alice/demo", "--bookmark", "main", "--key", "linux", "--json"})

	for _, expected := range []string{
		"GET /api/search/repositories",
		"POST /api/repos/alice/demo/labels",
		"DELETE /api/repos/alice/demo/labels/7",
		"POST /api/repos/alice/demo/secrets",
		"PATCH /api/repos/alice/demo/secrets/API_KEY",
		"GET /api/repos/alice/demo/variables/feature%20flag",
		"DELETE /api/user/keys/5",
		"PATCH /api/notifications/note-1",
		"DELETE /api/repos/alice/demo/caches",
	} {
		commandsHTTPCovRequireSeen(t, seen, expected)
	}
}

func TestCommandsHttp_Cov_ErrorBranchesAndSmallHelpers(t *testing.T) {
	commandsHTTPCovSetConfig(t, "http://127.0.0.1:1")

	if _, err := repoOnlyCommand("cov repo only", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		if owner != "alice" || repo != "demo" {
			t.Fatalf("repoOnlyCommand args = %s/%s", owner, repo)
		}
		return "ok", nil
	}).Handler(&incur.CommandContext{Options: map[string]any{"repo": "alice/demo"}}); err != nil {
		t.Fatalf("repoOnlyCommand success returned error: %v", err)
	}
	if _, err := repoOnlyCommand("cov repo only", nil).Handler(&incur.CommandContext{Options: map[string]any{"repo": "bad"}}); err == nil || !strings.Contains(err.Error(), "Invalid repo format") {
		t.Fatalf("repoOnlyCommand invalid repo error = %v", err)
	}

	deleteDef := namedRepoDeleteCommand("Delete cov", "Variable name", "/api/repos/%s/%s/variables/%s")
	if _, err := deleteDef.Handler(&incur.CommandContext{Args: map[string]any{"name": " \t "}, Options: map[string]any{"repo": "alice/demo"}}); err == nil || !strings.Contains(err.Error(), "variable name is required") {
		t.Fatalf("namedRepoDeleteCommand blank name error = %v", err)
	}
	if err := labelCommand().ServeWithOptions([]string{"delete", "0", "--repo", "alice/demo"}, incur.ServeOptions{Stdout: &bytes.Buffer{}}); err == nil || !strings.Contains(err.Error(), "invalid label id") {
		t.Fatalf("label delete invalid id error = %v", err)
	}
	if err := variableCommand().ServeWithOptions([]string{"get", " ", "--repo", "alice/demo"}, incur.ServeOptions{Stdout: &bytes.Buffer{}}); err == nil || !strings.Contains(err.Error(), "variable name is required") {
		t.Fatalf("variable get blank error = %v", err)
	}
	if err := sshKeyCommand().ServeWithOptions([]string{"delete", "abc"}, incur.ServeOptions{Stdout: &bytes.Buffer{}}); err == nil || !strings.Contains(err.Error(), "invalid SSH key id") {
		t.Fatalf("ssh key delete invalid id error = %v", err)
	}
	if err := notificationCommand().ServeWithOptions([]string{"read"}, incur.ServeOptions{Stdout: &bytes.Buffer{}}); err == nil || !strings.Contains(err.Error(), "Provide a notification ID") {
		t.Fatalf("notification read missing id error = %v", err)
	}
	if err := secretCommand().ServeWithOptions([]string{"set", "API_KEY", "--repo", "alice/demo"}, incur.ServeOptions{Stdout: &bytes.Buffer{}}); err == nil || !strings.Contains(err.Error(), "secret values must be provided") {
		t.Fatalf("secret set without stdin flag error = %v", err)
	}
	if err := searchCommand().ServeWithOptions([]string{"repos", " "}, incur.ServeOptions{Stdout: &bytes.Buffer{}}); err == nil || !strings.Contains(err.Error(), "search query is required") {
		t.Fatalf("search blank query error = %v", err)
	}

	options := pageLimitOptions()
	if options.Properties["page"].Default != 1 || options.Properties["limit"].Default != 30 {
		t.Fatalf("pageLimitOptions = %#v", options.Properties)
	}
	ctx := &incur.CommandContext{Options: map[string]any{"page": 2, "limit": 3, "bookmark": " main ", "key": " linux "}}
	query := cacheQuery(ctx, true)
	for _, want := range []string{"page=2", "per_page=3", "bookmark=main", "key=linux"} {
		if !strings.Contains(query, want) {
			t.Fatalf("cacheQuery include page = %q missing %q", query, want)
		}
	}
	query = cacheQuery(ctx, false)
	if strings.Contains(query, "page=") || strings.Contains(query, "per_page=") || !strings.Contains(query, "bookmark=main") || !strings.Contains(query, "key=linux") {
		t.Fatalf("cacheQuery without page = %q", query)
	}
	if got := cacheQuery(&incur.CommandContext{Options: map[string]any{}}, false); got != "" {
		t.Fatalf("cacheQuery empty = %q", got)
	}

	commandsHTTPCovWithStdin(t, "payload", func() {
		got, err := readStdinText("payload", false)
		if err != nil || got != "payload" {
			t.Fatalf("readStdinText payload = %q, %v", got, err)
		}
	})
	commandsHTTPCovWithStdin(t, "", func() {
		got, err := readStdinText("optional value", true)
		if err != nil || got != "" {
			t.Fatalf("readStdinText allow empty = %q, %v", got, err)
		}
	})
	commandsHTTPCovWithStdin(t, "", func() {
		if _, err := readStdinText("required value", false); err == nil || !strings.Contains(err.Error(), "no required value provided") {
			t.Fatalf("readStdinText empty error = %v", err)
		}
	})
}
