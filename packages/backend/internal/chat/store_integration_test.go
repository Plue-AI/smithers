package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

var testStore *Store

// dbWait bounds a wait that includes PostgreSQL round trips. A slow database
// must not read as a lost turn.
const dbWait = 10 * time.Second

var scopeID atomic.Int64

// Author rechecks use the real install membership tables alongside the journal.
var chatSuite = postgresfixture.Suite{}

func TestMain(m *testing.M) {
	os.Exit(chatSuite.Run(m, func(ctx context.Context, pool *pgxpool.Pool) error {
		var err error
		testStore, err = NewStore(pool)
		return err
	}))
}

// testClock is a store clock a test moves by hand.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) advance(by time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(by)
}

// clockedStore shares the test database but reads time from a clock the test
// controls, so lease expiry never races the database's speed.
func clockedStore(shared *Store) (*Store, *testClock) {
	clock := &testClock{now: time.Now()}
	return &Store{pool: shared.pool, now: clock.Now}, clock
}

func needStore(t *testing.T) *Store {
	t.Helper()
	chatSuite.Pool(t) // skips, or fails when required, if setup did not finish
	return testStore
}

func testScope() Scope {
	// IDs cross the canonical TypeScript number wire and must stay JS-safe.
	value := scopeID.Add(1)
	return Scope{RepositoryID: value, UserID: value, Owner: fmt.Sprintf("owner-%d", value)}
}

func testJournal() JournalRequest {
	return JournalRequest{Version: 1, LegID: uuid.NewString(), Token: strings.Repeat("a", 48) + strings.ReplaceAll(uuid.NewString(), "-", "")}
}

func requestFor(runID string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"instructions":"","messages":[{"content":"hello","role":"user"}],"runId":%q}`, runID))
}

func frame(runID, text string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"runId":%q,"type":"delta","kind":"text","text":%q}`, runID, text))
}

func toolFrame(runID string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"runId":%q,"type":"tool_call","call_id":"call-1","name":"inspect","arguments":"{\"path\":\"README.md\"}"}`, runID))
}

func done(runID, reason string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"runId":%q,"type":"done","reason":%q}`, runID, reason))
}

func admit(t *testing.T, store *Store, scope Scope, runID string, journal JournalRequest) AdmitResult {
	t.Helper()
	result, err := store.Admit(context.Background(), AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: requestFor(runID)})
	if err != nil || result.Status != "accepted" {
		t.Fatalf("admit: %#v err=%v", result, err)
	}
	return result
}

func TestJournalAdmissionCommitReplayAndRetirement(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "run-"+uuid.NewString(), testJournal()
	first := admit(t, store, scope, runID, journal)
	second, err := store.Admit(context.Background(), AdmitInput{Scope: scope, RunID: runID, Journal: journal,
		Request: json.RawMessage(fmt.Sprintf(`{"messages":[{"role":"user","content":"hello"}],"runId":%q,"instructions":""}`, runID))})
	if err != nil || second.Status != "existing" || !sameCursor(first.Cursor, second.Cursor) {
		t.Fatalf("idempotent admission: %#v err=%v", second, err)
	}
	changed := requestFor(runID)
	changed = bytes.Replace(changed, []byte("hello"), []byte("different"), 1)
	if _, err = store.Admit(context.Background(), AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: changed}); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed duplicate = %v", err)
	}
	wrong := journal
	wrong.Token = strings.Repeat("z", 64)
	if _, err = store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: wrong}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("wrong replay capability = %v", err)
	}
	grant, err := store.Claim(context.Background(), scope, first.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.MarkProviderStarted(context.Background(), grant); err != nil {
		t.Fatal(err)
	}
	commit := CommitInput{TurnID: first.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor,
		Frames: []json.RawMessage{frame(runID, "hello"), toolFrame(runID), done(runID, "tool_call")}}
	committed, err := store.Commit(context.Background(), commit)
	if err != nil || committed.Status != "committed" || committed.Cursor.Position != 3 {
		t.Fatalf("commit: %#v err=%v", committed, err)
	}
	retry, err := store.Commit(context.Background(), commit)
	if err != nil || retry.Status != "duplicate" || !sameCursor(retry.Cursor, committed.Cursor) {
		t.Fatalf("lost receipt retry: %#v err=%v", retry, err)
	}
	changedCommit := commit
	changedCommit.Frames = []json.RawMessage{frame(runID, "changed"), toolFrame(runID), done(runID, "tool_call")}
	if _, err = store.Commit(context.Background(), changedCommit); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed exact retry = %v", err)
	}
	page, err := store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal})
	if err != nil || len(page.Batches) != 1 || !page.Terminal || page.More || page.Batches[0].Hash != committed.Batch.Hash {
		t.Fatalf("replay: %#v err=%v", page, err)
	}
	if err = store.Verify(context.Background(), scope, runID, journal); err != nil {
		t.Fatalf("hash-chain verify: %v", err)
	}
	if _, err = store.pool.Exec(context.Background(), `UPDATE chat_turn_batches SET canonical_bytes=canonical_bytes+1 WHERE turn_id=$1 AND batch_number=1`, first.TurnID); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal, After: &committed.Cursor}); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("corrupt replay boundary = %v", err)
	}
	if _, err = store.pool.Exec(context.Background(), `UPDATE chat_turn_batches SET canonical_bytes=canonical_bytes-1 WHERE turn_id=$1 AND batch_number=1`, first.TurnID); err != nil {
		t.Fatal(err)
	}
	if err = store.Retire(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal}); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal}); !errors.Is(err, ErrRetired) {
		t.Fatalf("replay after retirement = %v", err)
	}
	if next, err := store.Admit(context.Background(), AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: requestFor(runID)}); !errors.Is(err, ErrRetired) || next.Status != "" {
		t.Fatalf("retired identity restarted: %#v err=%v", next, err)
	}
}

