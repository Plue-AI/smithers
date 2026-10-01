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
	"sort"
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

const (
	recommendQuestionSize = 255
	// selectQuestionSize leaves room for the none option in a choice of at
	// most 254 options.
	selectQuestionSize = 253

	recommendInstructions = "Choose the next command this user should run in Smithers, a product where a coding agent works on a repository. Prefer commands that continue what the user is doing; when the conversation is empty, prefer commands that start something."
	selectInstructions    = "The user just sent `message` to Smithers, a product where a coding agent works on a repository. Choose the command `message` asks the app to run or asks about, or `none` when it concerns no command: small talk, a general question, or a coding task."
	selectNoneCriterion   = "the message concerns none of these commands: small talk, a general question, or a coding task"
	selectNone            = "none"
)

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
	questions, _ := commandQuestions(input.Commands, recommendQuestionSize, recommendInstructions, "")
	answers, usage, err := j.evaluate(ctx, model, jevState(input.Repo, input.Tail), questions)
	if err != nil {
		return ports.RecommendationResult{}, err
	}
	type weighted struct {
		name        string
		probability float64
	}
	weightedNames := make([]weighted, 0)
	chosen := make([]string, 0)
	for index := 1; ; index++ {
		answer, ok := answers[questionKey(index)]
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
	return ports.RecommendationResult{Commands: commands, Model: model, Usage: usage}, nil
}

// SelectCommands asks Jev which offered commands message asks the app to run
// or asks about. Each choice question carries a none option; a message that
// concerns no command selects nothing.
func (j *JevRecommender) SelectCommands(ctx context.Context, input ports.CommandSelectionRequest) (ports.CommandSelectionResult, error) {
	model := ports.RecommendationModelID
	questions, count := commandQuestions(input.Commands, selectQuestionSize, selectInstructions, selectNoneCriterion)
	state := jevState(input.Repo, input.Tail)
	state["message"] = input.Message
	answers, usage, err := j.evaluate(ctx, model, state, questions)
	if err != nil {
		return ports.CommandSelectionResult{}, err
	}
	probabilities := make(map[string]float64)
	answered := false
	for index := 1; index <= count; index++ {
		answer, ok := answers[questionKey(index)]
		if !ok || answer.Type != "choice" || strings.TrimSpace(answer.Choice) == "" {
			continue
		}
		answered = true
		weights := answer.Probabilities
		if len(weights) == 0 {
			weights = map[string]float64{answer.Choice: 1}
		}
		for name, probability := range weights {
			if name != selectNone && probability > probabilities[name] {
				probabilities[name] = probability
			}
		}
	}
	if !answered {
		return ports.CommandSelectionResult{}, errors.New("Jev returned no choice")
	}
	selected := make([]ports.SelectedCommand, 0, len(probabilities))
	for name, probability := range probabilities {
		if probability >= ports.CommandSelectionMinProbability {
			selected = append(selected, ports.SelectedCommand{Name: name, Probability: probability})
		}
	}
	sort.Slice(selected, func(left, right int) bool {
		if selected[left].Probability != selected[right].Probability {
			return selected[left].Probability > selected[right].Probability
		}
		return selected[left].Name < selected[right].Name
	})
	if len(selected) > ports.CommandSelectionMax {
		selected = selected[:ports.CommandSelectionMax]
	}
	return ports.CommandSelectionResult{Commands: selected, Model: model, Usage: usage}, nil
}

func questionKey(index int) string { return fmt.Sprintf("command%d", index) }

// commandQuestions splits commands into choice questions of at most size
// options keyed command1, command2, ...; a non-empty none criterion adds a
// none option to each. No commands still asks one question.
func commandQuestions(commands []ports.RecommendationCommand, size int, instructions, none string) (map[string]any, int) {
	questions := make(map[string]any)
	count := 0
	for start := 0; start < len(commands) || count == 0; start += size {
		end := min(start+size, len(commands))
		criteria := make(map[string]string, end-start+1)
		for _, command := range commands[start:end] {
			criteria[command.Name] = command.Summary
		}
		if none != "" {
			criteria[selectNone] = none
		}
		count++
		questions[questionKey(count)] = map[string]any{"type": "choice", "instructions": instructions, "criteria": criteria}
	}
	return questions, count
}

func jevState(repo *string, tail []ports.RecommendationTailMessage) map[string]string {
	state := map[string]string{"repository": "(none selected)", "conversation": "(no messages yet)"}
	if repo != nil {
		state["repository"] = *repo
	}
	if len(tail) > 0 {
		lines := make([]string, 0, len(tail))
		for _, message := range tail {
			lines = append(lines, message.Role+": "+message.Text)
		}
		state["conversation"] = strings.Join(lines, "\n")
	}
	return state
}

type jevAnswer struct {
	Type          string             `json:"type"`
	Choice        string             `json:"choice"`
	Probabilities map[string]float64 `json:"probabilities"`
}

// evaluate makes one Jev call. An error joined with modelproxy.ErrNotCharged
// means the gateway cannot have charged it: it was never written or Jev
// refused it.
func (j *JevRecommender) evaluate(ctx context.Context, model string, state map[string]string, questions map[string]any) (map[string]jevAnswer, *ports.RecommendationUsage, error) {
	body, err := json.Marshal(map[string]any{"state": state, "questions": questions, "providerOptions": map[string]any{"gateway": map[string]bool{"zeroDataRetention": true}}})
	if err != nil {
		return nil, nil, errors.Join(modelproxy.ErrNotCharged, err)
	}
	apiKey, err := j.keys.PlatformModelKey(ctx, modelproxy.ProviderVercel)
	if err != nil || !modelproxy.UsableKey(apiKey) {
		return nil, nil, errors.Join(modelproxy.ErrNotCharged, ports.ErrModelCredentialMissing)
	}
	var written atomic.Bool
	traced := httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		if info.Err == nil {
			written.Store(true)
		}
	}})
	request, err := http.NewRequestWithContext(traced, http.MethodPost, j.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, nil, errors.Join(modelproxy.ErrNotCharged, err)
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
			return nil, nil, errors.Join(modelproxy.ErrNotCharged, err)
		}
		return nil, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, nil, errors.Join(modelproxy.ErrNotCharged, fmt.Errorf("Jev answered HTTP %d", response.StatusCode))
	}
	var envelope struct {
		Answers map[string]jevAnswer `json:"answers"`
		Usage   *struct {
			InputTokens  *int64 `json:"inputTokens"`
			OutputTokens *int64 `json:"outputTokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope); err != nil || len(envelope.Answers) == 0 {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, nil, fmt.Errorf("Jev returned no decision: %w", ctxErr)
		}
		return nil, nil, errors.New("Jev returned no decision")
	}
	var usage *ports.RecommendationUsage
	if reported := envelope.Usage; reported != nil && reported.InputTokens != nil && reported.OutputTokens != nil {
		usage = &ports.RecommendationUsage{InputTokens: *reported.InputTokens, OutputTokens: *reported.OutputTokens}
	}
	return envelope.Answers, usage, nil
}
