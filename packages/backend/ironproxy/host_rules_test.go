package ironproxy

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// ironProxyPermits evaluates a rendered allowlist exactly as iron-proxy
// 0.50.0 does (internal/hostmatch: MatchGlob, MatchPath, Rule.Matches on the
// request's Host without port and its decoded URL path).
func ironProxyPermits(t *testing.T, config Config, host, method, requestPath string) bool {
	t.Helper()
	glob := func(pattern, name string) bool {
		pattern, name = strings.ToLower(pattern), strings.ToLower(name)
		if pattern == "*" {
			return true
		}
		if strings.HasPrefix(pattern, "*.") {
			return strings.HasSuffix(name, pattern[1:]) || name == pattern[2:]
		}
		matched, err := path.Match(pattern, name)
		require.NoError(t, err, pattern)
		return matched
	}
	pathMatch := func(pattern, requestPath string) bool {
		if strings.HasSuffix(pattern, "/*") {
			return strings.HasPrefix(requestPath, pattern[:len(pattern)-1]) || requestPath == pattern[:len(pattern)-2]
		}
		matched, _ := path.Match(pattern, requestPath)
		return matched
	}
	allowlist := config.Transforms[0].Config.(AllowlistConfig)
	for _, domain := range allowlist.Domains {
		if glob(domain, host) {
			return true
		}
	}
	for _, rule := range allowlist.Rules {
		if !glob(rule.Host, host) {
			continue
		}
		if len(rule.Methods) > 0 && !containsFold(rule.Methods, method) {
			continue
		}
		if len(rule.Paths) == 0 {
			return true
		}
		for _, pattern := range rule.Paths {
			if pathMatch(pattern, requestPath) {
				return true
			}
		}
	}
	return false
}

func containsFold(values []string, value string) bool {
	for _, candidate := range values {
		if strings.EqualFold(candidate, value) {
			return true
		}
	}
	return false
}

func renderWithRules(t *testing.T, domains []string) Config {
	t.Helper()
	config, err := Render(Spec{
		ListenAddr: "127.0.0.1:1", HTTPListen: "127.0.0.1:2", HTTPSListen: "127.0.0.1:3", MetricsListen: "127.0.0.1:4",
		CACertPath: "ca.crt", CAKeyPath: "ca.key", AllowDomains: domains, HostRules: sandbox.ConversationWithheldHostRules(),
	})
	require.NoError(t, err)
	return config
}

var deploymentDomains = []string{"github.com", "api.github.com", "codeload.github.com", "*.githubusercontent.com", "registry.npmjs.org", "api.smithers.test"}

