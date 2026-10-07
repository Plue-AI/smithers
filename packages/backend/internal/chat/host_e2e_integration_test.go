package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
	"net/http"
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

func TestGoAdmissionThroughTypeScriptHostPersistsRendererJournal(t *testing.T) {
	f := newContextFixture(t)
	store, handler, server := f.handler.Store, f.handler, f.server
	fixture := startFixtureHost(t, server.URL)
	defer fixture.stop()
	httpHost, err := NewHTTPChatHost(fixture.origin, nil, "deterministic-host-token")
	if err != nil {
		t.Fatal(err)
	}
	dispatcher, err := NewDispatcher(store, PortHost{Host: httpHost, ProducerBaseURL: server.URL, credentials: handler.credentials, API: fixtureTurnAPI{begin: func(context.Context, middleware.Credential, int64, string, int64) (ports.ChatTurnAPI, error) {
		return ports.ChatTurnAPI{Author: "context-ben", Token: "smithers_" + strings.Repeat("a", 40), TokenID: 1}, nil
	}, end: func(context.Context, int64, int64) error { return nil }}}, 8, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	dispatchContext, stopDispatcher := context.WithCancel(context.Background())
	defer stopDispatcher()
	go func() { _ = dispatcher.Run(dispatchContext, 1) }()
	handler.Dispatcher = dispatcher

	started := time.Now()
	receipt := submitPrompt(t, server, "main", "typescript-held", "__held__")
	if time.Since(started) > time.Second {
		t.Fatal("admission waited for held model")
	}
	released := postJSON(t, server.Client(), fixture.origin+"/fixture/release", []byte(`{}`))
	released.Body.Close()
	if released.StatusCode != http.StatusNoContent {
		t.Fatalf("release=%d", released.StatusCode)
	}
	replay := awaitPrompt(t, server, receipt)
	wire, _ := json.Marshal(replay)
	if bytes.Contains(wire, []byte("fixture-secret-do-not-persist")) {
		t.Fatal("credential leaked")
	}
	if len(replay.Frames) == 0 {
		t.Fatal("missing durable output")
	}
	duplicate := submitPrompt(t, server, "main", "typescript-held", "__held__")
	if duplicate.Status != "existing" || duplicate.TurnID != receipt.TurnID {
		t.Fatal("duplicate did not join")
	}
	cancelled := submitPrompt(t, server, "main", "typescript-blocked", "__block__")
	deadline := time.Now().Add(dbWait)
	for {
		var started bool
		if err := store.pool.QueryRow(context.Background(), `SELECT producer_started_at IS NOT NULL FROM chat_turns WHERE id=$1`, cancelled.TurnID).Scan(&started); err != nil {
			t.Fatal(err)
		}
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("provider never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for range 2 {
		response := postJSON(t, server.Client(), server.URL+"/api/conversations/main/turns/"+cancelled.TurnID+"/stop", []byte(`{}`))
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("stop=%d", response.StatusCode)
		}
	}
	terminal := awaitPrompt(t, server, cancelled)
	raw, _ := json.Marshal(terminal)
	if !bytes.Contains(raw, []byte(`"reason":"cancelled"`)) {
		t.Fatalf("cancel replay=%s", raw)
	}
}
