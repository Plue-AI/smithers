package services

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestCleanRebaseRetainsOnlyTheSameReviewedPatch(t *testing.T) {
	f := newMythicalFixture(t)
	base := f.commit("base", map[string]string{"code": "before\n"})
	first := f.commit("reviewed work", map[string]string{"code": "after\n"})
	f.run("checkout", "--quiet", "--detach", base)
	onto := f.commit("new main", map[string]string{"main": "new main bytes\n"})
	f.run("cherry-pick", first)
	rebased := f.run("rev-parse", "HEAD")
	changed := f.commit("resolution changes work", map[string]string{"code": "different\n"})
	item := db.MythicalItem{CandidateBase: base, CandidateHead: first, PRHead: first}
	checks := mythicalChecks{Review: &mythicalReview{Head: first, Candidate: first, RunID: "original-review", Verdict: "approve", Posted: true}}
	item.Checks = checks.encode()
	st := mythicalItemStep{r: &mythicalRun{g: f.git}}
	retained, err := st.cleanRebaseReview(t.Context(), item, onto, rebased)
	require.NoError(t, err)
	require.NotNil(t, retained)
	require.Equal(t, first, retained.Head, "the original attestation is never rewritten")
	require.Equal(t, first, retained.Candidate)
	require.Equal(t, "original-review", retained.RunID)
	require.False(t, retained.Posted)
	current := item
	current.CandidateBase, current.CandidateHead, current.PRHead = onto, rebased, rebased
	require.False(t, mythicalReviewCurrent(retained, current), "publication must bind the new PR head")
	retained.Rebase.Head = rebased
	require.True(t, mythicalReviewCurrent(retained, current))
	for _, mutate := range []func(*db.MythicalItem){
		func(i *db.MythicalItem) { i.PRHead = first },
		func(i *db.MythicalItem) { i.PRHead = changed },
		func(i *db.MythicalItem) { i.CandidateHead = changed },
		func(i *db.MythicalItem) { i.CandidateBase = base },
	} {
		wrong := current
		mutate(&wrong)
		require.False(t, mythicalReviewCurrent(retained, wrong))
	}
	refused, err := st.cleanRebaseReview(t.Context(), item, onto, changed)
	require.NoError(t, err)
	require.Nil(t, refused, "changed work requires review")
	checks.ConflictReservation = &todoConflictReservation{Change: first, Onto: onto}
	item.Checks = checks.encode()
	refused, err = st.cleanRebaseReview(t.Context(), item, onto, rebased)
	require.NoError(t, err)
	require.Nil(t, refused, "a resolved conflict is new work even if its patch matches")
	for name, review := range map[string]*mythicalReview{
		"missing":         nil,
		"unfinished":      {Head: first, Candidate: first, RunID: "review"},
		"failed":          {Head: first, Candidate: first, RunID: "review", Verdict: "failed"},
		"unbound run":     {Head: first, Candidate: first, Verdict: "approve"},
		"other candidate": {Head: first, Candidate: changed, RunID: "review", Verdict: "approve"},
	} {
		t.Run(name, func(t *testing.T) {
			item.Checks = (mythicalChecks{Review: review}).encode()
			refused, err := st.cleanRebaseReview(t.Context(), item, onto, rebased)
			require.NoError(t, err)
			require.Nil(t, refused)
		})
	}
	current.Checks = (mythicalChecks{Review: retained}).encode()
	f.run("checkout", "--quiet", "--detach", onto)
	nextBase := f.commit("main moves again", map[string]string{"next-main": "another main change\n"})
	f.run("cherry-pick", rebased)
	nextHead := f.run("rev-parse", "HEAD")
	repeated, err := st.cleanRebaseReview(t.Context(), current, nextBase, nextHead)
	require.NoError(t, err)
	require.NotNil(t, repeated)
	require.Equal(t, first, repeated.Head)
	require.Equal(t, "original-review", repeated.RunID)
	require.Equal(t, nextHead, repeated.Rebase.Candidate)
	current.Checks = (mythicalChecks{Review: retained, ConflictReservation: &todoConflictReservation{Change: first, Onto: onto}}).encode()
	historical, err := st.cleanRebaseReview(t.Context(), current, nextBase, nextHead)
	require.NoError(t, err)
	require.NotNil(t, historical, "a spent reservation for an earlier target does not make a later clean rebase new work")
	retained.Rebase.PatchID = "another-patch"
	current.Checks = (mythicalChecks{Review: retained}).encode()
	refused, err = st.cleanRebaseReview(t.Context(), current, nextBase, nextHead)
	require.NoError(t, err)
	require.Nil(t, refused, "a mismatched retained patch cannot extend review continuity")
	_, err = f.git.stablePatchID(t.Context(), "main", rebased)
	require.Error(t, err, "mutable names cannot attest patch equivalence")
	_, err = f.git.stablePatchID(t.Context(), "0000000000000000000000000000000000000000", rebased)
	require.Error(t, err, "absent objects cannot attest patch equivalence")
	empty, err := f.git.stablePatchID(t.Context(), base, base)
	require.NoError(t, err)
	require.Equal(t, "empty", empty)
}

func TestStableRebasePatchNeverExecutesRepositoryTextconv(t *testing.T) {
	f := newMythicalFixture(t)
	sentinel := filepath.Join(t.TempDir(), "outside-sentinel")
	t.Setenv("SMITHERS_TEST_TEXTCONV_SENTINEL", sentinel)
	driver := filepath.Join(t.TempDir(), "textconv")
	require.NoError(t, os.WriteFile(driver, []byte("#!/bin/sh\n: > \"$SMITHERS_TEST_TEXTCONV_SENTINEL\"\ncat \"$1\"\n"), 0700))
	f.run("config", "core.worktree", f.root)
	f.run("config", "diff.branch.textconv", driver)
	base := f.commit("base", map[string]string{".gitattributes": "*.txt diff=branch\n", "code.txt": "before\n"})
	head := f.commit("candidate", map[string]string{"code.txt": "after\n"})
	patch, err := f.git.stablePatchID(t.Context(), base, head)
	require.NoError(t, err)
	require.Regexp(t, "^[0-9a-f]{40}$", patch)
	require.NoFileExists(t, sentinel, "host patch identity must not execute a branch-selected helper")
}
