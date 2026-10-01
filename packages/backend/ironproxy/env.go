package ironproxy

import (
	"fmt"
	"net"
	"sort"
	"strings"
)

// GuestNoProxy lists destinations the guest must reach directly: its own
// loopback and the sandbox host alias microsandbox writes into /etc/hosts.
var GuestNoProxy = []string{"localhost", "127.0.0.1", "::1", "host.microsandbox.internal"}

// GuestEnv returns the environment that routes a guest's traffic through the
// proxy at proxyURL and trusts the MITM CA at caPath. Both the upper- and
// lower-case proxy spellings are set because tools disagree on which they
// read (curl reads lower-case only; Go and Node read either). Node's built-in
// HTTP clients also require NODE_USE_ENV_PROXY to opt into these settings.
//
// The CA bundle variables are the portable trust path: they work on any
// guest image, including NixOS, without a distribution trust store. A NixOS
// guest that wants system-wide trust sets security.pki.certificateFiles to
// the same file; Ubuntu-derived images get update-ca-certificates as an
// image-kind hook on top.
func GuestEnv(proxyURL, caPath string) map[string]string {
	noProxy := strings.Join(GuestNoProxy, ",")
	return map[string]string{
		"HTTP_PROXY":          proxyURL,
		"HTTPS_PROXY":         proxyURL,
		"http_proxy":          proxyURL,
		"https_proxy":         proxyURL,
		"NO_PROXY":            noProxy,
		"no_proxy":            noProxy,
		"SSL_CERT_FILE":       caPath,
		"CURL_CA_BUNDLE":      caPath,
		"REQUESTS_CA_BUNDLE":  caPath,
		"NODE_EXTRA_CA_CERTS": caPath,
		"NODE_USE_ENV_PROXY":  "1",
		"GIT_SSL_CAINFO":      caPath,
	}
}

// GuestEnvNames lists the keys GuestEnv sets, sorted, so callers can assert
// the proxy wiring cannot be overridden by lower-precedence environment.
func GuestEnvNames() []string {
	names := make([]string, 0, 12)
	for name := range GuestEnv("http://proxy", "/ca") {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// GuestProxyURL is the URL a guest uses for the proxy the sandbox host runs
// on port. Guests reach the host through microsandbox's fixed alias.
func GuestProxyURL(port int) string {
	return fmt.Sprintf("http://%s", net.JoinHostPort("host.microsandbox.internal", fmt.Sprint(port)))
}
