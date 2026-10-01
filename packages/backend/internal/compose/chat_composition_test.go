package compose

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type unusedChatHost struct{}

func (unusedChatHost) RunChatTurn(context.Context, ports.ChatTurnGrant) error { return nil }

func TestChatCompositionRequiresPrivateCallbackBoundary(t *testing.T) {
	_, err := newChatComposition(runOptions{Options: Options{ChatProducerBaseURL: "http://127.0.0.1:1000"}}, nil, chat.RuntimeOptions{})
	require.ErrorContains(t, err, "requires a chat host")
	worker, err := newChatComposition(runOptions{topology: hostedWorkerTopology, Options: Options{
		ChatHost: unusedChatHost{}, ChatProducerBaseURL: "https://api.example.test",
	}}, &pgxpool.Pool{}, chat.RuntimeOptions{})
	require.NoError(t, err)
	require.Nil(t, worker.listener)

	publicListener, err := net.Listen("tcp", "0.0.0.0:0")
	require.NoError(t, err)
	_, err = newChatComposition(runOptions{topology: localTopology, Options: Options{
		ChatHost: unusedChatHost{}, ChatCallbackListener: publicListener,
	}}, nil, chat.RuntimeOptions{})
	require.ErrorContains(t, err, "must bind loopback")
}

func TestHostedAPICallbackUsesSharedListenerWhenPrivateListenerIsAbsent(t *testing.T) {
	runtime, err := newChatComposition(runOptions{topology: hostedAPITopology, Options: Options{
		ChatHost: unusedChatHost{}, ChatProducerBaseURL: "https://api.example.test",
	}}, &pgxpool.Pool{}, chat.RuntimeOptions{})
	require.NoError(t, err)
	require.NotNil(t, runtime)
	require.Nil(t, runtime.listener)
	router := chi.NewRouter()
	mountChatProducerOnSharedListener(router, runtime)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, chat.CommitPath, strings.NewReader(`{}`)))
	require.Equal(t, http.StatusUnauthorized, response.Code)
}

func TestChatStreamingRoutesRequireAuthentication(t *testing.T) {
	router := chi.NewRouter()
	// The product's ordinary /api subtree is registered first. The chat route
	// must still win and must not inherit that subtree's JSON request timeout.
	router.Route("/api", func(api chi.Router) {
		api.Post("/agent/turn", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		})
	})
	mountChatPublic(router, &chat.Runtime{Handler: &chat.Handler{}}, nil, &config.Config{})
	for _, path := range []string{chat.TurnPath, chat.CancelPath, chat.ReplayPath, chat.RetirePath, chat.AccountReplayPath} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, nil))
		require.Equal(t, http.StatusUnauthorized, response.Code, path)
	}
	history := httptest.NewRecorder()
	router.ServeHTTP(history, httptest.NewRequest(http.MethodGet, chat.HistoryPath, nil))
	require.Equal(t, http.StatusUnauthorized, history.Code, chat.HistoryPath)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, chat.CommitPath, nil))
	require.Equal(t, http.StatusNotFound, response.Code)
}

func TestChatErasureRouteSurvivesSignoutAndRejectsForeignOrigin(t *testing.T) {
	router := chi.NewRouter()
	mountChatPublic(router, &chat.Runtime{Handler: &chat.Handler{}}, nil, &config.Config{})
	// No AuthLoader identity or CSRF cookie is available after sign-out. A 503
	// from the handler proves the proof-only request passed the route stack.
	request := httptest.NewRequest(http.MethodPost, chat.ErasePath, strings.NewReader(`{"runId":"run","legId":"leg","retirementProof":"`+strings.Repeat("a", 64)+`"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
	foreign := request.Clone(request.Context())
	foreign.Header.Set("Origin", "https://foreign.invalid")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, foreign)
	require.Equal(t, http.StatusForbidden, response.Code)
}

func TestChatSizingDefaultsByRoleAndHonorsConfiguration(t *testing.T) {
	hosted, err := chatRuntimeOptions(config.ChatConfig{}, true, nil)
	require.NoError(t, err)
	require.Equal(t, hostedChatConcurrency, hosted.Concurrency)
	require.Equal(t, hostedChatQueueSize, hosted.QueueSize)
	local, err := chatRuntimeOptions(config.ChatConfig{}, false, nil)
	require.NoError(t, err)
	require.Zero(t, local.Concurrency, "single owner keeps the chat runtime default")
	configured, err := chatRuntimeOptions(config.ChatConfig{Concurrency: 64, QueueSize: 16, LeaseSeconds: 90}, true, nil)
	require.NoError(t, err)
	require.Equal(t, 64, configured.Concurrency)
	require.Equal(t, 16, configured.QueueSize)
	require.Equal(t, 90*time.Second, configured.Lease)
	_, err = chatRuntimeOptions(config.ChatConfig{Concurrency: -1}, true, nil)
	require.Error(t, err)
}

func TestChatSizingLoadsFromEnvironment(t *testing.T) {
	t.Setenv("SMITHERS_CHAT_CONCURRENCY", "48")
	t.Setenv("SMITHERS_CHAT_QUEUE_SIZE", "512")
	t.Setenv("SMITHERS_CHAT_LEASE_SECONDS", "60")
	cfg, err := config.Load("")
	require.NoError(t, err)
	require.Equal(t, config.ChatConfig{Concurrency: 48, QueueSize: 512, LeaseSeconds: 60}, cfg.Chat)
}
