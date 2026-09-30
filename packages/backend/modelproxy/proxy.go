package modelproxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptrace"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/modelprice"
)

// Callers authenticates a proxy request and names who pays for it.
// ErrUnauthenticated and ErrForbidden are answered as 401 and 403.
type Callers interface {
	ResolveModelCaller(r *http.Request) (Caller, error)
}

// OutOfCredit is the refusal code for a call the owner's credit cannot cover.
const OutOfCredit = "out_of_credit"

var (
	ErrUnauthenticated = errors.New("modelproxy: authentication required")
	ErrForbidden       = errors.New("modelproxy: credential may not spend platform models")
)

// Handler serves POST {Path}/{provider}/{inference path}.
type Handler struct {
	Meter   Meter
	Keys    Keys
	Callers Callers
	// Upstreams overrides a provider's origin (UpstreamsEnv).
	Upstreams map[string]string
	Client    *http.Client
	// MaxBodyBytes caps the request body; 0 means 16 MiB.
	MaxBodyBytes int64
}

const (
	defaultMaxBody  = 16 << 20
	maxResponseBody = 64 << 20
	upstreamTimeout = 15 * time.Minute
)

var defaultClient = &http.Client{
	Timeout: upstreamTimeout,
	// A redirect must never carry a platform key elsewhere.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest, ok := strings.CutPrefix(r.URL.Path, Path+"/")
	if !ok {
		rest, _ = strings.CutPrefix(r.URL.Path, APIPath+"/")
	}
	provider, path, _ := strings.Cut(rest, "/")
	path = strings.Trim(path, "/")
	rt, ok := routes[provider]
	if !ok || h.Keys == nil || !slices.Contains(h.Keys.PlatformModelProviders(), provider) {
		WriteError(w, provider, http.StatusNotFound, "not_found_error", "This provider is not offered on platform keys.")
		return
	}
	if r.Method != http.MethodPost || !slices.Contains(rt.paths, path) {
		WriteError(w, provider, http.StatusNotFound, "not_found_error", "Only POST "+strings.Join(rt.paths, ", ")+" is served.")
		return
	}
	resolveCaller := func() (Caller, bool) {
		caller, err := h.Callers.ResolveModelCaller(r)
		if err == nil {
			return caller, true
		}
		if errors.Is(err, ErrUnauthenticated) {
			WriteError(w, provider, http.StatusUnauthorized, "authentication_error", "Authentication required.")
			return Caller{}, false
		}
		if !errors.Is(err, ErrForbidden) {
			slog.Error("model proxy caller resolution failed", "provider", provider, "error", err)
		}
		WriteError(w, provider, http.StatusForbidden, "permission_error", "This credential may not spend platform models.")
		return Caller{}, false
	}
	// A refused credential never makes the proxy read a body.
	if _, ok := resolveCaller(); !ok {
		return
	}
	limit := h.MaxBodyBytes
	if limit <= 0 {
		limit = defaultMaxBody
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if int64(len(body)) > limit {
		slog.Warn("model proxy request body too large", "provider", provider, "path", path, "request_id", chimiddleware.GetReqID(r.Context()), "limit_bytes", limit)
		WriteError(w, provider, http.StatusRequestEntityTooLarge, "invalid_request_error", "Request body is too large.")
		return
	}
	if err != nil {
		// A stream the client or an edge proxy aborted, not an oversized one.
		slog.Warn("model proxy request body unreadable", "provider", provider, "path", path, "request_id", chimiddleware.GetReqID(r.Context()), "read_bytes", len(body), "error", err)
		WriteError(w, provider, http.StatusBadRequest, "invalid_request_error", "Request body could not be read.")
		return
	}
	parsed, err := parseRequest(provider, path, r.Header, body)
	if err != nil {
		var refused errRefused
		if errors.As(err, &refused) {
			WriteError(w, provider, http.StatusBadRequest, "invalid_request_error", refused.message)
			return
		}
		WriteError(w, provider, http.StatusBadRequest, "invalid_request_error", "Invalid request.")
		return
	}
	_, price, ok := Price(provider, parsed.model)
	if !ok {
		WriteError(w, provider, http.StatusBadRequest, "invalid_request_error", "Model "+parsed.model+" is not offered on platform keys.")
		return
	}
	if provider == ProviderOpenRouter {
		if parsed.body, err = withPriceCeiling(parsed.body, price); err != nil {
			WriteError(w, provider, http.StatusBadRequest, "invalid_request_error", "Invalid request.")
			return
		}
	}
	// The caller sets the body's pace, so the credential is resolved again
	// just before spending: a grant revoked meanwhile, such as a cancelled
	// chat turn, starts no provider call.
	caller, ok := resolveCaller()
	if !ok {
		return
	}
	call := Call{Provider: provider, Model: parsed.model, Stream: parsed.stream, Maximum: parsed.maximum(price)}
	answered := false
	_, err = h.Meter.Execute(r.Context(), caller, call, func(ctx context.Context) (Result, error) {
		answered = true
		return h.forward(ctx, w, r, provider, rt, path, parsed)
	})
	if answered {
		if err != nil && !errors.Is(err, credits.ErrOutcomeUnknown) && !errors.Is(err, ErrNotCharged) {
			slog.Warn("model proxy call finished with an error", "provider", provider, "model", parsed.model, "error", err)
		}
		return
	}
	switch {
	case errors.Is(err, credits.ErrInsufficient), errors.Is(err, credits.ErrSealed):
		WriteError(w, provider, http.StatusPaymentRequired, OutOfCredit, "Out of Smithers credit.")
	case errors.Is(err, ErrSpendCapReached):
		// The exhausted-quota shape parks the run; it retries hourly.
		w.Header().Set("Retry-After", SpendCapRetryAfter)
		WriteError(w, provider, http.StatusTooManyRequests, "insufficient_quota", "Platform model quota exceeded for today.")
	case errors.Is(err, ErrModelNotOffered):
		WriteError(w, provider, http.StatusBadRequest, "invalid_request_error", "Model "+parsed.model+" is not offered on platform keys.")
	default:
		slog.Error("model proxy reservation failed", "provider", provider, "model", parsed.model, "error", err)
		WriteError(w, provider, http.StatusServiceUnavailable, "api_error", "Model credit is unavailable.")
	}
}

// forward makes the one provider call and relays its answer. The upstream
// request is detached from the caller, so a caller that goes away still lets
// the call finish and report its usage.
func (h *Handler) forward(ctx context.Context, w http.ResponseWriter, r *http.Request, provider string, rt route, path string, parsed parsedCall) (Result, error) {
	key, err := h.Keys.PlatformModelKey(ctx, provider)
	if err != nil || !UsableKey(key) {
		WriteError(w, provider, http.StatusServiceUnavailable, "api_error", "This provider is not available.")
		return Result{Outcome: credits.ModelFailed}, errors.Join(ErrNotCharged, ErrKeyMissing)
	}
	upstream := rt.upstream
	if override, ok := h.Upstreams[provider]; ok {
		upstream = override
	}
	upstreamCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), upstreamTimeout)
	defer cancel()
	var written atomic.Bool
	upstreamCtx = httptrace.WithClientTrace(upstreamCtx, &httptrace.ClientTrace{
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err == nil {
				written.Store(true)
			}
		},
	})
	req, err := http.NewRequestWithContext(upstreamCtx, http.MethodPost, strings.TrimRight(upstream, "/")+"/"+path, bytes.NewReader(parsed.body))
	if err != nil {
		WriteError(w, provider, http.StatusInternalServerError, "api_error", "Model request could not be built.")
		return Result{Outcome: credits.ModelFailed}, ErrNotCharged
	}
	copyRequestHeaders(req.Header, r.Header)
	if provider == ProviderAnthropic {
		req.Header.Set("X-Api-Key", key)
		if req.Header.Get("Anthropic-Version") == "" {
			req.Header.Set("Anthropic-Version", "2023-06-01")
		}
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if provider == ProviderVercel {
		req.Header.Set("Ai-Gateway-Auth-Method", "api-key")
	}
	req.ContentLength = int64(len(parsed.body))
	client := h.Client
	if client == nil {
		client = defaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		WriteError(w, provider, http.StatusBadGateway, "api_error", "Model provider unreachable.")
		if written.Load() {
			// The provider may have received and run the call.
			return Result{Outcome: credits.ModelUnknown}, errors.New("modelproxy: provider connection failed after the request was sent")
		}
		return Result{Outcome: credits.ModelFailed}, ErrNotCharged
	}
	defer func() { _ = resp.Body.Close() }()
	copyResponseHeaders(w.Header(), resp.Header)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		outcome, err := credits.ModelFailed, error(ErrNotCharged)
		if refusedAfterRunning(resp.StatusCode) {
			// A gateway or timeout status can arrive after the model ran.
			outcome, err = credits.ModelUnknown, fmt.Errorf("modelproxy: provider answered HTTP %d", resp.StatusCode)
		}
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			// The provider's refusal of the platform key can quote part of it.
			WriteError(w, provider, http.StatusBadGateway, "api_error", "The provider refused the platform credential.")
			return Result{Outcome: outcome, Status: resp.StatusCode}, err
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, defaultMaxBody))
		if resp.StatusCode == http.StatusTooManyRequests && ProviderSpendCap(raw) {
			// The platform key's spend cap, not this caller's rate limit:
			// every caller is refused until the cap is raised. The provider's
			// body classifies it as an exhausted quota, so the run parks;
			// Retry-After re-checks hourly instead of waiting for the reset.
			slog.Error(spendCapLog, "provider", provider, "model", parsed.model)
			w.Header().Set("Retry-After", SpendCapRetryAfter)
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(raw)
		return Result{Outcome: outcome, Status: resp.StatusCode}, err
	}
	w.WriteHeader(resp.StatusCode)
	result := Result{Status: resp.StatusCode, Outcome: credits.ModelUnknown}
	if strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		usage, final := relayStream(w, resp.Body)
		if final {
			result.Outcome, result.Usage = credits.ModelSucceeded, usage
		}
		return result, nil
	}
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody+1))
	_, _ = w.Write(raw)
	if readErr != nil || len(raw) > maxResponseBody {
		return result, nil
	}
	if usage, ok := usageFromJSON(raw); ok {
		result.Outcome, result.Usage = credits.ModelSucceeded, usage
	}
	return result, nil
}

