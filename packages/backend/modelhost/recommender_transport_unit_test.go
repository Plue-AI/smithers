package modelhost

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

func TestRecommendationChargeFollowsCompletedRequestWrite(t *testing.T) {
	transportErr := errors.New("connection lost")
	writeErr := errors.New("write incomplete")
	for _, tc := range []struct {
		name       string
		invoke     bool
		writeErr   error
		notCharged bool
	}{{"before write", false, nil, true}, {"failed write", true, writeErr, true}, {"completed write", true, nil, false}} {
		t.Run(tc.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if tc.invoke {
					trace := httptrace.ContextClientTrace(request.Context())
					require.NotNil(t, trace)
					trace.WroteRequest(httptrace.WroteRequestInfo{Err: tc.writeErr})
				}
				return nil, transportErr
			})}
			recommender, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "gateway-key"}, "https://gateway.test/evaluate", client)
			require.NoError(t, err)
			result, err := recommender.Recommend(context.Background(), ports.RecommendationRequest{})
			require.Empty(t, result.Commands)
			require.Empty(t, result.Model)
			require.ErrorIs(t, err, transportErr)
			require.Equal(t, tc.notCharged, errors.Is(err, modelproxy.ErrNotCharged))
		})
	}
}

func TestRecommendationCombinesWeightedAndFallbackChoices(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"answers":{"command1":{"type":"choice","choice":"second","probabilities":{"first":0.9,"second":0.4,"ignored":0}},"command2":{"type":"choice","choice":"fallback"},"command3":{"type":"choice","choice":"third","probabilities":{"third":0.7}}}}`))}, nil
	})}
	recommender, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "key"}, "https://gateway.test", client)
	require.NoError(t, err)
	result, err := recommender.Recommend(context.Background(), ports.RecommendationRequest{})
	require.NoError(t, err)
	require.Equal(t, []string{"first", "third", "second", "fallback"}, result.Commands)
}

func TestRecommendationDefaultEndpointAndTimeoutRefuseRedirects(t *testing.T) {
	recommender, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "key"}, " \t", nil)
	require.NoError(t, err)
	require.Equal(t, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", recommender.endpoint)
	require.Equal(t, 1500*time.Millisecond, recommender.client.Timeout)
	require.ErrorIs(t, recommender.client.CheckRedirect(&http.Request{}, nil), http.ErrUseLastResponse)
}