func TestLineSeparatorFrameRoundTripsThroughPostgreSQL(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "unicode-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	separatorFrame := json.RawMessage(fmt.Sprintf(
		`{"runId":%q,"type":"delta","kind":"text","text":"actual:\u2028/\u2029 literal:\\u2028/\\u2029"}`,
		runID,
	))
	committed, err := store.Commit(context.Background(), CommitInput{
		TurnID: accepted.TurnID, Generation: grant.Generation, Token: grant.Token,
		Expected: grant.Cursor, Frames: []json.RawMessage{separatorFrame},
	})
	if err != nil {
		t.Fatalf("commit line separators: %v", err)
	}
	page, err := store.Replay(context.Background(), ReplayInput{
		Scope: scope, RunID: runID, Journal: journal, After: &accepted.Cursor,
	})
	if err != nil || len(page.Batches) != 1 || page.Batches[0].Hash != committed.Batch.Hash {
		t.Fatalf("replay line separators: %#v err=%v", page, err)
	}
	_, canonical, err := parseCanonical(page.Batches[0].Frames[0])
	if err != nil || !strings.Contains(canonical, "actual:\u2028/\u2029 literal:\\\\u2028/\\\\u2029") {
		t.Fatalf("line separator payload changed: %q err=%v", canonical, err)
	}
	if err = store.Verify(context.Background(), scope, runID, journal); err != nil {
		t.Fatalf("line separator hash chain: %v", err)
	}
}

func TestReplayHeadDoesNotRaceAConcurrentAppend(t *testing.T) {
	shared := needStore(t)
	store := &Store{pool: shared.pool, now: time.Now}
	scope, runID, journal := testScope(), "interleave-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Commit(context.Background(), CommitInput{
		TurnID: accepted.TurnID, Generation: grant.Generation, Token: grant.Token,
		Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, "first")},
	})
	if err != nil {
		t.Fatal(err)
	}

	headRead, appended := make(chan struct{}), make(chan struct{})
	store.afterReplayHead = func() {
		close(headRead)
		<-appended
	}
	type replayAnswer struct {
		page ReplayResult
		err  error
	}
	replayed := make(chan replayAnswer, 1)
	go func() {
		page, replayErr := store.Replay(context.Background(), ReplayInput{
			Scope: scope, RunID: runID, Journal: journal, After: &accepted.Cursor,
		})
		replayed <- replayAnswer{page: page, err: replayErr}
	}()
	<-headRead
	// The replay holds no row lock, so the producer appends and seals the turn
	// while the replay sits between its head read and its batch reads.
	result, err := store.Commit(context.Background(), CommitInput{
		TurnID: accepted.TurnID, Generation: grant.Generation, Token: grant.Token,
		Expected: first.Cursor, Frames: []json.RawMessage{done(runID, "stop")},
	})
	close(appended)
	if err != nil || result.Cursor.Batch != 2 {
		t.Fatalf("concurrent append: %#v err=%v", result, err)
	}
	select {
	case answer := <-replayed:
		if answer.err != nil || answer.page.Head.Batch != 1 || answer.page.Next.Batch != 1 || answer.page.Terminal || answer.page.More || len(answer.page.Batches) != 1 {
			t.Fatalf("replay crossed its captured head: %#v err=%v", answer.page, answer.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("replay did not finish")
	}
}

func TestCancelAndExpiredProviderAreDurableTerminalBatches(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	runID, journal := "cancel-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := store.Cancel(context.Background(), scope, runID)
	if err != nil || cancelled.Count != 1 {
		t.Fatalf("cancel: %#v err=%v", cancelled, err)
	}
	page, err := store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal})
	if err != nil || !page.Terminal || len(page.Batches) != 1 || !frameHasStringField(page.Batches[0].Frames[0], "reason", "cancelled") {
		t.Fatalf("cancel replay: %#v err=%v", page, err)
	}
	if err = store.FailProducer(context.Background(), grant, "host_failed"); err != nil {
		t.Fatalf("cancel race should be idempotent: %v", err)
	}

	// Lease expiry follows the store clock, so a slow database cannot fence
	// the grant before the provider starts.
	clocked, clock := clockedStore(store)
	runID, journal = "uncertain-"+uuid.NewString(), testJournal()
	accepted = admit(t, clocked, scope, runID, journal)
	grant, err = clocked.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err = clocked.MarkProviderStarted(context.Background(), grant); err != nil {
		t.Fatal(err)
	}
	clock.advance(2 * time.Minute)
	if _, err = clocked.Claim(context.Background(), scope, accepted.TurnID, time.Minute); !errors.Is(err, ErrUncertain) {
		t.Fatalf("post-provider reclaim = %v", err)
	}
	page, err = store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal})
	if err != nil || !page.Terminal || len(page.Batches) != 1 || !bytes.Contains(page.Batches[0].Frames[0], []byte(`"error"`)) {
		t.Fatalf("uncertain replay: %#v err=%v", page, err)
	}
}

