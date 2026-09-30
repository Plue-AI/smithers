package repohost

import (
	"fmt"
	"sort"
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

func TestPlanRefCaseCollisionsDirectoryVariants(t *testing.T) {
	for _, name := range []string{"Main", "main"} {
		for _, present := range []bool{false, true} {
			for _, reverse := range []bool{false, true} {
				canonical := "refs/heads/" + name
				variant := "refs/heads/Main/x"
				if name == "Main" {
					variant = "refs/heads/main/x"
				}
				refs := []string{canonical + "/x", variant}
				sort.Strings(refs)
				want := RefCaseCollision{Refs: append([]string(nil), refs...), Action: RefCaseCollisionReported}
				if present {
					refs = append(refs, canonical)
				}
				if reverse {
					for i, j := 0, len(refs)-1; i < j; i, j = i+1, j-1 {
						refs[i], refs[j] = refs[j], refs[i]
					}
				}
				t.Run(name+"/present="+fmt.Sprint(present)+"/reverse="+fmt.Sprint(reverse), func(t *testing.T) {
					require.Equal(t, []RefCaseCollision{want}, PlanRefCaseCollisions(refs, name, nil))
				})
			}
		}
	}
	require.Equal(t, []RefCaseCollision{{Refs: []string{"refs/heads/MAIN/x", "refs/heads/Main/x"}, Canonical: "refs/heads/main",
		Action: RefCaseCollisionRemoved, Variants: []string{"refs/heads/MAIN/x", "refs/heads/Main/x"}}},
		PlanRefCaseCollisions([]string{"refs/heads/Main/x", "refs/heads/MAIN/x"}, "main", nil))
	// Ordinary names remain the owner's decision; a canonical directory alone
	// is never removed to make room for a reserved ref.
	require.Equal(t, []RefCaseCollision{{Refs: []string{"refs/heads/Feature/x", "refs/heads/feature/x"}, Action: RefCaseCollisionReported}},
		PlanRefCaseCollisions([]string{"refs/heads/feature/x", "refs/heads/Feature/x"}, "main", nil))
	require.Empty(t, PlanRefCaseCollisions([]string{"refs/heads/main/x"}, "main", nil))
	// Nested reserved names can make different spellings variants of different
	// refs. Leave those ambiguous groups to the owner.
	require.Equal(t, []RefCaseCollision{{Refs: []string{"refs/heads/Mythical/x/y", "refs/heads/mythical/X/y"}, Action: RefCaseCollisionReported}},
		PlanRefCaseCollisions([]string{"refs/heads/Mythical/x/y", "refs/heads/mythical/X/y"}, "mythical/x", nil))
}

func TestPlanRefCaseCollisionsMythicalDefault(t *testing.T) {
	for _, name := range []string{"mythical", "Mythical", "MYTHICAL"} {
		for _, present := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/present=%t", name, present), func(t *testing.T) {
				refs := []string{"refs/heads/Mythical", "refs/heads/MYTHICAL"}
				if present {
					refs = append(refs, "refs/heads/mythical")
				}
				sort.Strings(refs)
				require.Equal(t, []RefCaseCollision{{Refs: refs, Canonical: MythicalBookmarkRef, Action: RefCaseCollisionRemoved, Variants: []string{"refs/heads/MYTHICAL", "refs/heads/Mythical"}}}, PlanRefCaseCollisions(refs, name, nil))
			})
		}
	}
}
