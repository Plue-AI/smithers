package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/ports"
)

// recordingSources is the SourceReader seam: the mirrored-main reader itself
// is covered against a real repository host in services; here only who may
// reach it, as whom, and how its answers reach the producer are under test.
type recordingSources struct {
	mu     sync.Mutex
	reads  []string
	source func(userID, repositoryID int64) (string, error)
	read   func(path string) (ports.SourceFile, error)
}

func (s *recordingSources) Source(_ context.Context, userID, repositoryID int64) (string, error) {
	return s.source(userID, repositoryID)
}

func (s *recordingSources) ReadSource(_ context.Context, userID, repositoryID int64, path string) (ports.SourceFile, error) {
	s.mu.Lock()
	s.reads = append(s.reads, fmt.Sprintf("%d/%d:%s", userID, repositoryID, path))
	s.mu.Unlock()
	return s.read(path)
}

func (s *recordingSources) calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.reads...)
}

func sourceReadServer(t *testing.T, store *Store, sources SourceReader) *httptest.Server {
	t.Helper()
	handler := &Handler{Store: store, Sources: sources}
	router := chi.NewRouter()
	handler.MountProducerCallbacks(router)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
}

func postSourceRead(t *testing.T, server *httptest.Server, token, turnID string, generation int64, path string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"turnId": turnID, "generation": generation, "path": path})
	request, err := http.NewRequest(http.MethodPost, server.URL+SourceReadPath, strings.NewReader(string(body)))
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

func TestSourceReadServesOnlyALiveProducerAsTheTurnAuthor(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	file := ports.SourceFile{Repository: "acme/app", Path: "JOURNEY.md", Commit: strings.Repeat("c", 40), Content: "Add a greeting to JOURNEY.md\n"}
	sources := &recordingSources{read: func(string) (ports.SourceFile, error) { return file, nil }}
	server := sourceReadServer(t, store, sources)
	runID := "source-" + uuid.NewString()
	accepted := admit(t, store, scope, runID, testJournal())
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	status, body := postSourceRead(t, server, grant.Token, grant.TurnID, grant.Generation, "JOURNEY.md")
	if status != http.StatusOK || body != `{"repository":"acme/app","path":"JOURNEY.md","commit":"cccccccccccccccccccccccccccccccccccccccc","content":"Add a greeting to JOURNEY.md\n","binary":false}` {
		t.Fatalf("live producer read = %d %s", status, body)
	}
	if want := []string{fmt.Sprintf("%d/%d:JOURNEY.md", scope.UserID, scope.RepositoryID)}; fmt.Sprint(sources.calls()) != fmt.Sprint(want) {
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
	if _, err = store.Cancel(context.Background(), scope, runID); err != nil {
		t.Fatal(err)
	}
	status, body = postSourceRead(t, server, grant.Token, grant.TurnID, grant.Generation, "JOURNEY.md")
	if status != http.StatusUnauthorized || body != `{"code":"producer_fenced","status":"error"}` {
		t.Fatalf("cancelled turn read = %d %s", status, body)
	}
	if len(sources.calls()) != 1 {
		t.Fatalf("refused capabilities reached the reader: %v", sources.calls())
	}
}

func TestSourceReadEndsWithTheTurnAndItsLease(t *testing.T) {
	store := needStore(t)
	clocked, clock := clockedStore(store)
	scope := testScope()
	sources := &recordingSources{read: func(string) (ports.SourceFile, error) { return ports.SourceFile{}, nil }}
	server := sourceReadServer(t, clocked, sources)

	runID := "source-finished-" + uuid.NewString()
	accepted := admit(t, clocked, scope, runID, testJournal())
	finished, err := clocked.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = clocked.Commit(context.Background(), CommitInput{TurnID: finished.TurnID, Generation: finished.Generation, Token: finished.Token, Expected: finished.Cursor, Frames: []json.RawMessage{done(runID, "stop")}}); err != nil {
		t.Fatal(err)
	}
	accepted = admit(t, clocked, scope, "source-expired-"+uuid.NewString(), testJournal())
	expired, err := clocked.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
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
	refusals := map[string]error{
		"not-ready.md": ports.ErrSourceNotReady,
		"../escape":    ports.ErrSourcePathRefused,
		"private.md":   ports.ErrSourceForbidden,
		"link":         ports.ErrSourceNotFound,
		"big.bin":      ports.ErrSourceTooLarge,
		"broken.md":    errors.New("repository host unreachable"),
	}
	sources := &recordingSources{read: func(path string) (ports.SourceFile, error) { return ports.SourceFile{}, refusals[path] }}
	server := sourceReadServer(t, store, sources)
	accepted := admit(t, store, scope, "source-refusals-"+uuid.NewString(), testJournal())
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
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
	status, body := postSourceRead(t, sourceReadServer(t, store, nil), grant.Token, grant.TurnID, grant.Generation, "JOURNEY.md")
	if status != http.StatusServiceUnavailable || body != `{"code":"source_unavailable","status":"error"}` {
		t.Fatalf("no reader = %d %s", status, body)
	}
}

type grantRecorder struct{ grants []ports.ChatTurnGrant }

func (h *grantRecorder) RunChatTurn(_ context.Context, grant ports.ChatTurnGrant) error {
	h.grants = append(h.grants, grant)
	return nil
}

func TestPortHostGrantsSourceOnlyWhenTheAuthorCanReadIt(t *testing.T) {
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
	recorder := &grantRecorder{}
	host := PortHost{Host: recorder, ProducerBaseURL: "http://127.0.0.1:1", Sources: sources}
	for owner := int64(1); owner <= 3; owner++ {
		if err := host.RunTurn(context.Background(), ProducerGrant{TurnID: "turn", OwnerID: owner, RepositoryID: 9}); err != nil {
			t.Fatalf("owner %d: %v", owner, err)
		}
	}
	if err := host.RunTurn(context.Background(), ProducerGrant{TurnID: "turn", OwnerID: 4, RepositoryID: 9}); err == nil || !strings.Contains(err.Error(), "database unavailable") {
		t.Fatalf("source lookup failure = %v, want the turn rerun", err)
	}
	if len(recorder.grants) != 3 {
		t.Fatalf("host launched %d turns, want 3", len(recorder.grants))
	}
	if source := recorder.grants[0].Source; source == nil || source.Repository != "acme/app" || recorder.grants[0].ProducerBaseURL != "http://127.0.0.1:1" {
		t.Fatalf("ready grant = %+v", recorder.grants[0])
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
	// A deployment without a reader grants none.
	recorder.grants = nil
	if err := (PortHost{Host: recorder, ProducerBaseURL: "http://127.0.0.1:1"}).RunTurn(context.Background(), ProducerGrant{TurnID: "turn", OwnerID: 1}); err != nil || recorder.grants[0].Source != nil {
		t.Fatalf("no reader: err=%v grant=%+v", err, recorder.grants)
	}
}
