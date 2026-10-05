package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// recordingAPI is the CommandAPI seam: the credential gate and the routes'
// own authorization are covered against real credentials in services and
// the production router in compose; here only who may reach it, with which
// credential, and how its answers reach the producer are under test.
type recordingAPI struct {
	mu      sync.Mutex
	calls   []string
	authors []string
	author  func(userID int64) (string, error)
	call    func(method, path string) (ports.ChatAPIAnswer, error)
}

func (a *recordingAPI) Author(_ context.Context, credential middleware.Credential, userID int64) (string, error) {
	a.mu.Lock()
	a.authors = append(a.authors, fmt.Sprintf("%s%s %d", credential.TokenHash, credential.SessionHash, userID))
	a.mu.Unlock()
	return a.author(userID)
}

func (a *recordingAPI) Call(_ context.Context, credential middleware.Credential, userID int64, method, path string) (ports.ChatAPIAnswer, error) {
	a.mu.Lock()
	a.calls = append(a.calls, fmt.Sprintf("%s%s %d %s %s", credential.TokenHash, credential.SessionHash, userID, method, path))
	a.mu.Unlock()
	return a.call(method, path)
}

func (a *recordingAPI) seen() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.calls...)
}

func apiCallServer(t *testing.T, store *Store, api CommandAPI, credentials *turnCredentials) *httptest.Server {
	t.Helper()
	handler := &Handler{Store: store, API: api, credentials: credentials}
	router := chi.NewRouter()
	handler.MountProducerCallbacks(router)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
}

func postAPICall(t *testing.T, server *httptest.Server, token, turnID string, generation int64, method, path string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"turnId": turnID, "generation": generation, "method": method, "path": path})
	request, err := http.NewRequest(http.MethodPost, server.URL+APICallPath, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("content-type", "application/json")
	if token != "" {
		request.Header.Set("authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	answer, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, strings.TrimSpace(string(answer))
}

func TestAPICallServesOnlyALiveProducerAsItsAdmittingCredential(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	credentials := newTurnCredentials()
	api := &recordingAPI{call: func(string, string) (ports.ChatAPIAnswer, error) {
		return ports.ChatAPIAnswer{Status: http.StatusOK, Body: json.RawMessage(`[{"n":1}]`)}, nil
	}}
	server := apiCallServer(t, store, api, credentials)
	runID := "api-" + uuid.NewString()
	grant := claimedTurn(t, store, credentials, scope, runID)

	status, body := postAPICall(t, server, grant.Token, grant.TurnID, grant.Generation, http.MethodGet, "/api/todos")
	if status != http.StatusOK || body != `{"status":200,"body":[{"n":1}]}` {
		t.Fatalf("live producer call = %d %s", status, body)
	}
	if want := []string{fmt.Sprintf("%s %d GET /api/todos", session.SessionHash, scope.UserID)}; fmt.Sprint(api.seen()) != fmt.Sprint(want) {
		t.Fatalf("calls = %v, want %v", api.seen(), want)
	}

	// No other capability reaches the API: a missing or wrong token, a stale
	// generation, a malformed turn id, and the producer once its turn is
	// cancelled.
	for _, attempt := range []struct {
		token, turnID string
		generation    int64
	}{
		{"", grant.TurnID, grant.Generation},
		{grant.Token + "x", grant.TurnID, grant.Generation},
		{grant.Token, grant.TurnID, grant.Generation + 1},
		{grant.Token, "not-a-turn", grant.Generation},
		{grant.Token, uuid.NewString(), grant.Generation},
	} {
		status, body = postAPICall(t, server, attempt.token, attempt.turnID, attempt.generation, http.MethodGet, "/api/todos")
		if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
			t.Fatalf("fenced call %+v = %d %s", attempt, status, body)
		}
	}
	if _, err := store.Cancel(context.Background(), scope, runID); err != nil {
		t.Fatal(err)
	}
	status, body = postAPICall(t, server, grant.Token, grant.TurnID, grant.Generation, http.MethodGet, "/api/todos")
	if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
		t.Fatalf("cancelled turn call = %d %s", status, body)
	}

	// A live turn whose admitting credential this process does not hold, such
	// as one recovered after a restart, reads nothing.
	unknown := testScope()
	accepted := admit(t, store, unknown, "api-unadmitted-"+uuid.NewString(), testJournal())
	orphan, err := store.Claim(context.Background(), unknown, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	status, body = postAPICall(t, server, orphan.Token, orphan.TurnID, orphan.Generation, http.MethodGet, "/api/todos")
	if status != http.StatusForbidden || body != `{"code":"forbidden","status":"error"}` {
		t.Fatalf("unadmitted turn call = %d %s", status, body)
	}
	if len(api.seen()) != 1 {
		t.Fatalf("refused capabilities reached the API: %v", api.seen())
	}
}

func TestAPICallStatesEachRefusal(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	credentials := newTurnCredentials()
	refusals := map[string]error{
		"/api/gone":  ports.ErrAPIForbidden,
		"/api/write": ports.ErrAPICallRefused,
		"/api/down":  errors.New("database unavailable"),
	}
	api := &recordingAPI{call: func(_, path string) (ports.ChatAPIAnswer, error) {
		if err := refusals[path]; err != nil {
			return ports.ChatAPIAnswer{}, err
		}
		// The route's own refusal is an answer, passed through as it stands.
		return ports.ChatAPIAnswer{Status: http.StatusForbidden, Body: json.RawMessage(`{"code":"permission","message":"Install owner session required"}`)}, nil
	}}
	server := apiCallServer(t, store, api, credentials)
	grant := claimedTurn(t, store, credentials, scope, "api-refusals-"+uuid.NewString())
	for path, want := range map[string]string{
		"/api/gone":  `403 {"code":"forbidden","status":"error"}`,
		"/api/write": `400 {"code":"call_refused","status":"error"}`,
		"/api/down":  `503 {"code":"api_failed","status":"error"}`,
		"/api/todos": `200 {"status":403,"body":{"code":"permission","message":"Install owner session required"}}`,
	} {
		status, body := postAPICall(t, server, grant.Token, grant.TurnID, grant.Generation, http.MethodGet, path)
		if got := fmt.Sprintf("%d %s", status, body); got != want {
			t.Fatalf("%s = %s, want %s", path, got, want)
		}
	}
	// An unknown field is not a call.
	request, _ := http.NewRequest(http.MethodPost, server.URL+APICallPath, strings.NewReader(`{"turnId":"`+grant.TurnID+`","generation":1,"method":"GET","path":"/api/todos","body":{}}`))
	request.Header.Set("authorization", "Bearer "+grant.Token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("call with a body = %d", response.StatusCode)
	}
	// Without an API the callback refuses after the capability check.
	status, body := postAPICall(t, apiCallServer(t, store, nil, credentials), grant.Token, grant.TurnID, grant.Generation, http.MethodGet, "/api/todos")
	if status != http.StatusServiceUnavailable || body != `{"code":"api_unavailable","status":"error"}` {
		t.Fatalf("no API = %d %s", status, body)
	}
	if len(api.seen()) != 4 {
		t.Fatalf("calls = %v", api.seen())
	}
}

func TestAPICallEndsWithTheTurnAndItsLease(t *testing.T) {
	store := needStore(t)
	clocked, clock := clockedStore(store)
	scope := testScope()
	credentials := newTurnCredentials()
	api := &recordingAPI{call: func(string, string) (ports.ChatAPIAnswer, error) { return ports.ChatAPIAnswer{}, nil }}
	server := apiCallServer(t, clocked, api, credentials)
	runID := "api-finished-" + uuid.NewString()
	finished := claimedTurn(t, clocked, credentials, scope, runID)
	if _, err := clocked.Commit(context.Background(), CommitInput{TurnID: finished.TurnID, Generation: finished.Generation, Token: finished.Token, Expected: finished.Cursor, Frames: []json.RawMessage{done(runID, "stop")}}); err != nil {
		t.Fatal(err)
	}
	expired := claimedTurn(t, clocked, credentials, scope, "api-expired-"+uuid.NewString())
	clock.advance(2 * time.Minute)
	for _, grant := range []ProducerGrant{finished, expired} {
		status, body := postAPICall(t, server, grant.Token, grant.TurnID, grant.Generation, http.MethodGet, "/api/todos")
		if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
			t.Fatalf("ended turn call = %d %s", status, body)
		}
	}
	if len(api.seen()) != 0 {
		t.Fatalf("ended turns reached the API: %v", api.seen())
	}
}

