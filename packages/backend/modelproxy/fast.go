package modelproxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// InstallFastSource is the host-only install source. The proxy reads its credential
// just before transport; neither a binding nor a caller can retrieve it.
type InstallFastSource struct {
	Origin     string
	InstallID  string
	Credential func(context.Context) (string, error)
	Observe    func(context.Context, FastStatus) error
	Selected   func(context.Context, int) error
	Status     func(context.Context) (FastStatus, error)
}
type FastCause string

const (
	FastCapacity    FastCause = "capacity"
	FastUnreachable FastCause = "unreachable"
	FastRefused     FastCause = "refused"
)

type FastStatus struct {
	Cause     FastCause
	Remaining *int64
	ResetAt   string
}

const FastPath = Path + "/fast/v1/chat/completions"

func (h *Handler) serveFast(w http.ResponseWriter, r *http.Request) {
	caller, err := h.Callers.ResolveModelCaller(r)
	if err != nil || caller.Source != SourceApp {
		WriteError(w, ProviderCerebras, 403, "permission_error", "Host fast-model access required.")
		return
	}
	if r.URL.Path == Path+"/fast/selected" {
		var input struct {
			Index int `json:"index"`
		}
		if r.Method != "POST" || json.NewDecoder(io.LimitReader(r.Body, 256)).Decode(&input) != nil || input.Index < 1 || input.Index > 2 {
			WriteError(w, ProviderCerebras, 400, "invalid_request_error", "Invalid source.")
			return
		}
		if h.Fast.Selected != nil {
			_ = h.Fast.Selected(r.Context(), input.Index)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != "POST" {
		WriteError(w, ProviderCerebras, 404, "not_found_error", "Only POST is served.")
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
	credential, err := h.Fast.Credential(r.Context())
	if err != nil || credential == "" {
		WriteError(w, ProviderCerebras, 401, "authentication_error", "Smithers sign-in unavailable.")
		return
	}
	if h.Fast.Status != nil {
		if status, statusErr := h.Fast.Status(r.Context()); statusErr == nil && status.Cause == "capacity" {
			if reset, parseErr := time.Parse(time.RFC3339, status.ResetAt); parseErr == nil && time.Now().Before(reset) {
				WriteError(w, ProviderCerebras, 429, "insufficient_quota", "Daily Smithers quota used.")
				return
			}
		}
	}
	client := &http.Client{Timeout: 8 * time.Second}
	if h.Client != nil {
		*client = *h.Client
		client.Timeout = 8 * time.Second
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = fastTransport{base: transport, observe: h.Fast.Observe, install: h.Fast.InstallID}
	r = r.Clone(r.Context())
	r.Header = r.Header.Clone()
	r.Header.Set(InstallHeader, h.Fast.InstallID)
	forward := *h
	forward.Keys = StaticKeys{ProviderCerebras: credential}
	forward.Client = client
	forward.Upstreams = map[string]string{ProviderCerebras: strings.TrimRight(h.Fast.Origin, "/") + FastGatewayPath}
	safe := &secretWriter{ResponseWriter: w, secret: []byte(credential)}
	_, _ = forward.forward(r.Context(), safe, r, ProviderCerebras, routes[ProviderCerebras], "v1/chat/completions", parsed)
	safe.finish()
}

type fastTransport struct {
	install string
	base    http.RoundTripper
	observe func(context.Context, FastStatus) error
}

func (t fastTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.Header.Set(InstallHeader, t.install)
	res, err := t.base.RoundTrip(req)
	status := FastStatus{}
	if err != nil {
		status.Cause = "unreachable"
	} else {
		switch {
		case res.StatusCode == 401 || res.StatusCode == 403:
			status.Cause = "refused"
		case res.StatusCode == 429:
			status.Cause = "capacity"
		case res.StatusCode < 200 || res.StatusCode >= 300:
			status.Cause = "unreachable"
		}
		status.ResetAt = res.Header.Get("Smithers-Quota-Reset")
		if remaining := res.Header.Get("Smithers-Quota-Remaining"); remaining != "" {
			var value int64
			if json.Unmarshal([]byte(remaining), &value) == nil && value >= 0 {
				status.Remaining = &value
			}
		}
		if status.Cause != "" {
			// Gateway refusals are typed, content-free errors. Never relay upstream
			// prose, which can contain a reflected credential or prompt.
			var refusal struct {
				Code      string `json:"code"`
				ResetAt   string `json:"reset_at"`
				Remaining *int64 `json:"remaining"`
				Error     struct {
					Code    string `json:"code"`
					ResetAt string `json:"reset_at"`
				} `json:"error"`
			}
			_ = json.NewDecoder(io.LimitReader(res.Body, 16<<10)).Decode(&refusal)
			_ = res.Body.Close()
			if refusal.Code == "capacity" || refusal.Error.Code == "capacity" {
				status.Cause = "capacity"
				res.StatusCode = 429
			}
			if refusal.ResetAt != "" {
				status.ResetAt = refusal.ResetAt
			} else if refusal.Error.ResetAt != "" {
				status.ResetAt = refusal.Error.ResetAt
			}
			if refusal.Remaining != nil {
				status.Remaining = refusal.Remaining
			}
			code := "api_error"
			if status.Cause == "capacity" {
				code = "insufficient_quota"
			} else if status.Cause == "refused" {
				code = "authentication_error"
			}
			clean, _ := json.Marshal(map[string]any{"error": map[string]string{"type": code, "code": code, "message": "Smithers fast model " + string(status.Cause)}})
			res.Body = io.NopCloser(strings.NewReader(string(clean)))
			res.ContentLength = int64(len(clean))
			res.Header.Set("Content-Type", "application/json")
			res.Header.Del("Content-Length")
		}
	}
	if err == nil && res.StatusCode >= 200 && res.StatusCode < 300 {
		responseBody := res.Body
		res.Body = &fastQuotaBody{ReadCloser: responseBody, refresh: func() {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(req.Context()), 2*time.Second)
			defer cancel()
			quotaReq, _ := http.NewRequestWithContext(ctx, "GET", strings.TrimSuffix(req.URL.String(), "/v1/chat/completions")+"/quota", nil)
			quotaReq.Header.Set("Authorization", req.Header.Get("Authorization"))
			quotaReq.Header.Set(InstallHeader, t.install)
			quota, quotaErr := t.base.RoundTrip(quotaReq)
			if quotaErr != nil {
				return
			}
			defer quota.Body.Close()
			var counts struct {
				Remaining int64  `json:"remaining_tokens"`
				ResetAt   string `json:"reset_at"`
			}
			if quota.StatusCode == 200 && json.NewDecoder(io.LimitReader(quota.Body, 4096)).Decode(&counts) == nil && counts.Remaining >= 0 {
				if t.observe != nil {
					_ = t.observe(ctx, FastStatus{Remaining: &counts.Remaining, ResetAt: counts.ResetAt})
				}
			}
		}}
	}
	if t.observe != nil {
		_ = t.observe(context.WithoutCancel(req.Context()), status)
	}
	return res, err
}

type fastQuotaBody struct {
	io.ReadCloser
	refresh func()
}

func (b *fastQuotaBody) Close() error { err := b.ReadCloser.Close(); b.refresh(); return err }
