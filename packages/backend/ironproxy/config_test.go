package ironproxy

import (
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestRenderEmitsRealIronProxySchema(t *testing.T) {
	t.Parallel()
	payload, err := RenderYAML(Spec{
		ListenAddr: "127.0.0.1:41000", HTTPListen: "127.0.0.1:42000", HTTPSListen: "127.0.0.1:43000", MetricsListen: "127.0.0.1:44000",
		CACertPath: "/run/egress/ca.crt",
		CAKeyPath:  "/run/egress/ca.key",
		Secrets: []SecretBinding{{
			EnvVar: "ANTHROPIC_API_KEY", Hosts: []string{"api.anthropic.com"},
			MatchHeaders: []string{"x-api-key", "authorization"}, Require: true,
		}},
	})
	require.NoError(t, err)

	// Decode generically so the assertions are about the wire schema
	// iron-proxy parses, not about our Go structs.
	var decoded map[string]any
	require.NoError(t, yaml.Unmarshal(payload, &decoded))

	dns := decoded["dns"].(map[string]any)
	assert.Equal(t, false, dns["enabled"], "explicit-proxy mode never runs DNS interception")

	proxy := decoded["proxy"].(map[string]any)
	assert.Equal(t, "127.0.0.1:41000", proxy["tunnel_listen"])
	assert.Equal(t, "127.0.0.1:42000", proxy["http_listen"], "the transparent listeners never fall back to :80")
	assert.Equal(t, "127.0.0.1:43000", proxy["https_listen"], "the transparent listeners never fall back to :443")
	assert.Equal(t, map[string]any{"listen": "127.0.0.1:44000"}, decoded["metrics"], "metrics never falls back to the worker's :9090")
	assert.Equal(t, defaultMaxRequestBodyBytes, proxy["max_request_body_bytes"])
	assert.Equal(t, "10m", proxy["upstream_response_header_timeout"])
	deny := proxy["upstream_deny_cidrs"].([]any)
	for _, required := range []string{
		"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16",
		"0.0.0.0/8", "127.0.0.0/8", "::1/128", "fe80::/10", "fc00::/7", "::ffff:0.0.0.0/96",
	} {
		assert.Contains(t, deny, required, "upstream deny list must cover %s", required)
	}

	tlsConfig := decoded["tls"].(map[string]any)
	assert.Equal(t, "mitm", tlsConfig["mode"])
	assert.Equal(t, "/run/egress/ca.crt", tlsConfig["ca_cert"])
	assert.Equal(t, "/run/egress/ca.key", tlsConfig["ca_key"])

	transforms := decoded["transforms"].([]any)
	require.Len(t, transforms, 2, "transforms is an ordered list of {name, config}")
	allowlist := transforms[0].(map[string]any)
	assert.Equal(t, "allowlist", allowlist["name"])
	assert.Equal(t, []any{"*"}, allowlist["config"].(map[string]any)["domains"])

	secrets := transforms[1].(map[string]any)
	assert.Equal(t, "secrets", secrets["name"])
	entries := secrets["config"].(map[string]any)["secrets"].([]any)
	require.Len(t, entries, 1)
	entry := entries[0].(map[string]any)
	assert.Equal(t, map[string]any{"type": "env", "var": "ANTHROPIC_API_KEY"}, entry["source"])
	replace := entry["replace"].(map[string]any)
	assert.Equal(t, "ANTHROPIC_API_KEY", replace["proxy_value"], "placeholder defaults to NAME so the guest carries NAME=NAME")
	assert.Equal(t, []any{"Authorization", "X-Api-Key"}, replace["match_headers"])
	assert.Equal(t, true, replace["require"])
	assert.Nil(t, replace["match_query"], "query scanning stays off unless bound")
	assert.Equal(t, []any{map[string]any{"host": "api.anthropic.com"}}, entry["rules"])

	assert.NotContains(t, string(payload), "sk-ant-", "a rendered config never carries a value")
}

func TestRenderFailsClosedOnUnenforceableBindings(t *testing.T) {
	t.Parallel()
	base := Spec{ListenAddr: "127.0.0.1:1", HTTPListen: "127.0.0.1:2", HTTPSListen: "127.0.0.1:3", MetricsListen: "127.0.0.1:4", CACertPath: "/c", CAKeyPath: "/k"}
	missingCA := base
	missingCA.CACertPath, missingCA.CAKeyPath = "", ""
	cases := map[string]struct {
		spec  Spec
		cause string
	}{
		"missing listener":      {Spec{CACertPath: "/c", CAKeyPath: "/k"}, "listen address is required"},
		"listener without port": {Spec{ListenAddr: "127.0.0.1", CACertPath: "/c", CAKeyPath: "/k"}, `listen address "127.0.0.1"`},
		"missing CA":            {missingCA, "CA certificate and key paths are required"},
		"blank env var":         {withSecrets(base, SecretBinding{Hosts: []string{"a.example"}, MatchHeaders: []string{"authorization"}}), "secret binding env var is required"},
		"no host":               {withSecrets(base, SecretBinding{EnvVar: "K", MatchHeaders: []string{"authorization"}}), "secret K has no host binding"},
		"no location":           {withSecrets(base, SecretBinding{EnvVar: "K", Hosts: []string{"a.example"}}), "secret K has no match location"},
		"placeholder collision": {withSecrets(base,
			SecretBinding{EnvVar: "A", ProxyValue: "same", Hosts: []string{"a.example"}, MatchHeaders: []string{"h"}},
			SecretBinding{EnvVar: "B", ProxyValue: "same", Hosts: []string{"b.example"}, MatchHeaders: []string{"h"}},
		), `placeholder "same" bound to both A and B`},
		"wildcard secret host": {withSecrets(base, SecretBinding{EnvVar: "K", Hosts: []string{"a.example", "*.ngrok-free.app"}, MatchHeaders: []string{"h"}}), `secret K host "*.ngrok-free.app" is not one exact host name`},
		"cidr secret host":     {withSecrets(base, SecretBinding{EnvVar: "K", Hosts: []string{"127.0.0.0/8"}, MatchHeaders: []string{"h"}}), `secret K host "127.0.0.0/8" is not one exact host name`},
		"single-address cidr":  {withSecrets(base, SecretBinding{EnvVar: "K", Hosts: []string{"10.0.0.1/32"}, MatchHeaders: []string{"h"}}), `secret K host "10.0.0.1/32" is not one exact host name`},
		"bad deny cidr":        {Spec{ListenAddr: "127.0.0.1:1", HTTPListen: "127.0.0.1:2", HTTPSListen: "127.0.0.1:3", MetricsListen: "127.0.0.1:4", CACertPath: "/c", CAKeyPath: "/k", UpstreamDenyCIDRs: []string{"10.0.0.1"}}, `upstream deny cidr "10.0.0.1"`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Render(tc.spec)
			require.ErrorIs(t, err, ErrInvalidSpec)
			assert.ErrorContains(t, err, tc.cause)
		})
	}
}

