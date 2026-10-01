package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

func selectionRequest(n int) ports.CommandSelectionRequest {
	commands := make([]ports.RecommendationCommand, n)
	for i := range commands {
		commands[i] = ports.RecommendationCommand{Name: fmt.Sprintf("c%03d", i), Summary: fmt.Sprintf("summary %d", i)}
	}
	repo := "owner/repo"
	return ports.CommandSelectionRequest{
		Message:  "land my change",
		Tail:     []ports.RecommendationTailMessage{{Role: "user", Text: "hi"}, {Role: "assistant", Text: "hello"}},
		Repo:     &repo,
		Commands: commands,
	}
}

func jevSelector(t *testing.T, handler http.HandlerFunc) *JevRecommender {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	selector, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "gateway-key"}, server.URL, server.Client())
	require.NoError(t, err)
	return selector
}

func answering(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}
}

func TestSelectCommands_SendsOneRequestWithNoneInEveryQuestion(t *testing.T) {
	var requests int
	var header http.Header
	var body struct {
		State           map[string]string `json:"state"`
		ProviderOptions map[string]any    `json:"providerOptions"`
		Questions       map[string]struct {
			Type         string            `json:"type"`
			Instructions string            `json:"instructions"`
			Criteria     map[string]string `json:"criteria"`
		} `json:"questions"`
	}
	selector := jevSelector(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		header = r.Header.Clone()
		require.Equal(t, http.MethodPost, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		answering(`{"answers":{"command1":{"type":"choice","choice":"none"},"command2":{"type":"choice","choice":"none"}}}`)(w, r)
	})
	result, err := selector.SelectCommands(context.Background(), selectionRequest(300))
	require.NoError(t, err)
	require.Equal(t, 1, requests)
	require.Equal(t, "Bearer gateway-key", header.Get("Authorization"))
	require.Equal(t, "typesafe-ai/jev", header.Get("ai-model-id"))
	require.Equal(t, "0.0.1", header.Get("ai-gateway-protocol-version"))
	require.Equal(t, "api-key", header.Get("ai-gateway-auth-method"))
	require.Equal(t, "4", header.Get("ai-evaluation-model-specification-version"))
	require.Equal(t, "application/json", header.Get("Content-Type"))
	require.Equal(t, map[string]string{
		"message":      "land my change",
		"conversation": "user: hi\nassistant: hello",
		"repository":   "owner/repo",
	}, body.State)
	require.Equal(t, map[string]any{"gateway": map[string]any{"zeroDataRetention": true}}, body.ProviderOptions)
	require.Len(t, body.Questions, 2)
	first, second := body.Questions["command1"], body.Questions["command2"]
	require.Len(t, first.Criteria, 254, "253 commands and none")
	require.Len(t, second.Criteria, 48, "47 commands and none")
	for _, question := range []string{"command1", "command2"} {
		q := body.Questions[question]
		require.Equal(t, "choice", q.Type)
		require.Equal(t, "The user just sent `message` to Smithers, a product where a coding agent works on a repository. Choose the command `message` asks the app to run or asks about, or `none` when it concerns no command: small talk, a general question, or a coding task.", q.Instructions)
		require.Equal(t, "the message concerns none of these commands: small talk, a general question, or a coding task", q.Criteria["none"])
	}
	require.Equal(t, "summary 0", first.Criteria["c000"])
	require.Equal(t, "summary 252", first.Criteria["c252"])
	require.NotContains(t, first.Criteria, "c253")
	require.Equal(t, "summary 253", second.Criteria["c253"])
	require.Equal(t, "summary 299", second.Criteria["c299"])
	require.Empty(t, result.Commands, "none everywhere selects nothing")
	require.Equal(t, ports.RecommendationModelID, result.Model)
}

