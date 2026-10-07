package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type fixtureHost struct {
	origin string
	stop   func()
}

func startFixtureHost(t *testing.T, callbackURL string, modelOrigin ...string) fixtureHost {
	t.Helper()
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("bun is required for the cross-runtime chat integration")
	}
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	fixture := filepath.Join(root, "packages/smithers/agent/model-host/test/fixtures/deterministic-host.ts")
	ctx, cancel := context.WithCancel(context.Background())
	command := exec.CommandContext(ctx, bun, fixture)
	command.Dir = root
	command.Env = append(os.Environ(),
		"SMITHERS_CHAT_HOST_TOKEN=deterministic-host-token",
		"SMITHERS_CHAT_CALLBACK_URL="+callbackURL,
		"SMITHERS_CHAT_HOST_PORT=0",
	)
	if len(modelOrigin) > 0 {
		command.Env = append(command.Env, "SMITHERS_FIXTURE_MODEL_ORIGIN="+modelOrigin[0])
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err = command.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			ready <- scanner.Text()
			return
		}
		ready <- ""
	}()
	var line string
	select {
	case line = <-ready:
	case <-time.After(10 * time.Second):
		cancel()
		_ = command.Wait()
		t.Fatal("deterministic TypeScript host did not become ready")
	}
	var identity struct {
		Origin   string `json:"origin"`
		Protocol string `json:"protocol"`
	}
	if json.Unmarshal([]byte(line), &identity) != nil || identity.Origin == "" || identity.Protocol != "smithers.chat-model-host/v1" {
		cancel()
		_ = command.Wait()
		t.Fatalf("invalid deterministic host readiness: %q (%s)", line, strings.TrimSpace(stderr.String()))
	}
	return fixtureHost{origin: identity.Origin, stop: func() {
		cancel()
		done := make(chan struct{})
		go func() { _ = command.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = command.Process.Kill()
			<-done
		}
	}}
}

func bodyWithContent(runID, content string, journal JournalRequest) []byte {
	value := map[string]any{
		"runId": runID, "journal": journal, "instructions": "answer",
		"messages": []any{map[string]any{"role": "user", "content": content}},
		"tools":    []any{map[string]any{"name": "inspect", "description": "inspect", "parameters": map[string]any{"type": "object"}}},
	}
	body, _ := json.Marshal(value)
	return body
}

