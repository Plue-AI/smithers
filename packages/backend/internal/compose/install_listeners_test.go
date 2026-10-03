package compose

import (
	"context"
	"github.com/stretchr/testify/require"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// §16.3.1 / C-INS-03: real listeners, open before close, permanent loopback.
func TestInstallListenersReplacementAndRollback(t *testing.T) {
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), ReadHeaderTimeout: time.Second}
	listeners, err := newInstallHTTPListeners(server, "127.0.0.1:0")
	require.NoError(t, err)
	defer listeners.Close()
	port := listeners.loopback.Addr().(*net.TCPAddr).Port
	var lan string
	interfaces, err := net.InterfaceAddrs()
	require.NoError(t, err)
	for _, address := range interfaces {
		if network, ok := address.(*net.IPNet); ok && network.IP.To4() != nil && !network.IP.IsLoopback() {
			lan = network.IP.String()
			break
		}
	}
	require.NotEmpty(t, lan, "C-INS-03 requires the runner's network interface")
	address := net.JoinHostPort(lan, strconv.Itoa(port))
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	probe := func(addr string) bool {
		response, err := client.Get("http://" + addr)
		if err != nil {
			return false
		}
		response.Body.Close()
		return response.StatusCode == 204
	}
	require.True(t, probe(listeners.loopback.Addr().String()))
	require.False(t, probe(address))
	change, err := listeners.Prepare(context.Background(), lan)
	require.NoError(t, err)
	require.True(t, probe(address), "prepared listener accepts before commit")
	change.Abort()
	require.False(t, probe(address))
	require.True(t, probe(listeners.loopback.Addr().String()))
	change, err = listeners.Prepare(context.Background(), lan)
	require.NoError(t, err)
	change.Commit()
	change.Abort()
	require.True(t, probe(address))
	require.True(t, probe(listeners.loopback.Addr().String()))
	next, err := listeners.Prepare(context.Background(), "")
	require.NoError(t, err)
	require.True(t, probe(address), "old listener remains until commit")
	next.Commit()
	require.False(t, probe(address))
	require.True(t, probe(listeners.loopback.Addr().String()))
	_, err = listeners.Prepare(context.Background(), "invalid")
	require.Error(t, err)
	require.True(t, probe(listeners.loopback.Addr().String()))
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = listeners.Prepare(cancelled, "0.0.0.0")
	require.Error(t, err)
}
func TestInstallWildcardKeepsLoopback(t *testing.T) {
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), ReadHeaderTimeout: time.Second}
	listeners, err := newInstallHTTPListeners(server, "127.0.0.1:0")
	require.NoError(t, err)
	defer listeners.Close()
	change, err := listeners.Prepare(context.Background(), "0.0.0.0")
	require.NoError(t, err)
	change.Commit()
	response, err := http.Get("http://" + listeners.loopback.Addr().String())
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 204, response.StatusCode)
	require.Equal(t, "0.0.0.0", listeners.bind)
}

func TestInstallStartupRefusesUnavailableProvidersBeforeEffects(t *testing.T) {
	// Real startup command and literal configuration: no seeded settings and
	// no replacement launcher. The nonexistent database cannot hide a write.
	path := filepath.Join(t.TempDir(), "install.yaml")
	require.NoError(t, os.WriteFile(path, []byte("install:\n  bind: 0.0.0.0\n  origins: [http://lan-a:4000]\ndatabase:\n  url: postgres://127.0.0.1:1/unavailable\n"), 0600))
	err := Run(context.Background(), []string{"--config", path}, io.Discard, io.Discard)
	require.ErrorContains(t, err, "install serving providers unavailable")
	require.NotContains(t, err.Error(), "database")
}
