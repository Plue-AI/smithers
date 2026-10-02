package modelhost

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// The command-selection eval (issue #3313): fixed chat messages against the
// retained 220-command catalog. The GitHub connection/import commands remain;
// retired provider commands are absent. Original model answers remain byte-for-byte
// recorded evidence (including obsolete zero-score keys), not fresh live results.
// Offline (the default) it replays recorded
// Jev answers through SelectCommands, so a change to the question shape,
// threshold or parsing that loses a command fails here. Live, it asks the
// gateway itself:
//
//	SMITHERS_JEV_EVAL=live   AI_GATEWAY_API_KEY=... go test ./modelhost -run TestCommandSelectionEval -v
//	SMITHERS_JEV_EVAL=record AI_GATEWAY_API_KEY=... go test ./modelhost -run TestCommandSelectionEval
//
// record rewrites testdata/command_selection_eval.json's answers from a live run.
// expect is a list of alternatives sets: every set needs one member selected;
// an empty expect means the selection must be empty.

type selectionEvalCase struct {
	ID      string          `json:"id"`
	Message string          `json:"message"`
	Expect  [][]string      `json:"expect"`
	Answer  json.RawMessage `json:"answer,omitempty"`
}

type selectionEval struct {
	Catalog []ports.RecommendationCommand `json:"catalog"`
	Cases   []selectionEvalCase           `json:"cases"`
}

const selectionEvalPath = "testdata/command_selection_eval.json"

func recallMet(selected []ports.SelectedCommand, expect [][]string) bool {
	if len(expect) == 0 {
		return len(selected) == 0
	}
	names := map[string]bool{}
	for _, command := range selected {
		names[command.Name] = true
	}
	for _, alternatives := range expect {
		found := false
		for _, name := range alternatives {
			found = found || names[name]
		}
		if !found {
			return false
		}
	}
	return true
}

type capturingTransport struct{ last []byte }

func (c *capturingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := http.DefaultTransport.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		return nil, err
	}
	c.last = body
	response.Body = io.NopCloser(bytes.NewReader(body))
	return response, nil
}

func TestCommandSelectionEval(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(selectionEvalPath))
	require.NoError(t, err)
	var eval selectionEval
	require.NoError(t, json.Unmarshal(raw, &eval))
	require.Len(t, eval.Catalog, 220)
	for _, command := range eval.Catalog {
		require.NotContains(t, command.Name, "integrations.")
	}
	mode := os.Getenv("SMITHERS_JEV_EVAL")
	live := mode == "live" || mode == "record"
	if live && os.Getenv("AI_GATEWAY_API_KEY") == "" {
		t.Skip("SMITHERS_JEV_EVAL needs AI_GATEWAY_API_KEY")
	}
	latencies := make([]time.Duration, 0, len(eval.Cases))
	for index := range eval.Cases {
		item := &eval.Cases[index]
		var selector *JevRecommender
		capture := &capturingTransport{}
		if live {
			selector, err = NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: os.Getenv("AI_GATEWAY_API_KEY")}, "",
				&http.Client{Timeout: 5 * time.Second, Transport: capture})
		} else {
			require.NotEmpty(t, item.Answer, "%s has no recorded answer; run with SMITHERS_JEV_EVAL=record", item.ID)
			server := httptest.NewServer(answering(string(item.Answer)))
			t.Cleanup(server.Close)
			selector, err = NewJevRecommender(modelproxy.StaticKeys{modelproxy.ProviderVercel: "gateway-key"}, server.URL, server.Client())
		}
		require.NoError(t, err)
		started := time.Now()
		result, err := selector.SelectCommands(context.Background(), ports.CommandSelectionRequest{Message: item.Message, Commands: eval.Catalog})
		latencies = append(latencies, time.Since(started))
		require.NoError(t, err, item.ID)
		t.Logf("%-20s %6s %v", item.ID, time.Since(started).Round(time.Millisecond), result.Commands)
		require.True(t, recallMet(result.Commands, item.Expect), "%s: selected %v, expected %v", item.ID, result.Commands, item.Expect)
		if mode == "record" {
			var compact bytes.Buffer
			require.NoError(t, json.Compact(&compact, capture.last))
			item.Answer = compact.Bytes()
		}
	}
	if live {
		sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
		t.Logf("live latency: max %s over %d cases", latencies[len(latencies)-1].Round(time.Millisecond), len(latencies))
	}
	if mode == "record" {
		out, err := json.MarshalIndent(eval, "", " ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(selectionEvalPath, append(out, '\n'), 0o644))
	}
}
