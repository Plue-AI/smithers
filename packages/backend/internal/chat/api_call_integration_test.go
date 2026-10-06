package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

type fixtureTurnAPI struct {
	begin func(context.Context, middleware.Credential, int64, string, int64) (ports.ChatTurnAPI, error)
	end   func(context.Context, int64, int64) error
}

func (a fixtureTurnAPI) Begin(ctx context.Context, c middleware.Credential, u int64, id string, g int64) (ports.ChatTurnAPI, error) {
	return a.begin(ctx, c, u, id, g)
}
func (a fixtureTurnAPI) End(ctx context.Context, u, id int64) error { return a.end(ctx, u, id) }

type turnHostFunc func(context.Context, ports.ChatTurnGrant) error

func (f turnHostFunc) RunChatTurn(ctx context.Context, g ports.ChatTurnGrant) error { return f(ctx, g) }

func TestPortHostOwnsCredentialThroughSuccessFailureAndCancellation(t *testing.T) {
	for _, outcome := range []string{"success", "failure", "cancellation"} {
		t.Run(outcome, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			credentials := newTurnCredentials()
			key := turnKey{userID: 7, runID: "run", legID: "leg"}
			credentials.admit(key, middleware.Credential{SessionHash: "original"})
			ended := false
			api := fixtureTurnAPI{begin: func(_ context.Context, c middleware.Credential, u int64, id string, g int64) (ports.ChatTurnAPI, error) {
				require.Equal(t, middleware.Credential{SessionHash: "original"}, c)
				require.Equal(t, int64(7), u)
				require.Equal(t, "turn", id)
				require.Equal(t, int64(2), g)
				return ports.ChatTurnAPI{Author: "ben", Token: "private-turn-bearer", TokenID: 42}, nil
			}, end: func(cleanup context.Context, u, id int64) error {
				require.NoError(t, cleanup.Err())
				require.Equal(t, int64(7), u)
				require.Equal(t, int64(42), id)
				_, bounded := cleanup.Deadline()
				require.True(t, bounded)
				ended = true
				return nil
			}}
			expected := errors.New("host failed")
			host := PortHost{API: api, credentials: credentials, Host: turnHostFunc(func(_ context.Context, g ports.ChatTurnGrant) error {
				require.Equal(t, "private-turn-bearer", g.API.Token)
				c, ok := credentials.credential(key)
				require.True(t, ok)
				sum := sha256.Sum256([]byte(g.API.Token))
				require.Equal(t, hex.EncodeToString(sum[:]), c.TokenHash)
				if outcome == "cancellation" {
					cancel()
					return ctx.Err()
				}
				if outcome == "failure" {
					return expected
				}
				return nil
			})}
			err := host.RunTurn(ctx, ProducerGrant{TurnID: "turn", OwnerID: 7, RunID: "run", LegID: "leg", Generation: 2})
			switch outcome {
			case "success":
				require.NoError(t, err)
			case "failure":
				require.ErrorIs(t, err, expected)
			default:
				require.ErrorIs(t, err, context.Canceled)
			}
			require.True(t, ended)
			remaining, ok := credentials.credential(key)
			if outcome == "success" {
				require.False(t, ok)
			} else {
				require.True(t, ok)
				require.Equal(t, middleware.Credential{SessionHash: "original"}, remaining)
			}
		})
	}
}

func TestPortHostRefusesSharedLaunchWhenIssuerFails(t *testing.T) {
	failure := errors.New("issuer unavailable")
	api := fixtureTurnAPI{begin: func(context.Context, middleware.Credential, int64, string, int64) (ports.ChatTurnAPI, error) {
		return ports.ChatTurnAPI{}, failure
	}}
	host := PortHost{API: api, Host: turnHostFunc(func(context.Context, ports.ChatTurnGrant) error {
		t.Fatal("model launched without authority")
		return nil
	})}
	require.ErrorIs(t, host.RunTurn(t.Context(), ProducerGrant{Request: []byte(`{"sharedConversation":true}`)}), failure)
}

func TestProducerCredentialCleanupPreservesReplacement(t *testing.T) {
	credentials := newTurnCredentials()
	key := turnKey{userID: 7, runID: "run", legID: "leg"}
	releaseOld := credentials.bind(key, middleware.Credential{TokenHash: "old"})
	releaseNew := credentials.bind(key, middleware.Credential{TokenHash: "new"})
	releaseOld()
	current, ok := credentials.credential(key)
	require.True(t, ok)
	require.Equal(t, "new", current.TokenHash)
	releaseNew()
	_, ok = credentials.credential(key)
	require.False(t, ok)
}

func TestPortHostLegacyRefusalPreservesExistingModelBehavior(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "shared"}[shared], func(t *testing.T) {
			called := false
			api := fixtureTurnAPI{begin: func(context.Context, middleware.Credential, int64, string, int64) (ports.ChatTurnAPI, error) {
				return ports.ChatTurnAPI{}, ports.ErrAPIForbidden
			}}
			host := PortHost{API: api, Host: turnHostFunc(func(_ context.Context, grant ports.ChatTurnGrant) error {
				called = true
				require.Nil(t, grant.API)
				return nil
			})}
			request := []byte(`{}`)
			if shared {
				request = []byte(`{"sharedConversation":true}`)
			}
			err := host.RunTurn(t.Context(), ProducerGrant{Request: request})
			if shared {
				require.ErrorIs(t, err, ports.ErrAPIForbidden)
				require.False(t, called)
			} else {
				require.NoError(t, err)
				require.True(t, called)
			}
		})
	}
}
