package modelproxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/modelprice"
)

const FastGatewayPath = "/api/fast-model"
const InstallHeader = "X-Smithers-Install-ID"

// FastGateway is the hosted, card-free Cerebras path. It never admits coding
// or Decisions providers and reuses the proxy's bounded request and relay.
type FastGateway struct {
	Quota    credits.FastQuota
	Keys     Keys
	Upstream string
	Client   *http.Client
	// Models restricts the gateway to the deployment's fast-model seats.
	Models []string
}

func (g *FastGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	install := r.Header.Get(InstallHeader)
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		WriteError(w, ProviderCerebras, 401, "authentication_error", "Invalid install credential.")
		return
	}
	if install == "" {
		var err error
		install, err = g.Quota.ResolveInstall(r.Context(), token)
		if err != nil {
			if errors.Is(err, credits.ErrInstallCredential) {
				WriteError(w, ProviderCerebras, 401, "authentication_error", "Invalid install credential.")
			} else {
				WriteError(w, ProviderCerebras, 503, "api_error", "Fast model unavailable.")
			}
			return
		}
	}
	if err := g.Quota.Verify(r.Context(), install, token); err != nil {
		if errors.Is(err, credits.ErrInstallCredential) {
			WriteError(w, ProviderCerebras, 401, "authentication_error", "Invalid install credential.")
		} else {
			WriteError(w, ProviderCerebras, 503, "api_error", "Fast model unavailable.")
		}
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == FastGatewayPath+"/quota" {
		remaining, err := g.Quota.Remaining(r.Context(), install, token)
		if err != nil {
			WriteError(w, ProviderCerebras, 503, "api_error", "Fast model unavailable.")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"remaining_tokens": remaining, "daily_tokens": g.Quota.Limit(), "reset_at": g.Quota.ResetAt()})
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != FastGatewayPath+"/v1/chat/completions" {
		WriteError(w, ProviderCerebras, 404, "not_found_error", "Unknown fast-model route.")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, defaultMaxBody+1))
	if err != nil || len(body) > defaultMaxBody {
		WriteError(w, ProviderCerebras, 400, "invalid_request_error", "Invalid request.")
		return
	}
	parsed, err := parseRequest(ProviderCerebras, "v1/chat/completions", r.Header, body)
	if err != nil {
		WriteError(w, ProviderCerebras, 400, "invalid_request_error", "Invalid request.")
		return
	}
	models := g.Models
	if len(models) == 0 {
		models = []string{"gpt-oss-120b"}
	}
	offered := false
	for _, model := range models {
		offered = offered || parsed.model == model
	}
	if !offered {
		WriteError(w, ProviderCerebras, 400, "invalid_request_error", "Fast model is not offered.")
		return
	}
	maximum := parsed.maximum(modelprice.Price{})
	bound := maximum.PromptTokens() + maximum.OutputTokens
	answered := false
	err = g.Quota.Execute(r.Context(), install, token, bound, func() (int64, bool, error) {
		// Resolve once so the same value is used for forwarding and redaction.
		if g.Keys == nil {
			return 0, true, ErrKeyMissing
		}
		key, keyErr := g.Keys.PlatformModelKey(r.Context(), ProviderCerebras)
		if keyErr != nil || !UsableKey(key) {
			return 0, true, ErrKeyMissing
		}
		client := defaultClient
		if g.Client != nil {
			cloned := *g.Client
			cloned.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			client = &cloned
		}
		proxy := Handler{Keys: StaticKeys{ProviderCerebras: key}, Client: client}
		if g.Upstream != "" {
			proxy.Upstreams = map[string]string{ProviderCerebras: g.Upstream}
		}
		safe := &secretWriter{ResponseWriter: w, secret: []byte(key)}
		answered = true
		result, forwardErr := proxy.forward(r.Context(), safe, r, ProviderCerebras, routes[ProviderCerebras], "v1/chat/completions", parsed)
		safe.finish()
		switch result.Outcome {
		case credits.ModelSucceeded:
			return result.Usage.PromptTokens() + result.Usage.OutputTokens, true, forwardErr
		case credits.ModelFailed:
			return 0, true, forwardErr
		default:
			return 0, false, forwardErr
		}
	})
	if answered {
		return
	}
	switch {
	case errors.Is(err, credits.ErrInstallCredential):
		WriteError(w, ProviderCerebras, 401, "authentication_error", "Invalid install credential.")
	case errors.Is(err, credits.ErrFastCapacity):
		reset := g.Quota.ResetAt()
		w.Header().Set("Retry-After", strconv.FormatInt(int64(reset.Sub(g.Quota.CurrentTime()).Seconds())+1, 10))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": "capacity", "code": "capacity", "message": "Daily Smithers quota used.", "reset_at": reset}})
	default:
		WriteError(w, ProviderCerebras, 503, "api_error", "Fast model unavailable.")
	}
}

// secretWriter holds only a key-sized tail so a provider cannot echo the key,
// even split across SSE frames or writes. It does not persist response content.
type secretWriter struct {
	http.ResponseWriter
	secret, tail []byte
}

func (w *secretWriter) WriteHeader(status int) {
	for name, values := range w.Header() {
		for i, value := range values {
			values[i] = strings.ReplaceAll(value, string(w.secret), "[redacted]")
		}
		w.Header()[name] = values
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *secretWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.tail = append(w.tail, p...)
	w.tail = bytes.ReplaceAll(w.tail, w.secret, []byte("[redacted]"))
	keep := len(w.secret) - 1
	if len(w.tail) > keep {
		cut := len(w.tail) - keep
		_, err := w.ResponseWriter.Write(w.tail[:cut])
		w.tail = append([]byte(nil), w.tail[cut:]...)
		if err != nil {
			return 0, err
		}
	}
	return n, nil
}
func (w *secretWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *secretWriter) finish() { _, _ = w.ResponseWriter.Write(w.tail); w.tail = nil; w.Flush() }
