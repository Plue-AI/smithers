package routes

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

// The provider account pool route. Workspaces' and managed Flow hosts'
// (a box's coding host) model calls reach here (POST
// /provider-pool/chatgpt/codex/responses: connected Codex sign-ins; POST
// /provider-pool/anthropic/v1/messages: connected Anthropic API keys) with the
// workspace's pool credential or the host's model credential instead of a
// provider key; GET /provider-pool/routes tells the guest which routes have
// connected accounts right now. A Claude subscription is never pooled: it runs
// only on the user's own Claude Code (#2777). The handler
// asks the pool for the next account per request, and on a usage limit or a
// refused credential records it and tries the next account before anything
// reaches the caller. Provider tokens never leave this process.

// ProviderPool is the account pool (services.ProviderConnectionService).
type ProviderPool interface {
	PickForModelCall(ctx context.Context, userID, repositoryID int64, provider string, excluded []string) (services.ProviderPoolPick, error)
	MarkLimited(ctx context.Context, connectionID string, until time.Time) error
	MarkRejected(ctx context.Context, connectionID string, generation int64, reason string) error
	ForceRefresh(ctx context.Context, connectionID string) error
	HasPool(ctx context.Context, userID, repositoryID int64, provider string) (bool, error)
}

// ProviderPoolScopes binds an authenticated call to its pool's user and
// repository (services.ProviderPoolScopes).
type ProviderPoolScopes interface {
	Scope(ctx context.Context, bearer string) (userID, repositoryID int64, ok bool)
}

// ProviderPoolUses records which account took a workspace's model call
// (db.Queries.RecordWorkspaceProviderUse).
type ProviderPoolUses interface {
	RecordWorkspaceProviderUse(ctx context.Context, workspaceID, connectionID, model string) error
}

// ProviderPoolHandler serves /provider-pool/{provider}/{path}.
type ProviderPoolHandler struct {
	Pool   ProviderPool
	Scopes ProviderPoolScopes
	// Uses, when set, records the account each served call used, so the
	// monitor can say which account a workspace runs on.
	Uses ProviderPoolUses
	// recording bounds the records in flight; a record never delays a call.
	recording     chan struct{}
	recordingOnce sync.Once
	recorded      sync.WaitGroup
	// Upstreams overrides a provider's origin (tests).
	Upstreams map[string]string
	Client    *http.Client
	// MaxBodyBytes caps the request body; 0 means 16 MiB.
	MaxBodyBytes int64
}

const providerPoolDefaultMaxBody = 16 << 20

// ServeHTTP answers one model call from the caller's connected accounts.
func (h *ProviderPoolHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	provider, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, services.ProviderPoolPath+"/"), "/")
	if provider == "routes" && rest == "" && r.Method == http.MethodGet {
		h.serveRoutes(w, r)
		return
	}
	route, ok := modelPoolRoutes[provider]
	if !ok {
		writeModelPoolError(w, http.StatusNotFound, "not_found_error", "Unknown provider.", 0)
		return
	}
	if r.Method != http.MethodPost || strings.Trim(rest, "/") != route.path {
		writeModelPoolError(w, http.StatusNotFound, "not_found_error", "Only POST "+route.path+" is served.", 0)
		return
	}
	userID, repositoryID, ok := h.Scopes.Scope(r.Context(), poolBearer(r))
	if !ok {
		writeModelPoolError(w, http.StatusForbidden, "permission_error", "A pool credential is required.", 0)
		return
	}
	limit := h.MaxBodyBytes
	if limit <= 0 {
		limit = providerPoolDefaultMaxBody
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		writeModelPoolError(w, http.StatusRequestEntityTooLarge, "invalid_request_error", "Request body is too large.", 0)
		return
	}
	h.servePool(w, r, provider, route, body, userID, repositoryID)
}

