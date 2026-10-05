package modelproxy

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/modelprice"
)

// route is one provider the proxy fronts: its upstream origin and the exact
// inference paths it forwards.
type route struct {
	upstream string
	paths    []string
}

var routes = map[string]route{
	ProviderAnthropic:  {"https://api.anthropic.com", []string{"v1/messages"}},
	ProviderOpenAI:     {"https://api.openai.com", []string{"v1/responses", "v1/chat/completions"}},
	ProviderCerebras:   {"https://api.cerebras.ai", []string{"v1/chat/completions"}},
	ProviderOpenRouter: {"https://openrouter.ai/api", []string{"v1/responses", "v1/chat/completions"}},
	// Chat completions on the Gateway are priced by no platform row, so only
	// an owner-paid proxy (Handler.OwnerPaid) forwards them.
	ProviderVercel: {"https://ai-gateway.vercel.sh", []string{jevPath, "v1/chat/completions"}},
}

// jevPath is the Gateway's evaluation model path.
const jevPath = "v4/ai/evaluation-model"

// JevModel is the Vercel AI Gateway evaluation model, named by the
// ai-model-id header rather than the body.
const JevModel = "typesafe-ai/jev"

// JevMaxRequestTokens is the gateway's limit on one Jev request, state and
// questions together (https://ai-gateway.vercel.sh/v1/models). Jev is priced
// per input token and its output is free, so this is the call's bound.
const JevMaxRequestTokens = 64_000

// JevMaximum is the dearest usage one Jev call can report: its rate card has
// one input rate for every cache class.
var JevMaximum = modelprice.Usage{InputTokens: JevMaxRequestTokens}

const (
	// inputAllowance covers tokens a provider adds beyond the request text:
	// message framing and the tool-use system prompt.
	inputAllowance = 4096
	// DefaultOutputCap is sent as the output ceiling when an OpenAI-family
	// request names none, so the provider enforces the reserved bound.
	DefaultOutputCap = 32768
	maxChoices       = 16
)

// errRefused is a request the proxy will not forward; the message is safe
// to return to the caller.
type errRefused struct{ message string }

func (e errRefused) Error() string { return e.message }

func refuse(message string) error { return errRefused{message} }

// parsedCall is a request ready to meter and forward.
type parsedCall struct {
	body    []byte
	model   string
	stream  bool
	maximum func(modelprice.Price) modelprice.Usage
}

const (
	// imageAllowance bounds one inline image: its token cost follows its
	// pixel size, not its encoded size. Providers downscale larger images.
	imageAllowance = 12_000
)

// refusedFields change the price or pull in input the request does not
// contain, so the bound would not hold.
var refusedFields = []string{
	"previous_response_id", "conversation", "prompt", "background", // provider-held context
	"mcp_servers", "container", // provider-side tool execution
	"audio", "modalities", // audio is priced separately
	"models", "plugins", "route", // OpenRouter fallbacks and paid plugins
	"inference_geo",
}

