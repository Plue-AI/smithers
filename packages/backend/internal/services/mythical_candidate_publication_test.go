package services

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Replay uses real immutable Git objects, not a tree identity supplied by the
// request. None of these refusals may create a remote branch.
func TestCandidatePublicationReplayRefusesUnverifiedOrDifferentTrees(t *testing.T) {
	for _, tc := range []struct {
		name           string
		verified, same bool
		want           string
	}{
		{"unverified", false, true, "no verified candidate"},
		{"different tree", true, false, "differs from the verified candidate"},
		{"protected path", true, true, "a maintainer changes protected paths"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMythicalFixture(t)
			base := f.commit("main", map[string]string{"a": "original\n"})
			candidate := f.commit("checked", map[string]string{".github/workflows/push.yml": "on: push\n"})
			proposal := candidate
			if !tc.same {
				proposal = f.commit("unchecked", map[string]string{"a": "unverified\n"})
			}
			service := &MythicalService{publication: &mythicalPublication{}, prFacts: func(context.Context, db.MythicalItem) (mythicalPRShape, error) { return mythicalPRShape{}, nil }}
			step := &mythicalItemStep{s: service, r: &mythicalRun{g: f.git, mainTip: base, owner: "fixture", repo: filepath.Base(f.root)}}
			item := db.MythicalItem{Outsider: true, CandidateBase: base, CandidateHead: candidate, CandidateVerified: tc.verified, Checks: (mythicalChecks{Branch: "smithers/test"}).encode()}
			err := step.pushProposal(t.Context(), item, mythicalGitHubRepo{GitURL: "http://127.0.0.1:1/unreachable"}, mythicalProposalOp{Branch: "smithers/test", Head: proposal})
			require.ErrorContains(t, err, tc.want)
		})
	}
}

func TestCandidatePublicationUsesCurrentMainPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, policy, want string
		outsider           bool
	}{
		{"unreadable policy", "{broken", ".smithers/factory.json", true},
		{"trusted protected path", `{"github":{"protectedPaths":["a"]}}`, "a maintainer changes protected paths: a", true},
		{"insider control", "{broken", "read the pull request branch", false},
		{"equal tree distinct commit", `{}`, "read the pull request branch", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMythicalFixture(t)
			base := f.commit("main", map[string]string{"a": "original\n", factoryProjectionPath: tc.policy})
			candidate := f.commit("checked", map[string]string{"a": "checked\n"})
			observed, err := f.git.readCommit(t.Context(), candidate)
			require.NoError(t, err)
			observed.Parents = []string{base}
			observed.Message = "PR commit with equal tree\n"
			proposal, err := f.git.writeCommit(t.Context(), observed)
			require.NoError(t, err)
			require.NotEqual(t, candidate, proposal)
			service := &MythicalService{publication: &mythicalPublication{}, prFacts: func(context.Context, db.MythicalItem) (mythicalPRShape, error) { return mythicalPRShape{}, nil }}
			step := &mythicalItemStep{s: service, r: &mythicalRun{g: f.git, mainTip: base, owner: "fixture", repo: filepath.Base(f.root)}}
			item := db.MythicalItem{Outsider: tc.outsider, CandidateBase: base, CandidateHead: candidate, CandidateVerified: true, Checks: (mythicalChecks{Branch: "smithers/test"}).encode()}
			err = step.pushProposal(t.Context(), item, mythicalGitHubRepo{GitURL: "http://127.0.0.1:1/unreachable"}, mythicalProposalOp{Branch: "smithers/test", Head: proposal})
			require.ErrorContains(t, err, tc.want)
		})
	}
}

