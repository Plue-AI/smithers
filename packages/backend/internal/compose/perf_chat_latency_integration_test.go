package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	dto "github.com/prometheus/client_model/go"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

// The external model host is controlled so duplicate/fenced callback delivery
// can be exercised deterministically. Auth, admission, dispatch, producer
// grants, journal commits, and the owner metrics route are production code.
type perfLatencyHost struct{ grants chan ports.ChatTurnGrant }

func (h perfLatencyHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	select {
	case h.grants <- grant:
	case <-ctx.Done():
		return ctx.Err()
	}
	<-ctx.Done()
	return ctx.Err()
}

func TestPerfChatLatencyComposedInstall(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	_, err := f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	callbackRouter := chi.NewRouter()
	callback := httptest.NewServer(callbackRouter)
	defer callback.Close()
	host := perfLatencyHost{grants: make(chan ports.ChatTurnGrant, 1)}
	runtime, err := chat.NewRuntime(f.pool, host, callback.URL, chat.RuntimeOptions{API: services.InstallAPI{Auth: func() *services.AuthService {
		auth := services.NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
		auth.Members = &services.Members{Pool: f.pool}
		return auth
	}()}})
	require.NoError(t, err)
	runtime.MountProducerCallbacks(callbackRouter)
	runtime.Handler.ResolveBranch = func(_ context.Context, _ chat.Scope, branch string) (string, error) { return branch, nil }
	ctx, cancel := context.WithCancel(t.Context())
	dispatchDone := make(chan error, 1)
	go func() { dispatchDone <- runtime.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-dispatchDone:
		case <-time.After(5 * time.Second):
			t.Error("chat dispatcher did not stop")
		}
	})
	metrics := routes.NewSmithersMetrics()
	metrics.MustRegister(runtime.Collectors()...)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	fn := reflect.ValueOf(buildRouter)
	args := make([]reflect.Value, fn.Type().NumIn())
	for i := range args {
		args[i] = reflect.Zero(fn.Type().In(i))
		for _, value := range []any{cfg, q, f.pool, metrics} {
			v := reflect.ValueOf(value)
			if v.Type() == fn.Type().In(i) {
				args[i] = v
			}
		}
	}
	args[len(args)-1] = reflect.ValueOf([]any{})
	router := fn.CallSlice(args)[0].Interface().(chi.Router)
	mountChatPublic(router, runtime, q, cfg)
	server.Config.Handler = router
	server.Start()
	defer server.Close()
	client := &http.Client{Timeout: 15 * time.Second}
	request := func(method, path string, body []byte) *http.Response {
		req, err := http.NewRequestWithContext(t.Context(), method, origin+path, bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("Cookie", "session="+f.cookie+"; __csrf=perf-latency-csrf")
		req.Header.Set("X-CSRF-Token", "perf-latency-csrf")
		response, err := client.Do(req)
		require.NoError(t, err)
		return response
	}
	before := request("GET", "/api/install/metrics", nil)
	beforeRaw, err := io.ReadAll(before.Body)
	before.Body.Close()
	require.NoError(t, err)
	require.Equal(t, 200, before.StatusCode, string(beforeRaw))
	require.NotContains(t, string(beforeRaw), `"name":"smithers_chat_durable_latency_seconds"`, "no turn means no latency samples")
	response := request("POST", "/api/conversations/main/prompt", []byte(`{"prompt":"Explain retry","idempotencyKey":"perf-latency"}`))
	defer response.Body.Close()
	require.Equal(t, 202, response.StatusCode)
	var grant ports.ChatTurnGrant
	select {
	case grant = <-host.grants:
	case <-time.After(5 * time.Second):
		t.Fatal("production dispatcher did not launch")
	}
	frames := []json.RawMessage{
		json.RawMessage(`{"runId":"` + grant.RunID + `","type":"delta","kind":"text","text":"Retries three times"}`),
		json.RawMessage(`{"runId":"` + grant.RunID + `","type":"card","card":{"kind":"file","payload":{"path":"src/retry.ts"}}}`),
		json.RawMessage(`{"runId":"` + grant.RunID + `","type":"done","reason":"stop"}`),
	}
	body, err := json.Marshal(map[string]any{"turnId": grant.TurnID, "generation": grant.Generation, "expected": grant.Cursor, "frames": frames})
	require.NoError(t, err)
	for _, token := range []string{"fenced-token", grant.Token, grant.Token} {
		req, err := http.NewRequestWithContext(t.Context(), "POST", callback.URL+chat.CommitPath, bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		committed, err := client.Do(req)
		require.NoError(t, err)
		raw, err := io.ReadAll(committed.Body)
		committed.Body.Close()
		require.NoError(t, err)
		if token == grant.Token {
			require.Equal(t, 200, committed.StatusCode, string(raw))
		} else {
			require.Equal(t, 401, committed.StatusCode, string(raw))
		}
	}
	transcript := request("GET", "/api/conversations/main", nil)
	stream, err := io.ReadAll(transcript.Body)
	transcript.Body.Close()
	require.NoError(t, err)
	require.Contains(t, string(stream), "Retries three times")
	cancelled := request("POST", "/api/conversations/main/prompt", []byte(`{"prompt":"Explain retry","idempotencyKey":"perf-cancel"}`))
	defer cancelled.Body.Close()
	require.Equal(t, 202, cancelled.StatusCode)
	var cancelGrant ports.ChatTurnGrant
	select {
	case cancelGrant = <-host.grants:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled turn was not dispatched")
	}
	stop := request("POST", "/api/conversations/main/turns/"+cancelGrant.TurnID+"/stop", []byte(`{}`))
	stopRaw, err := io.ReadAll(stop.Body)
	stop.Body.Close()
	require.NoError(t, err)
	require.Equal(t, 200, stop.StatusCode, string(stopRaw))
	snapshot := request("GET", "/api/install/metrics", nil)
	defer snapshot.Body.Close()
	raw, err := io.ReadAll(snapshot.Body)
	require.NoError(t, err)
	require.Equal(t, 200, snapshot.StatusCode, string(raw))
	var decoded struct{ Metrics []*dto.MetricFamily }
	require.NoError(t, json.Unmarshal(raw, &decoded))
	seen := map[string]bool{}
	for _, family := range decoded.Metrics {
		if family.GetName() != "smithers_chat_durable_latency_seconds" {
			continue
		}
		for _, metric := range family.Metric {
			stage := metric.Label[0].GetValue()
			seen[stage] = true
			require.Equal(t, uint64(1), metric.Histogram.GetSampleCount(), "fenced/duplicate callbacks must not add observations")
			require.Positive(t, metric.Histogram.GetSampleSum())
		}
	}
	require.Equal(t, map[string]bool{"first_token": true, "answer_with_cards": true}, seen)
}