func TestSelectCommands_DescribesAnEmptyConversationAndNoRepository(t *testing.T) {
	var state map[string]string
	selector := jevSelector(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			State     map[string]string `json:"state"`
			Questions map[string]any    `json:"questions"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		state = body.State
		require.Len(t, body.Questions, 1)
		answering(`{"answers":{"command1":{"type":"choice","choice":"none"}}}`)(w, r)
	})
	request := selectionRequest(3)
	request.Tail, request.Repo, request.Message = nil, nil, "hi"
	_, err := selector.SelectCommands(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"message": "hi", "conversation": "(no messages yet)", "repository": "(none selected)"}, state)
}

func TestSelectCommands_UnionsAnswersAboveTheThreshold(t *testing.T) {
	probabilities := make([]string, 0, 16)
	for i := range 16 {
		probabilities = append(probabilities, fmt.Sprintf(`"c%03d":%g`, 10+i, 0.03+float64(i)/1000))
	}
	selector := jevSelector(t, answering(`{"answers":{`+
		`"command1":{"type":"choice","choice":"c000","probabilities":{"c000":0.6,"none":0.95,"c001":0.02,"c002":0.0199,`+strings.Join(probabilities, ",")+`}},`+
		`"command2":{"type":"choice","choice":"c260"},`+
		`"command3":{"type":"choice","choice":"c999","probabilities":{"c999":1}}},`+
		`"usage":{"inputTokens":800,"outputTokens":2}}`))
	result, err := selector.SelectCommands(context.Background(), selectionRequest(300))
	require.NoError(t, err)
	require.Len(t, result.Commands, ports.CommandSelectionMax)
	require.Equal(t, ports.SelectedCommand{Name: "c260", Probability: 1}, result.Commands[0], "a choice without probabilities counts at 1.0")
	require.Equal(t, ports.SelectedCommand{Name: "c000", Probability: 0.6}, result.Commands[1])
	for i := 2; i < len(result.Commands); i++ {
		require.Greater(t, result.Commands[i-1].Probability, result.Commands[i].Probability)
		require.Equal(t, fmt.Sprintf("c%03d", 25-(i-2)), result.Commands[i].Name)
	}
	for _, command := range result.Commands {
		require.NotEqual(t, "none", command.Name)
		require.NotEqual(t, "c999", command.Name, "command3 was not asked")
	}
	require.Equal(t, &ports.RecommendationUsage{InputTokens: 800, OutputTokens: 2}, result.Usage)
}

func TestSelectCommands_KeepsTheThresholdBoundary(t *testing.T) {
	selector := jevSelector(t, answering(`{"answers":{"command1":{"type":"choice","choice":"none","probabilities":{"none":0.9,"c001":0.02,"c002":0.0199}}}}`))
	result, err := selector.SelectCommands(context.Background(), selectionRequest(3))
	require.NoError(t, err)
	require.Equal(t, []ports.SelectedCommand{{Name: "c001", Probability: 0.02}}, result.Commands)
	require.Nil(t, result.Usage)
}

func TestSelectCommands_Failures(t *testing.T) {
	for _, tc := range []struct {
		name       string
		handler    http.HandlerFunc
		notCharged bool
		message    string
	}{
		{"http 500", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) }, true, "Jev answered HTTP 500"},
		{"no answers", answering(`{"answers":{}}`), false, "Jev returned no decision"},
		{"not json", answering(`<html>`), false, "Jev returned no decision"},
		{"no asked question answered", answering(`{"answers":{"command9":{"type":"choice","choice":"c001"}}}`), false, "Jev returned no choice"},
		{"blank choice", answering(`{"answers":{"command1":{"type":"choice","choice":" "}}}`), false, "Jev returned no choice"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := jevSelector(t, tc.handler).SelectCommands(context.Background(), selectionRequest(3))
			require.ErrorContains(t, err, tc.message)
			require.Equal(t, tc.notCharged, errors.Is(err, modelproxy.ErrNotCharged))
			require.Empty(t, result.Commands)
			require.Empty(t, result.Model)
		})
	}
}

func TestSelectCommands_UnwrittenRequestIsNotCharged(t *testing.T) {
	transportErr := errors.New("connection refused")
	for _, tc := range []struct {
		name       string
		write      bool
		notCharged bool
	}{{"never written", false, true}, {"written", true, false}} {
		t.Run(tc.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if tc.write {
					httptrace.ContextClientTrace(request.Context()).WroteRequest(httptrace.WroteRequestInfo{})
				}
				return nil, transportErr
			})}
			selector, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "key"}, "https://gateway.test", client)
			require.NoError(t, err)
			_, err = selector.SelectCommands(context.Background(), selectionRequest(3))
			require.ErrorIs(t, err, transportErr)
			require.Equal(t, tc.notCharged, errors.Is(err, modelproxy.ErrNotCharged))
		})
	}
}

func TestSelectCommands_MissingKeyIsNotCharged(t *testing.T) {
	selector, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "key"}, "https://gateway.test", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("unexpected dispatch")
	})})
	require.NoError(t, err)
	selector.keys = modelproxy.StaticKeys{modelproxy.ProviderVercel: ""}
	_, err = selector.SelectCommands(context.Background(), selectionRequest(3))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	require.ErrorIs(t, err, modelproxy.ErrNotCharged)
}

func TestSelectCommands_StopsAtTheContextDeadline(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-time.After(3 * time.Second):
		case <-release:
		}
		answering(`{"answers":{"command1":{"type":"choice","choice":"c001"}}}`)(w, r)
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) }) // runs before server.Close
	// No client timeout: only the context bounds the call.
	selector, err := NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "key"}, server.URL, &http.Client{})
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err = selector.SelectCommands(ctx, selectionRequest(3))
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.False(t, errors.Is(err, modelproxy.ErrNotCharged), "the request was written")
	require.Less(t, time.Since(started), time.Second)
}