func withSecrets(spec Spec, bindings ...SecretBinding) Spec {
	spec.Secrets = bindings
	return spec
}

func TestRenderSupportsCIDRAllowlistAndExactSecretHosts(t *testing.T) {
	t.Parallel()
	config, err := Render(Spec{
		ListenAddr: "127.0.0.1:1", HTTPListen: "127.0.0.1:2", HTTPSListen: "127.0.0.1:3", MetricsListen: "127.0.0.1:4", CACertPath: "/c", CAKeyPath: "/k",
		AllowDomains:      []string{"api.openai.com", " api.openai.com ", "*.anthropic.com"},
		AllowCIDRs:        []string{"127.0.0.0/8"},
		UpstreamDenyCIDRs: []string{},
		Secrets:           []SecretBinding{{EnvVar: "TOKEN", Hosts: []string{"127.0.0.1", "Example.test", "0:0::1"}, MatchQuery: true}},
	})
	require.NoError(t, err)
	allowlist := config.Transforms[0].Config.(AllowlistConfig)
	assert.Equal(t, []string{"*.anthropic.com", "api.openai.com"}, allowlist.Domains, "deduplicated and sorted")
	assert.Equal(t, []string{"127.0.0.0/8"}, allowlist.CIDRs)
	assert.Empty(t, config.Proxy.UpstreamDenyCIDRs, "an explicit empty override is honored for tests")
	entry := config.Transforms[1].Config.(SecretsConfig).Secrets[0]
	assert.Equal(t, []SecretRule{{Host: "::1"}, {Host: "127.0.0.1"}, {Host: "example.test"}}, entry.Rules, "one exact host each, address literals canonical")
	assert.Equal(t, []string{}, entry.Replace.MatchHeaders, "query-only bindings emit an explicit empty header list")
	assert.True(t, entry.Replace.MatchQuery)
}

func TestGuestEnvRoutesEveryToolchainThroughTheProxy(t *testing.T) {
	t.Parallel()
	env := GuestEnv(GuestProxyURL(41000), "/etc/smithers/egress-ca.pem")
	assert.Equal(t, "http://host.microsandbox.internal:41000", env["HTTPS_PROXY"])
	assert.Equal(t, env["HTTPS_PROXY"], env["https_proxy"])
	assert.Equal(t, env["HTTP_PROXY"], env["http_proxy"])
	assert.Equal(t, "1", env["NODE_USE_ENV_PROXY"])
	for _, name := range []string{"SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "GIT_SSL_CAINFO"} {
		assert.Equal(t, "/etc/smithers/egress-ca.pem", env[name], name)
	}
	assert.True(t, strings.Contains(env["NO_PROXY"], "host.microsandbox.internal"), "the sandbox host alias stays direct")
	assert.Equal(t, env["NO_PROXY"], env["no_proxy"])
	assert.Len(t, GuestEnvNames(), len(env))
	assert.Contains(t, GuestEnvNames(), "NODE_USE_ENV_PROXY")
}