// parseRequest reads what metering needs, refuses what cannot be bounded
// from the request, and returns the body to forward: with an output ceiling
// the provider enforces, a usage report requested on streamed chat
// completions, and on OpenRouter a price ceiling at the reserved rate.
func parseRequest(provider, path string, header http.Header, body []byte) (parsedCall, error) {
	if provider == ProviderVercel && path == jevPath {
		if strings.TrimSpace(header.Get("Ai-Model-Id")) != JevModel {
			return parsedCall{}, refuse("ai-model-id must be " + JevModel)
		}
		if !json.Valid(body) {
			return parsedCall{}, refuse("request body must be JSON")
		}
		return parsedCall{body: body, model: JevModel, maximum: func(modelprice.Price) modelprice.Usage { return JevMaximum }}, nil
	}
	if provider == ProviderAnthropic && strings.Contains(strings.ToLower(header.Get("Anthropic-Beta")), "context-1m") {
		return parsedCall{}, refuse("the long-context beta is not offered on platform keys")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return parsedCall{}, refuse("request body must be a JSON object")
	}
	call := parsedCall{}
	if raw, ok := fields["model"]; !ok || json.Unmarshal(raw, &call.model) != nil || strings.TrimSpace(call.model) == "" || len(call.model) > 200 {
		return parsedCall{}, refuse("model is required")
	}
	if provider == ProviderOpenRouter && strings.Contains(call.model, ":") {
		return parsedCall{}, refuse("model variants are not offered on platform keys")
	}
	if raw, ok := fields["stream"]; ok && !isEmptyJSON(raw) && json.Unmarshal(raw, &call.stream) != nil {
		return parsedCall{}, refuse("stream must be a boolean")
	}
	for _, name := range refusedFields {
		if raw, ok := fields[name]; ok && !isEmptyJSON(raw) && string(raw) != "false" {
			return parsedCall{}, refuse(name + " is not offered on platform keys")
		}
	}
	if err := checkTier(fields); err != nil {
		return parsedCall{}, err
	}
	var document any
	if err := json.Unmarshal(body, &document); err != nil {
		return parsedCall{}, refuse("request body must be a JSON object")
	}
	content := contentScan{provider: provider}
	if err := content.check(document); err != nil {
		return parsedCall{}, err
	}
	if err := checkTools(fields["tools"]); err != nil {
		return parsedCall{}, err
	}
	if path == "v1/responses" {
		if err := checkStoredItems(fields); err != nil {
			return parsedCall{}, err
		}
	}
	honored := honoredOutputCaps(provider, path)
	output, present, err := outputCap(fields, honored)
	if err != nil {
		return parsedCall{}, err
	}
	changed := false
	if !present {
		if provider == ProviderAnthropic {
			return parsedCall{}, refuse("max_tokens is required")
		}
		fields[honored[0]], _ = json.Marshal(DefaultOutputCap)
		output, changed = DefaultOutputCap, true
	}
	choices := int64(1)
	if raw, ok := fields["n"]; ok && !isEmptyJSON(raw) {
		if json.Unmarshal(raw, &choices) != nil || choices < 1 || choices > maxChoices {
			return parsedCall{}, refuse("n must be an integer from 1 to 16")
		}
	}
	if output > math.MaxInt64/choices {
		return parsedCall{}, refuse("combined output token limit is too large")
	}
	if call.stream && path == "v1/chat/completions" {
		options := map[string]json.RawMessage{}
		if raw, ok := fields["stream_options"]; ok && !isEmptyJSON(raw) {
			if json.Unmarshal(raw, &options) != nil {
				return parsedCall{}, refuse("stream_options must be an object")
			}
		}
		options["include_usage"] = json.RawMessage("true")
		fields["stream_options"], _ = json.Marshal(options)
		changed = true
	}
	call.body = body
	if changed {
		if call.body, err = json.Marshal(fields); err != nil {
			return parsedCall{}, refuse("request body could not be encoded")
		}
	}
	input := int64(len(call.body)) + inputAllowance + int64(content.images)*imageAllowance
	outputTotal := output * choices
	call.maximum = func(price modelprice.Price) modelprice.Usage {
		// The rate card follows the prompt bound, so a prompt that can
		// cross a long-context threshold is reserved at the long rates.
		// Only a request that asks for the 1-hour cache can be billed for it.
		if !content.oneHour {
			price.CacheWrite1hPerMTok, price.LongContext.CacheWrite1hPerMTok = 0, 0
		}
		return price.Maximum(input, outputTotal)
	}
	return call, nil
}

// withPriceCeiling asks OpenRouter to route only to providers at or below the
// reserved rate, so its per-provider pricing cannot exceed the bound.
func withPriceCeiling(body []byte, price modelprice.Price) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	options := map[string]json.RawMessage{}
	if raw, ok := fields["provider"]; ok && !isEmptyJSON(raw) {
		if json.Unmarshal(raw, &options) != nil {
			return nil, refuse("provider must be an object")
		}
	}
	perMillion := func(micro int64) json.Number {
		return json.Number(strconv.FormatFloat(float64(micro)/1_000_000, 'f', -1, 64))
	}
	options["max_price"], _ = json.Marshal(map[string]json.Number{
		"prompt": perMillion(price.InputPerMTok), "completion": perMillion(price.OutputPerMTok),
		"request": "0", "image": "0",
	})
	fields["provider"], _ = json.Marshal(options)
	return json.Marshal(fields)
}

