package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/apiclient"
)

func TestAccountHistoryHTTPRestoresCommittedTurnsWithoutDeviceToken(t *testing.T) {
	store := needStore(t)
	owner, other := testScope(), testScope()
	host := &deterministicHost{store: store, entered: make(chan struct{}), release: make(chan struct{})}
	close(host.release)
	dispatcher, err := NewDispatcher(store, host, 8, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() { done <- dispatcher.Run(ctx, 1) }()
	defer func() {
		stop()
		select {
		case <-done:
		case <-time.After(dbWait):
			t.Error("dispatcher did not stop")
		}
	}()
	handler := &Handler{Store: store, Dispatcher: dispatcher}
	// Only authentication and the model are fixtures: the public HTTP
	// admission, real PostgreSQL journal, dispatcher and committed replay run.
	clientA := httptest.NewServer(authenticatedRoutes(handler, owner.UserID, owner.Owner))
	defer clientA.Close()
	clientB := httptest.NewServer(authenticatedRoutes(handler, owner.UserID, owner.Owner))
	defer clientB.Close()
	outsider := httptest.NewServer(authenticatedRoutes(handler, other.UserID, other.Owner))
	defer outsider.Close()
	journal := testJournal()
	runID := "account-" + journal.LegID
	body := map[string]any{"runId": runID, "conversationId": "branch-saved", "journal": journal,
		"instructions": "private instructions", "context": map[string]any{"private": "context-secret"},
		"messages": []any{map[string]any{"type": "function_call_output", "call_id": "old", "output": "private-tool-secret"},
			map[string]any{"role": "user", "content": "hello from A"}}}
	raw, _ := json.Marshal(body)
	response := postJSON(t, clientA.Client(), clientA.URL+TurnPath, raw)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("admission=%d", response.StatusCode)
	}
	_, err = io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	listed, err := clientB.Client().Get(clientB.URL + HistoryPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listed.Body.Close()
	listedBytes, _ := io.ReadAll(listed.Body)
	if listed.StatusCode != http.StatusOK {
		t.Fatalf("list=%d %s", listed.StatusCode, listedBytes)
	}
	var history HistoryPage
	if err = json.Unmarshal(listedBytes, &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Conversations) != 1 || history.Conversations[0].ID != "branch-saved" || len(history.Conversations[0].Turns) != 1 || history.Conversations[0].Turns[0].RunID != runID {
		t.Fatalf("account list=%#v", history)
	}
	for _, private := range []string{journal.Token, "private instructions", "context-secret", "private-tool-secret", "hello from A", "accessHash", "ownerHash", "writerHash"} {
		if strings.Contains(string(listedBytes), private) {
			t.Fatalf("private field in list: %q", private)
		}
	}
	generated := &apiclient.Client{BaseURL: clientB.URL, HTTPClient: clientB.Client()}
	generatedList, err := generated.GetAPIAgentConversations(context.Background(), apiclient.GetAPIAgentConversationsParams{})
	if err != nil || len(generatedList.Conversations) != 1 || generatedList.Conversations[0].ID != "branch-saved" {
		t.Fatalf("generated index=%#v err=%v", generatedList, err)
	}
	generatedReplay, err := generated.PostAPIAgentConversationsReplay(context.Background(), apiclient.SavedConversationReplayRequest{RunID: runID, LegID: journal.LegID})
	if err != nil || generatedReplay.UserText != "hello from A" || len(generatedReplay.Page.Batches) != 1 {
		t.Fatalf("generated replay=%#v err=%v", generatedReplay, err)
	}
	var decodedText string
	if err = json.Unmarshal(generatedReplay.Page.Batches[0].Frames[0].AdditionalProperties["text"], &decodedText); err != nil || decodedText != "deterministic" {
		t.Fatalf("generated frame payload=%q err=%v", decodedText, err)
	}
	accountRead, _ := json.Marshal(map[string]any{"runId": runID, "legId": journal.LegID})
	replay := postJSON(t, clientB.Client(), clientB.URL+AccountReplayPath, accountRead)
	replayBytes, _ := io.ReadAll(replay.Body)
	replay.Body.Close()
	if replay.StatusCode != http.StatusOK {
		t.Fatalf("account replay=%d %s", replay.StatusCode, replayBytes)
	}
	var restored AccountReplayResult
	if err = json.Unmarshal(replayBytes, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.ConversationID != "branch-saved" || restored.UserText != "hello from A" || !restored.Page.Terminal || len(restored.Page.Batches) != 1 {
		t.Fatalf("restored=%#v", restored)
	}
	for _, private := range []string{journal.Token, "private instructions", "context-secret", "private-tool-secret", "accessHash", "writerHash"} {
		if strings.Contains(string(replayBytes), private) {
			t.Fatalf("private request field in replay: %q", private)
		}
	}
	// The model is deterministic, but client B is the real app controller and
	// HTTP adapter over an empty browser journal, against this live PG server.
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	browserCtx, cancelBrowser := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelBrowser()
	browser := exec.CommandContext(browserCtx, "bun", "test", "apps/app/src/mainview/state/ConversationHistory.test.ts", "--test-name-pattern", "real PostgreSQL server client B")
	browser.Dir = root
	browser.Env = append(os.Environ(), "SMITHERS_ACCOUNT_HISTORY_ORIGIN="+clientB.URL, "SMITHERS_ACCOUNT_HISTORY_OWNER="+owner.Owner)
	browserOutput, browserErr := browser.CombinedOutput()
	t.Logf("client B app boundary:\n%s", browserOutput)
	if browserErr != nil {
		t.Fatalf("empty browser restore: %v", browserErr)
	}
	denied := postJSON(t, outsider.Client(), outsider.URL+AccountReplayPath, accountRead)
	denied.Body.Close()
	if denied.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-account read=%d", denied.StatusCode)
	}
	otherList, err := outsider.Client().Get(outsider.URL + HistoryPath)
	if err != nil {
		t.Fatal(err)
	}
	var empty HistoryPage
	err = json.NewDecoder(otherList.Body).Decode(&empty)
	otherList.Body.Close()
	if err != nil || len(empty.Conversations) != 0 {
		t.Fatalf("cross-account list=%#v err=%v", empty, err)
	}
	retireBody, _ := json.Marshal(map[string]any{"runId": runID, "journal": journal})
	retired := postJSON(t, clientA.Client(), clientA.URL+RetirePath, retireBody)
	retired.Body.Close()
	if retired.StatusCode != http.StatusOK {
		t.Fatalf("retire=%d", retired.StatusCode)
	}
	retiredRead := postJSON(t, clientB.Client(), clientB.URL+AccountReplayPath, accountRead)
	retiredRead.Body.Close()
	if retiredRead.StatusCode != http.StatusGone {
		t.Fatalf("retired account read=%d", retiredRead.StatusCode)
	}
	page, err := store.History(context.Background(), owner, "", 50)
	if err != nil || len(page.Conversations) != 0 {
		t.Fatalf("retired index=%#v err=%v", page, err)
	}
}

func TestAccountHistoryPagesPublicRunLinksAndLegacyIdentity(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	ctx := context.Background()
	firstJournal, secondJournal := testJournal(), testJournal()
	first := admit(t, store, scope, "legacy-run", firstJournal)
	grant, err := store.Claim(ctx, scope, first.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	publicCard := json.RawMessage(`{"runId":"legacy-run","type":"card","card":{"id":"flow-run-actual","kind":"run-trace","title":"Run","payload":{"repo":"alice/demo","runId":"actual","result":"public card body"}}}`)
	_, err = store.Commit(ctx, CommitInput{TurnID: first.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{publicCard, done("legacy-run", "stop")}})
	if err != nil {
		t.Fatal(err)
	}
	admit(t, store, scope, "later-run", secondJournal)
	page, err := store.History(ctx, scope, "", 1)
	if err != nil || page.Next == nil || len(page.Conversations) != 1 || page.Conversations[0].ID != "legacy-run" {
		t.Fatalf("first page=%#v err=%v", page, err)
	}
	links := page.Conversations[0].Turns[0].RunLinks
	if len(links) != 1 || links[0].RunID != "actual" || links[0].Repo != "alice/demo" {
		t.Fatalf("public links=%#v", links)
	}
	encoded, _ := json.Marshal(page)
	if strings.Contains(string(encoded), "public card body") {
		t.Fatal("run payload crossed metadata boundary")
	}
	if err = store.Retire(ctx, ReplayInput{Scope: scope, RunID: "legacy-run", Journal: firstJournal}); err != nil {
		t.Fatal(err)
	}
	next, err := store.History(ctx, scope, *page.Next, 1)
	if err != nil || next.Next != nil || len(next.Conversations) != 1 || next.Conversations[0].ID != "later-run" {
		t.Fatalf("page after retirement=%#v err=%v", next, err)
	}
	proof, err := digest("access", secondJournal.Token)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Erase(ctx, "later-run", secondJournal.LegID, proof); err != nil {
		t.Fatal(err)
	}
	_, err = store.ReplayAccount(ctx, AccountReplayInput{Scope: scope, RunID: "later-run", LegID: secondJournal.LegID})
	if !errors.Is(err, ErrRetired) {
		t.Fatalf("erased account read=%v", err)
	}
	for _, limit := range []int{0, -1, 51} {
		if _, err = store.History(ctx, scope, "", limit); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("limit%d=%v", limit, err)
		}
	}
	for _, cursor := range []string{"not-base64", strings.Repeat("a", 513), "e30"} {
		if _, err = store.History(ctx, scope, cursor, 1); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid cursor=%v", err)
		}
	}
	if _, err = store.History(ctx, Scope{}, "", 1); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid account=%v", err)
	}
}

