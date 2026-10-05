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

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// recordingSources is the SourceReader seam: the mirrored-main reader and its
// credential checks are covered against a real repository host and real
// credentials in services; here only who may reach it, with which credential,
// and how its answers reach the producer are under test.
type recordingSources struct {
	mu      sync.Mutex
	reads   []string
	lists   []string
	lookups []string
	source  func(userID, repositoryID int64) (string, error)
	read    func(path string) (ports.SourceFile, error)
	list    func(path string) (ports.SourceDirectory, error)
}

func (s *recordingSources) Source(_ context.Context, credential middleware.Credential, userID, repositoryID int64) (string, error) {
	s.mu.Lock()
	s.lookups = append(s.lookups, fmt.Sprintf("%s%s %d/%d", credential.TokenHash, credential.SessionHash, userID, repositoryID))
	s.mu.Unlock()
	return s.source(userID, repositoryID)
}

func (s *recordingSources) ReadSource(_ context.Context, credential middleware.Credential, userID, repositoryID int64, path string) (ports.SourceFile, error) {
	s.mu.Lock()
	s.reads = append(s.reads, fmt.Sprintf("%s%s %d/%d:%s", credential.TokenHash, credential.SessionHash, userID, repositoryID, path))
	s.mu.Unlock()
	return s.read(path)
}

func (s *recordingSources) ListSource(_ context.Context, credential middleware.Credential, userID, repositoryID int64, path string) (ports.SourceDirectory, error) {
	s.mu.Lock()
	s.lists = append(s.lists, fmt.Sprintf("%s%s %d/%d:%s", credential.TokenHash, credential.SessionHash, userID, repositoryID, path))
	s.mu.Unlock()
	return s.list(path)
}

func (s *recordingSources) listed() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.lists...)
}

func (s *recordingSources) calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.reads...)
}

// session is the browser credential the tests' turns are admitted with.
var session = middleware.Credential{SessionHash: strings.Repeat("5", 64)}

func sourceReadServer(t *testing.T, store *Store, sources SourceReader, credentials *turnCredentials) *httptest.Server {
	t.Helper()
	handler := &Handler{Store: store, Sources: sources, credentials: credentials}
	router := chi.NewRouter()
	handler.MountProducerCallbacks(router)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
}

func postSourceRead(t *testing.T, server *httptest.Server, token, turnID string, generation int64, path string) (int, string) {
	t.Helper()
	return postSource(t, server, SourceReadPath, token, turnID, generation, path)
}

func postSource(t *testing.T, server *httptest.Server, route, token, turnID string, generation int64, path string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"turnId": turnID, "generation": generation, "path": path})
	request, err := http.NewRequest(http.MethodPost, server.URL+route, strings.NewReader(string(body)))
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

// claimedTurn admits and claims one turn, recording the credential that
// admitted it as the turn route does.
func claimedTurn(t *testing.T, store *Store, credentials *turnCredentials, scope Scope, runID string) ProducerGrant {
	t.Helper()
	journal := testJournal()
	credentials.admit(turnKey{userID: scope.UserID, runID: runID, legID: journal.LegID}, session)
	accepted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return grant
}

func TestSourceReadServesOnlyALiveProducerAsItsAdmittingCredential(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	credentials := newTurnCredentials()
	file := ports.SourceFile{Repository: "acme/app", Path: "JOURNEY.md", Commit: strings.Repeat("c", 40), Content: "Add a greeting to JOURNEY.md\n"}
	sources := &recordingSources{read: func(string) (ports.SourceFile, error) { return file, nil }}
	server := sourceReadServer(t, store, sources, credentials)
	runID := "source-" + uuid.NewString()
	grant := claimedTurn(t, store, credentials, scope, runID)

	status, body := postSourceRead(t, server, grant.Token, grant.TurnID, grant.Generation, "JOURNEY.md")
	if status != http.StatusOK || body != `{"repository":"acme/app","path":"JOURNEY.md","commit":"cccccccccccccccccccccccccccccccccccccccc","content":"Add a greeting to JOURNEY.md\n","binary":false}` {
		t.Fatalf("live producer read = %d %s", status, body)
	}
	if want := []string{fmt.Sprintf("%s %d/%d:JOURNEY.md", session.SessionHash, scope.UserID, scope.RepositoryID)}; fmt.Sprint(sources.calls()) != fmt.Sprint(want) {
		t.Fatalf("reads = %v, want %v", sources.calls(), want)
	}

	// No other capability reaches the reader: a missing or wrong token, a
	// stale generation, a malformed turn id, and the producer once its turn is
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
		status, body = postSourceRead(t, server, attempt.token, attempt.turnID, attempt.generation, "JOURNEY.md")
		if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
			t.Fatalf("fenced read %+v = %d %s", attempt, status, body)
		}
	}
	if _, err := store.Cancel(context.Background(), scope, runID); err != nil {
		t.Fatal(err)
	}
	status, body = postSourceRead(t, server, grant.Token, grant.TurnID, grant.Generation, "JOURNEY.md")
	if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
		t.Fatalf("cancelled turn read = %d %s", status, body)
	}

	// A live turn whose admitting credential this process does not hold, such
	// as one recovered after a restart, reads nothing.
	unknown := testScope()
	accepted := admit(t, store, unknown, "source-unadmitted-"+uuid.NewString(), testJournal())
	orphan, err := store.Claim(context.Background(), unknown, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	status, body = postSourceRead(t, server, orphan.Token, orphan.TurnID, orphan.Generation, "JOURNEY.md")
	if status != http.StatusForbidden || body != `{"code":"forbidden","status":"error"}` {
		t.Fatalf("unadmitted turn read = %d %s", status, body)
	}
	if len(sources.calls()) != 1 {
		t.Fatalf("refused capabilities reached the reader: %v", sources.calls())
	}
}