// SpendCapRetryAfter is how long a parked run waits before trying again:
// access returns when the cap is raised, at any time.
const SpendCapRetryAfter = "3600"

// ProviderSpendCap reports a 429 body that is an account-level spend cap:
// Anthropic's enforced_spend_limit_reached
// (https://platform.claude.com/docs/en/api/rate-limits) or OpenAI's
// insufficient_quota. Neither clears on retry.
func ProviderSpendCap(body []byte) bool {
	var doc struct {
		Error struct {
			Type    string `json:"type"`
			Code    any    `json:"code"`
			Details struct {
				ErrorCode string `json:"error_code"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &doc) != nil {
		return false
	}
	code, _ := doc.Error.Code.(string)
	return doc.Error.Details.ErrorCode == "enforced_spend_limit_reached" ||
		doc.Error.Type == "insufficient_quota" || code == "insufficient_quota"
}

// refusedAfterRunning reports a status that does not prove the provider
// skipped the call: a gateway, timeout or unclassified server error.
func refusedAfterRunning(status int) bool {
	switch status {
	case http.StatusRequestTimeout, 499, http.StatusBadGateway, http.StatusGatewayTimeout, 520, 522, 524:
		return true
	}
	return status >= 500 && status != http.StatusServiceUnavailable && status != 529 && status != http.StatusNotImplemented
}

// relayStream copies SSE lines to the caller as they arrive and reads the
// usage the provider reports. final is true only when the stream reached its
// terminal frame with usage: Anthropic message_stop, a Responses
// response.completed/incomplete/failed carrying usage, or Chat Completions
// [DONE] after a usage chunk. A caller that goes away does not stop the relay.
func relayStream(w http.ResponseWriter, body io.Reader) (usage modelprice.Usage, final bool) {
	flusher, _ := w.(http.Flusher)
	reader := bufio.NewReaderSize(body, 64<<10)
	known, terminal, clientGone := false, false, false
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if !clientGone {
				if _, writeErr := w.Write(line); writeErr != nil {
					clientGone = true
				} else if flusher != nil {
					flusher.Flush()
				}
			}
			payload := bytes.TrimSpace(line)
			if data, ok := bytes.CutPrefix(payload, []byte("data:")); ok {
				data = bytes.TrimSpace(data)
				switch {
				case bytes.Equal(data, []byte("[DONE]")):
					terminal = terminal || known
				case len(data) > 0 && data[0] == '{':
					if u, ok := usageFromJSON(data); ok {
						usage, known = mergeUsage(usage, u), true
					}
					var event struct {
						Type string `json:"type"`
					}
					if json.Unmarshal(data, &event) == nil {
						switch event.Type {
						case "message_stop", "response.completed", "response.incomplete", "response.failed":
							terminal = true
						case "error":
							terminal = false
						}
					}
				}
			}
		}
		if err != nil {
			return usage, known && terminal && errors.Is(err, io.EOF)
		}
	}
}

// copyRequestHeaders forwards the headers a provider reads and nothing that
// could carry the caller's Smithers credential.
func copyRequestHeaders(dst, src http.Header) {
	for _, name := range []string{"Content-Type", "Accept", "Anthropic-Version", "Anthropic-Beta", "OpenAI-Beta", "User-Agent",
		"Ai-Gateway-Protocol-Version", "Ai-Evaluation-Model-Specification-Version", "Ai-Model-Id"} {
		if value := src.Get(name); value != "" {
			dst.Set(name, value)
		}
	}
	if dst.Get("Content-Type") == "" {
		dst.Set("Content-Type", "application/json")
	}
}

func copyResponseHeaders(dst, src http.Header) {
	for _, name := range []string{"Content-Type", "Cache-Control", "Request-Id", "X-Request-Id", "Retry-After"} {
		if value := src.Get(name); value != "" {
			dst.Set(name, value)
		}
	}
}

// WriteError answers in the provider's own error shape so the caller's SDK
// classifies it.
func WriteError(w http.ResponseWriter, provider string, status int, kind, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(status)
	doc := map[string]any{"error": map[string]any{"type": kind, "message": message}}
	if provider == ProviderAnthropic {
		doc["type"] = "error"
	}
	if kind == OutOfCredit {
		// The app reads the refusal code at the top level (machineReadableRefusal).
		doc["code"] = OutOfCredit
	}
	_ = json.NewEncoder(w).Encode(doc)
}