// checkTier refuses priced service modifiers the table does not carry.
func checkTier(fields map[string]json.RawMessage) error {
	allowed := map[string][]string{
		"service_tier": {"auto", "default", "flex", "standard_only"},
		"speed":        {"standard"},
	}
	for name, values := range allowed {
		raw, ok := fields[name]
		if !ok || isEmptyJSON(raw) {
			continue
		}
		var value string
		if json.Unmarshal(raw, &value) != nil || !slices.Contains(values, value) {
			return refuse(name + " " + strings.TrimSpace(string(raw)) + " is not offered on platform keys")
		}
	}
	return nil
}

// honoredOutputCaps lists the output ceiling fields the upstream enforces on
// a path; the first is the one the proxy adds when the request names none.
func honoredOutputCaps(provider, path string) []string {
	switch {
	case provider == ProviderAnthropic:
		return []string{"max_tokens"}
	case path == "v1/responses":
		return []string{"max_output_tokens"}
	case provider == ProviderOpenAI || provider == ProviderCerebras:
		return []string{"max_completion_tokens", "max_tokens"}
	default:
		return []string{"max_tokens", "max_completion_tokens"}
	}
}

// outputCap reads the largest output ceiling the request names. Only a
// ceiling in a honored field bounds the output: the upstream ignores the
// others and would generate up to the model's full output.
func outputCap(fields map[string]json.RawMessage, honored []string) (int64, bool, error) {
	var largest int64
	present := false
	for _, name := range []string{"max_tokens", "max_output_tokens", "max_completion_tokens"} {
		raw, ok := fields[name]
		if !ok || isEmptyJSON(raw) {
			continue
		}
		var n int64
		if json.Unmarshal(raw, &n) != nil || n <= 0 {
			return 0, false, refuse(name + " must be a positive integer")
		}
		present = present || slices.Contains(honored, name)
		largest = max(largest, n)
	}
	return largest, present, nil
}

// serverTools run on the provider: they are charged outside token usage or
// add input the request size does not bound.
var serverTools = []string{"web_search", "web_fetch", "code_execution", "code_interpreter", "file_search", "image_generation", "mcp", "tool_search"}

func checkTools(raw json.RawMessage) error {
	if isEmptyJSON(raw) {
		return nil
	}
	var tools []map[string]json.RawMessage
	if json.Unmarshal(raw, &tools) != nil {
		return refuse("tools must be an array of objects")
	}
	for _, tool := range tools {
		var kind string
		if raw, ok := tool["type"]; ok {
			_ = json.Unmarshal(raw, &kind)
		}
		for _, prefix := range serverTools {
			if strings.HasPrefix(kind, prefix) {
				return refuse("tool " + kind + " is not offered on platform keys")
			}
		}
	}
	return nil
}

// checkStoredItems refuses Responses input items whose content the provider
// loads by ID, which the request size does not bound: item references, and
// reasoning without its encrypted content unless the request opts out of
// storage.
func checkStoredItems(fields map[string]json.RawMessage) error {
	var items []map[string]json.RawMessage
	if raw := fields["input"]; isEmptyJSON(raw) || json.Unmarshal(raw, &items) != nil {
		return nil
	}
	stored := string(fields["store"]) != "false"
	for _, item := range items {
		var kind string
		if raw, ok := item["type"]; ok {
			_ = json.Unmarshal(raw, &kind)
		}
		id, role := !isEmptyJSON(item["id"]), !isEmptyJSON(item["role"])
		content, encrypted := !isEmptyJSON(item["content"]), !isEmptyJSON(item["encrypted_content"])
		if kind == "item_reference" || (kind == "" && id && !role && !content) || (kind == "reasoning" && id && !encrypted && stored) {
			return refuse("stored items are not offered on platform keys")
		}
	}
	return nil
}