func TestAccountHistoryVerifiedPaginationAndPublicHTTPRefusals(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	scope := testScope()
	journal := testJournal()
	accepted := admit(t, store, scope, "paged", journal)
	grant, err := store.Claim(ctx, scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 9; index++ {
		frame := json.RawMessage(fmt.Sprintf(`{"type":"delta","runId":"paged","kind":"text","text":"%d"}`, index))
		frames := []json.RawMessage{frame}
		if index == 8 {
			frames = append(frames, done("paged", "stop"))
		}
		committed, err := store.Commit(ctx, CommitInput{TurnID: accepted.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: frames})
		if err != nil {
			t.Fatal(err)
		}
		grant.Cursor = committed.Cursor
	}
	first, err := store.ReplayAccount(ctx, AccountReplayInput{Scope: scope, RunID: "paged", LegID: journal.LegID})
	if err != nil || !first.Page.More || len(first.Page.Batches) != 8 {
		t.Fatalf("first page=%#v err=%v", first, err)
	}
	second, err := store.ReplayAccount(ctx, AccountReplayInput{Scope: scope, RunID: "paged", LegID: journal.LegID, After: &first.Page.Next})
	if err != nil || second.Page.More || len(second.Page.Batches) != 1 || !sameCursor(second.Page.Next, grant.Cursor) {
		t.Fatalf("second page=%#v err=%v", second, err)
	}
	wrongScope := scope
	wrongScope.Owner = "not-owner"
	if _, err = store.ReplayAccount(ctx, AccountReplayInput{Scope: wrongScope, RunID: "paged", LegID: journal.LegID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("owner mismatch=%v", err)
	}
	if _, err = store.History(ctx, wrongScope, "", 50); !errors.Is(err, ErrForbidden) {
		t.Fatalf("owner list mismatch=%v", err)
	}
	for _, input := range []AccountReplayInput{{Scope: scope}, {Scope: Scope{}, RunID: "paged", LegID: journal.LegID}, {Scope: scope, RunID: "paged", LegID: "absent"}, {Scope: scope, RunID: "paged", LegID: journal.LegID, After: &Cursor{}}} {
		if _, err = store.ReplayAccount(ctx, input); err == nil {
			t.Fatal("invalid account replay accepted")
		}
	}
	handler := &Handler{Store: store}
	server := httptest.NewServer(authenticatedRoutes(handler, scope.UserID, scope.Owner))
	defer server.Close()
	for _, suffix := range []string{"?limit=0", "?limit=51", "?limit=NaN", "?after=invalid"} {
		response, err := server.Client().Get(server.URL + HistoryPath + suffix)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("invalid list %s=%d", suffix, response.StatusCode)
		}
	}
	for _, body := range []string{`{}`, `{"runId":"paged","legId":"missing"}`, `{"runId":"paged","legId":"x","journal":{"token":"not accepted"}}`, `{"runId":"paged","legId":"x"} {}`, `{`} {
		response := postJSON(t, server.Client(), server.URL+AccountReplayPath, []byte(body))
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusNotFound {
			t.Fatalf("invalid replay=%d", response.StatusCode)
		}
	}
	// Tampered committed bytes refuse both the listing and replay. The index
	// cannot lend legitimacy to a run link from a corrupt journal.
	_, err = store.pool.Exec(ctx, `UPDATE chat_turn_batches SET frames='[{"type":"delta","runId":"paged","kind":"text","text":"tampered"}]' WHERE turn_id=$1 AND batch_number=1`, accepted.TurnID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.History(ctx, scope, "", 50); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("corrupt list=%v", err)
	}
	if _, err = store.ReplayAccount(ctx, AccountReplayInput{Scope: scope, RunID: "paged", LegID: journal.LegID}); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("corrupt replay=%v", err)
	}
}

