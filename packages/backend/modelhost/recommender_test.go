package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

func TestJevRecommender_UsesGatewayDecisionAndFiltersAtRouteBoundary(t *testing.T) {
	var gotHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("ai-model-id")
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.NotNil(t, body["questions"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"answers":{"command1":{"type":"choice","choice":"review","probabilities":{"review":0.9,"help":0.1}}}}`))
	}))
	defer server.Close()
	recommender, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "gateway-key"}, server.URL, server.Client())
	require.NoError(t, err)
	result, err := recommender.Recommend(context.Background(), ports.RecommendationRequest{
		Commands: []ports.RecommendationCommand{{Name: "review", Summary: "Review"}, {Name: "help", Summary: "Help"}},
	})
	require.NoError(t, err)
	require.Equal(t, JevDefaultModel, gotHeader)
	require.Equal(t, []string{"review", "help"}, result.Commands)
	require.Nil(t, result.Usage, "an answer without usage reports none")
}

func TestJevRecommender_ReportsTheTokensJevCounted(t *testing.T) {
	for _, item := range []struct {
		usage string
		want  *ports.RecommendationUsage
	}{
		{`{"inputTokens":120,"outputTokens":3}`, &ports.RecommendationUsage{InputTokens: 120, OutputTokens: 3}},
		{`{"inputTokens":120}`, nil},
		{`{"outputTokens":3}`, nil},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"answers":{"command1":{"type":"choice","choice":"review"}},"usage":` + item.usage + `}`))
		}))
		recommender, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "gateway-key"}, server.URL, server.Client())
		require.NoError(t, err)
		result, err := recommender.Recommend(context.Background(), ports.RecommendationRequest{
			Commands: []ports.RecommendationCommand{{Name: "review", Summary: "Review"}},
		})
		server.Close()
		require.NoError(t, err)
		require.Equal(t, item.want, result.Usage, item.usage)
	}
}

func TestJevRecommenderRejectsInvalidEndpointAndBindingBeforeDispatch(t *testing.T) {
	keys := modelproxy.StaticKeys{modelproxy.ProviderVercel: "gateway-key"}
	if _, err := NewJevRecommender(nil, "https://gateway.test/evaluate", nil); !errors.Is(err, ports.ErrModelCredentialMissing) {
		t.Fatalf("missing platform key: %v", err)
	}
	for _, endpoint := range []string{"file:///tmp/evaluate", "https://user@gateway.test/evaluate", "https://", "http://[::1"} {
		if _, err := NewJevRecommender(keys, endpoint, nil); err == nil {
			t.Fatalf("invalid endpoint %q accepted", endpoint)
		}
	}
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		requests++
		return nil, errors.New("unexpected dispatch")
	})}
	recommender, err := NewJevRecommender(keys, "https://gateway.test/evaluate", client)
	require.NoError(t, err)
	for _, model := range []json.RawMessage{json.RawMessage(`{"modelId":"other"}`), json.RawMessage(`{`)} {
		_, err := recommender.Recommend(context.Background(), ports.RecommendationRequest{Model: model})
		require.ErrorIs(t, err, modelproxy.ErrNotCharged)
	}
	require.Zero(t, requests)
	withoutKey, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "<placeholder>"}, "https://gateway.test/evaluate", client)
	require.NoError(t, err)
	_, err = withoutKey.Recommend(context.Background(), ports.RecommendationRequest{})
	require.ErrorIs(t, err, modelproxy.ErrNotCharged)
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	require.Zero(t, requests)
}

func TestJevRecommenderBatchesCommandsAndCarriesConversationState(t *testing.T) {
	commands := make([]ports.RecommendationCommand, 256)
	for i := range commands {
		commands[i] = ports.RecommendationCommand{Name: fmt.Sprintf("command-%d", i), Summary: fmt.Sprintf("summary-%d", i)}
	}
	repo := "smithers"
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		require.Equal(t, http.MethodPost, request.Method)
		require.Equal(t, "Bearer gateway-key", request.Header.Get("Authorization"))
		require.Equal(t, JevProtocolVersion, request.Header.Get("ai-gateway-protocol-version"))
		require.Equal(t, JevSpecificationVersion, request.Header.Get("ai-evaluation-model-specification-version"))
		var body struct {
			State     map[string]string `json:"state"`
			Questions map[string]struct {
				Criteria map[string]string `json:"criteria"`
			} `json:"questions"`
		}
		require.NoError(t, json.NewDecoder(request.Body).Decode(&body))
		require.Equal(t, repo, body.State["repository"])
		require.Equal(t, "user: fix tests\nassistant: running", body.State["conversation"])
		require.Len(t, body.Questions["command1"].Criteria, 255)
		require.Equal(t, "summary-255", body.Questions["command2"].Criteria["command-255"])
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"answers":{"command1":{"type":"choice","choice":"command-9"},"command2":{"type":"choice","choice":"command-255"}}}`))}, nil
	})}
	recommender, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "gateway-key"}, "https://gateway.test/evaluate", client)
	require.NoError(t, err)
	result, err := recommender.Recommend(context.Background(), ports.RecommendationRequest{
		Repo: &repo, Tail: []ports.RecommendationTailMessage{{Role: "user", Text: "fix tests"}, {Role: "assistant", Text: "running"}}, Commands: commands,
	})
	require.NoError(t, err)
	require.Equal(t, JevDefaultModel, result.Model)
	require.Equal(t, []string{"command-9", "command-255"}, result.Commands)
}

func TestJevRecommenderClassifiesGatewayFailuresAndClosesResponses(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		body       string
		message    string
		notCharged bool
	}{
		{"rejected status", http.StatusServiceUnavailable, `unavailable`, "Jev answered HTTP 503", true},
		{"malformed JSON", http.StatusOK, `{`, "Jev returned no decision", false},
		{"empty answers", http.StatusOK, `{"answers":{}}`, "Jev returned no decision", false},
		{"wrong answer type", http.StatusOK, `{"answers":{"command1":{"type":"text","choice":"review"}}}`, "Jev returned no choice", false},
		{"nonpositive weights", http.StatusOK, `{"answers":{"command1":{"type":"choice","choice":"review","probabilities":{"review":0,"help":-1}}}}`, "Jev returned no choice", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			closed := false
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: tc.status,
					Header:     make(http.Header),
					Body:       &trackingReadCloser{Reader: strings.NewReader(tc.body), closed: &closed},
				}, nil
			})}
			recommender, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "gateway-key"}, "https://gateway.test/evaluate", client)
			require.NoError(t, err)
			_, err = recommender.Recommend(context.Background(), ports.RecommendationRequest{Commands: []ports.RecommendationCommand{{Name: "review"}}})
			require.ErrorContains(t, err, tc.message)
			require.Equal(t, tc.notCharged, errors.Is(err, modelproxy.ErrNotCharged))
			require.True(t, closed)
		})
	}
}
