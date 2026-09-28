package chat

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

// Explicit HTTP transport unit fake: local-socket host evidence is a separate
// existing component test, not counted by this fixture.
type chatHostUnitTransport func(*http.Request) (*http.Response, error)

func (f chatHostUnitTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type chatHostUnitBody struct {
	io.Reader
	closed int
}

func (b *chatHostUnitBody) Close() error { b.closed++; return nil }

func chatHostUnitGrant() ports.ChatTurnGrant {
	return ports.ChatTurnGrant{TurnID: "turn", OwnerID: 7, RunID: "run", LegID: "leg", Generation: 1, Token: strings.Repeat("a", 32),
		Cursor:    ports.ChatTurnCursor{Version: 1, RunID: "run", LegID: "leg", Hash: strings.Repeat("b", 64)},
		ExpiresAt: time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC), Request: []byte(`{"instructions":"héllo","messages":[],"runId":"run"}`), ProducerBaseURL: "http://callback.invalid/base"}
}

func TestHTTPChatHostUnitConstructorRefusalsDoNotQuoteConfigurationSecrets(t *testing.T) {
	for _, endpoint := range []string{"", " ", "ftp://host", "/relative", "http://[bad", "https://user:private-unit-fixture@host", "https://host?token=private-unit-fixture", "https://host#private-unit-fixture"} {
		host, err := NewHTTPChatHost(endpoint, nil, "host-token")
		require.Nil(t, host)
		require.EqualError(t, err, "chat model host URL is invalid")
		require.NotContains(t, err.Error(), "private-unit-fixture")
	}
	for _, auth := range []string{"", " \t\n"} {
		host, err := NewHTTPChatHost("https://host.invalid", nil, auth)
		require.Nil(t, host)
		require.EqualError(t, err, "chat model host authorization is required")
	}
	host, err := NewHTTPChatHost("https://host.invalid", nil, "host-token")
	require.NoError(t, err)
	require.Zero(t, host.client.Timeout, "the dispatcher context bounds inference, not an arbitrary fixed client timeout")
	require.NotSame(t, http.DefaultClient, host.client, "mutable global client policy does not alter this host")
}

func TestHTTPChatHostUnitSendsLiteralGrantAndClosesSuccessfulResponse(t *testing.T) {
	for _, status := range []int{200, 202, 204, 299} {
		body := &chatHostUnitBody{Reader: strings.NewReader("success detail")}
		calls := 0
		client := &http.Client{Timeout: time.Minute, Transport: chatHostUnitTransport(func(sent *http.Request) (*http.Response, error) {
			defer sent.Body.Close()
			calls++
			require.Equal(t, "POST", sent.Method)
			require.Equal(t, "https://host.invalid/ingress/v1/chat/turn", sent.URL.String())
			require.Equal(t, "application/json", sent.Header.Get("Content-Type"))
			require.Equal(t, "Bearer host-token", sent.Header.Get("Authorization"))
			raw, err := io.ReadAll(sent.Body)
			require.NoError(t, err)
			require.JSONEq(t, `{"turnId":"turn","ownerId":7,"runId":"run","legId":"leg","generation":1,"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cursor":{"version":1,"runId":"run","legId":"leg","batch":0,"position":0,"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"expiresAt":"2026-09-27T12:00:00Z","request":{"instructions":"héllo","messages":[],"runId":"run"},"producerBaseUrl":"http://callback.invalid/base"}`, string(raw))
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: body, Request: sent}, nil
		})}
		host, err := NewHTTPChatHost(" https://host.invalid/ingress/ ", client, " host-token ")
		require.NoError(t, err)
		grant := chatHostUnitGrant()
		before := string(grant.Request)
		require.NoError(t, host.RunChatTurn(t.Context(), grant))
		require.Equal(t, before, string(grant.Request))
		require.Equal(t, 1, calls)
		require.Equal(t, 1, body.closed)
		require.Equal(t, time.Minute, client.Timeout, "supplied client policy is retained")
	}
}

func TestHTTPChatHostUnitRefusalDetailsAreBoundedAndValidUTF8(t *testing.T) {
	for _, item := range []struct{ raw, detail string }{
		{" \tprovider_unreachable\n", "provider_unreachable"},
		{string([]byte{'b', 'a', 'd', 0xff, '!'}), "bad?!"},
		{strings.Repeat("x", 513), strings.Repeat("x", 512)},
	} {
		body := &chatHostUnitBody{Reader: strings.NewReader(item.raw)}
		host, err := NewHTTPChatHost("https://host.invalid", &http.Client{Transport: chatHostUnitTransport(func(sent *http.Request) (*http.Response, error) {
			defer sent.Body.Close()
			return &http.Response{StatusCode: 502, Header: http.Header{}, Body: body, Request: sent}, nil
		})}, "host-token")
		require.NoError(t, err)
		require.EqualError(t, host.RunChatTurn(t.Context(), chatHostUnitGrant()), "chat model host refused grant with status 502: "+item.detail)
		require.Equal(t, 1, body.closed)
	}
}

func TestHTTPChatHostUnitTransportFailureAndCancellationPreserveCauses(t *testing.T) {
	failure := &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
	host, err := NewHTTPChatHost("https://host.invalid", &http.Client{Transport: chatHostUnitTransport(func(sent *http.Request) (*http.Response, error) {
		defer sent.Body.Close()
		return nil, failure
	})}, "host-token")
	require.NoError(t, err)
	err = host.RunChatTurn(t.Context(), chatHostUnitGrant())
	require.ErrorIs(t, err, failure)
	require.Contains(t, err.Error(), "run chat model host:")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	canceledHost, err := NewHTTPChatHost("https://host.invalid", &http.Client{Transport: chatHostUnitTransport(func(sent *http.Request) (*http.Response, error) {
		defer sent.Body.Close()
		return nil, sent.Context().Err()
	})}, "host-token")
	require.NoError(t, err)
	err = canceledHost.RunChatTurn(ctx, chatHostUnitGrant())
	require.True(t, errors.Is(err, context.Canceled), "host work remains attached to dispatcher cancellation")
}

func TestHTTPChatHostUnitMalformedPublicGrantNeverDispatches(t *testing.T) {
	host, err := NewHTTPChatHost("https://host.invalid", &http.Client{Transport: chatHostUnitTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("malformed public grant must not reach transport")
		return nil, nil
	})}, "host-token")
	require.NoError(t, err)
	grant := chatHostUnitGrant()
	grant.Request = []byte(`{`)
	err = host.RunChatTurn(t.Context(), grant)
	require.Error(t, err)
	require.Contains(t, err.Error(), "encode chat model grant:")
}