// serveRoutes lists the routes with connected accounts in the caller's
// scope, limited or not: {"routes":["anthropic","chatgpt"]}. A guest asks
// when it resolves a seat, so an account connected after boot serves the next
// seat without a restart.
func (h *ProviderPoolHandler) serveRoutes(w http.ResponseWriter, r *http.Request) {
	userID, repositoryID, ok := h.Scopes.Scope(r.Context(), poolBearer(r))
	if !ok {
		writeModelPoolError(w, http.StatusForbidden, "permission_error", "A pool credential is required.", 0)
		return
	}
	routes := []string{}
	for name := range modelPoolRoutes {
		has, err := h.Pool.HasPool(r.Context(), userID, repositoryID, modelPoolRoutes[name].pool)
		if err != nil {
			slog.Error("provider pool routes failed", "repository_id", repositoryID, "error", err)
			writeModelPoolError(w, http.StatusBadGateway, "api_error", "Connected accounts are unavailable.", 0)
			return
		}
		if has {
			routes = append(routes, name)
		}
	}
	slices.Sort(routes)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string][]string{"routes": routes})
}

// modelPoolModelPattern bounds what is recorded as a call's model: a model
// id, never free text from the body.
var modelPoolModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)

// modelPoolModel reads the model a call names, or "" when it names none
// that looks like a model id.
func modelPoolModel(body []byte) string {
	var doc struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &doc) != nil || !modelPoolModelPattern.MatchString(doc.Model) {
		return ""
	}
	return doc.Model
}

const modelPoolRecordsInFlight = 64

// recordUse counts a call an account answered successfully, off the call's
// path: the relay never waits for it, and a failed or shed record never
// fails the call.
func (h *ProviderPoolHandler) recordUse(ctx context.Context, conn *services.ResolvedProviderConnection, status int, body []byte) {
	if h.Uses == nil || conn == nil || status < 200 || status > 299 {
		return
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.WorkspaceRestriction() == "" {
		return
	}
	h.recordingOnce.Do(func() { h.recording = make(chan struct{}, modelPoolRecordsInFlight) })
	select {
	case h.recording <- struct{}{}:
	default:
		slog.Warn("provider pool use not recorded: too many records in flight", "connection_id", conn.ConnectionID)
		return
	}
	workspaceID, connectionID, model := info.WorkspaceRestriction(), conn.ConnectionID, modelPoolModel(body)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	h.recorded.Add(1)
	go func() {
		defer func() { cancel(); <-h.recording; h.recorded.Done() }()
		if err := h.Uses.RecordWorkspaceProviderUse(ctx, workspaceID, connectionID, model); err != nil {
			slog.Warn("record provider pool use failed", "connection_id", connectionID, "error", err)
		}
	}()
}

// ProviderPoolAuth requires a bearer credential. A managed Flow host's model
// credential is verified by the scope; any other token goes through
// userAuth. A cookie alone never spends an account.
func ProviderPoolAuth(userAuth func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		user := userAuth(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if poolBearer(r) == "" {
				writeModelPoolError(w, http.StatusUnauthorized, "authentication_error", "Authentication required.", 0)
				return
			}
			r.Header.Del("Cookie")
			// userAuth reads bearer credentials only.
			if r.Header.Get("Authorization") == "" {
				r.Header.Set("Authorization", "Bearer "+poolBearer(r))
			}
			r.Header.Del("X-Api-Key")
			if strings.HasPrefix(poolBearer(r), flowhost.ModelCredentialPrefix) {
				next.ServeHTTP(w, r)
				return
			}
			user.ServeHTTP(w, r)
		})
	}
}

// poolBearer is the request's pool credential, or "": a bearer token, or the
// x-api-key header an Anthropic Messages client sends its key in.
func poolBearer(r *http.Request) string {
	scheme, token, _ := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	if strings.EqualFold(scheme, "bearer") {
		return strings.TrimSpace(token)
	}
	if r.Header.Get("Authorization") == "" {
		return strings.TrimSpace(r.Header.Get("X-Api-Key"))
	}
	return ""
}

