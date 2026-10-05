package compose

import (
	"errors"
	"io"
	"net"
	"net/http"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func addressListenerGet(t *testing.T, address string) (string, error) {
	t.Helper()
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	response, err := client.Get("http://" + address + "/readyz")
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	return string(body), err
}

// addressListenerServer is the product server shape: one http.Server whose
// loopback listener never closes, plus the network listener under test.
func addressListenerServer(t *testing.T) (*networkListener, string, *[]net.Listener) {
	t.Helper()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ready") })}
	loopback, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	go func() { _ = srv.Serve(loopback) }()
	t.Cleanup(func() { _ = srv.Close() })
	opened := &[]net.Listener{}
	network := &networkListener{serve: srv.Serve, listen: func(kind, address string) (net.Listener, error) {
		ln, err := net.Listen(kind, address)
		if err == nil {
			*opened = append(*opened, ln)
		}
		return ln, err
	}}
	return network, loopback.Addr().String(), opened
}

func TestNetworkListenerOpensBeforeClosingAndKeepsLoopback(t *testing.T) {
	network, loopback, opened := addressListenerServer(t)
	require.NoError(t, network.Listen("127.0.0.1:0"))
	require.Len(t, *opened, 1)
	first := (*opened)[0].Addr().String()
	body, err := addressListenerGet(t, first)
	require.NoError(t, err)
	require.Equal(t, "ready", body)

	// A new bind serves; the previous one is refused; loopback never closes.
	require.NoError(t, network.Listen("127.0.0.1:0"))
	require.Len(t, *opened, 2)
	second := (*opened)[1].Addr().String()
	body, err = addressListenerGet(t, second)
	require.NoError(t, err)
	require.Equal(t, "ready", body)
	_, err = addressListenerGet(t, first)
	require.Error(t, err)
	body, err = addressListenerGet(t, loopback)
	require.NoError(t, err)
	require.Equal(t, "ready", body)

	// This Mac only closes the network listener and keeps loopback.
	require.NoError(t, network.Listen(""))
	_, err = addressListenerGet(t, second)
	require.Error(t, err)
	_, err = addressListenerGet(t, loopback)
	require.NoError(t, err)
}

func TestNetworkListenerRefusedBindKeepsTheCurrentOne(t *testing.T) {
	network, _, opened := addressListenerServer(t)
	require.NoError(t, network.Listen("127.0.0.1:0"))
	current := (*opened)[0].Addr().String()
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer taken.Close()
	err = network.Listen(taken.Addr().String())
	var typed *services.InstallReadinessError
	require.True(t, errors.As(err, &typed))
	require.Equal(t, "address_unavailable", typed.Code)
	require.Equal(t, "user", typed.Class)
	require.Equal(t, "Can't listen on "+taken.Addr().String(), typed.Message)
	_, err = addressListenerGet(t, current)
	require.NoError(t, err)
}

// The install's real shape on macOS: loopback on 127.0.0.1:4000 and Network on
// 0.0.0.0:4000, the same port, both serving, reached at an interface address.
func TestNetworkListenerWildcardBesideLoopbackOnOnePortDarwin(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("BSD sockets let a wildcard bind share a port with a loopback bind; Linux refuses it")
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ready") })}
	loopback, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	go func() { _ = srv.Serve(loopback) }()
	defer srv.Close()
	port := strconv.Itoa(loopback.Addr().(*net.TCPAddr).Port)
	network := &networkListener{serve: srv.Serve, listen: net.Listen}
	require.NoError(t, network.Listen(net.JoinHostPort("0.0.0.0", port)))
	body, err := addressListenerGet(t, loopback.Addr().String())
	require.NoError(t, err)
	require.Equal(t, "ready", body)
	interfaceAddress := ""
	addresses, err := net.InterfaceAddrs()
	require.NoError(t, err)
	for _, candidate := range addresses {
		if ip, ok := candidate.(*net.IPNet); ok && ip.IP.To4() != nil && !ip.IP.IsLoopback() && !ip.IP.IsLinkLocalUnicast() {
			interfaceAddress = ip.IP.String()
			break
		}
	}
	if interfaceAddress == "" {
		t.Skip("no interface address to reach the network listener at")
	}
	body, err = addressListenerGet(t, net.JoinHostPort(interfaceAddress, port))
	require.NoError(t, err)
	require.Equal(t, "ready", body)
	require.NoError(t, network.Listen(""))
	_, err = addressListenerGet(t, net.JoinHostPort(interfaceAddress, port))
	require.Error(t, err)
	_, err = addressListenerGet(t, loopback.Addr().String())
	require.NoError(t, err)
}
