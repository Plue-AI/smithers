package machined

import (
	"crypto/sha256"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestActorIdentityValidation(t *testing.T) {
	base := ActorIdentity{Kind: "person", MemberID: 1, Via: "web"}
	for name, change := range map[string]func(*ActorIdentity){
		"zero member":                func(a *ActorIdentity) { a.MemberID = 0 },
		"negative member":            func(a *ActorIdentity) { a.MemberID = -1 },
		"unknown kind":               func(a *ActorIdentity) { a.Kind = "outside" },
		"unknown transport":          func(a *ActorIdentity) { a.Via = "guest" },
		"person has run":             func(a *ActorIdentity) { a.Run = "spoof" },
		"person has agent kind":      func(a *ActorIdentity) { a.AgentKind = "coding" },
		"person has agent transport": func(a *ActorIdentity) { a.Via = "agent" },
		"agent lacks run":            func(a *ActorIdentity) { a.Kind = "agent"; a.AgentKind = "coding" },
		"agent lacks kind":           func(a *ActorIdentity) { a.Kind = "agent"; a.Run = "r" },
		"unknown agent kind":         func(a *ActorIdentity) { a.Kind = "agent"; a.Run = "r"; a.AgentKind = "root" },
		"padded run":                 func(a *ActorIdentity) { a.Kind = "agent"; a.Run = " r"; a.AgentKind = "coding" },
		"NUL run":                    func(a *ActorIdentity) { a.Kind = "agent"; a.Run = "r\x00"; a.AgentKind = "coding" },
		"oversize identity":          func(a *ActorIdentity) { a.Kind = "agent"; a.Run = strings.Repeat("r", 800); a.AgentKind = "coding" },
	} {
		t.Run(name, func(t *testing.T) {
			a := base
			change(&a)
			_, err := a.canonical()
			require.ErrorIs(t, err, ErrUnauthorized)
		})
	}
	for _, via := range []string{"ssh", "terminal", "cli", "web"} {
		a := base
		a.Via = via
		_, err := a.canonical()
		require.NoError(t, err)
	}
	for _, kind := range []string{"coding", "reviewer", "external"} {
		a := ActorIdentity{Kind: "agent", MemberID: 7, Run: "run", AgentKind: kind, Via: "agent"}
		_, err := a.canonical()
		require.NoError(t, err)
	}
	raw, err := base.canonical()
	require.NoError(t, err)
	digest := sha256.Sum256(raw)
	decoded, err := decodeActorIdentity([]byte(`{ "via":"web", "member_id":1, "kind":"person" }`), digest[:])
	require.NoError(t, err)
	require.Equal(t, base, decoded)
	for _, raw := range []string{`{`, `{"kind":"person","member_id":1,"via":"web","credential":"secret"}`, `{"kind":"person","member_id":2,"via":"web"}`, `{"kind":"person","member_id":"1","via":"web"}`} {
		_, err := decodeActorIdentity([]byte(raw), digest[:])
		require.ErrorIs(t, err, ErrUnauthorized)
	}
	_, err = decodeActorIdentity(raw, nil)
	require.ErrorIs(t, err, ErrUnauthorized)
}

func TestActorReferenceScopeAndUnavailableTransaction(t *testing.T) {
	branch := "abcdef12-1234-4234-a234-123456789abc"
	a := ActorIdentity{Kind: "person", MemberID: 1, Via: "web"}
	for _, scope := range [][2]string{{"", "vm"}, {uuid.Nil.String(), "vm"}, {strings.ToUpper(branch), "vm"}, {branch, ""}, {branch, "vm\x00"}, {branch, strings.Repeat("v", 1025)}} {
		require.ErrorIs(t, actorScope(scope[0], scope[1]), ErrUnauthorized)
	}
	require.NoError(t, actorScope(branch, "vm"))
	_, err := RecordActorInTx(t.Context(), nil, branch, "vm", a)
	require.ErrorIs(t, err, ErrNotReady)
	_, err = ResolveActorInTx(t.Context(), nil, branch, "vm", make([]byte, 16))
	require.ErrorIs(t, err, ErrNotReady)
}