func TestGenerateCAProducesASigningCA(t *testing.T) {
	t.Parallel()
	ca, err := GenerateCA("plue-egress-test", time.Hour)
	require.NoError(t, err)
	block, _ := pem.Decode(ca.CertPEM)
	require.NotNil(t, block)
	cert, err := x509.ParseCertificate(block.Bytes)
	require.NoError(t, err)
	assert.True(t, cert.IsCA)
	assert.Equal(t, "plue-egress-test", cert.Subject.CommonName)
	assert.NotZero(t, cert.KeyUsage&x509.KeyUsageCertSign)
	keyBlock, _ := pem.Decode(ca.KeyPEM)
	require.NotNil(t, keyBlock)
	assert.Equal(t, "EC PRIVATE KEY", keyBlock.Type)
}

// Two secrets bound to the same header on the same host must both be able to
// swap. iron-proxy writes a swapped header back under the configured name and
// reads it under the canonical one, so only canonical names let the second
// binding see the header the first one already processed.
func TestRenderCanonicalizesMatchHeadersSoEveryBindingSwaps(t *testing.T) {
	t.Parallel()
	config, err := Render(Spec{
		ListenAddr: "127.0.0.1:41000", HTTPListen: "127.0.0.1:42000", HTTPSListen: "127.0.0.1:43000", MetricsListen: "127.0.0.1:44000",
		CACertPath: "/run/egress/ca.crt", CAKeyPath: "/run/egress/ca.key",
		Secrets: []SecretBinding{
			{EnvVar: "S0", ProxyValue: "AI_GATEWAY_API_KEY", Hosts: []string{"api.jjhub.tech"}, MatchHeaders: []string{"authorization", "x-api-key"}},
			{EnvVar: "S1", ProxyValue: "CEREBRAS_API_KEY", Hosts: []string{"api.jjhub.tech"}, MatchHeaders: []string{"Authorization", "authorization", "x-api-key"}},
			{EnvVar: "S2", ProxyValue: "CUSTOM", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"/^x-custom-.*$/"}},
		},
	})
	require.NoError(t, err)
	var entries []SecretEntry
	for _, transform := range config.Transforms {
		if secrets, ok := transform.Config.(SecretsConfig); ok {
			entries = secrets.Secrets
		}
	}
	require.Len(t, entries, 3)
	assert.Equal(t, []string{"Authorization", "X-Api-Key"}, entries[0].Replace.MatchHeaders)
	assert.Equal(t, []string{"Authorization", "X-Api-Key"}, entries[1].Replace.MatchHeaders, "case variants collapse to one canonical name")
	assert.Equal(t, []string{"/^x-custom-.*$/"}, entries[2].Replace.MatchHeaders, "regex patterns are left as written")
}

func TestRenderRefusesNonASCIIHosts(t *testing.T) {
	t.Parallel()
	base := Spec{ListenAddr: "127.0.0.1:1", HTTPListen: "127.0.0.1:2", HTTPSListen: "127.0.0.1:3", MetricsListen: "127.0.0.1:4", CACertPath: "/c", CAKeyPath: "/k"}
	kelvin := "K.example.com" // lower-cases to k.example.com
	dotted := "İ.example.com" // lower-cases to i.example.com
	for name, spec := range map[string]Spec{
		"secret kelvin":  withSecrets(base, SecretBinding{EnvVar: "T", Hosts: []string{kelvin}, MatchQuery: true}),
		"secret dotted":  withSecrets(base, SecretBinding{EnvVar: "T", Hosts: []string{dotted}, MatchQuery: true}),
		"allow kelvin":   func() Spec { s := base; s.AllowDomains = []string{kelvin}; return s }(),
		"allow wildcard": func() Spec { s := base; s.AllowDomains = []string{"*." + kelvin}; return s }(),
		"host rule": func() Spec {
			s := base
			s.HostRules = []sandbox.EgressHostRule{{Host: kelvin, Paths: []string{"/x"}}}
			return s
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Render(spec)
			require.ErrorIs(t, err, ErrInvalidSpec)
			assert.Regexp(t, "ASCII|not one exact", err.Error())
		})
	}
	_, err := Render(withSecrets(base, SecretBinding{EnvVar: "T", Hosts: []string{"k.example.com"}, MatchQuery: true}))
	require.NoError(t, err)
}
