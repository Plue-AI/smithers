package services

import (
	"context"
	"testing"

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
	require.Equal(t, profile, *read.Profile)
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

	_, err = service.Put(ctx, ada, SignupProfile{Name: "Ada", Account: "Ada Park", Stage: "poll"})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodeValidationFailed, apiErr.Code)
	read, err = service.Get(ctx, ada)
	require.NoError(t, err)
	require.Equal(t, "ada", read.Profile.Account, "a refused write keeps the saved profile")

	_, err = pool.Exec(ctx, `UPDATE onboarding_answers SET answers = '{"name": 1}' WHERE user_id = $1`, ada)
	require.NoError(t, err)
	_, err = service.Get(ctx, ada)
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodeInternal, apiErr.Code)
}