func TestPortHostGrantsTheAPIOnlyWhenTheAdmittingCredentialIsItsAuthors(t *testing.T) {
	answers := map[int64]error{2: ports.ErrAPIForbidden, 3: errors.New("database unavailable")}
	api := &recordingAPI{author: func(userID int64) (string, error) {
		if err := answers[userID]; err != nil {
			return "", err
		}
		return fmt.Sprintf("person-%d", userID), nil
	}}
	credentials := newTurnCredentials()
	logs := &bytes.Buffer{}
	recorder := &grantRecorder{}
	host := PortHost{Host: recorder, ProducerBaseURL: "http://127.0.0.1:1", API: api, credentials: credentials, logger: slog.New(slog.NewTextHandler(logs, nil))}
	turn := func(owner int64) ProducerGrant {
		return ProducerGrant{TurnID: fmt.Sprintf("turn-%d", owner), OwnerID: owner, RunID: fmt.Sprintf("run-%d", owner), LegID: "leg"}
	}
	for owner := int64(1); owner <= 4; owner++ {
		if owner != 4 {
			credentials.admit(turnKey{userID: owner, runID: turn(owner).RunID, legID: "leg"}, session)
		}
		if err := host.RunTurn(context.Background(), turn(owner)); err != nil {
			t.Fatal(err)
		}
	}
	got := make([]string, 0, len(recorder.grants))
	for _, grant := range recorder.grants {
		if grant.API == nil {
			got = append(got, "none")
		} else {
			got = append(got, grant.API.Author)
		}
		if grant.Source != nil {
			t.Fatalf("a deployment without a source reader granted source: %+v", grant.Source)
		}
	}
	// The author's session gets the API; a refused credential, a failed
	// lookup and a turn admitted elsewhere get none, and only a failure is logged.
	if want := []string{"person-1", "none", "none", "none"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("grants = %v, want %v", got, want)
	}
	if want := []string{session.SessionHash + " 1", session.SessionHash + " 2", session.SessionHash + " 3"}; fmt.Sprint(api.authors) != fmt.Sprint(want) {
		t.Fatalf("lookups = %v, want %v", api.authors, want)
	}
	if strings.Count(logs.String(), "without the install API") != 1 || !strings.Contains(logs.String(), "turn-3") {
		t.Fatalf("log = %s", logs.String())
	}
	// Without an API composed, no turn is granted it.
	recorder.grants = nil
	host.API = nil
	if err := host.RunTurn(context.Background(), turn(1)); err != nil {
		t.Fatal(err)
	}
	if recorder.grants[0].API != nil {
		t.Fatalf("a deployment without an API granted it: %+v", recorder.grants[0].API)
	}
}