// A run started from an outsider's approved text reaches no GitHub issue,
// comment or pull request conversation, and still fetches code, releases
// and packages.
func TestHostRulesWithholdGitHubConversation(t *testing.T) {
	t.Parallel()
	for name, domains := range map[string][]string{"deployment list": deploymentDomains, "any host": {"*"}} {
		config := renderWithRules(t, domains)
		assert.NotContains(t, config.Transforms[0].Config.(AllowlistConfig).Domains, "*", name)
		for _, denied := range [][3]string{
			{"api.github.com", "GET", "/repos/acme/demo/issues/4"},
			{"api.github.com", "GET", "/repos/acme/demo/issues"},
			{"api.github.com", "GET", "/repos/acme/demo/issues/4/comments"},
			{"api.github.com", "GET", "/repos/acme/demo/issues/comments/9"},
			{"api.github.com", "GET", "/repos/acme/demo/pulls/4/comments"},
			{"api.github.com", "GET", "/repos/acme/demo/pulls/4/reviews"},
			{"api.github.com", "GET", "/repos/acme/demo/pulls/4"},
			{"api.github.com", "POST", "/graphql"},
			{"api.github.com", "GET", "/search/issues"},
			{"API.GitHub.com", "GET", "/repos/acme/demo/issues/4"},
			{"api.github.com.", "GET", "/repos/acme/demo/issues/4"},
			{"github.com", "GET", "/acme/demo/issues/4"},
			{"github.com", "GET", "/acme/demo/pull/4"},
			{"github.com", "GET", "/acme/demo/issues/4.json"},
			{"github.com.", "GET", "/acme/demo/issues/4"},
			{"github.com", "POST", "/acme/demo/git-receive-pack"},
			{"api.github.com.", "CONNECT", ""},
		} {
			assert.False(t, ironProxyPermits(t, config, denied[0], denied[1], denied[2]), "%s: %v", name, denied)
		}
		for _, allowed := range [][3]string{
			{"github.com", "CONNECT", ""},
			{"api.github.com", "CONNECT", ""},
			{"github.com", "GET", "/acme/demo.git/info/refs"},
			{"github.com", "POST", "/acme/demo.git/git-upload-pack"},
			{"github.com", "GET", "/oven-sh/bun/releases/download/bun-v1.2.0/bun-linux-x64.zip"},
			{"github.com", "GET", "/oven-sh/bun/releases/latest/download/bun-linux-x64.zip"},
			{"github.com", "GET", "/acme/demo/archive/refs/tags/v1.tar.gz"},
			{"api.github.com", "GET", "/repos/acme/demo/releases/latest"},
			{"api.github.com", "GET", "/repos/acme/demo/tarball/v1"},
			{"codeload.github.com", "GET", "/acme/demo/tar.gz/v1"},
			{"objects.githubusercontent.com", "GET", "/release-asset"},
			{"registry.npmjs.org", "GET", "/effect"},
			{"api.smithers.test", "GET", "/api/repos/acme/demo/git/refs"},
		} {
			assert.True(t, ironProxyPermits(t, config, allowed[0], allowed[1], allowed[2]), "%s: %v", name, allowed)
		}
	}
	// "any host" keeps every other name, including near misses of the
	// narrowed hosts.
	config := renderWithRules(t, []string{"*"})
	for _, host := range []string{"example.com", "github.co", "github.comx", "xgithub.com", "api.github.co", "gist.github.com", "a", "140.82.112.6"} {
		assert.True(t, ironProxyPermits(t, config, host, "GET", "/"), host)
	}
}

func TestHostRulesFailClosedOnAWiderGlob(t *testing.T) {
	t.Parallel()
	_, err := Render(Spec{
		ListenAddr: "127.0.0.1:1", HTTPListen: "127.0.0.1:2", HTTPSListen: "127.0.0.1:3", MetricsListen: "127.0.0.1:4",
		CACertPath: "ca.crt", CAKeyPath: "ca.key", AllowDomains: []string{"*.github.com"}, HostRules: sandbox.ConversationWithheldHostRules(),
	})
	require.ErrorIs(t, err, ErrInvalidSpec)
}

func TestHostRulesRenderIronProxySchema(t *testing.T) {
	t.Parallel()
	payload, err := RenderYAML(Spec{
		ListenAddr: "127.0.0.1:1", HTTPListen: "127.0.0.1:2", HTTPSListen: "127.0.0.1:3", MetricsListen: "127.0.0.1:4",
		CACertPath: "ca.crt", CAKeyPath: "ca.key", AllowDomains: deploymentDomains,
		HostRules: []sandbox.EgressHostRule{{Host: "GitHub.com", Methods: []string{"post"}, Paths: []string{"/*/*/git-upload-pack"}}},
	})
	require.NoError(t, err)
	var decoded struct {
		Transforms []struct {
			Config struct {
				Domains []string         `yaml:"domains"`
				Rules   []map[string]any `yaml:"rules"`
			} `yaml:"config"`
		} `yaml:"transforms"`
	}
	require.NoError(t, yaml.Unmarshal(payload, &decoded))
	assert.NotContains(t, decoded.Transforms[0].Config.Domains, "github.com")
	assert.Equal(t, []map[string]any{
		{"host": "github.com", "methods": []any{"POST"}, "paths": []any{"/*/*/git-upload-pack"}},
		{"host": "github.com", "methods": []any{"CONNECT"}},
	}, decoded.Transforms[0].Config.Rules)
}