func TestSourceReadEndsWithTheTurnAndItsLease(t *testing.T) {
	store := needStore(t)
	clocked, clock := clockedStore(store)
	scope := testScope()
	credentials := newTurnCredentials()
	sources := &recordingSources{read: func(string) (ports.SourceFile, error) { return ports.SourceFile{}, nil }}
	server := sourceReadServer(t, clocked, sources, credentials)

	runID := "source-finished-" + uuid.NewString()
	finished := claimedTurn(t, clocked, credentials, scope, runID)
	if _, err := clocked.Commit(context.Background(), CommitInput{TurnID: finished.TurnID, Generation: finished.Generation, Token: finished.Token, Expected: finished.Cursor, Frames: []json.RawMessage{done(runID, "stop")}}); err != nil {
		t.Fatal(err)
	}
	expired := claimedTurn(t, clocked, credentials, scope, "source-expired-"+uuid.NewString())
	clock.advance(2 * time.Minute)
	for _, grant := range []ProducerGrant{finished, expired} {
		status, body := postSourceRead(t, server, grant.Token, grant.TurnID, grant.Generation, "JOURNEY.md")
		if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
			t.Fatalf("ended turn read = %d %s", status, body)
		}
	}
	if len(sources.calls()) != 0 {
		t.Fatalf("ended turns reached the reader: %v", sources.calls())
	}
}

func TestSourceReadStatesEachRefusal(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	credentials := newTurnCredentials()
	refusals := map[string]error{
		"not-ready.md": ports.ErrSourceNotReady,
		"../escape":    ports.ErrSourcePathRefused,
		"private.md":   ports.ErrSourceForbidden,
		"link":         ports.ErrSourceNotFound,
		"big.bin":      ports.ErrSourceTooLarge,
		"broken.md":    errors.New("repository host unreachable"),
	}
	sources := &recordingSources{read: func(path string) (ports.SourceFile, error) { return ports.SourceFile{}, refusals[path] }}
	server := sourceReadServer(t, store, sources, credentials)
	grant := claimedTurn(t, store, credentials, scope, "source-refusals-"+uuid.NewString())
	for path, want := range map[string]string{
		"not-ready.md": `409 {"code":"source_not_ready","status":"error"}`,
		"../escape":    `400 {"code":"path_refused","status":"error"}`,
		"private.md":   `403 {"code":"forbidden","status":"error"}`,
		"link":         `404 {"code":"not_found","status":"error"}`,
		"big.bin":      `413 {"code":"too_large","status":"error"}`,
		"broken.md":    `503 {"code":"source_failed","status":"error"}`,
	} {
		status, body := postSourceRead(t, server, grant.Token, grant.TurnID, grant.Generation, path)
		if got := fmt.Sprintf("%d %s", status, body); got != want {
			t.Fatalf("%s = %s, want %s", path, got, want)
		}
	}
	// Without a reader the callback refuses after the capability check.
	status, body := postSourceRead(t, sourceReadServer(t, store, nil, credentials), grant.Token, grant.TurnID, grant.Generation, "JOURNEY.md")
	if status != http.StatusServiceUnavailable || body != `{"code":"source_unavailable","status":"error"}` {
		t.Fatalf("no reader = %d %s", status, body)
	}
}

