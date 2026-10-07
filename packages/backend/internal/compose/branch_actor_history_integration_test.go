package compose

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestBranchActorHistoryResolvesAbsentSponsors(t *testing.T) {
	f := presenceInstall(t)
	// Historical users are retained independently of current membership. The
	// caller is the authorized owner; the edit's sponsor is absent from the roster.
	person, err := f.p.queries.CreateUser(t.Context(), db.CreateUserParams{Username: "former-member", LowerUsername: "former-member", DisplayName: "Former Member"})
	require.NoError(t, err)
	topics := &liveTopics{presence: f.p}
	for _, kind := range []string{"coding", "reviewer", "external"} {
		raw := json.RawMessage(fmt.Sprintf(`{"kind":"agent","id":"run:old-attempt","run_id":"old-attempt","agent_kind":%q,"for_member":%q}`, kind, fmt.Sprint(person.ID)))
		resolve := topics.changeActorResolver(t.Context())
		rendered, err := resolve(raw)
		require.NoError(t, err)
		var actor map[string]any
		require.NoError(t, json.Unmarshal(rendered, &actor))
		require.Equal(t, "agent", actor["kind"])
		require.Equal(t, kind, actor["agent"])
		require.Equal(t, "old-attempt", actor["run_id"])
		require.Equal(t, "run:old-attempt", actor["id"])
		require.NotEmpty(t, actor["avatar_url"])
		require.Equal(t, float64(0), actor["color_index"])
		sponsor := actor["for_member"].(map[string]any)
		require.Equal(t, "former-member", sponsor["login"])
		require.Equal(t, "Former Member", sponsor["name"])
		require.NotEmpty(t, sponsor["avatar_url"])
		cached, err := resolve(raw)
		require.NoError(t, err)
		require.JSONEq(t, string(rendered), string(cached))
	}
	for _, raw := range []string{`{"kind":"outside","color_index":7}`, `{"kind":"agent","id":"old","agent":"coding","avatar_url":"/avatar.svg","color_index":6}`} {
		got, err := topics.changeActorResolver(t.Context())(json.RawMessage(raw))
		require.NoError(t, err)
		require.JSONEq(t, raw, string(got))
	}
	_, err = topics.changeActorResolver(t.Context())(json.RawMessage(`{"kind":"agent","for_member":"999999","agent_kind":"coding","run_id":"r","id":"run:r"}`))
	require.Error(t, err)
}
