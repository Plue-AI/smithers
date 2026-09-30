package modelhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

const (
	JevEvaluateURL          = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
	JevDefaultModel         = ports.RecommendationModelID
	JevProtocolVersion      = "0.0.1"
	JevSpecificationVersion = "4"
)

// JevRecommender is the shared HTTP adapter for the Vercel AI Gateway
// evaluation model. The platform key is resolved for each call and never
// enters a route request or a persisted recommendation row. The caller meters
// each call (routes.RecommendationHandler).
type JevRecommender struct {
	keys     modelproxy.Keys
	endpoint string
	client   *http.Client
}

func NewJevRecommender(keys modelproxy.Keys, endpoint string, client *http.Client) (*JevRecommender, error) {
	if keys == nil || !slices.Contains(keys.PlatformModelProviders(), modelproxy.ProviderVercel) {
		return nil, ports.ErrModelCredentialMissing
	}
	if strings.TrimSpace(endpoint) == "" {
		endpoint = JevEvaluateURL
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("Jev endpoint is invalid")
	}
	if client == nil {
		client = &http.Client{Timeout: 1500 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &JevRecommender{keys: keys, endpoint: endpoint, client: client}, nil
}

func (j *JevRecommender) Recommend(ctx context.Context, input ports.RecommendationRequest) (ports.RecommendationResult, error) {
	model := ports.RecommendationModelID
	if len(input.Model) > 0 {
		var binding struct {
			ModelID string `json:"modelId"`
		}
		if json.Unmarshal(input.Model, &binding) != nil || strings.TrimSpace(binding.ModelID) != ports.RecommendationModelID {
			return ports.RecommendationResult{}, errors.Join(modelproxy.ErrNotCharged, errors.New("recommendation model is not Jev"))
		}
	}
	questions := make(map[string]any)
	for start, index := 0, 0; start < len(input.Commands) || (start == 0 && len(input.Commands) == 0); index++ {
		end := start + 255
		if end > len(input.Commands) {
			end = len(input.Commands)
		}
		criteria := make(map[string]string, end-start)
		for _, command := range input.Commands[start:end] {
			criteria[command.Name] = command.Summary
		}
		questions[fmt.Sprintf("command%d", index+1)] = map[string]any{
			"type":         "choice",
			"instructions": "Choose the next command this user should run in Smithers, a product where a coding agent works on a repository. Prefer commands that continue what the user is doing; when the conversation is empty, prefer commands that start something.",
			"criteria":     criteria,
		}
		if end == len(input.Commands) {
			break
		}
		start = end
	}
	state := map[string]string{"repository": "(none selected)", "conversation": "(no messages yet)"}
	if input.Repo != nil {
		state["repository"] = *input.Repo
	}
	if len(input.Tail) > 0 {
		lines := make([]string, 0, len(input.Tail))
		for _, message := range input.Tail {
			lines = append(lines, message.Role+": "+message.Text)
		}
		state["conversation"] = strings.Join(lines, "\n")
	}
	body, err := json.Marshal(map[string]any{"state": state, "questions": questions, "providerOptions": map[string]any{"gateway": map[string]bool{"zeroDataRetention": true}}})
	if err != nil {
		return ports.RecommendationResult{}, errors.Join(modelproxy.ErrNotCharged, err)
	}
	apiKey, err := j.keys.PlatformModelKey(ctx, modelproxy.ProviderVercel)
	if err != nil || !modelproxy.UsableKey(apiKey) {
		return ports.RecommendationResult{}, errors.Join(modelproxy.ErrNotCharged, ports.ErrModelCredentialMissing)
	}
	var written atomic.Bool
	traced := httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		if info.Err == nil {
			written.Store(true)
		}
	}})
	request, err := http.NewRequestWithContext(traced, http.MethodPost, j.endpoint, bytes.NewReader(body))
	if err != nil {
		return ports.RecommendationResult{}, errors.Join(modelproxy.ErrNotCharged, err)
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("ai-gateway-protocol-version", JevProtocolVersion)
	request.Header.Set("ai-gateway-auth-method", "api-key")
	request.Header.Set("ai-evaluation-model-specification-version", JevSpecificationVersion)
	request.Header.Set("ai-model-id", model)
	request.Header.Set("Content-Type", "application/json")
	response, err := j.client.Do(request)
	if err != nil {
		if !written.Load() {
			return ports.RecommendationResult{}, errors.Join(modelproxy.ErrNotCharged, err)
		}
		return ports.RecommendationResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ports.RecommendationResult{}, errors.Join(modelproxy.ErrNotCharged, fmt.Errorf("Jev answered HTTP %d", response.StatusCode))
	}
	var envelope struct {
		Answers map[string]struct {
			Type          string             `json:"type"`
			Choice        string             `json:"choice"`
			Probabilities map[string]float64 `json:"probabilities"`
		} `json:"answers"`
		Usage *struct {
			InputTokens  *int64 `json:"inputTokens"`
			OutputTokens *int64 `json:"outputTokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope); err != nil || len(envelope.Answers) == 0 {
		return ports.RecommendationResult{}, errors.New("Jev returned no decision")
	}
	type weighted struct {
		name        string
		probability float64
	}
	weightedNames := make([]weighted, 0)
	chosen := make([]string, 0)
	for index := 1; ; index++ {
		answer, ok := envelope.Answers[fmt.Sprintf("command%d", index)]
		if !ok {
			break
		}
		if answer.Type != "choice" || strings.TrimSpace(answer.Choice) == "" {
			continue
		}
		if len(answer.Probabilities) == 0 {
			chosen = append(chosen, answer.Choice)
			continue
		}
		for name, probability := range answer.Probabilities {
			if probability > 0 {
				weightedNames = append(weightedNames, weighted{name: name, probability: probability})
			}
		}
	}
	if len(weightedNames) == 0 && len(chosen) == 0 {
		return ports.RecommendationResult{}, errors.New("Jev returned no choice")
	}
	for left := 0; left < len(weightedNames); left++ {
		for right := left + 1; right < len(weightedNames); right++ {
			if weightedNames[right].probability > weightedNames[left].probability {
				weightedNames[left], weightedNames[right] = weightedNames[right], weightedNames[left]
			}
		}
	}
	commands := make([]string, 0, len(weightedNames)+len(chosen))
	for _, item := range weightedNames {
		commands = append(commands, item.name)
	}
	commands = append(commands, chosen...)
	result := ports.RecommendationResult{Commands: commands, Model: model}
	if usage := envelope.Usage; usage != nil && usage.InputTokens != nil && usage.OutputTokens != nil {
		result.Usage = &ports.RecommendationUsage{InputTokens: *usage.InputTokens, OutputTokens: *usage.OutputTokens}
	}
	return result, nil
}
