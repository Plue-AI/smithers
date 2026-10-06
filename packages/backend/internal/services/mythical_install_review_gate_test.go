package services

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestInstallReviewGateDoesNotGrantLegacyAutomerge(t *testing.T) {
	o := newMythicalOrchestration(t)
	o.service.installGitHubPolling = true
	item := db.MythicalItem{State: "proposed", PRHead: "head", Checks: mythicalChecks{Todo: true, Automerge: true, Review: &mythicalReview{Head: "head", Verdict: "approve", Posted: true}}.encode()}
	step := &mythicalItemStep{s: o.service, gh: &mythicalGitHubRepo{}}
	next, saved, err := step.gate(t.Context(), item)
	require.NoError(t, err)
	require.False(t, saved)
	require.Equal(t, item, *next)
	require.Empty(t, o.github.merges, "only the person's head-bound merge approval may merge an installed TODO")
}