var dataFields = []string{"input_schema", "parameters", "schema", "json_schema", "metadata", "format", "arguments"}

// contentScan refuses content whose tokens the request size does not bound
// (anything fetched by reference, PDFs, audio) or whose cache lifetime the
// provider's usage report does not price, and counts inline images, which are
// bounded per image. Only Anthropic reports 1-hour cache writes separately.
type contentScan struct {
	provider string
	images   int
	oneHour  bool
}

func (c *contentScan) check(value any) error {
	switch v := value.(type) {
	case map[string]any:
		for _, name := range []string{"file_id", "file_url", "file_data"} {
			if s, ok := v[name].(string); ok && s != "" {
				return refuse("files are not offered on platform keys")
			}
		}
		kind, _ := v["type"].(string)
		switch kind {
		case "url", "file", "input_file", "input_audio", "audio", "video", "video_url", "input_video", "container_upload":
			return refuse("content of type " + kind + " is not offered on platform keys")
		case "document":
			if source, _ := v["source"].(map[string]any); source != nil {
				if sourceType, _ := source["type"].(string); sourceType != "text" && sourceType != "content" {
					return refuse("documents are offered on platform keys as text only")
				}
			}
		case "image", "image_url", "input_image":
			c.images++
		}
		if control, ok := v["cache_control"].(map[string]any); ok {
			ttl, _ := control["ttl"].(string)
			if ttl != "" && ttl != "5m" && (ttl != "1h" || c.provider != ProviderAnthropic) {
				return refuse("cache lifetime " + ttl + " is not offered on platform keys")
			}
			c.oneHour = c.oneHour || ttl == "1h"
		}
		if _, ok := v["video_url"]; ok {
			return refuse("video is not offered on platform keys")
		}
		switch image := v["image_url"].(type) {
		case string:
			if !strings.HasPrefix(image, "data:") {
				return refuse("images by URL are not offered on platform keys")
			}
		case map[string]any:
			if url, _ := image["url"].(string); !strings.HasPrefix(url, "data:") {
				return refuse("images by URL are not offered on platform keys")
			}
		}
		for name, child := range v {
			// Schemas and a model's own tool arguments are data, not content.
			if slices.Contains(dataFields, name) || (name == "input" && strings.HasSuffix(kind, "tool_use")) {
				continue
			}
			if err := c.check(child); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range v {
			if err := c.check(child); err != nil {
				return err
			}
		}
	}
	return nil
}

func isEmptyJSON(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s == "" || s == "null"
}

var errUsageMissing = errors.New("usage missing")

// usageFromJSON finds a usage object at the top level, under "message"
// (Anthropic message_start) or under "response" (Responses events).
func usageFromJSON(raw []byte) (modelprice.Usage, bool) {
	var doc struct {
		Usage   json.RawMessage `json:"usage"`
		Message struct {
			Usage json.RawMessage `json:"usage"`
		} `json:"message"`
		Response struct {
			Usage json.RawMessage `json:"usage"`
		} `json:"response"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return modelprice.Usage{}, false
	}
	for _, candidate := range []json.RawMessage{doc.Usage, doc.Message.Usage, doc.Response.Usage} {
		if usage, err := decodeUsage(candidate); err == nil {
			return usage, true
		}
	}
	return modelprice.Usage{}, false
}

func decodeUsage(raw json.RawMessage) (modelprice.Usage, error) {
	if isEmptyJSON(raw) {
		return modelprice.Usage{}, errUsageMissing
	}
	var u struct {
		InputTokens       *int64 `json:"input_tokens"`
		OutputTokens      *int64 `json:"output_tokens"`
		InputTokensCamel  *int64 `json:"inputTokens"`
		OutputTokensCamel *int64 `json:"outputTokens"`
		PromptTokens      *int64 `json:"prompt_tokens"`
		CompletionTokens  *int64 `json:"completion_tokens"`
		CacheRead         *int64 `json:"cache_read_input_tokens"`
		CacheWrite        *int64 `json:"cache_creation_input_tokens"`
		CacheCreation     struct {
			FiveMinute *int64 `json:"ephemeral_5m_input_tokens"`
			OneHour    *int64 `json:"ephemeral_1h_input_tokens"`
		} `json:"cache_creation"`
		PromptDetails struct {
			Cached     *int64 `json:"cached_tokens"`
			CacheWrite *int64 `json:"cache_write_tokens"`
		} `json:"prompt_tokens_details"`
		InputDetails struct {
			Cached     *int64 `json:"cached_tokens"`
			CacheWrite *int64 `json:"cache_write_tokens"`
		} `json:"input_tokens_details"`
	}
	if err := json.Unmarshal(raw, &u); err != nil {
		return modelprice.Usage{}, err
	}
	out := modelprice.Usage{}
	found := false
	pick := func(dst *int64, values ...*int64) {
		for _, v := range values {
			if v != nil {
				*dst = *v
				found = true
				return
			}
		}
	}
	// The Vercel AI Gateway evaluation model reports camelCase counts.
	pick(&out.InputTokens, u.InputTokens, u.PromptTokens, u.InputTokensCamel)
	pick(&out.OutputTokens, u.OutputTokens, u.CompletionTokens, u.OutputTokensCamel)
	pick(&out.CacheReadTokens, u.CacheRead, u.PromptDetails.Cached, u.InputDetails.Cached)
	pick(&out.CacheWriteTokens, u.CacheWrite, u.PromptDetails.CacheWrite, u.InputDetails.CacheWrite)
	// Anthropic's cache_creation_input_tokens counts both cache lifetimes;
	// cache_creation splits them. A total below its parts is raised to them;
	// a negative or overflowing split is marked invalid so it is never priced.
	var fiveMinute int64
	pick(&fiveMinute, u.CacheCreation.FiveMinute)
	pick(&out.CacheWrite1hTokens, u.CacheCreation.OneHour)
	switch {
	case fiveMinute < 0 || out.CacheWrite1hTokens < 0 || fiveMinute > math.MaxInt64-out.CacheWrite1hTokens:
		out.CacheWriteTokens = -1
	case out.CacheWriteTokens < fiveMinute+out.CacheWrite1hTokens:
		out.CacheWriteTokens = fiveMinute + out.CacheWrite1hTokens
	}
	if !found {
		return modelprice.Usage{}, errUsageMissing
	}
	// OpenAI counts cached tokens inside prompt_tokens (Chat) and
	// input_tokens (Responses); Anthropic reports them separately.
	if u.CacheRead == nil && (u.PromptDetails.Cached != nil || u.InputDetails.Cached != nil) && out.InputTokens >= out.CacheReadTokens {
		out.InputTokens -= out.CacheReadTokens
	}
	// OpenAI (GPT-5.6 and later) and OpenRouter count cache writes inside
	// input_tokens / prompt_tokens too.
	if u.CacheWrite == nil && (u.PromptDetails.CacheWrite != nil || u.InputDetails.CacheWrite != nil) && out.InputTokens >= out.CacheWriteTokens {
		out.InputTokens -= out.CacheWriteTokens
	}
	return out, nil
}

// mergeUsage keeps the largest value per field: Anthropic streams report
// input on message_start and cumulative output on every message_delta. A
// negative (invalid) value is kept, so the merged usage is never priced.
func mergeUsage(a, b modelprice.Usage) modelprice.Usage {
	merge := func(x, y int64) int64 {
		if x < 0 || y < 0 {
			return min(x, y)
		}
		return max(x, y)
	}
	return modelprice.Usage{
		InputTokens:        merge(a.InputTokens, b.InputTokens),
		OutputTokens:       merge(a.OutputTokens, b.OutputTokens),
		CacheReadTokens:    merge(a.CacheReadTokens, b.CacheReadTokens),
		CacheWriteTokens:   merge(a.CacheWriteTokens, b.CacheWriteTokens),
		CacheWrite1hTokens: merge(a.CacheWrite1hTokens, b.CacheWrite1hTokens),
	}
}
