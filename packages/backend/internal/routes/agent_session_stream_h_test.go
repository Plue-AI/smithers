package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

type agentSessionStreamCovService struct {
	messages []services.AgentMessageResponse
	called   bool
}

func (s *agentSessionStreamCovService) GetSessionForRepo(context.Context, string, int64) error {
	return nil
}

func (s *agentSessionStreamCovService) ListMessagesAfterID(_ context.Context, _ string, after int64, limit int) ([]services.AgentMessageResponse, error) {
	s.called = true
	var page []services.AgentMessageResponse
	for _, message := range s.messages {
		if message.ID > after && len(page) < limit {
			page = append(page, message)
		}
	}
	return page, nil
}

func (s *agentSessionStreamCovService) GetAgentMessageStreamHead(context.Context, string) (int64, error) {
	return 0, nil
}

func TestAgentSessionStream_H_StreamConfigAndReplayBranches(t *testing.T) {
	oldServe := serveAgentSessionBrokerSSE
	t.Cleanup(func() { serveAgentSessionBrokerSSE = oldServe })

	var gotCfg sse.BrokerStreamConfig
	serveAgentSessionBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
		gotCfg = cfg
		cfg.OnConnect(w, r, httptest.NewRecorder())
		w.WriteHeader(http.StatusAccepted)
	}

	svc := &agentSessionStreamCovService{messages: []services.AgentMessageResponse{{ID: 21, SessionID: testAgentSessionID, Role: "user", Sequence: 1}, {
		ID:        22,
		SessionID: testAgentSessionID,
		Role:      "assistant",
		Sequence:  2,
		CreatedAt: time.Date(2026, 7, 7, 1, 2, 3, 0, time.UTC),
	}}}
	h := &AgentSessionStreamHandler{
		Service: svc,
		Broker:  &sse.Broker{},
		Metrics: &SmithersMetrics{SSEActiveConnections: prometheus.NewGauge(prometheus.GaugeOpts{Name: "agent_session_stream_h_active"})},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/x/stream", nil)
	req.Header.Set("Last-Event-ID", "21")
	req = withRouteParams(req, map[string]string{"id": testAgentSessionID})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()

	h.AgentSessionStream(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "agent_session_"+strings.ReplaceAll(testAgentSessionID, "-", ""), gotCfg.Channel)
	assert.Equal(t, int64(7), gotCfg.UserID)
	assert.Equal(t, "agent.session", gotCfg.EventType)
	assert.NotNil(t, gotCfg.ActiveConnections)
	assert.Contains(t, rec.Body.String(), "id: 22")
	assert.True(t, svc.called)
}

func TestAgentSessionStream_H_ReplayMarshalErrorAndIDs(t *testing.T) {
	oldMarshal := marshalAgentSessionReplayPayload
	t.Cleanup(func() { marshalAgentSessionReplayPayload = oldMarshal })
	marshalAgentSessionReplayPayload = func(any) ([]byte, error) {
		return nil, errors.New("marshal failed")
	}

	svc := &agentSessionStreamCovService{messages: []services.AgentMessageResponse{{
		ID:        31,
		SessionID: testAgentSessionID,
		Role:      "assistant",
		CreatedAt: time.Now().UTC(),
	}}}
	rec := serveAgentSessionReplay(t, svc, "30")

	assert.Contains(t, rec.Body.String(), "event: stream.error")
	assert.NotContains(t, rec.Body.String(), "id:")
	assert.True(t, rec.Flushed)

	assert.Empty(t, extractAgentEventID(`not-json`))
	assert.Equal(t, "1", extractAgentEventID(`{"id":1}`))
	assert.Equal(t, "2", extractAgentEventID(`{"sequence":2}`))
	assert.Equal(t, "3", extractAgentEventID(`{"message":{"id":3}}`))
	assert.Equal(t, "4", extractAgentEventID(`{"message":{"sequence":4}}`))
	assert.Empty(t, extractAgentEventID(`{"message":{}}`))
}