func TestCandidatePublicationEqualTreePush(t *testing.T) {
	f := newMythicalFixture(t)
	base := f.commit("main", map[string]string{"a": "original\n"})
	candidate := f.commit("checked", map[string]string{"a": "checked\n"})
	observed, err := f.git.readCommit(t.Context(), candidate)
	require.NoError(t, err)
	observed.Message = "PR head\n"
	proposal, err := f.git.writeCommit(t.Context(), observed)
	require.NoError(t, err)
	require.NotEqual(t, candidate, proposal)
	remote := filepath.Join(t.TempDir(), "github.git")
	f.run("init", "--quiet", "--bare", remote)
	service := &MythicalService{publication: &mythicalPublication{}, prFacts: func(context.Context, db.MythicalItem) (mythicalPRShape, error) { return mythicalPRShape{}, nil }}
	step := &mythicalItemStep{s: service, r: &mythicalRun{g: f.git, mainTip: base, owner: "fixture", repo: filepath.Base(f.root)}}
	item := db.MythicalItem{Outsider: true, CandidateBase: base, CandidateHead: candidate, CandidateVerified: true, Checks: (mythicalChecks{Branch: "smithers/test"}).encode()}
	op := mythicalProposalOp{Branch: "smithers/test", Head: proposal}
	item = bindCandidatePublicationClaim(t, step, item)
	require.NoError(t, step.pushProposal(t.Context(), item, mythicalGitHubRepo{GitURL: remote}, op))
	// Observe GitHub independently rather than reading the candidate helper.
	require.Equal(t, "checked", f.run("--git-dir", remote, "show", "refs/heads/smithers/test:a"))
	require.Equal(t, f.tree(candidate), f.run("--git-dir", remote, "rev-parse", "refs/heads/smithers/test^{tree}"))
	// Replaying the same intent settles the already-published head.
	require.NoError(t, step.pushProposal(t.Context(), item, mythicalGitHubRepo{GitURL: remote}, op))
	require.Equal(t, proposal, f.run("--git-dir", remote, "rev-parse", "refs/heads/smithers/test"))
}

func TestCandidatePublicationReplayOnMovedPrefix(t *testing.T) {
	f := newMythicalFixture(t)
	base := f.commit("main", map[string]string{"a": "original\n"})
	candidate := f.commit("checked", map[string]string{"a": "checked\n"})
	remote := filepath.Join(t.TempDir(), "github.git")
	f.run("init", "--quiet", "--bare", remote)
	service := &MythicalService{publication: &mythicalPublication{}, prFacts: func(context.Context, db.MythicalItem) (mythicalPRShape, error) { return mythicalPRShape{}, nil }}
	step := &mythicalItemStep{s: service, r: &mythicalRun{g: f.git, mainTip: base}}
	item := db.MythicalItem{CandidateBase: base, CandidateHead: candidate, CandidateVerified: true, Checks: (mythicalChecks{Branch: "smithers/test"}).encode()}
	op := mythicalProposalOp{Branch: "smithers/test", Head: candidate}
	gh := mythicalGitHubRepo{GitURL: remote}
	item = bindCandidatePublicationClaim(t, step, item)
	step.r.mainTip = f.commit("main moved", map[string]string{"b": "new main\n"})
	require.ErrorContains(t, step.pushProposal(t.Context(), item, gh, op), "rebase_pending")
	require.Empty(t, f.run("--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "a recorded intent must not push after main moved")
	step.r.mainTip = base
	require.NoError(t, step.pushProposal(t.Context(), item, gh, op))
	step.r.mainTip = "new-main"
	require.NoError(t, step.pushProposal(t.Context(), item, gh, op), "settle the effect committed before the crash without a second push")
	require.Equal(t, candidate, f.run("--git-dir", remote, "rev-parse", "refs/heads/smithers/test"))
	require.Equal(t, "checked", f.run("--git-dir", remote, "show", "refs/heads/smithers/test:a"))
}

// Positive publication fixtures carry the same live PostgreSQL claim as the
// worker. Object equality alone never grants permission to write a branch.
func bindCandidatePublicationClaim(t *testing.T, step *mythicalItemStep, item db.MythicalItem) db.MythicalItem {
	t.Helper()
	f := newMythicalServiceFixture(t)
	ctx := t.Context()
	q := db.New(f.pool)
	_, err := q.RequestMythicalBootstrap(ctx, f.repoID, f.userID, 1, false)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET running=true,claim=1,landed_main=$2,lease_expires_at=now()+interval '1 minute' WHERE repository_id=$1`, f.repoID, item.CandidateBase)
	require.NoError(t, err)
	var id pgtype.UUID
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,candidate_base,candidate_head,candidate_verified,outsider,checks) VALUES($1,'todo','proposing','Candidate',$2,$3,true,$4,$5) RETURNING id`, f.repoID, item.CandidateBase, item.CandidateHead, item.Outsider, item.Checks).Scan(&id))
	saved, err := q.GetMythicalItem(ctx, id)
	require.NoError(t, err)
	step.s.store = f.pool
	step.r.row, err = q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	return saved
}

func TestCandidatePushRefusesMissingClaimStore(t *testing.T) {
	for _, service := range []*MythicalService{nil, {}} {
		step := &mythicalItemStep{s: service}
		err := step.pushCurrentProposal(t.Context(), db.MythicalItem{}, func() error { t.Fatal("unbound publication reached GitHub"); return nil })
		require.ErrorContains(t, err, "claim store is unavailable")
	}
}