func TestGoAdmissionThroughTypeScriptHostPersistsRendererJournal(t *testing.T) {
	store := needStore(t)
	scope := testScope()
	handler := &Handler{Store: store}
	server := httptest.NewServer(authenticatedRoutes(handler, scope.UserID, scope.Owner))
	defer server.Close()
	fixture := startFixtureHost(t, server.URL)
	defer fixture.stop()
	httpHost, err := NewHTTPChatHost(fixture.origin, nil, "deterministic-host-token")
	if err != nil {
		t.Fatal(err)
	}
	dispatcher, err := NewDispatcher(store, PortHost{Host: httpHost, ProducerBaseURL: server.URL}, 8, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	dispatchContext, stopDispatcher := context.WithCancel(context.Background())
	defer stopDispatcher()
	go func() { _ = dispatcher.Run(dispatchContext, 1) }()
	handler.Dispatcher = dispatcher

	runID, journal := "typescript-"+time.Now().Format("150405.000000000"), testJournal()
	startedAt := time.Now()
	response := postJSON(t, server.Client(), server.URL+TurnPath, bodyWithContent(runID, "__held__", journal))
	if response.StatusCode != http.StatusOK || response.Header.Get(journalHeader) != "1" {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("turn admission: %d %s", response.StatusCode, raw)
	}
	if time.Since(startedAt) > time.Second {
		t.Fatal("turn admission waited for the held TypeScript model")
	}
	scanner := bufio.NewScanner(response.Body)
	if !scanner.Scan() {
		t.Fatalf("missing accepted delivery: %v", scanner.Err())
	}
	var accepted Delivery
	if err = json.Unmarshal(scanner.Bytes(), &accepted); err != nil || accepted.Type != "accepted" {
		t.Fatalf("accepted delivery: %s err=%v", scanner.Bytes(), err)
	}
	var terminal bool
	if err = store.pool.QueryRow(context.Background(), `SELECT terminal FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3`, scope.UserID, runID, journal.LegID).Scan(&terminal); err != nil || terminal {
		t.Fatalf("turn became terminal before fixture release: terminal=%v err=%v", terminal, err)
	}
	released := postJSON(t, server.Client(), fixture.origin+"/fixture/release", []byte(`{}`))
	_ = released.Body.Close()
	if released.StatusCode != http.StatusNoContent {
		t.Fatalf("fixture release: %d", released.StatusCode)
	}
	var deliveries []Delivery
	for scanner.Scan() {
		var delivery Delivery
		if err = json.Unmarshal(scanner.Bytes(), &delivery); err != nil {
			t.Fatal(err)
		}
		deliveries = append(deliveries, delivery)
	}
	_ = response.Body.Close()
	if err = scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(deliveries) < 3 || deliveries[len(deliveries)-1].Type != "caught-up" || deliveries[len(deliveries)-1].Terminal == nil || !*deliveries[len(deliveries)-1].Terminal {
		wire, _ := json.Marshal(deliveries)
		t.Fatalf("terminal journal delivery missing: %s", wire)
	}
	wire, _ := json.Marshal(deliveries)
	if bytes.Contains(wire, []byte("fixture-secret-do-not-persist")) {
		t.Fatal("provider credential reached the durable journal")
	}
	foundTool := false
	for _, delivery := range deliveries {
		if delivery.Batch == nil {
			continue
		}
		for _, frame := range delivery.Batch.Frames {
			foundTool = foundTool || frameHasStringField(frame, "type", "tool_call")
		}
	}
	if !foundTool {
		t.Fatal("deterministic TypeScript tool invocation was not committed")
	}

	duplicate := postJSON(t, server.Client(), server.URL+TurnPath, bodyWithContent(runID, "__held__", journal))
	defer func() { _ = duplicate.Body.Close() }()
	var existing AdmitResult
	if duplicate.StatusCode != http.StatusOK || json.NewDecoder(duplicate.Body).Decode(&existing) != nil || existing.Status != "existing" {
		t.Fatalf("duplicate turn did not join: %d %#v", duplicate.StatusCode, existing)
	}
	replayRequestBody, _ := json.Marshal(replayRequest{RunID: runID, Journal: journal, After: &accepted.Cursor})
	replay := postJSON(t, server.Client(), server.URL+ReplayPath, replayRequestBody)
	defer func() { _ = replay.Body.Close() }()
	var page ReplayResult
	if replay.StatusCode != http.StatusOK || json.NewDecoder(replay.Body).Decode(&page) != nil || !page.Terminal || len(page.Batches) == 0 {
		t.Fatalf("reload replay: %d %#v", replay.StatusCode, page)
	}

	cancelRun, cancelJournal := "cancel-"+time.Now().Format("150405.000000000"), testJournal()
	cancelStream := postJSON(t, server.Client(), server.URL+TurnPath, bodyWithContent(cancelRun, "__block__", cancelJournal))
	cancelScanner := bufio.NewScanner(cancelStream.Body)
	if !cancelScanner.Scan() {
		t.Fatal("blocked turn was not accepted")
	}
	var cancelAccepted Delivery
	if err = json.Unmarshal(cancelScanner.Bytes(), &cancelAccepted); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	providerStarted := false
	for time.Now().Before(deadline) {
		if err = store.pool.QueryRow(context.Background(), `SELECT producer_started_at IS NOT NULL FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3`, scope.UserID, cancelRun, cancelJournal.LegID).Scan(&providerStarted); err == nil && providerStarted {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !providerStarted {
		t.Fatal("TypeScript provider never reached the durable started boundary")
	}
	_ = cancelStream.Body.Close()
	cancelBody, _ := json.Marshal(cancelRequest{RunID: cancelRun})
	cancelResponse := postJSON(t, server.Client(), server.URL+CancelPath, cancelBody)
	var cancelReceipt map[string]string
	if cancelResponse.StatusCode != http.StatusOK || json.NewDecoder(cancelResponse.Body).Decode(&cancelReceipt) != nil || cancelReceipt["status"] != "cancelled" {
		t.Fatalf("cancel receipt: %d %#v", cancelResponse.StatusCode, cancelReceipt)
	}
	_ = cancelResponse.Body.Close()
	settledCancel := postJSON(t, server.Client(), server.URL+CancelPath, cancelBody)
	var settledReceipt map[string]string
	if settledCancel.StatusCode != http.StatusOK || json.NewDecoder(settledCancel.Body).Decode(&settledReceipt) != nil || settledReceipt["status"] != "not-found" {
		t.Fatalf("settled cancel receipt: %d %#v", settledCancel.StatusCode, settledReceipt)
	}
	_ = settledCancel.Body.Close()
	cancelReplayBody, _ := json.Marshal(replayRequest{RunID: cancelRun, Journal: cancelJournal, After: &cancelAccepted.Cursor})
	cancelReplay := postJSON(t, server.Client(), server.URL+ReplayPath, cancelReplayBody)
	defer func() { _ = cancelReplay.Body.Close() }()
	var cancelled ReplayResult
	if cancelReplay.StatusCode != http.StatusOK || json.NewDecoder(cancelReplay.Body).Decode(&cancelled) != nil || !cancelled.Terminal || len(cancelled.Batches) != 1 || !frameHasStringField(cancelled.Batches[0].Frames[0], "reason", "cancelled") {
		t.Fatalf("cancel replay after disconnect: %d %#v", cancelReplay.StatusCode, cancelled)
	}
	if err = store.Verify(context.Background(), scope, cancelRun, cancelJournal); err != nil {
		t.Fatalf("cancelled hash chain: %v", err)
	}

}
