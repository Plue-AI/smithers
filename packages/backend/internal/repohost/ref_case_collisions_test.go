package repohost

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPlanRefCaseCollisions(t *testing.T) {
	refs := []string{
		"refs/heads/Mythical", "refs/notes/MYTHICAL",
		"refs/heads/MAIN",
		"refs/heads/release/1", "refs/heads/Release/1",
		"refs/heads/Feature", "refs/heads/feature",
		"refs/heads/Hotfix", "refs/heads/HOTFIX",
		"refs/heads/mythical​/x",
		"refs/heads/ok",
	}
	got := PlanRefCaseCollisions(refs, "main", []string{"release/*", "hotfix*"})
	require.Equal(t, []RefCaseCollision{
		{Refs: []string{"refs/heads/Feature", "refs/heads/feature"}, Action: RefCaseCollisionReported},
		// Two variants of a missing protected name: the owner picks one.
		{Refs: []string{"refs/heads/HOTFIX", "refs/heads/Hotfix"}, Action: RefCaseCollisionReported},
		{Refs: []string{"refs/heads/MAIN"}, Canonical: "refs/heads/main", Action: RefCaseCollisionRenamed, Variants: []string{"refs/heads/MAIN"}},
		// A missing mythical ref is never filled from a variant.
		{Refs: []string{"refs/heads/Mythical"}, Canonical: "refs/heads/mythical", Action: RefCaseCollisionRemoved, Variants: []string{"refs/heads/Mythical"}},
		{Refs: []string{"refs/heads/Release/1", "refs/heads/release/1"}, Canonical: "refs/heads/release/1", Action: RefCaseCollisionRemoved, Variants: []string{"refs/heads/Release/1"}},
		{Refs: []string{"refs/heads/mythical​/x"}, Canonical: "refs/heads/mythical", Action: RefCaseCollisionRemoved, Variants: []string{"refs/heads/mythical​/x"}},
		{Refs: []string{"refs/notes/MYTHICAL"}, Canonical: "refs/notes/mythical", Action: RefCaseCollisionRemoved, Variants: []string{"refs/notes/MYTHICAL"}},
	}, got)

	// Canonical names alone, and a repository without a default, are clean.
	require.Empty(t, PlanRefCaseCollisions([]string{"refs/heads/main", "refs/heads/mythical", "refs/notes/mythical", "refs/heads/mythical-x"}, "main", nil))
	require.Equal(t, RefCaseCollisionRemoved, PlanRefCaseCollisions([]string{"refs/heads/Mythical"}, "", nil)[0].Action)
	// A directory variant beside the existing reserved ref blocks nothing.
	require.Equal(t, []RefCaseCollision{{Refs: []string{"refs/heads/Main/x"}, Canonical: "refs/heads/main", Action: RefCaseCollisionReported}},
		PlanRefCaseCollisions([]string{"refs/heads/main", "refs/heads/Main/x"}, "main", nil))
	require.Equal(t, "refs/smithers/case-collision/20260927T000000Z/0/heads/MAIN", RefCaseCollisionBackup("20260927T000000Z", 0, "refs/heads/MAIN"))
}
