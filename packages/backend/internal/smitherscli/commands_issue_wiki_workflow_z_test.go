package smitherscli

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

// commandsIWWZServeErr runs a command expecting an error containing want.
func commandsIWWZServeErr(t *testing.T, cli *incur.Cli, want string, argv ...string) {
	t.Helper()
	var stdout bytes.Buffer
	err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("%v error = %v, want contains %q\n%s", argv, err, want, stdout.String())
	}
}

// commandsIWWZSuccessServer returns generic-success JSON for the alice/demo
// repo and 500 for the err/err repo, so callers can exercise both the
// FormatExplicit success branches and the cleanAPIError error branches.
func commandsIWWZSuccessServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/repos/err/err") {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"boom"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		switch {
		case r.Method == http.MethodPost && path == "/api/repos/alice/demo/issues":
			fmt.Fprint(w, `{"number":7,"title":"Crash","state":"open","author":{"login":"alice"}}`)
		case r.Method == http.MethodGet && path == "/api/repos/alice/demo/issues":
			if r.URL.Query().Get("limit") == "1" {
				w.Header().Set("Link", `</api/repos/alice/demo/issues?cursor=n2>; rel="next"`)
			}
			fmt.Fprint(w, `[{"number":7,"title":"Crash","state":"open","author":{"login":"alice"}}]`)
		case r.Method == http.MethodGet && path == "/api/repos/alice/demo/issues/7":
			fmt.Fprint(w, `{"number":7,"title":"Crash","state":"open","body":"b","author":{"login":"alice"},"assignees":[{"login":"bob"}]}`)
		case path == "/api/repos/alice/demo/issues/7/comments":
			fmt.Fprint(w, `{"id":1,"body":"c"}`)
		case path == "/api/repos/alice/demo/issues/7":
			fmt.Fprint(w, `{"number":7,"title":"Crash","state":"closed"}`)
		case path == "/api/repos/alice/demo/issues/7/reactions":
			fmt.Fprint(w, `{"content":"heart"}`)
		case path == "/api/repos/alice/demo/issues/7/pin":
			fmt.Fprint(w, `{"number":7,"pinned":true}`)
		case path == "/api/repos/alice/demo/issues/7/dependencies":
			fmt.Fprint(w, `{"blocks":8}`)
		case r.Method == http.MethodGet && path == "/api/repos/alice/demo/wiki/navigation/index":
			fmt.Fprint(w, `{"pages":[{"id":7,"slug":"home","title":"Home","path":"Home.md","revision":2,"visibility":"`+r.URL.Query().Get("visibility")+`","metadata":{"tags":["guide"],"links":[]},"backlinks":[{"page_id":8,"path":"Guides/Start.md","embed":false}]},{"id":8,"slug":"start","title":"Start","path":"Guides/Start.md","revision":1,"metadata":{"tags":[]},"backlinks":[]}],"folders":["Guides"],"tags":["guide"]}`)
		case r.Method == http.MethodGet && path == "/api/repos/alice/demo/wiki/history/7":
			fmt.Fprint(w, `[{"page_id":7,"revision":2,"path":"Home.md","title":"Home","content_digest":"aa","deleted":false,"author":{"id":1,"login":"alice"},"updated_at":"2026-09-26T00:00:00Z"},{"page_id":7,"revision":1,"path":"Old/Home.md","title":"Home","content_digest":"bb","deleted":false,"author":{"id":1,"login":"alice"},"updated_at":"2026-09-26T00:00:00Z"}]`)
		case r.Method == http.MethodGet && path == "/api/repos/alice/demo/wiki":
			fmt.Fprint(w, `[{"title":"Home","slug":"home","author":{"login":"w"},"updated_at":"t"}]`)
		case r.Method == http.MethodGet && path == "/api/repos/alice/demo/wiki/search":
			fmt.Fprint(w, `[{"title":"Docs","slug":"docs","author":{},"updated_at":"t"}]`)
		case r.Method == http.MethodPost && path == "/api/repos/alice/demo/wiki":
			fmt.Fprint(w, `{"title":"Home","slug":"home"}`)
		case path == "/api/repos/alice/demo/wiki/home/revisions":
			fmt.Fprint(w, `[{"id":12,"title":"Home","author":{},"updated_at":"t"}]`)
		case path == "/api/repos/alice/demo/wiki/home":
			fmt.Fprint(w, `{"title":"Home","slug":"home","body":"Welcome","author":{"login":"w"},"updated_at":"t"}`)
		case r.Method == http.MethodGet && path == "/api/repos/alice/demo/workflows":
			fmt.Fprint(w, `{"workflows":[{"id":123,"name":"Build"}]}`)
		case r.Method == http.MethodGet && path == "/api/repos/alice/demo/runs":
			fmt.Fprint(w, `[{"id":42,"status":"completed"}]`)
		case path == "/api/repos/alice/demo/runs/42":
			fmt.Fprint(w, `{"id":42,"status":"completed"}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, path)
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
}

func TestCommandsIssueWikiWorkflow_Z_IssueFormatAndErrorBranches(t *testing.T) {
	server := commandsIWWZSuccessServer(t)
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	// FormatExplicit (--json) and TOON success branches.
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"create", "--repo", "alice/demo", "--title", "Crash", "--json"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"create", "--repo", "alice/demo", "--title", "Crash", "--format", "toon"})
	// list: --json with cursor, --json without cursor, non-json without cursor, --all non-json.
	if out := commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"list", "--repo", "alice/demo", "--limit", "1", "--json"}); !strings.Contains(out, "next_cursor") {
		t.Fatalf("list --json cursor output = %s", out)
	}
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"list", "--repo", "alice/demo", "--limit", "2", "--json"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"list", "--repo", "alice/demo", "--limit", "2"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"list", "--repo", "alice/demo", "--all"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"view", "7", "--repo", "alice/demo"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"close", "7", "--repo", "alice/demo", "--comment", "done", "--json"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"reopen", "7", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"edit", "7", "--repo", "alice/demo", "--title", "X", "--json"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"comment", "7", "--repo", "alice/demo", "--body", "n", "--json"})

	// cleanAPIError error branches (err/err returns 500).
	commandsIWWZServeErr(t, issueCommand(), "boom", "create", "--repo", "err/err", "--title", "X")
	commandsIWWZServeErr(t, issueCommand(), "boom", "list", "--repo", "err/err")
	commandsIWWZServeErr(t, issueCommand(), "boom", "list", "--repo", "err/err", "--all")
	commandsIWWZServeErr(t, issueCommand(), "boom", "view", "7", "--repo", "err/err")
	commandsIWWZServeErr(t, issueCommand(), "boom", "close", "7", "--repo", "err/err", "--comment", "done")
	commandsIWWZServeErr(t, issueCommand(), "boom", "close", "7", "--repo", "err/err")
	commandsIWWZServeErr(t, issueCommand(), "boom", "reopen", "7", "--repo", "err/err")
	commandsIWWZServeErr(t, issueCommand(), "boom", "edit", "7", "--repo", "err/err", "--title", "X")
	commandsIWWZServeErr(t, issueCommand(), "boom", "edit", "7", "--repo", "err/err", "--label", "bug")
	commandsIWWZServeErr(t, issueCommand(), "boom", "edit", "7", "--repo", "err/err", "--assignee", "bob")
	commandsIWWZServeErr(t, issueCommand(), "boom", "comment", "7", "--repo", "err/err", "--body", "n")

	// ResolveRepoRef error branches (bad repo ref).
	commandsIWWZServeErr(t, issueCommand(), "Invalid repo format", "create", "--repo", "bad", "--title", "X")
	commandsIWWZServeErr(t, issueCommand(), "Invalid repo format", "list", "--repo", "bad")
	commandsIWWZServeErr(t, issueCommand(), "Invalid repo format", "view", "7", "--repo", "bad")

	// parseIssueNumber error branches (bad number / bad blocks).
	commandsIWWZServeErr(t, issueCommand(), "invalid issue number", "view", "abc", "--repo", "alice/demo")
}

func TestCommandsIssueWikiWorkflow_Z_WikiFormatAndErrorBranches(t *testing.T) {
	server := commandsIWWZSuccessServer(t)
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	// FormatExplicit success branches.
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"list", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"search", "--repo", "alice/demo", "--query", "docs"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"view", "home", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"create", "--repo", "alice/demo", "--title", "Home", "--slug", "home", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"edit", "home", "--repo", "alice/demo", "--title", "X", "--slug", "y", "--body", "z", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"delete", "home", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"revisions", "home", "--repo", "alice/demo", "--json"})
	// The wiki spaces (#1922): every command carries --visibility; index and history are new.
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"list", "--repo", "alice/demo", "--visibility", "private"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"view", "home", "--repo", "alice/demo", "--visibility", "private", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"edit", "home", "--repo", "alice/demo", "--path", "Guides/Home.md", "--expected-revision", "2", "--visibility", "private", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"index", "--repo", "alice/demo", "--visibility", "private"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"index", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"history", "7", "--repo", "alice/demo", "--visibility", "private"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"history", "7", "--repo", "alice/demo", "--json"})
	commandsIWWZServeErr(t, wikiCommand(), "invalid wiki page id", "history", "x", "--repo", "alice/demo")
	commandsIWWZServeErr(t, wikiCommand(), "boom", "index", "--repo", "err/err")
	commandsIWWZServeErr(t, wikiCommand(), "boom", "history", "7", "--repo", "err/err")
	commandsIWWZServeErr(t, wikiCommand(), "Invalid repo format", "index", "--repo", "bad")
	commandsIWWZServeErr(t, wikiCommand(), "Invalid repo format", "history", "7", "--repo", "bad")

	// cleanAPIError error branches.
	commandsIWWZServeErr(t, wikiCommand(), "boom", "list", "--repo", "err/err")
	commandsIWWZServeErr(t, wikiCommand(), "boom", "search", "--repo", "err/err", "--query", "x")
	commandsIWWZServeErr(t, wikiCommand(), "boom", "view", "home", "--repo", "err/err")
	commandsIWWZServeErr(t, wikiCommand(), "boom", "create", "--repo", "err/err", "--title", "Home")
	commandsIWWZServeErr(t, wikiCommand(), "boom", "edit", "home", "--repo", "err/err", "--title", "X")
	commandsIWWZServeErr(t, wikiCommand(), "boom", "delete", "home", "--repo", "err/err")
	commandsIWWZServeErr(t, wikiCommand(), "boom", "revisions", "home", "--repo", "err/err")

	// ResolveRepoRef error branches.
	commandsIWWZServeErr(t, wikiCommand(), "Invalid repo format", "list", "--repo", "bad")
	commandsIWWZServeErr(t, wikiCommand(), "Invalid repo format", "create", "--repo", "bad", "--title", "Home")
	commandsIWWZServeErr(t, wikiCommand(), "Invalid repo format", "view", "home", "--repo", "bad")
}

func TestCommandsIssueWikiWorkflow_Z_WorkflowErrorBranches(t *testing.T) {
	server := commandsIWWZSuccessServer(t)
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	// run: ResolveRepoRef error and workflows-GET error.
	commandsIWWZServeErr(t, workflowCommand(), "Invalid repo format", "run", "build", "--repo", "bad")
	commandsIWWZServeErr(t, workflowCommand(), "boom", "run", "build", "--repo", "err/err")
	// dispatch: ResolveRepoRef + dispatch error.
	commandsIWWZServeErr(t, workflowCommand(), "Invalid repo format", "dispatch", "1", "--repo", "bad")
	commandsIWWZServeErr(t, workflowCommand(), "boom", "dispatch", "1", "--repo", "err/err")
	// run subcommands: ResolveRepoRef + request error.
	commandsIWWZServeErr(t, workflowRunCommand(), "Invalid repo format", "view", "42", "--repo", "bad")
	commandsIWWZServeErr(t, workflowRunCommand(), "boom", "view", "42", "--repo", "err/err")
	commandsIWWZServeErr(t, workflowRunCommand(), "Invalid repo format", "watch", "42", "--repo", "bad")
	commandsIWWZServeErr(t, workflowRunCommand(), "boom", "watch", "42", "--repo", "err/err")
	commandsIWWZServeErr(t, workflowRunCommand(), "Invalid repo format", "logs", "42", "--repo", "bad")
	commandsIWWZServeErr(t, workflowRunCommand(), "Failed to connect to run stream", "logs", "42", "--repo", "err/err")
	// watch on the workflow top-level command too.
	commandsIWWZServeErr(t, workflowCommand(), "Invalid repo format", "watch", "42", "--repo", "bad")
}

// TestCommandsIssueWikiWorkflow_Z_StreamEvents covers streamWorkflowRunEvents
// terminal-flush branches (done vs non-done trailing event) and watch on a
// completed run.
func TestCommandsIssueWikiWorkflow_Z_StreamEvents(t *testing.T) {
	mode := "done-no-blank"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/repos/alice/demo/runs/42":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":42,"status":"completed"}`)
		case "/api/repos/alice/demo/runs/43":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":43,"status":"running"}`)
		case "/api/repos/alice/demo/runs/43/logs", "/api/repos/alice/demo/runs/42/logs":
			w.Header().Set("Content-Type", "text/event-stream")
			switch mode {
			case "done-no-blank":
				// Last event ("done") has no trailing blank line: exercises the
				// post-loop flush() returning true.
				fmt.Fprint(w, "event: log\ndata: {\"content\":\"hi\"}\n\n")
				fmt.Fprint(w, "event: done\ndata: {\"status\":\"completed\"}\n")
			case "log-no-blank":
				// Last event ("log") has no trailing blank line: exercises the
				// post-loop flush() returning false, then final return.
				fmt.Fprint(w, "event: log\ndata: {\"content\":\"tail\"}\n")
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	events := commandsIssueWikiWorkflowCovCaptureStderr(t, func() {
		if evts, err := streamWorkflowRunEvents("alice", "demo", 43); err != nil || len(evts) != 2 {
			t.Errorf("done-no-blank events = (%#v, %v)", evts, err)
		}
	})
	if !strings.Contains(events, "Run completed: completed") {
		t.Fatalf("stream stderr = %q", events)
	}

	mode = "log-no-blank"
	commandsIssueWikiWorkflowCovCaptureStderr(t, func() {
		if evts, err := streamWorkflowRunEvents("alice", "demo", 43); err != nil || len(evts) != 1 {
			t.Errorf("log-no-blank events = (%#v, %v)", evts, err)
		}
	})

	// watch on an already-completed run returns without streaming.
	mode = "done-no-blank"
	commandsIssueWikiWorkflowCovCaptureStderr(t, func() {
		if out, err := watchWorkflowRun("alice", "demo", 42); err != nil || objectValue(out)["status"] != "completed" {
			t.Errorf("watchWorkflowRun completed = (%#v, %v)", out, err)
		}
	})
}

