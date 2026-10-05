package modelhost

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/ports"
)

func TestProviderStandInAcceptsOnlyAnHTTPLoopbackOrigin(t *testing.T) {
	for raw, want := range map[string]providerStandIn{
		"":                        "",
		"  ":                      "",
		"http://127.0.0.1:47400":  "http://127.0.0.1:47400",
		"http://127.0.0.1:47400/": "http://127.0.0.1:47400",
		" http://localhost:9 ":    "http://localhost:9",
		"http://[::1]:47400":      "http://[::1]:47400",
		"http://127.3.2.1:1":      "http://127.3.2.1:1",
	} {
		got, err := parseProviderStandIn(raw)
		require.NoError(t, err, raw)
		assert.Equal(t, want, got, raw)
	}
	for _, raw := range []string{
		"https://127.0.0.1:47400",      // the stand-in serves plain http
		"http://127.0.0.1",             // no port
		"http://10.0.0.5:47400",        // not this machine
		"http://example.test:47400",    // a name that may resolve anywhere
		"http://127.0.0.1.nip.io:4740", // a loopback-looking name
		"http://127.0.0.1:47400/v1",    // a path
		"http://u:p@127.0.0.1:47400",   // userinfo
		"http://127.0.0.1:47400?x=1",   // query
		"http://127.0.0.1:47400#x",     // fragment
		"127.0.0.1:47400",              // no scheme
		"http://127.0.0.1:47400 x",
	} {
		_, err := parseProviderStandIn(raw)
		assert.ErrorContains(t, err, ProviderStandInVariable, raw)
	}
}

func TestProviderStandInRoutesBuiltInsAndKeepsEverythingElse(t *testing.T) {
	origin := providerStandIn("http://127.0.0.1:47400")
	request := json.RawMessage(`{"model":{"id":"jev","protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"},"input":{"q":1}}`)
	binding := Binding{Model: json.RawMessage(`{"protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}`),
		CredentialName: "AI_GATEWAY_API_KEY", CredentialValue: "sk-value"}

	routed, body, err := origin.route(binding, request)
	require.NoError(t, err)
	assert.Equal(t, "STANDIN_AI_GATEWAY_API_KEY", routed.CredentialName)
	assert.Equal(t, "http://127.0.0.1:47400", routed.CredentialOrigin)
	assert.Equal(t, "sk-value", routed.CredentialValue)
	assert.JSONEq(t, `{"protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"STANDIN_AI_GATEWAY_API_KEY","baseUrl":"http://127.0.0.1:47400"}`, string(routed.Model))
	assert.JSONEq(t, `{"model":{"id":"jev","protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"STANDIN_AI_GATEWAY_API_KEY","baseUrl":"http://127.0.0.1:47400"},"input":{"q":1}}`, string(body))
	// The launch environment pins the renamed key to the stand-in alone.
	environment, err := credentialEnvironment(routed)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"SMITHERS_MODEL_KEY_STANDIN_AI_GATEWAY_API_KEY": "sk-value",
		"SMITHERS_MODEL_KEY_STANDIN_AI_GATEWAY_API_KEY_ORIGIN": "http://127.0.0.1:47400"}, environment)

	// A base URL keeps its path on the stand-in's origin.
	for base, want := range map[string]string{
		"https://api.cerebras.ai":    "http://127.0.0.1:47400",
		"https://openrouter.ai/api/": "http://127.0.0.1:47400/api",
	} {
		model, err := origin.model(json.RawMessage(`{"protocol":"openai-chat","modelId":"m","credential":"CEREBRAS_API_KEY","baseUrl":"` + base + `"}`))
		require.NoError(t, err)
		assert.JSONEq(t, `{"protocol":"openai-chat","modelId":"m","credential":"STANDIN_CEREBRAS_API_KEY","baseUrl":"`+want+`"}`, string(model), base)
	}

	// A turn that names no model plans the binding alone.
	_, body, err = origin.route(binding, json.RawMessage(`{"model":null,"repositoryId":3}`))
	require.NoError(t, err)
	assert.JSONEq(t, `{"model":null,"repositoryId":3}`, string(body))
	_, body, err = origin.route(binding, json.RawMessage(`{"repositoryId":3}`))
	require.NoError(t, err)
	assert.JSONEq(t, `{"repositoryId":3}`, string(body))

	custom := Binding{Model: json.RawMessage(`{"protocol":"openai-chat","modelId":"m","credential":"LOCAL_KEY","baseUrl":"http://127.0.0.1:9"}`),
		CredentialName: "LOCAL_KEY", CredentialOrigin: "http://127.0.0.1:9", CredentialValue: "v"}
	managed := binding
	managed.Managed = true
	for name, kept := range map[string]Binding{"custom credential": custom, "managed credit": managed} {
		routed, body, err := origin.route(kept, request)
		require.NoError(t, err)
		assert.Equal(t, kept, routed, name)
		assert.Equal(t, string(request), string(body), name)
	}
	routed, body, err = providerStandIn("").route(binding, request)
	require.NoError(t, err)
	assert.Equal(t, binding, routed)
	assert.Equal(t, string(request), string(body))

	_, _, err = origin.route(Binding{Model: json.RawMessage(`{"protocol":"openai-chat","modelId":"m","credential":"OPENAI_API_KEY","baseUrl":"http://[::1"}`),
		CredentialName: "OPENAI_API_KEY", CredentialValue: "v"}, request)
	assert.ErrorContains(t, err, "base URL")
}