// TestHostRulesIntegrationRefuseIssueEndpoints drives the real iron-proxy
// binary: issue, comment and GraphQL requests to GitHub are refused with 403
// before any upstream dial. It skips without SMITHERS_TEST_IRON_PROXY_BIN or
// iron-proxy on PATH.
func TestHostRulesIntegrationRefuseIssueEndpoints(t *testing.T) {
	binary := strings.TrimSpace(os.Getenv("SMITHERS_TEST_IRON_PROXY_BIN"))
	if binary == "" {
		var err error
		if binary, err = exec.LookPath("iron-proxy"); err != nil {
			t.Skip("iron-proxy binary not on PATH; set SMITHERS_TEST_IRON_PROXY_BIN")
		}
	}
	dir := t.TempDir()
	ca, err := GenerateCA("host-rules", time.Hour)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "ca.crt"), ca.CertPEM, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "ca.key"), ca.KeyPEM, 0o600))
	ports := make([]string, 4)
	for i := range ports {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		require.NoError(t, err)
		ports[i] = listener.Addr().String()
		require.NoError(t, listener.Close())
	}
	payload, err := RenderYAML(Spec{
		ListenAddr: ports[0], HTTPListen: ports[1], HTTPSListen: ports[2], MetricsListen: ports[3],
		CACertPath: filepath.Join(dir, "ca.crt"), CAKeyPath: filepath.Join(dir, "ca.key"),
		AllowDomains: []string{"*"}, HostRules: sandbox.ConversationWithheldHostRules(),
	})
	require.NoError(t, err)
	configPath := filepath.Join(dir, "proxy.yaml")
	require.NoError(t, os.WriteFile(configPath, payload, 0o600))
	cmd := exec.Command(binary, "-config", configPath)
	cmd.Dir = dir
	require.NoError(t, cmd.Start())
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	deadline := time.Now().Add(15 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", ports[0], 250*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			break
		}
		require.True(t, time.Now().Before(deadline), "iron-proxy did not listen")
		time.Sleep(100 * time.Millisecond)
	}
	pool := x509.NewCertPool()
	require.True(t, pool.AppendCertsFromPEM(ca.CertPEM))
	proxyURL, err := url.Parse("http://" + ports[0])
	require.NoError(t, err)
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
		Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: pool},
	}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, request := range [][2]string{
		{"GET", "https://api.github.com/repos/smithersai/smithers/issues/1"},
		{"GET", "https://api.github.com/repos/smithersai/smithers/issues/1/comments"},
		{"GET", "https://api.github.com/repos/smithersai/smithers/pulls/1/reviews"},
		{"POST", "https://api.github.com/graphql"},
		{"GET", "https://github.com/smithersai/smithers/issues/1"},
		{"GET", "http://github.com/smithersai/smithers/issues/1"},
	} {
		req, err := http.NewRequest(request[0], request[1], nil)
		require.NoError(t, err)
		response, err := client.Do(req)
		if err != nil {
			assert.Contains(t, strings.ToLower(err.Error()), "forbidden", "%v must be refused", request)
			continue
		}
		_ = response.Body.Close()
		assert.Equal(t, http.StatusForbidden, response.StatusCode, "%v must be refused", request)
		assert.Empty(t, response.Header.Get("X-GitHub-Request-Id"), "%v must be refused by the proxy, not GitHub", request)
	}
	if os.Getenv("SMITHERS_TEST_EGRESS_GITHUB") != "1" {
		t.Log("GitHub reachability skipped; set SMITHERS_TEST_EGRESS_GITHUB=1")
		return
	}
	for _, allowed := range []string{
		"https://api.github.com/repos/smithersai/smithers",
		"https://github.com/smithersai/smithers.git/info/refs?service=git-upload-pack",
	} {
		response, err := client.Get(allowed)
		require.NoError(t, err, allowed)
		_ = response.Body.Close()
		assert.NotEmpty(t, response.Header.Get("X-GitHub-Request-Id"), allowed+" reaches GitHub")
		assert.Less(t, response.StatusCode, 400, allowed+" "+strconv.Itoa(response.StatusCode))
	}
}