// TestCommandsIssueWikiWorkflow_Z_StreamErrors covers streamWorkflowRunEvents
// transport/status error branches.
func TestCommandsIssueWikiWorkflow_Z_StreamErrors(t *testing.T) {
	// Non-2xx status on the logs stream.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, "nope")
	}))
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)
	if _, err := streamWorkflowRunEvents("alice", "demo", 1); err == nil || !strings.Contains(err.Error(), "Failed to connect to run stream") {
		t.Fatalf("stream non-2xx = %v", err)
	}

	// Transport error: unreachable API URL.
	commandsIssueWikiWorkflowCovSetConfig(t, "http://127.0.0.1:1")
	if _, err := streamWorkflowRunEvents("alice", "demo", 1); err == nil {
		t.Fatal("stream transport error expected")
	}

	commandsIssueWikiWorkflowCovSetConfig(t, "://bad-url")
	if _, err := streamWorkflowRunEvents("alice", "demo", 1); err == nil {
		t.Fatal("stream bad URL error expected")
	}

	t.Setenv("SMITHERS_TOKEN", "")
	if _, err := streamWorkflowRunEvents("alice", "demo", 1); err == nil {
		t.Fatal("stream auth error expected")
	}
}

func TestCommandsIssueWikiWorkflow_Z_WatchStreamingErrorAndDefaultEvents(t *testing.T) {
	mode := "watch-error"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/repos/alice/demo/runs/44":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":44,"status":"running"}`)
		case "/api/repos/alice/demo/runs/44/logs":
			if mode == "watch-error" {
				w.WriteHeader(http.StatusBadGateway)
				fmt.Fprint(w, "nope")
				return
			}
			if mode == "empty" {
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "\n")
			fmt.Fprint(w, "data: raw default\n\n")
			fmt.Fprint(w, "event: done\ndata: {\"status\":\"completed\"}\n\n")
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	if _, err := watchWorkflowRun("alice", "demo", 44); err == nil || !strings.Contains(err.Error(), "Failed to connect") {
		t.Fatalf("watchWorkflowRun stream error = %v", err)
	}
	mode = "default"
	events, err := streamWorkflowRunEvents("alice", "demo", 44)
	if err != nil || len(events) != 2 || events[0]["type"] != "log" {
		t.Fatalf("default stream events = (%#v, %v)", events, err)
	}

	mode = "empty"
	events, err = streamWorkflowRunEvents("alice", "demo", 44)
	if err != nil || len(events) != 0 {
		t.Fatalf("empty stream events = (%#v, %v)", events, err)
	}
}

// TestCommandsIssueWikiWorkflow_Z_StreamScannerError covers the scanner.Err
// branch by returning a line that exceeds the scanner buffer.
func TestCommandsIssueWikiWorkflow_Z_StreamScannerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		// A single line longer than the 4MB scanner cap triggers ErrTooLong.
		huge := strings.Repeat("x", 5*1024*1024)
		fmt.Fprint(w, "data: "+huge)
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)
	if _, err := streamWorkflowRunEvents("alice", "demo", 1); err == nil {
		t.Fatal("stream scanner error expected")
	}
}

// TestCommandsIssueWikiWorkflow_Z_StreamAuthError covers the RequireAuthToken
// error branch when no token is configured.
func TestCommandsIssueWikiWorkflow_Z_StreamAuthError(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "")
	t.Setenv("SMITHERS_AUTH_FILE", t.TempDir()+"/auth.json")
	if _, err := streamWorkflowRunEvents("alice", "demo", 1); err == nil {
		t.Fatal("stream auth error expected")
	}
}