type bindingLauncher struct {
	lease   Lease
	binding *Binding
}

func (launcher bindingLauncher) LaunchChatHost(_ context.Context, _ ports.ChatTurnGrant, binding Binding) (Lease, error) {
	*launcher.binding = binding
	return launcher.lease, nil
}

// The packaged host plans both the launch binding and the test's record, so
// both reach it on the stand-in, and the result comes back unchanged.
func TestModelTestRunsOnTheProviderStandIn(t *testing.T) {
	var private []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		private, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"ok":true,"latencyMs":3}`))
	}))
	defer server.Close()
	var launched Binding
	resolver := ResolverFunc(func(_ context.Context, _, _ int64, request json.RawMessage) (Binding, error) {
		var input struct{ Model json.RawMessage }
		require.NoError(t, json.Unmarshal(request, &input))
		return Binding{Model: input.Model, CredentialName: "ANTHROPIC_API_KEY", CredentialValue: "sk-ant"}, nil
	})
	host, err := New(resolver, bindingLauncher{lease: &testLease{origin: server.URL}, binding: &launched}, WithProviderStandIn("http://localhost:47400"))
	require.NoError(t, err)
	result, err := host.RunModelTest(context.Background(), 7, json.RawMessage(`{"model":{"id":"coding","protocol":"anthropic-messages","modelId":"m","credential":"ANTHROPIC_API_KEY"}}`))
	require.NoError(t, err)
	assert.JSONEq(t, `{"ok":true,"latencyMs":3}`, string(result))
	assert.Equal(t, "STANDIN_ANTHROPIC_API_KEY", launched.CredentialName)
	assert.Equal(t, "http://localhost:47400", launched.CredentialOrigin)
	assert.JSONEq(t, `{"model":{"id":"coding","protocol":"anthropic-messages","modelId":"m","credential":"STANDIN_ANTHROPIC_API_KEY","baseUrl":"http://localhost:47400"}}`, string(private))

	_, err = New(resolver, bindingLauncher{binding: &launched}, WithProviderStandIn("https://api.anthropic.com"))
	assert.ErrorContains(t, err, ProviderStandInVariable)
}

// The coding host reaches providers only through the model proxy, so the
// stand-in is every proxied provider's upstream as well.
func TestProviderStandInIsEveryProxiedProvidersUpstream(t *testing.T) {
	upstreams, err := ProviderStandInUpstreams("http://127.0.0.1:47400/")
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"anthropic": "http://127.0.0.1:47400", "openai": "http://127.0.0.1:47400", "cerebras": "http://127.0.0.1:47400",
		"openrouter": "http://127.0.0.1:47400", "vercel": "http://127.0.0.1:47400"}, upstreams)
	upstreams, err = ProviderStandInUpstreams("")
	require.NoError(t, err)
	assert.Nil(t, upstreams)
	_, err = ProviderStandInUpstreams("https://ai-gateway.vercel.sh")
	assert.ErrorContains(t, err, ProviderStandInVariable)
}
