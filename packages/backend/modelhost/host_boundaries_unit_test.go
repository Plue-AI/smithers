package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

func TestHostPrivateEndpointErrorsReleaseLease(t *testing.T) {
	cleanupErr := errors.New("cleanup unavailable")
	for _, operation := range []string{"chat", "stream", "probe"} {
		t.Run(operation, func(t *testing.T) {
			dispatched := false
			lease := &testLease{origin: "http://[", closeErr: cleanupErr, client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				dispatched = true
				return nil, errors.New("unexpected dispatch")
			})}}
			host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) { return Binding{}, nil }), testLauncher{lease: lease})
			require.NoError(t, err)
			switch operation {
			case "chat":
				err = host.RunChatTurn(context.Background(), ports.ChatTurnGrant{OwnerID: 7})
			case "stream":
				var stream io.ReadCloser
				stream, err = host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
				require.Nil(t, stream)
			case "probe":
				var result json.RawMessage
				result, err = host.RunModelTest(context.Background(), 7, json.RawMessage(`{}`))
				require.Nil(t, result)
			}
			require.ErrorIs(t, err, cleanupErr)
			require.False(t, dispatched)
			require.True(t, lease.closed)
			require.True(t, lease.closeDeadline)
		})
	}
}

func TestModelStreamStatusBoundaries(t *testing.T) {
	for _, status := range []int{199, 200, 299, 300, 400, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			requests := 0
			closed := false
			lease := &testLease{origin: "https://private.test", client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				requests++
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: &trackingReadCloser{Reader: strings.NewReader("sealed\n"), closed: &closed}}, nil
			})}}
			host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) { return Binding{}, nil }), testLauncher{lease: lease})
			require.NoError(t, err)
			stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
			if status >= 200 && status < 300 {
				require.NoError(t, err)
				body, err := io.ReadAll(stream)
				require.NoError(t, err)
				require.Equal(t, "sealed\n", string(body))
				require.NoError(t, stream.Close())
			} else {
				require.Nil(t, stream)
				require.Error(t, err)
				require.Equal(t, status == 400, errors.Is(err, ports.ErrModelRequestInvalid))
			}
			require.Equal(t, 1, requests)
			require.True(t, closed)
			require.True(t, lease.closed)
		})
	}
}

func TestHostProbeLaunchFailureDoesNotAcquireLease(t *testing.T) {
	launchErr := errors.New("launch refused")
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) { return Binding{}, nil }), testLauncher{err: launchErr})
	require.NoError(t, err)
	result, err := host.RunModelTest(context.Background(), 7, json.RawMessage(`{}`))
	require.Nil(t, result)
	require.ErrorIs(t, err, launchErr)
}

func TestLeaseWithoutClientGetsIndependentDefaultClients(t *testing.T) {
	lease := nilClientLease{&testLease{origin: "https://private.test"}}
	endpoint, first, token := leaseEndpoint(lease)
	require.Equal(t, "https://private.test", endpoint)
	require.Equal(t, "private-token", token)
	require.NotNil(t, first)
	require.Zero(t, first.Timeout)
	_, second, _ := leaseEndpoint(lease)
	require.NotSame(t, first, second)
	first.Timeout = time.Second
	require.Zero(t, second.Timeout)
}