// A listing reaches the reader on exactly a read's terms: only a live
// producer, only as its turn's admitting credential, each refusal by its code.
func TestSourceListServesOnlyALiveProducerAndStatesEachRefusal(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	credentials := newTurnCredentials()
	root := ports.SourceDirectory{
		Repository: "acme/app", Path: "", Commit: strings.Repeat("c", 40),
		Entries: []ports.SourceEntry{{Name: "test", Kind: "dir"}, {Name: "package.json", Kind: "file"}},
	}
	refusals := map[string]error{
		"not-ready": ports.ErrSourceNotReady,
		"../escape": ports.ErrSourcePathRefused,
		"private":   ports.ErrSourceForbidden,
		"missing":   ports.ErrSourceNotFound,
		"broken":    errors.New("repository host unreachable"),
	}
	sources := &recordingSources{list: func(path string) (ports.SourceDirectory, error) {
		if path == "" {
			return root, nil
		}
		return ports.SourceDirectory{}, refusals[path]
	}}
	server := sourceReadServer(t, store, sources, credentials)
	runID := "source-list-" + uuid.NewString()
	grant := claimedTurn(t, store, credentials, scope, runID)

	status, body := postSource(t, server, SourceListPath, grant.Token, grant.TurnID, grant.Generation, "")
	if status != http.StatusOK || body != `{"repository":"acme/app","path":"","commit":"cccccccccccccccccccccccccccccccccccccccc","entries":[{"name":"test","kind":"dir"},{"name":"package.json","kind":"file"}],"truncated":false}` {
		t.Fatalf("live producer listing = %d %s", status, body)
	}
	if want := []string{fmt.Sprintf("%s %d/%d:", session.SessionHash, scope.UserID, scope.RepositoryID)}; fmt.Sprint(sources.listed()) != fmt.Sprint(want) {
		t.Fatalf("listings = %v, want %v", sources.listed(), want)
	}
	if len(sources.calls()) != 0 {
		t.Fatalf("a listing read a file: %v", sources.calls())
	}
	for path, want := range map[string]string{
		"not-ready": `409 {"code":"source_not_ready","status":"error"}`,
		"../escape": `400 {"code":"path_refused","status":"error"}`,
		"private":   `403 {"code":"forbidden","status":"error"}`,
		"missing":   `404 {"code":"not_found","status":"error"}`,
		"broken":    `503 {"code":"source_failed","status":"error"}`,
	} {
		status, body := postSource(t, server, SourceListPath, grant.Token, grant.TurnID, grant.Generation, path)
		if got := fmt.Sprintf("%d %s", status, body); got != want {
			t.Fatalf("%s = %s, want %s", path, got, want)
		}
	}
	listed := len(sources.listed())

	// No other capability reaches the reader, nor a turn this process did not admit.
	for _, attempt := range []struct {
		token, turnID string
		generation    int64
	}{
		{"", grant.TurnID, grant.Generation},
		{grant.Token + "x", grant.TurnID, grant.Generation},
		{grant.Token, grant.TurnID, grant.Generation + 1},
		{grant.Token, uuid.NewString(), grant.Generation},
	} {
		status, body = postSource(t, server, SourceListPath, attempt.token, attempt.turnID, attempt.generation, "")
		if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
			t.Fatalf("fenced listing %+v = %d %s", attempt, status, body)
		}
	}
	unknown := testScope()
	accepted := admit(t, store, unknown, "source-list-unadmitted-"+uuid.NewString(), testJournal())
	orphan, err := store.Claim(context.Background(), unknown, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	status, body = postSource(t, server, SourceListPath, orphan.Token, orphan.TurnID, orphan.Generation, "")
	if status != http.StatusForbidden || body != `{"code":"forbidden","status":"error"}` {
		t.Fatalf("unadmitted turn listing = %d %s", status, body)
	}
	if _, err := store.Cancel(context.Background(), scope, runID); err != nil {
		t.Fatal(err)
	}
	status, body = postSource(t, server, SourceListPath, grant.Token, grant.TurnID, grant.Generation, "")
	if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
		t.Fatalf("cancelled turn listing = %d %s", status, body)
	}
	if len(sources.listed()) != listed {
		t.Fatalf("refused capabilities reached the reader: %v", sources.listed())
	}
	// Without a reader the callback refuses after the capability check.
	live := claimedTurn(t, store, credentials, scope, "source-list-noreader-"+uuid.NewString())
	status, body = postSource(t, sourceReadServer(t, store, nil, credentials), SourceListPath, live.Token, live.TurnID, live.Generation, "")
	if status != http.StatusServiceUnavailable || body != `{"code":"source_unavailable","status":"error"}` {
		t.Fatalf("no reader = %d %s", status, body)
	}
}

type grantRecorder struct {
	grants []ports.ChatTurnGrant
	err    error
}

