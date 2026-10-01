package ironproxy

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Exercise Node itself and a forwarding CONNECT proxy over real TCP/TLS.
// The .invalid target cannot resolve directly; only the proxy knows its local
// upstream. No internet service, guest image, or iron-proxy binary is needed.
func TestGuestEnvNodeFetchUsesProxyWithoutDirectDNS(t *testing.T) {
	node, err := exec.LookPath("node")
	require.NoError(t, err, "Node 26.4+ is required for the guest proxy integration test")
	const host = "node-fetch.invalid"
	ca, err := GenerateCA("Node guest proxy test", time.Hour)
	require.NoError(t, err)
	caPair, err := tls.X509KeyPair(ca.CertPEM, ca.KeyPEM)
	require.NoError(t, err)
	caCert, err := x509.ParseCertificate(caPair.Certificate[0])
	require.NoError(t, err)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	leaf := &x509.Certificate{
		SerialNumber: big.NewInt(1), DNSNames: []string{host}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, caCert, &key.PublicKey, caPair.PrivateKey)
	require.NoError(t, err)
	keyDER, err := x509.MarshalECPrivateKey(key)
	require.NoError(t, err)
	certificate, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	require.NoError(t, err)
	caPath := filepath.Join(t.TempDir(), "ca.pem")
	require.NoError(t, os.WriteFile(caPath, ca.CertPEM, 0o600))

	var requests atomic.Int32
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		assert.Equal(t, "/package-manager", r.URL.Path)
		_, _ = io.WriteString(w, "package-manager-download")
	}))
	upstream.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	upstream.StartTLS()
	t.Cleanup(upstream.Close)

	var connects atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Host != host+":443" {
			http.Error(w, "unexpected destination", http.StatusForbidden)
			return
		}
		connects.Add(1)
		remote, dialErr := net.DialTimeout("tcp", upstream.Listener.Addr().String(), time.Second)
		if dialErr != nil {
			http.Error(w, dialErr.Error(), http.StatusBadGateway)
			return
		}
		defer remote.Close()
		client, buffered, hijackErr := w.(http.Hijacker).Hijack()
		if hijackErr != nil {
			return
		}
		defer client.Close()
		_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		if buffered.Flush() != nil {
			return
		}
		done := make(chan struct{})
		go func() {
			_, _ = io.Copy(remote, buffered)
			_ = remote.Close()
			close(done)
		}()
		_, _ = io.Copy(client, remote)
		_ = client.Close()
		<-done
	}))
	t.Cleanup(proxy.Close)

	for _, tc := range []struct {
		name    string
		change  func(map[string]string)
		target  string
		failure string
		proxied bool
	}{
		{name: "guest environment", proxied: true},
		{name: "missing Node opt-in", change: func(env map[string]string) { delete(env, "NODE_USE_ENV_PROXY") }, failure: "ENOTFOUND"},
		{name: "untrusted proxy CA", change: func(env map[string]string) {
			delete(env, "NODE_EXTRA_CA_CERTS")
			delete(env, "SSL_CERT_FILE")
		}, failure: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", proxied: true},
		{name: "NO_PROXY bypass", change: func(env map[string]string) { env["NO_PROXY"], env["no_proxy"] = host, host }, failure: "ENOTFOUND"},
		{name: "loopback stays direct", target: upstream.URL + "/package-manager"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := GuestEnv(proxy.URL, caPath)
			if tc.change != nil {
				tc.change(env)
			}
			target := tc.target
			if target == "" {
				target = "https://" + host + "/package-manager"
			}
			beforeConnects, beforeRequests := connects.Load(), requests.Load()
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, node, "--input-type=module", "-e", `
try {
  const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(5000) });
  if (response.status !== 200) throw new Error("unexpected status " + response.status);
  console.log(await response.text());
  process.exit(0);
} catch (error) {
  console.error(error.cause?.code ?? error.message);
  process.exit(1);
}`, target)
			// Exclude ambient proxy settings and Node flags, including insecure
			// TLS overrides, so only GuestEnv configures this child.
			cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
			for name, value := range env {
				cmd.Env = append(cmd.Env, name+"="+value)
			}
			output, runErr := cmd.CombinedOutput()
			if tc.failure == "" {
				require.NoError(t, runErr, "%s", output)
				assert.Equal(t, "package-manager-download\n", string(output))
				assert.Equal(t, beforeRequests+1, requests.Load())
			} else {
				require.Error(t, runErr, "%s", output)
				assert.Contains(t, string(output), tc.failure)
				assert.Equal(t, beforeRequests, requests.Load(), "failed fetch never reaches the upstream")
			}
			if tc.proxied {
				assert.Greater(t, connects.Load(), beforeConnects, "Node must use the configured CONNECT proxy")
			} else {
				assert.Equal(t, beforeConnects, connects.Load(), "direct fetch must bypass the proxy")
			}
		})
	}
}