type deterministicHost struct {
	store   *Store
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

type shutdownHost struct{ entered chan struct{} }

func (h shutdownHost) RunTurn(ctx context.Context, _ ProducerGrant) error {
	close(h.entered)
	<-ctx.Done()
	return ctx.Err()
}

func TestDispatcherShutdownLeavesUnstartedTurnRecoverable(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "shutdown-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	host := shutdownHost{entered: make(chan struct{})}
	// The production lease: shutdown must hand the turn back at once rather
	// than strand it until the lease runs out.
	dispatcher, err := NewDispatcher(store, host, 1, DefaultLease)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- dispatcher.Run(ctx, 1) }()
	if !dispatcher.Enqueue(Candidate{Scope: scope, TurnID: accepted.TurnID}) {
		t.Fatal("enqueue refused")
	}
	select {
	case <-host.entered:
	case <-time.After(dbWait):
		t.Fatal("host did not receive admitted turn")
	}
	cancel()
	select {
	case err = <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(dbWait):
		t.Fatal("dispatcher did not stop")
	}
	state, terminal, err := store.GetState(context.Background(), scope, accepted.TurnID)
	if err != nil || state != StateRunning || terminal {
		t.Fatalf("shutdown invented a terminal fact: state=%s terminal=%v err=%v", state, terminal, err)
	}
	candidates, err := store.RecoveryCandidates(context.Background(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, candidate := range candidates {
		found = found || candidate.TurnID == accepted.TurnID
	}
	if !found {
		t.Fatal("shutdown left the lease held, so recovery cannot see the turn")
	}
	recovered, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil || recovered.Generation != 2 {
		t.Fatalf("unstarted turn was not recoverable: %#v err=%v", recovered, err)
	}
}

func (h *deterministicHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	h.once.Do(func() { close(h.entered) })
	if err := h.store.MarkProviderStarted(ctx, grant); err != nil {
		return err
	}
	select {
	case <-h.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	_, err := h.store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor,
		Frames: []json.RawMessage{frame(grant.RunID, "deterministic"), toolFrame(grant.RunID), done(grant.RunID, "tool_call")}})
	return err
}

func authenticatedRoutes(handler *Handler, userID int64, owner string) http.Handler {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: userID, Username: owner}})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	handler.MountPublic(router)
	// Historical-journal fixtures exercise the retained decoder/writer protocol;
	// these routes are deliberately absent from the product mount.
	router.Post(TurnPath, handler.Turn)
	router.Post(CancelPath, handler.Cancel)
	router.Post(RetirePath, handler.Retire)
	handler.MountProducerCallbacks(router)
	return router
}

func turnBody(runID string, journal JournalRequest) []byte {
	value := map[string]any{"runId": runID, "journal": journal, "messages": []any{map[string]any{"role": "user", "content": "hello"}}, "instructions": "answer", "tools": []any{map[string]any{"name": "inspect", "description": "inspect", "parameters": map[string]any{"type": "object"}}}}
	body, _ := json.Marshal(value)
	return body
}

