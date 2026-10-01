package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The signup profile against the product database: onboarding_answers keeps
// one document per user, a write replaces it, and nobody reads another
// user's row.
func TestSignupProfileServicePersistsInOnboardingAnswers(t *testing.T) {
	pool := setupTestPool(t)
	ctx := context.Background()
	ada, _ := setupTestUserAndRepo(t, pool)
	bob, _ := setupTestUserAndRepo(t, pool)
	service := NewSignupProfileService(db.New(pool))

	empty, err := service.Get(ctx, ada)
	require.NoError(t, err)
	require.Nil(t, empty.Profile)
	require.Nil(t, empty.UpdatedAt)

	profile := SignupProfile{Name: "Ada Park", Account: "adapark", Stage: "poll", Question: 5, Repo: "new", Answers: map[string]SignupAnswer{
		"size": {One: "2–10"}, "models": {Many: []string{"Codex", "Claude"}, many: true}, "none": {many: true},
	}}
	saved, err := service.Put(ctx, ada, profile)
	require.NoError(t, err)
	require.NotNil(t, saved.UpdatedAt)

	read, err := service.Get(ctx, ada)
	require.NoError(t, err)
	// The nil multi-choice input has the canonical [] representation on disk.
	expected := profile
	expected.Answers = map[string]SignupAnswer{
		"size": {One: "2–10"}, "models": {Many: []string{"Codex", "Claude"}, many: true}, "none": {Many: []string{}, many: true},
	}
	require.Equal(t, expected, *read.Profile)
	require.Equal(t, *saved.UpdatedAt, *read.UpdatedAt)
	var stored string
	require.NoError(t, pool.QueryRow(ctx, `SELECT answers::text FROM onboarding_answers WHERE user_id = $1`, ada).Scan(&stored))
	require.JSONEq(t, `{"name":"Ada Park","account":"adapark","stage":"poll","question":5,"repo":"new","answers":{"size":"2–10","models":["Codex","Claude"],"none":[]}}`, stored)

	other, err := service.Get(ctx, bob)
	require.NoError(t, err)
	require.Nil(t, other.Profile)

	replaced := SignupProfile{Name: "Ada Park", Account: "ada", Stage: "done", Question: 6}
	_, err = service.Put(ctx, ada, replaced)
	require.NoError(t, err)
	read, err = service.Get(ctx, ada)
	require.NoError(t, err)
	replaced.Answers = map[string]SignupAnswer{}
	require.Equal(t, replaced, *read.Profile)
	beforeRefused := read

	_, err = service.Put(ctx, ada, SignupProfile{Name: "Ada", Account: "Ada Park", Stage: "poll"})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodeValidationFailed, apiErr.Code)
	read, err = service.Get(ctx, ada)
	require.NoError(t, err)
	require.Equal(t, "ada", read.Profile.Account, "a refused write keeps the saved profile")
	require.Equal(t, beforeRefused, read, "a refused write preserves the whole profile and timestamp")

	_, err = pool.Exec(ctx, `UPDATE onboarding_answers SET answers = '{"name": 1}' WHERE user_id = $1`, ada)
	require.NoError(t, err)
	_, err = service.Get(ctx, ada)
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodeInternal, apiErr.Code)
}

func TestSignupProfileAnswersCanonicalPostgresRoundtrip(t *testing.T) {
	pool := setupTestPool(t)
	ctx := context.Background()
	service := NewSignupProfileService(db.New(pool))
	cases := []struct {
		name      string
		input     SignupAnswer
		canonical SignupAnswer
		wire      string
	}{
		{"nil choices", SignupAnswer{many: true}, SignupAnswer{Many: []string{}, many: true}, `[]`},
		{"empty choices", SignupAnswer{Many: []string{}, many: true}, SignupAnswer{Many: []string{}, many: true}, `[]`},
		{"nonempty choices", SignupAnswer{Many: []string{"Codex", "Claude"}, many: true}, SignupAnswer{Many: []string{"Codex", "Claude"}, many: true}, `["Codex","Claude"]`},
		{"single choice", SignupAnswer{One: "2–10"}, SignupAnswer{One: "2–10"}, `"2–10"`},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			owner, _ := setupTestUserAndRepo(t, pool)
			profile := SignupProfile{Name: "Ada Park", Account: "adapark", Stage: "poll", Question: 5, Repo: "new", Answers: map[string]SignupAnswer{"choice": tt.input}}
			canonical := profile
			canonical.Answers = map[string]SignupAnswer{"choice": tt.canonical}
			wantDocument := fmt.Sprintf(`{"name":"Ada Park","account":"adapark","stage":"poll","question":5,"answers":{"choice":%s},"repo":"new"}`, tt.wire)

			// Both caller-side nil and empty slices have the same exact public JSON.
			requestWire, err := json.Marshal(profile)
			require.NoError(t, err)
			require.Equal(t, wantDocument, string(requestWire))
			var decodedRequest SignupProfile
			require.NoError(t, json.Unmarshal(requestWire, &decodedRequest))
			require.Equal(t, canonical, decodedRequest)

			saved, err := service.Put(ctx, owner, profile)
			require.NoError(t, err)
			require.Equal(t, profile, *saved.Profile, "the write receipt preserves the caller's Go value")
			require.NotNil(t, saved.UpdatedAt)
			require.Equal(t, time.UTC, saved.UpdatedAt.Location())
			read, err := service.Get(ctx, owner)
			require.NoError(t, err)
			require.Equal(t, canonical, *read.Profile)
			require.Equal(t, *saved.UpdatedAt, *read.UpdatedAt)
			var stored string
			require.NoError(t, pool.QueryRow(ctx, `SELECT answers::text FROM onboarding_answers WHERE user_id = $1`, owner).Scan(&stored))
			require.JSONEq(t, wantDocument, stored)

			wantReceipt := fmt.Sprintf(`{"profile":%s,"updated_at":%q}`, wantDocument, saved.UpdatedAt.Format(time.RFC3339Nano))
			for _, receipt := range []SignupProfileReceipt{saved, read} {
				wire, err := json.Marshal(receipt)
				require.NoError(t, err)
				require.Equal(t, wantReceipt, string(wire), "PUT and GET expose the same complete JSON receipt")
				var decoded SignupProfileReceipt
				require.NoError(t, json.Unmarshal(wire, &decoded))
				require.Equal(t, read, decoded)
				roundtrip, err := json.Marshal(decoded)
				require.NoError(t, err)
				require.Equal(t, string(wire), string(roundtrip))
			}
		})
	}
}