func (h *grantRecorder) RunChatTurn(_ context.Context, grant ports.ChatTurnGrant) error {
	h.grants = append(h.grants, grant)
	return h.err
}

func TestPortHostGrantsSourceOnlyWhenTheAdmittingCredentialCanReadIt(t *testing.T) {
	answers := map[int64]error{2: ports.ErrSourceNotReady, 3: ports.ErrSourceForbidden, 4: errors.New("database unavailable")}
	sources := &recordingSources{source: func(userID, repositoryID int64) (string, error) {
		if repositoryID != 9 {
			return "", fmt.Errorf("repository %d was not the turn's", repositoryID)
		}
		if err := answers[userID]; err != nil {
			return "", err
		}
		return "acme/app", nil
	}}
	credentials := newTurnCredentials()
	logs := &bytes.Buffer{}
	recorder := &grantRecorder{}
	host := PortHost{Host: recorder, ProducerBaseURL: "http://127.0.0.1:1", Sources: sources, credentials: credentials, logger: slog.New(slog.NewTextHandler(logs, nil))}
	turn := func(owner int64) ProducerGrant {
		return ProducerGrant{TurnID: fmt.Sprintf("turn-%d", owner), OwnerID: owner, RepositoryID: 9, RunID: fmt.Sprintf("run-%d", owner), LegID: "leg"}
	}
	for owner := int64(1); owner <= 5; owner++ {
		if owner != 5 {
			credentials.admit(turnKey{userID: owner, runID: turn(owner).RunID, legID: "leg"}, session)
		}
		// A failed lookup runs the turn without source rather than failing it.
		if err := host.RunTurn(context.Background(), turn(owner)); err != nil {
			t.Fatalf("owner %d: %v", owner, err)
		}
	}
	if len(recorder.grants) != 5 {
		t.Fatalf("host launched %d turns, want 5", len(recorder.grants))
	}
	if source := recorder.grants[0].Source; source == nil || source.Repository != "acme/app" || recorder.grants[0].ProducerBaseURL != "http://127.0.0.1:1" {
		t.Fatalf("readable grant = %+v", recorder.grants[0])
	}
	for _, grant := range recorder.grants[1:] {
		if grant.Source != nil {
			t.Fatalf("grant without a readable source carried %+v", grant.Source)
		}
		encoded, _ := json.Marshal(grant)
		if strings.Contains(string(encoded), `"source"`) {
			t.Fatalf("grant wire names a source: %s", encoded)
		}
	}
	// The lookup ran with the admitting credential; a turn with none was never looked up.
	if want := fmt.Sprint([]string{session.SessionHash + " 1/9", session.SessionHash + " 2/9", session.SessionHash + " 3/9", session.SessionHash + " 4/9"}); fmt.Sprint(sources.lookups) != want {
		t.Fatalf("lookups = %v, want %v", sources.lookups, want)
	}
	if !strings.Contains(logs.String(), "chat turn runs without source after its lookup failed") || !strings.Contains(logs.String(), "database unavailable") {
		t.Fatalf("lookup failure was not logged: %s", logs.String())
	}
	// A turn the host finished reads no more; one it failed keeps its credential for the rerun.
	if _, ok := credentials.credential(turnKey{userID: 1, runID: "run-1", legID: "leg"}); ok {
		t.Fatal("a finished turn kept its credential")
	}
	recorder.err = errors.New("host failed before the provider started")
	credentials.admit(turnKey{userID: 6, runID: "run-6", legID: "leg"}, session)
	if err := host.RunTurn(context.Background(), turn(6)); err == nil {
		t.Fatal("host failure was not returned for a rerun")
	}
	if _, ok := credentials.credential(turnKey{userID: 6, runID: "run-6", legID: "leg"}); !ok {
		t.Fatal("a turn to rerun lost its credential")
	}
	// A deployment without a reader grants none.
	recorder.grants, recorder.err = nil, nil
	if err := (PortHost{Host: recorder, ProducerBaseURL: "http://127.0.0.1:1", credentials: credentials}).RunTurn(context.Background(), turn(6)); err != nil || recorder.grants[0].Source != nil {
		t.Fatalf("no reader: err=%v grant=%+v", err, recorder.grants)
	}
}

