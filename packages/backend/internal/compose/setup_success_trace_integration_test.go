package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// Exercises successful setup through the real install router, PostgreSQL,
// GitHub fake and native repository engine. The existing rehearsal's image
// adapter executes no recipe: this is trace evidence, not VM qualification.
func TestInstallSuccessfulSetupSecretTracePostgres(t *testing.T) {
	if os.Getenv("SMITHERS_FFI_LIBRARY_PATH") == "" || os.Getenv("SMITHERS_TEST_DATABASE_URL") == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH and SMITHERS_TEST_DATABASE_URL required for native setup trace capture")
	}
	t.Setenv("SMITHERS_SETUP_TRACE_INTEGRATION", "1")
	t.Setenv("J1_REHEARSAL_CONTINUE", "")
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter), sdktrace.WithSampler(sdktrace.AlwaysSample()))
	var r *rehearsal
	var mintLine string
	capture := &setupSuccessCapture{}
	capture.secrets.Store("rehearsal-key", true)
	// Registered before the composition so its shutdown drains logs first.
	t.Cleanup(func() {
		if r == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		require.NoError(t, provider.ForceFlush(ctx))
		spans := exporter.GetSpans()
		observed := map[string]bool{}
		browserSignInRefused := false
		for _, span := range spans {
			method, path, status := "", "", int64(0)
			for _, attribute := range span.Attributes {
				value := attribute.Value.Emit()
				switch attribute.Key {
				case "http.request.method", "http.method":
					method = value
				case "url.path", "url.full", "http.target", "http.url":
					if u, err := url.Parse(value); err == nil {
						path = u.Path
					}
				case "http.response.status_code", "http.status_code":
					status = attribute.Value.AsInt64()
				}
			}
			if method == "POST" && path == "/api/install/setup/sign_in" && status == http.StatusConflict {
				browserSignInRefused = true
			}
			if status >= 200 && status < 400 {
				observed[method+" "+path] = true
			}
		}
		for _, request := range []string{
			"GET /setup", "GET /api/install", "PUT /api/install", "GET /api/status",
			"POST /api/install/setup/address", "POST /api/install/setup/app", "GET /setup/github/callback",
			"GET /api/auth/github", "GET /api/auth/github/callback",
			"POST /api/install/setup/repository", "POST /api/install/setup/models",
			"POST /api/install/setup/source", "POST /api/install/setup/machine",
		} {
			require.True(t, observed[request], "missing successful exported span for %s", request)
		}
		require.True(t, browserSignInRefused, "the sign-in step must export its browser-door refusal")
		output := r.stdout.String()
		require.True(t, strings.HasPrefix(output, mintLine), "mint byte range changed")
		ordinary := strings.TrimPrefix(output, mintLine)
		// Serialize the complete exported spans, including status descriptions,
		// resource attributes and links, rather than scanning only route attributes.
		exportedTrace, err := json.Marshal(spans)
		require.NoError(t, err)
		surfaces := []string{ordinary, r.logs.String(), capture.body.String(), string(exportedTrace)}
		count := 0
		capture.secrets.Range(func(key, _ any) bool {
			count++
			secret := key.(string)
			for _, surface := range surfaces {
				require.False(t, strings.Contains(surface, secret) || strings.Contains(surface, url.QueryEscape(secret)), "setup credential leaked outside its delivery surface")
			}
			return true
		})
		require.GreaterOrEqual(t, count, 3, "scan requires setup token, setup cookie and provider key")
		// Preserve the captured surfaces, never the allowed credential deliveries.
		evidence, err := json.MarshalIndent(map[string]any{
			"scope":             "successful composed setup; test image adapter, not microVM qualification",
			"successful_routes": observed, "credentials_scanned": count,
			"ordinary_stdout": ordinary, "backend_logs": r.logs.String(),
			"http_responses": capture.body.String(), "exported_trace": json.RawMessage(exportedTrace),
			"mint_line": "<redacted>",
		}, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "secret-trace.json"), append([]byte(capture.redact(string(evidence))), '\n'), 0600))
		require.NoError(t, provider.Shutdown(ctx))
	})

	// Redact durable diagnostic files even when a missing span or a leak fails
	// the assertions. The in-memory captures above retain the original bytes.
	t.Cleanup(func() {
		if r == nil {
			return
		}
		for _, pattern := range []string{"*.log", "*.json", "*.tsv"} {
			paths, err := filepath.Glob(filepath.Join(r.evidence, pattern))
			require.NoError(t, err)
			for _, path := range paths {
				raw, err := os.ReadFile(path)
				require.NoError(t, err)
				redacted := capture.redact(string(raw))
				require.NoError(t, os.WriteFile(path, []byte(redacted), 0600))
			}
		}
	})
	r = newRehearsal(t, "SMITHERS_SETUP_TRACE_INTEGRATION", "C-SEC-04", "setup-trace-")
	mintLine = r.stdout.String()
	require.True(t, strings.HasSuffix(mintLine, "\n"))
	var mint struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal([]byte(mintLine), &mint))
	require.NotEmpty(t, mint.URLs)
	for _, raw := range mint.URLs {
		u, err := url.Parse(raw)
		require.NoError(t, err)
		token := u.Query().Get("token")
		require.NotEmpty(t, token)
		capture.secrets.Store(token, true)
	}
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous) })
	r.client.Transport = capture
	require.True(t, r.setupSource(), "setup must reach Source ready through HTTP")
	require.True(t, r.setupMachine(), "setup must reach Machine ready through HTTP")
	_, err := r.expect("PUT", "/api/install", `{"chatgpt":false}`, http.StatusOK)
	require.NoError(t, err)
	// A new sign-in request after setup is refused. It needs its own key: the
	// setup walk sent sign_in under the path's key, and a replay returns the
	// first admission's receipt before readiness checks (9e9493943c).
	code, data, err := r.keyed("POST", "/api/install/setup/sign_in", `{}`, r.keyPrefix+"sign-in-after-setup")
	require.NoError(t, err)
	require.Equal(t, http.StatusConflict, code, string(data))
	_, err = r.expect("GET", "/api/status", "", http.StatusOK)
	require.NoError(t, err)
}

type setupSuccessCapture struct {
	body       lockedBuffer
	secrets    sync.Map
	deliveries sync.Map
}

func (c *setupSuccessCapture) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := http.DefaultTransport.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	// Personal token delivery is an intentional body surface in the existing
	// Source helper; retain its behavior but never persist that credential.
	if request.URL.Path == "/api/user/tokens" {
		var credential struct {
			Token string `json:"token"`
		}
		if json.Unmarshal(body, &credential) == nil && credential.Token != "" {
			c.deliveries.Store(credential.Token, true)
		}
	}
	c.body.Write(body)
	for _, cookie := range response.Cookies() {
		if cookie.Value != "" {
			c.deliveries.Store(cookie.Value, true)
		}
		if cookie.Name == "smithers_setup_session" && cookie.Value != "" {
			c.secrets.Store(cookie.Value, true)
		}
	}
	for name, values := range response.Header {
		if strings.EqualFold(name, "Set-Cookie") {
			continue
		}
		for _, value := range values {
			c.body.Write([]byte(name + ": " + value + "\n"))
		}
	}
	return response, nil
}

func (c *setupSuccessCapture) redact(value string) string {
	for _, inventory := range []*sync.Map{&c.secrets, &c.deliveries} {
		inventory.Range(func(key, _ any) bool {
			secret := key.(string)
			value = strings.ReplaceAll(value, secret, "<redacted>")
			value = strings.ReplaceAll(value, url.QueryEscape(secret), "<redacted>")
			return true
		})
	}
	return value
}