const (
	modelPoolMaxAttempts  = 8
	modelPoolDefaultLimit = 5 * time.Minute
	modelPoolMinLimit     = 30 * time.Second
	modelPoolMaxLimit     = 7 * 24 * time.Hour
)

// modelPoolRoute is one proxied path that may draw on a pool: the pool's
// provider, the exact inference path, and the upstream origin.
type modelPoolRoute struct {
	pool     string
	path     string
	upstream string
}

var modelPoolRoutes = map[string]modelPoolRoute{
	"chatgpt":   {pool: services.ProviderConnectionProviderCodex, path: "codex/responses", upstream: "https://chatgpt.com/backend-api"},
	"anthropic": {pool: services.ProviderConnectionProviderClaude, path: "v1/messages", upstream: "https://api.anthropic.com"},
}

var modelPoolClient = &http.Client{
	Timeout: 15 * time.Minute,
	// A provider redirect must never carry an account credential elsewhere.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// servePool answers the call from the pool, trying accounts until one
// takes it or none is left.
func (h *ProviderPoolHandler) servePool(w http.ResponseWriter, r *http.Request, provider string, route modelPoolRoute, body []byte, userID, repositoryID int64) {
	ctx := r.Context()
	var tried []string
	refreshed := map[string]bool{}
	var pick services.ProviderPoolPick
	for attempt := 0; attempt < modelPoolMaxAttempts; attempt++ {
		var err error
		pick, err = h.Pool.PickForModelCall(ctx, userID, repositoryID, route.pool, tried)
		if err != nil {
			slog.Error("provider pool pick failed", "provider", route.pool, "repository_id", repositoryID, "error", err)
			writeModelPoolError(w, http.StatusBadGateway, "api_error", "Connected accounts are unavailable.", 0)
			return
		}
		if !pick.Pooled {
			writeModelPoolError(w, http.StatusNotFound, "not_found_error", "No connected account serves this repository.", 0)
			return
		}
		conn := pick.Connection
		if conn == nil {
			break
		}
		tried = append(tried, conn.ConnectionID)
		resp, err := h.sendPooled(ctx, provider, route, r.Header, body, conn)
		if err != nil {
			// The request may have reached the provider; retrying could
			// duplicate a generation.
			writeModelPoolError(w, http.StatusBadGateway, "api_error", "Model provider unreachable.", 0)
			return
		}
		switch {
		case resp.StatusCode == http.StatusTooManyRequests:
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			_ = resp.Body.Close()
			until := modelPoolLimitReset(resp.Header, raw, time.Now())
			if modelproxy.ProviderSpendCap(raw) {
				// A spend cap names no reset and clears only when the key's
				// owner raises it: re-check it as the model proxy does.
				until = modelPoolLimitReset(http.Header{"Retry-After": {modelproxy.SpendCapRetryAfter}}, nil, time.Now())
			}
			if err := h.Pool.MarkLimited(context.WithoutCancel(ctx), conn.ConnectionID, until); err != nil {
				slog.Warn("mark provider connection limited failed", "connection_id", conn.ConnectionID, "error", err)
			}
			continue
		case resp.StatusCode == http.StatusUnauthorized:
			_ = resp.Body.Close()
			// A refused Codex token is refreshed once and the account tried
			// again; an API key, or a token refused again after its refresh,
			// needs a new sign-in.
			if conn.HasRefreshToken && !refreshed[conn.ConnectionID] && h.Pool.ForceRefresh(context.WithoutCancel(ctx), conn.ConnectionID) == nil {
				refreshed[conn.ConnectionID] = true
				tried = tried[:len(tried)-1]
				continue
			}
			if err := h.Pool.MarkRejected(context.WithoutCancel(ctx), conn.ConnectionID, conn.RefreshGeneration, "provider refused the credential (401)"); err != nil {
				slog.Warn("mark provider connection rejected failed", "connection_id", conn.ConnectionID, "error", err)
			}
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if meter, ok := h.Pool.(interface {
				RecordUsage(context.Context, string, http.Header) error
			}); ok {
				if err := meter.RecordUsage(ctx, conn.ConnectionID, resp.Header); err != nil {
					slog.Error("record provider usage failed", "connection_id", conn.ConnectionID, "error", err)
				}
			}
		}
		h.recordUse(ctx, conn, resp.StatusCode, body)
		h.relayPooled(ctx, w, resp, conn)
		return
	}
	writeModelPoolExhausted(w, pick)
}

func (h *ProviderPoolHandler) sendPooled(ctx context.Context, provider string, route modelPoolRoute, in http.Header, body []byte, conn *services.ResolvedProviderConnection) (*http.Response, error) {
	upstream := route.upstream
	if override, ok := h.Upstreams[provider]; ok {
		upstream = override
	}
	out := http.Header{}
	copyProviderPoolHeaders(out, in)
	if route.pool == services.ProviderConnectionProviderClaude {
		// A claude connection is an Anthropic API key (#2777).
		// Anthropic reads every anthropic-beta header a client repeats.
		for _, name := range []string{"Anthropic-Version", "Anthropic-Beta"} {
			if values := in.Values(name); len(values) > 0 {
				out[name] = slices.Clone(values)
			}
		}
		out.Set("X-Api-Key", conn.AccessToken)
	} else {
		for _, name := range []string{"Originator", "Session_id", "Version", "Conversation_id"} {
			if value := in.Get(name); value != "" {
				out.Set(name, value)
			}
		}
		out.Set("Authorization", "Bearer "+conn.AccessToken)
		out.Set("Chatgpt-Account-Id", conn.AccountID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(upstream, "/")+"/"+route.path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = out
	req.ContentLength = int64(len(body))
	client := h.Client
	if client == nil {
		client = modelPoolClient
	}
	return client.Do(req)
}

// relayPooled streams the provider's answer to the caller. A usage limit
// reported inside an already-started stream cannot be retried (the caller
// has seen output), but the account is still parked for later requests.
func (h *ProviderPoolHandler) relayPooled(ctx context.Context, w http.ResponseWriter, resp *http.Response, conn *services.ResolvedProviderConnection) {
	defer func() { _ = resp.Body.Close() }()
	copyProviderPoolResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		_, _ = io.Copy(w, io.LimitReader(resp.Body, providerPoolDefaultMaxBody))
		return
	}
	flusher, _ := w.(http.Flusher)
	reader := bufio.NewReaderSize(resp.Body, 64<<10)
	limited := false
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if _, writeErr := w.Write(line); writeErr == nil && flusher != nil {
				flusher.Flush()
			}
			if !limited && modelPoolStreamLimit(line) {
				limited = true
				payload := bytes.TrimSpace(bytes.TrimPrefix(bytes.TrimSpace(line), []byte("data:")))
				until := modelPoolLimitReset(resp.Header, payload, time.Now())
				if markErr := h.Pool.MarkLimited(context.WithoutCancel(ctx), conn.ConnectionID, until); markErr != nil {
					slog.Warn("mark provider connection limited failed", "connection_id", conn.ConnectionID, "error", markErr)
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// modelPoolStreamLimit reports an SSE data line that ends the stream on a
// usage or rate limit: the Responses `response.failed` / `error` events.
func modelPoolStreamLimit(line []byte) bool {
	payload := bytes.TrimSpace(line)
	if !bytes.HasPrefix(payload, []byte("data:")) {
		return false
	}
	payload = bytes.TrimSpace(payload[len("data:"):])
	if !bytes.Contains(payload, []byte("limit")) {
		return false
	}
	var event struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return false
	}
	if event.Type != "error" && event.Type != "response.failed" {
		return false
	}
	return bytes.Contains(payload, []byte("rate_limit")) || bytes.Contains(payload, []byte("usage_limit"))
}

// modelPoolLimitReset reads when a limited account resets: an explicit
// reset in the body (Codex resets_at / resets_in_seconds) or Retry-After;
// otherwise a short default. Clamped so a bad
// value neither hammers the account nor parks it for good.
func modelPoolLimitReset(header http.Header, body []byte, now time.Time) time.Time {
	var reset time.Time
	var doc struct {
		Error struct {
			ResetsAt        json.Number `json:"resets_at"`
			ResetsInSeconds json.Number `json:"resets_in_seconds"`
		} `json:"error"`
		Response struct {
			Error struct {
				ResetsAt        json.Number `json:"resets_at"`
				ResetsInSeconds json.Number `json:"resets_in_seconds"`
			} `json:"error"`
		} `json:"response"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if decoder.Decode(&doc) == nil {
		for _, pair := range [][2]json.Number{{doc.Error.ResetsAt, doc.Error.ResetsInSeconds}, {doc.Response.Error.ResetsAt, doc.Response.Error.ResetsInSeconds}} {
			if at, err := pair[0].Float64(); err == nil && at > 0 {
				reset = time.Unix(int64(at), 0)
				break
			}
			if in, err := pair[1].Float64(); err == nil && in > 0 {
				reset = now.Add(time.Duration(in) * time.Second)
				break
			}
		}
	}
	if reset.IsZero() {
		if value := strings.TrimSpace(header.Get("Retry-After")); value != "" {
			if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
				reset = now.Add(time.Duration(seconds) * time.Second)
			} else if at, err := http.ParseTime(value); err == nil {
				reset = at
			}
		}
	}
	if reset.IsZero() {
		reset = now.Add(modelPoolDefaultLimit)
	}
	if reset.Before(now.Add(modelPoolMinLimit)) {
		reset = now.Add(modelPoolMinLimit)
	}
	if reset.After(now.Add(modelPoolMaxLimit)) {
		reset = now.Add(modelPoolMaxLimit)
	}
	return reset
}

// writeModelPoolError answers in the Responses error shape so the caller's
// SDK classifies it (rate limit, authentication, not found).
func writeModelPoolError(w http.ResponseWriter, status int, kind, message string, retryAfter time.Duration) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Round(time.Second)/time.Second)))
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": kind, "message": message}})
}

// writeModelPoolExhausted answers when no account of the pool can take the
// call: all parked on usage limits (429 until the earliest reset), all
// needing a new sign-in (401), or every account tried for this call (503).
func writeModelPoolExhausted(w http.ResponseWriter, pick services.ProviderPoolPick) {
	now := time.Now()
	switch {
	case pick.Pooled && pick.Reconnect:
		writeModelPoolError(w, http.StatusUnauthorized, "authentication_error", "Every connected account needs a reconnect.", 0)
	case !pick.NextReset.IsZero() && pick.NextReset.After(now):
		writeModelPoolError(w, http.StatusTooManyRequests, "usage_limit_reached", "Every connected account is at its usage limit.", pick.NextReset.Sub(now))
	default:
		writeModelPoolError(w, http.StatusServiceUnavailable, "overloaded_error", "No connected account could take the request.", 30*time.Second)
	}
}

// copyProviderPoolHeaders forwards the request headers a provider reads and
// nothing that could carry the caller's Smithers credential.
func copyProviderPoolHeaders(dst, src http.Header) {
	for _, name := range []string{"Content-Type", "Accept", "OpenAI-Beta", "User-Agent"} {
		if value := src.Get(name); value != "" {
			dst.Set(name, value)
		}
	}
	if dst.Get("Content-Type") == "" {
		dst.Set("Content-Type", "application/json")
	}
}

func copyProviderPoolResponseHeaders(dst, src http.Header) {
	for _, name := range []string{"Content-Type", "Cache-Control", "Request-Id", "X-Request-Id", "Retry-After"} {
		if value := src.Get(name); value != "" {
			dst.Set(name, value)
		}
	}
}