func TestAccountHistoryRequiresAuthenticationAtActualHTTPBoundary(t *testing.T) {
	store := needStore(t)
	server := httptest.NewServer(authenticatedRoutes(&Handler{Store: store}, 0, ""))
	defer server.Close()
	listed, err := server.Client().Get(server.URL + HistoryPath)
	if err != nil {
		t.Fatal(err)
	}
	listed.Body.Close()
	replayed := postJSON(t, server.Client(), server.URL+AccountReplayPath, []byte(`{"runId":"run","legId":"leg"}`))
	replayed.Body.Close()
	if listed.StatusCode != http.StatusForbidden || replayed.StatusCode != http.StatusForbidden {
		t.Fatalf("signed out list/replay=%d/%d", listed.StatusCode, replayed.StatusCode)
	}
}

func TestAccountHistoryExcludesPrivateModelPurposeAndPinsMetadata(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	scope := testScope()
	journal := testJournal()
	request := json.RawMessage(`{"runId":"private-model","purpose":"explain","conversationId":"branch-private","messages":[{"role":"user","content":"private explanation input"}]}`)
	admitted, err := store.Admit(ctx, AdmitInput{Scope: scope, RunID: "private-model", Journal: journal, Request: request})
	if err != nil {
		t.Fatal(err)
	}
	page, err := store.History(ctx, scope, "", 50)
	if err != nil || len(page.Conversations) != 0 {
		t.Fatalf("private model listed: %#v %v", page, err)
	}
	if _, err = store.ReplayAccount(ctx, AccountReplayInput{Scope: scope, RunID: "private-model", LegID: journal.LegID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("private model account replay=%v", err)
	}
	// The original proof-gated replay remains available to its existing owner.
	if _, err = store.Replay(ctx, ReplayInput{Scope: scope, RunID: "private-model", Journal: journal}); err != nil {
		t.Fatal(err)
	}
	_ = admitted
	for _, id := range []any{nil, "", strings.Repeat("x", 161), 17} {
		value := map[string]any{"conversationId": id}
		raw, _ := json.Marshal(value)
		if _, err = store.Admit(ctx, AdmitInput{Scope: scope, RunID: "invalid", Journal: testJournal(), Request: raw}); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid branch admitted: %v", err)
		}
	}
}

