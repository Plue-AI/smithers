package repohostserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestPushHookSenderFromHeaders(t *testing.T) {
	headers := http.Header{}
	headers.Set("X-Smithers-Pusher-Id", "42")
	headers.Set("X-Smithers-Pusher-Login", "alice")
	headers.Set(repohost.RepositoryIDHeader, "109")

	sender := pushHookSenderFromHeaders(headers)
	if sender.RepositoryID != 109 || sender.PusherID != 42 || sender.PusherLogin != "alice" {
		t.Fatalf("unexpected sender: %#v", sender)
	}
	for _, value := range []string{"", "bad", "999999999999999999999999999"} {
		headers.Set(repohost.RepositoryIDHeader, value)
		if got := pushHookSenderFromHeaders(headers).RepositoryID; got != 0 {
			t.Fatalf("invalid repository header %q yielded ID %d", value, got)
		}
	}
}

func TestPushHookPayloadsFromRefDiff(t *testing.T) {
	beforeRefs := map[string]string{
		"refs/heads/main":  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"refs/tags/v1.0":   "dddddddddddddddddddddddddddddddddddddddd",
		"refs/jj/keep/old": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
	}
	afterRefs := map[string]string{
		"refs/heads/dev":   "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"refs/heads/main":  "cccccccccccccccccccccccccccccccccccccccc",
		"refs/jj/keep/new": "ffffffffffffffffffffffffffffffffffffffff",
		// The stack service's own writes are not user pushes.
		"refs/heads/mythical": "1111111111111111111111111111111111111111",
		"refs/notes/mythical": "2222222222222222222222222222222222222222",
	}

	headers := http.Header{}
	headers.Set(repohost.RepositoryIDHeader, "109")
	headers.Set("X-Smithers-Pusher-Id", "42")
	headers.Set("X-Smithers-Pusher-Login", "alice")
	payloads := pushHookPayloadsFromRefDiff(beforeRefs, afterRefs, "alice", "demo", pushHookSenderFromHeaders(headers))

	want := []PushHookPayload{
		{
			RepositoryID: 109,
			Owner:        "alice",
			Repo:         "demo",
			RefName:      "refs/heads/dev",
			BeforeSHA:    "",
			CommitSHA:    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			PusherID:     42,
			PusherLogin:  "alice",
		},
		{
			RepositoryID: 109,
			Owner:        "alice",
			Repo:         "demo",
			RefName:      "refs/heads/main",
			BeforeSHA:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			CommitSHA:    "cccccccccccccccccccccccccccccccccccccccc",
			PusherID:     42,
			PusherLogin:  "alice",
		},
		{
			RepositoryID: 109,
			Owner:        "alice",
			Repo:         "demo",
			RefName:      "refs/tags/v1.0",
			BeforeSHA:    "dddddddddddddddddddddddddddddddddddddddd",
			CommitSHA:    "",
			PusherID:     42,
			PusherLogin:  "alice",
		},
	}
	if !reflect.DeepEqual(payloads, want) {
		t.Fatalf("unexpected payloads (internal refs must be filtered): %#v", payloads)
	}
}

func TestSendPushHookPostsJSONAndBearerToken(t *testing.T) {
	var gotAuth string
	var gotPayload PushHookPayload

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatalf("decode push hook request: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	cfg := Config{
		PushHookCallbackURL:   srv.URL,
		PushHookCallbackToken: "secret",
	}
	want := PushHookPayload{RepositoryID: 109, Owner: "alice", Repo: "demo", RefName: "refs/heads/main", CommitSHA: "deadbeef", PusherID: 42, PusherLogin: "alice"}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sendPushHook(ctx, srv.Client(), cfg, want); err != nil {
		t.Fatalf("sendPushHook: %v", err)
	}

	if gotAuth != "Bearer secret" {
		t.Fatalf("unexpected auth header %q", gotAuth)
	}
	if gotPayload != want {
		t.Fatalf("unexpected payload %#v", gotPayload)
	}
}

// The API answers a push for a repository it no longer knows with a typed
// not_found body. That is the only 404 a delivery may ignore.
func TestSendPushHookIgnoresTypedRepositoryNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"not_found","fault":"user","message":"Repository not found"}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sendPushHook(ctx, srv.Client(), Config{PushHookCallbackURL: srv.URL, PushHookCallbackToken: "callback-token"}, PushHookPayload{}); err != nil {
		t.Fatalf("expected typed repository-not-found callback to be ignored, got %v", err)
	}
}

// A callback URL that names no route (a wrong path, or an API that did not
// register the push-hook handler) must fail every delivery, not succeed.
func TestSendPushHookFailsOnUnroutedCallback(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/repo-host/push-events", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := sendPushHook(ctx, srv.Client(), Config{PushHookCallbackURL: srv.URL + "/internal/repo-host/push-event", PushHookCallbackToken: "callback-token"}, PushHookPayload{})
	if err == nil {
		t.Fatal("expected an unrouted callback to fail")
	}
}