func TestTurnCredentialsKeepTheFirstAdmissionForATurnLifetime(t *testing.T) {
	clock := &testClock{now: time.Now()}
	credentials := &turnCredentials{now: clock.Now, admitted: map[turnKey]admittedCredential{}}
	key, other := turnKey{userID: 1, runID: "run", legID: "leg"}, turnKey{userID: 2, runID: "run", legID: "leg"}
	token := middleware.Credential{TokenHash: strings.Repeat("7", 64)}

	releaseFirst := credentials.admit(key, session)
	// A second admission of the same turn neither replaces nor removes the first.
	credentials.admit(key, token)()
	if got, ok := credentials.credential(key); !ok || got != session {
		t.Fatalf("credential = %+v %t, want the first admission's", got, ok)
	}
	if _, ok := credentials.credential(other); ok {
		t.Fatal("another account's turn with the same identity read the credential")
	}
	// An admission that accepts nothing new forgets only its own record.
	releaseFirst()
	if _, ok := credentials.credential(key); ok {
		t.Fatal("a released admission kept its credential")
	}
	releaseFirst = credentials.admit(key, token)
	credentials.end(key)
	credentials.admit(key, session)
	releaseFirst()
	if got, ok := credentials.credential(key); !ok || got != session {
		t.Fatalf("a stale release removed a later admission: %+v %t", got, ok)
	}
	// A request without a credential records nothing.
	credentials.admit(other, middleware.Credential{})
	if _, ok := credentials.credential(other); ok {
		t.Fatal("an empty credential was recorded")
	}
	// A turn reads as its credential for a turn credential's lifetime, no longer.
	clock.advance(turnCredentialLifetime - time.Second)
	if _, ok := credentials.credential(key); !ok {
		t.Fatal("credential expired early")
	}
	clock.advance(time.Second)
	if _, ok := credentials.credential(key); ok {
		t.Fatal("credential outlived a turn credential's lifetime")
	}
	credentials.admit(other, token)
	if _, swept := credentials.admitted[key]; swept {
		t.Fatal("an expired credential was kept past the next admission")
	}
	// A deployment without the store forgets everything safely.
	var none *turnCredentials
	none.admit(key, session)()
	none.end(key)
	if _, ok := none.credential(key); ok {
		t.Fatal("no store answered a credential")
	}
}

// The turn route records the credential that admitted each turn, first
// admission only, before the turn exists.
func TestTurnRouteRecordsTheAdmittingCredential(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	host := &deterministicHost{store: store, entered: make(chan struct{}), release: make(chan struct{})}
	close(host.release)
	dispatcher, err := NewDispatcher(store, host, 8, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = dispatcher.Run(ctx, 1) }()
	credentials := newTurnCredentials()
	handler := &Handler{Store: store, Dispatcher: dispatcher, credentials: credentials}
	as := func(info *middleware.AuthInfo) *httptest.Server {
		router := chi.NewRouter()
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				next.ServeHTTP(w, r.WithContext(middleware.ContextWithAuthInfo(r.Context(), info)))
			})
		})
		handler.MountPublic(router)
		server := httptest.NewServer(router)
		t.Cleanup(server.Close)
		return server
	}
	user := &db.User{ID: scope.UserID, Username: scope.Owner}
	browser := as(&middleware.AuthInfo{User: user, SessionHash: session.SessionHash})
	pat := as(&middleware.AuthInfo{User: user, IsTokenAuth: true, TokenHash: strings.Repeat("7", 64)})
	runID, journal := "credential-"+uuid.NewString(), testJournal()
	post := func(server *httptest.Server, body []byte) int {
		response := postJSON(t, server.Client(), server.URL+TurnPath, body)
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode
	}
	key := turnKey{userID: scope.UserID, runID: runID, legID: journal.LegID}
	if status := post(browser, turnBody(runID, journal)); status != http.StatusOK {
		t.Fatalf("turn = %d", status)
	}
	if got, ok := credentials.credential(key); !ok || got != session {
		t.Fatalf("admitted credential = %+v %t", got, ok)
	}
	// Reattaching with another credential leaves the admitting one.
	if status := post(pat, turnBody(runID, journal)); status != http.StatusOK {
		t.Fatalf("reattach = %d", status)
	}
	if got, _ := credentials.credential(key); got != session {
		t.Fatalf("reattaching replaced the credential with %+v", got)
	}
	// An admission the store refuses forgets the credential it recorded.
	refused, refusedJournal := "credential-refused-"+uuid.NewString(), testJournal()
	var body map[string]any
	if err = json.Unmarshal(turnBody(refused, refusedJournal), &body); err != nil {
		t.Fatal(err)
	}
	body["conversationId"] = 5
	invalid, _ := json.Marshal(body)
	if status := post(pat, invalid); status == http.StatusOK {
		t.Fatal("an invalid conversation id was admitted")
	}
	if _, ok := credentials.credential(turnKey{userID: scope.UserID, runID: refused, legID: refusedJournal.LegID}); ok {
		t.Fatal("a refused admission kept its credential")
	}
}