func TestAccountHistoryRunReferenceBoundIsExplicitAndVerified(t *testing.T) {
	for _, count := range []int{64, 65} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			store := needStore(t)
			ctx := context.Background()
			scope := testScope()
			journal := testJournal()
			admitted := admit(t, store, scope, "refs", journal)
			grant, err := store.Claim(ctx, scope, admitted.TurnID, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			frames := make([]json.RawMessage, 0, count+4)
			for index := count - 1; index >= 0; index-- {
				frames = append(frames, json.RawMessage(fmt.Sprintf(`{"runId":"refs","type":"card","card":{"id":"card%d","kind":"run-trace","payload":{"repo":"alice/demo","runId":"run-%03d","workspaceId":"box"}}}`, index, index)))
			}
			frames = append(frames, frames[0], json.RawMessage(`{"runId":"refs","type":"card","card":{"kind":"run-trace","payload":{"repo":"invalid","runId":"hidden"}}}`), json.RawMessage(`{"runId":"refs","type":"card","card":{"kind":"file","payload":{"repo":"alice/demo","runId":"not-a-run"}}}`), done("refs", "stop"))
			_, err = store.Commit(ctx, CommitInput{TurnID: admitted.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: frames})
			if err != nil {
				t.Fatal(err)
			}
			page, err := store.History(ctx, scope, "", 50)
			if count == 65 {
				if !errors.Is(err, ErrLimit) {
					t.Fatalf("oversized references=%v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			refs := page.Conversations[0].Turns[0].RunLinks
			if len(refs) != 64 || refs[0].RunID != "run-000" || refs[63].RunID != "run-063" || refs[0].WorkspaceID != "box" {
				t.Fatalf("bounded references=%#v", refs)
			}
		})
	}
}