func postJSON(t *testing.T, client *http.Client, url string, body []byte) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestRendererRoutesAcknowledgeBeforeHostAndReconnectExactly(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	host := &deterministicHost{store: store, entered: make(chan struct{}), release: make(chan struct{})}
	dispatcher, err := NewDispatcher(store, host, 8, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = dispatcher.Run(ctx, 1) }()
	server := httptest.NewServer(authenticatedRoutes(&Handler{Store: store, Dispatcher: dispatcher}, scope.UserID, scope.Owner))
	defer server.Close()
	runID, journal := "http-"+uuid.NewString(), testJournal()
	body := turnBody(runID, journal)
	started := time.Now()
	response := postJSON(t, server.Client(), server.URL+TurnPath, body)
	if response.StatusCode != http.StatusOK || response.Header.Get(journalHeader) != "1" || !strings.Contains(response.Header.Get("content-type"), "application/x-ndjson") {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("turn response: %d %s", response.StatusCode, raw)
	}
	if time.Since(started) > time.Second {
		t.Fatal("turn response waited for model completion")
	}
	scanner := bufio.NewScanner(response.Body)
	if !scanner.Scan() {
		t.Fatalf("accepted delivery missing: %v", scanner.Err())
	}
	var accepted Delivery
	if err = json.Unmarshal(scanner.Bytes(), &accepted); err != nil || accepted.Type != "accepted" || accepted.Cursor.Batch != 0 {
		t.Fatalf("accepted delivery: %s err=%v", scanner.Bytes(), err)
	}
	select {
	case <-host.entered:
	case <-time.After(dbWait):
		t.Fatal("model host was not launched")
	}
	select {
	case <-host.release:
		t.Fatal("test release unexpectedly closed")
	default:
	}
	close(host.release)
	var deliveries []Delivery
	for scanner.Scan() {
		var delivery Delivery
		if err = json.Unmarshal(scanner.Bytes(), &delivery); err != nil {
			t.Fatal(err)
		}
		deliveries = append(deliveries, delivery)
	}
	_ = response.Body.Close()
	if len(deliveries) != 2 || deliveries[0].Type != "batch" || deliveries[1].Type != "caught-up" || deliveries[1].Terminal == nil || !*deliveries[1].Terminal {
		t.Fatalf("journal deliveries: %#v", deliveries)
	}
	if got := deliveries[0].Batch.Frames[1]; !bytes.Contains(got, []byte(`"type":"tool_call"`)) {
		t.Fatalf("tool frame missing: %s", got)
	}

	duplicate := postJSON(t, server.Client(), server.URL+TurnPath, body)
	defer func() { _ = duplicate.Body.Close() }()
	var existing AdmitResult
	if duplicate.StatusCode != http.StatusOK || !strings.Contains(duplicate.Header.Get("content-type"), "application/json") || json.NewDecoder(duplicate.Body).Decode(&existing) != nil || existing.Status != "existing" {
		t.Fatalf("duplicate did not join: %d %#v", duplicate.StatusCode, existing)
	}
	replayBody, _ := json.Marshal(replayRequest{RunID: runID, Journal: journal, After: &accepted.Cursor})
	replayed := postJSON(t, server.Client(), server.URL+ReplayPath, replayBody)
	defer func() { _ = replayed.Body.Close() }()
	var page ReplayResult
	if replayed.StatusCode != http.StatusOK || json.NewDecoder(replayed.Body).Decode(&page) != nil || len(page.Batches) != 1 || !page.Terminal {
		t.Fatalf("replay after reload: %d %#v", replayed.StatusCode, page)
	}
	retireBody, _ := json.Marshal(map[string]any{"runId": runID, "journal": journal})
	retired := postJSON(t, server.Client(), server.URL+RetirePath, retireBody)
	defer func() { _ = retired.Body.Close() }()
	if retired.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(retired.Body)
		t.Fatalf("retire: %d %s", retired.StatusCode, raw)
	}
}

func frameHasStringField(frame json.RawMessage, field, expected string) bool {
	var value map[string]any
	return json.Unmarshal(frame, &value) == nil && value[field] == expected
}

func recoveryHas(t *testing.T, store *Store, turnID string) bool {
	t.Helper()
	candidates, err := store.RecoveryCandidates(context.Background(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range candidates {
		if candidate.TurnID == turnID {
			return true
		}
	}
	return false
}

// Recovery and Claim must read lease expiry from one clock. Otherwise a
// replica whose clock runs apart from PostgreSQL re-selects a turn Claim
// still calls busy, or never selects one Claim would take.
func TestRecoveryAndClaimShareOneClock(t *testing.T) {
	store, clock := clockedStore(needStore(t))
	scope, runID, journal := testScope(), "clock-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	if _, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute); err != nil {
		t.Fatal(err)
	}
	if recoveryHas(t, store, accepted.TurnID) {
		t.Fatal("recovery selected a turn under a live lease")
	}
	clock.advance(2 * time.Minute)
	if !recoveryHas(t, store, accepted.TurnID) {
		t.Fatal("recovery ignored a lease the store clock says has expired")
	}
	if recovered, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute); err != nil || recovered.Generation != 2 {
		t.Fatalf("reclaim after expiry: %#v err=%v", recovered, err)
	}
}
