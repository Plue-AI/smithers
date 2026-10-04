package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func TestTODOPrBodyUsesAcceptedFacts(t *testing.T) {
	p := mythicalPRShape{Branch: "smithers/retry-webhooks", Title: "Retry webhooks", Prompt: "Latest prompt fixes #7", Acceptance: "Retry once", Evidence: "| Check | Result |\n| unit | passed |", DiffStat: "1 file changed", Review: "Reviewed", URL: "http://localhost/todos/2", Owner: "ben", Included: []mythicalPRIncluded{{Number: 1, URL: "https://github.com/o/r/pull/7"}}}
	title, body, err := p.render()
	require.NoError(t, err)
	require.Equal(t, "Retry webhooks", title)
	require.Equal(t, "Latest prompt Refs #7\n\nRetry once\n\n| Check | Result |\n| unit | passed |\n\n1 file changed\n\nReviewed\n\nIncludes [T1](https://github.com/o/r/pull/7) until they merge\n\nhttp://localhost/todos/2\n\nRequested by @ben", body)
	p.Prompt = "Amended prompt"
	p.Included = nil
	_, body, err = p.render()
	require.NoError(t, err)
	require.NotContains(t, body, "Latest prompt")
	require.NotContains(t, body, "Includes")
	p.Evidence = strings.Repeat("界", 30000)
	_, body, err = p.render()
	require.NoError(t, err)
	require.Less(t, len(body), 65536)
	require.True(t, utf8.ValidString(body))
	require.True(t, strings.HasSuffix(body, "Requested by @ben"))
	p.Prompt = strings.Repeat("x", 65536)
	_, _, err = p.render()
	require.Error(t, err)
	for _, branch := range []string{"", "smithers/../main", "main", "smithers/Upper", "smithers/a.lock", "smithers/a/b"} {
		p.Branch = branch
		_, _, err = p.render()
		require.Error(t, err, branch)
	}
	p.Branch = "smithers/retry-webhooks"
	p.Prompt = "Prompt"
	p.Included = []mythicalPRIncluded{{Number: 0, URL: "https://github.com/o/r/pull/7"}}
	_, _, err = p.render()
	require.Error(t, err)
}

func TestTODOPrLifecycleDecision(t *testing.T) {
	now := time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		fact mythicalGitHubFact
		item mythicalGitHubFactItem
		want mythicalGitHubFactDecision
	}{
		{"merge", mythicalGitHubFact{Kind: "merged", OnMain: true, MergeCommit: "sha"}, mythicalGitHubFactItem{State: "in_review"}, mythicalGitHubFactDecision{Event: "merged"}},
		{"dropped containment exception", mythicalGitHubFact{Kind: "merged", OnMain: true, MergeCommit: "sha"}, mythicalGitHubFactItem{State: "dropped"}, mythicalGitHubFactDecision{Event: "merged"}},
		{"duplicate merge", mythicalGitHubFact{Kind: "merged", OnMain: true, MergeCommit: "sha"}, mythicalGitHubFactItem{State: "merged"}, mythicalGitHubFactDecision{Noop: "already_merged"}},
		{"not on main", mythicalGitHubFact{Kind: "merged", MergeCommit: "sha"}, mythicalGitHubFactItem{State: "paused"}, mythicalGitHubFactDecision{Noop: "merge_not_on_main"}},
		{"missing commit", mythicalGitHubFact{Kind: "merged", OnMain: true}, mythicalGitHubFactItem{State: "working"}, mythicalGitHubFactDecision{Noop: "merge_not_on_main"}},
		{"close", mythicalGitHubFact{Kind: "closed"}, mythicalGitHubFactItem{State: "failed"}, mythicalGitHubFactDecision{Event: "dropped"}},
		{"duplicate close", mythicalGitHubFact{Kind: "closed"}, mythicalGitHubFactItem{State: "dropped"}, mythicalGitHubFactDecision{Noop: "already_closed"}},
		{"day six", mythicalGitHubFact{Kind: "reopened"}, mythicalGitHubFactItem{State: "dropped", ClosedAt: now.Add(-6 * 24 * time.Hour)}, mythicalGitHubFactDecision{Event: "in_review"}},
		{"day seven inclusive", mythicalGitHubFact{Kind: "reopened"}, mythicalGitHubFactItem{State: "dropped", ClosedAt: now.Add(-7 * 24 * time.Hour)}, mythicalGitHubFactDecision{Event: "in_review"}},
		{"one nanosecond late", mythicalGitHubFact{Kind: "reopened"}, mythicalGitHubFactItem{State: "dropped", ClosedAt: now.Add(-7*24*time.Hour - time.Nanosecond)}, mythicalGitHubFactDecision{Noop: "reopen_window_expired"}},
		{"day eight", mythicalGitHubFact{Kind: "reopened"}, mythicalGitHubFactItem{State: "dropped", ClosedAt: now.Add(-8 * 24 * time.Hour)}, mythicalGitHubFactDecision{Noop: "reopen_window_expired"}},
		{"unknown close time", mythicalGitHubFact{Kind: "reopened"}, mythicalGitHubFactItem{State: "dropped"}, mythicalGitHubFactDecision{Noop: "reopen_window_expired"}},
		{"future close time", mythicalGitHubFact{Kind: "reopened"}, mythicalGitHubFactItem{State: "dropped", ClosedAt: now.Add(time.Hour)}, mythicalGitHubFactDecision{Noop: "reopen_window_expired"}},
		{"duplicate reopen", mythicalGitHubFact{Kind: "reopened"}, mythicalGitHubFactItem{State: "in_review"}, mythicalGitHubFactDecision{Noop: "not_dropped"}},
		{"terminal absorbs close", mythicalGitHubFact{Kind: "closed"}, mythicalGitHubFactItem{State: "merged"}, mythicalGitHubFactDecision{Noop: "terminal"}},
		{"foreign push", mythicalGitHubFact{Kind: "push", Head: "new"}, mythicalGitHubFactItem{State: "paused", Head: "old"}, mythicalGitHubFactDecision{Attention: "foreign_push"}},
		{"terminal push", mythicalGitHubFact{Kind: "push", Head: "new"}, mythicalGitHubFactItem{State: "dropped", Head: "old"}, mythicalGitHubFactDecision{Noop: "terminal"}},
		{"same head", mythicalGitHubFact{Kind: "push", Head: "old"}, mythicalGitHubFactItem{State: "working", Head: "old"}, mythicalGitHubFactDecision{Noop: "unchanged"}},
	} {
		t.Run(tc.name, func(t *testing.T) { require.Equal(t, tc.want, decideGitHubFact(tc.fact, tc.item, now)) })
	}
}

func TestTODOPrAdapterDraftBodyAndRefusal(t *testing.T) {
	gh := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"POST /repos/o/r/pulls":    answer(201, map[string]any{"number": 7, "node_id": "PR_7", "draft": true, "state": "open"}),
		"PATCH /repos/o/r/pulls/7": answer(200, map[string]any{}),
		"POST /graphql": answer(200, map[string]any{"data": map[string]any{
			"markPullRequestReadyForReview": map[string]any{"pullRequest": map[string]any{"id": "PR_7", "isDraft": false}},
			"convertPullRequestToDraft":     map[string]any{"pullRequest": map[string]any{"id": "PR_7", "isDraft": true}},
		}}),
	}}
	api := gh.api(t)
	ctx := context.Background()
	pull, err := api.CreatePull(ctx, stackRepo, "Title", "smithers/retry", "main", "Body", true)
	require.NoError(t, err)
	require.True(t, pull.Draft)
	require.Equal(t, "PR_7", pull.NodeID)
	require.NoError(t, api.UpdatePullBody(ctx, stackRepo, 7, "Latest body"))
	require.NoError(t, api.MarkReadyForReview(ctx, stackRepo, "PR_7"))
	require.NoError(t, api.ConvertToDraft(ctx, stackRepo, "PR_7"))
	require.Contains(t, gh.calls[0], `"draft":true`)
	require.Contains(t, gh.calls[2], "markPullRequestReadyForReview")
	require.Contains(t, gh.calls[3], "convertPullRequestToDraft")
	before := len(gh.calls)
	require.Error(t, api.ConvertToDraft(ctx, stackRepo, ""))
	require.Len(t, gh.calls, before)
	commit := mythicalMergeCommitText{Title: "Wave (#7)", Message: "TODO T3, reviewed at head."}
	for _, status := range []int{401, 403, 404, 405, 409, 422} {
		gh.mu.Lock()
		gh.routes["PUT /repos/o/r/pulls/7/merge"] = answer(status, map[string]any{"message": "1 approving review required on GitHub", "errors": []map[string]string{{"message": "protected branch"}, {"message": "head changed"}}})
		gh.mu.Unlock()
		_, err = api.Merge(ctx, stackRepo, 7, "head", commit)
		var refusal *GitHubRefusal
		require.ErrorAs(t, err, &refusal, "HTTP %d is GitHub refusing the merge", status)
		require.Equal(t, status, refusal.Status)
		raw, _ := json.Marshal(refusal)
		require.JSONEq(t, `{"code":"github_refused","class":"github","message":"1 approving review required on GitHub","errors":[{"message":"protected branch"},{"message":"head changed"}]}`, string(raw))
		require.Contains(t, gh.calls[len(gh.calls)-1], `{"commit_message":"TODO T3, reviewed at head.","commit_title":"Wave (#7)","merge_method":"squash","sha":"head"}`)
	}
	gh.mu.Lock()
	gh.routes["PUT /repos/o/r/pulls/7/merge"] = answer(403, map[string]any{})
	gh.mu.Unlock()
	_, err = api.Merge(ctx, stackRepo, 7, "head", commit)
	var bare *GitHubRefusal
	require.ErrorAs(t, err, &bare)
	require.Equal(t, "GitHub refused the merge (HTTP 403)", bare.Message, "a refusal without words still says what happened")
	for _, status := range []int{500, 502} {
		gh.mu.Lock()
		gh.routes["PUT /repos/o/r/pulls/7/merge"] = answer(status, map[string]any{"message": "Server Error"})
		gh.mu.Unlock()
		_, err = api.Merge(ctx, stackRepo, 7, "head", commit)
		require.Error(t, err)
		require.False(t, errors.As(err, &bare), "HTTP %d leaves the merge unknown", status)
	}
}

func TestTODOPrNamedChecksUseProtectionAndRules(t *testing.T) {
	gh := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"GET /repos/o/r/branches/main/protection":                                 answer(200, map[string]any{"required_status_checks": map[string]any{"contexts": []string{"unit"}}}),
		"GET /repos/o/r/rules/branches/main":                                      answer(200, []map[string]any{{"type": "required_status_checks", "parameters": map[string]any{"required_status_checks": []map[string]string{{"context": "integration"}}}}}),
		"GET /repos/o/r/commits/abc/check-runs?filter=latest&per_page=100&page=1": answer(200, map[string]any{"check_runs": []map[string]string{{"name": "unit", "status": "completed", "conclusion": "success"}}}),
		"GET /repos/o/r/commits/abc/statuses?per_page=100&page=1":                 answer(200, []map[string]string{{"context": "lint", "state": "success"}, {"context": "lint", "state": "failure"}}),
		"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1":             answer(200, map[string]any{"check_suites": []any{}}),
	}}
	api := gh.api(t)
	facts, err := api.HeadCheckFacts(context.Background(), stackRepo, "abc")
	require.NoError(t, err)
	require.Equal(t, []mythicalHeadCheck{{Name: "unit", State: "green", Required: true}, {Name: "lint", State: "green"}, {Name: "integration", State: "pending", Required: true}}, facts)
	verdict, err := api.HeadChecks(context.Background(), stackRepo, "abc")
	require.NoError(t, err)
	require.Equal(t, mythicalCIPending, verdict)
	// No classic protection is GitHub's 404 "Branch not protected": rulesets
	// still decide. Any other refusal leaves protection unknown.
	gh.mu.Lock()
	gh.routes["GET /repos/o/r/branches/main/protection"] = answer(404, map[string]any{"message": "Branch not protected"})
	gh.mu.Unlock()
	facts, err = api.HeadCheckFacts(context.Background(), stackRepo, "abc")
	require.NoError(t, err)
	require.Equal(t, []mythicalHeadCheck{{Name: "unit", State: "green"}, {Name: "lint", State: "green"}, {Name: "integration", State: "pending", Required: true}}, facts)
	for _, refused := range []struct {
		status  int
		message string
	}{{403, "Resource not accessible by integration"}, {404, "Not Found"}, {502, "Bad Gateway"}} {
		gh.mu.Lock()
		gh.routes["GET /repos/o/r/branches/main/protection"] = answer(refused.status, map[string]any{"message": refused.message})
		gh.mu.Unlock()
		_, err = api.HeadCheckFacts(context.Background(), stackRepo, "abc")
		require.Error(t, err, "HTTP %d %s is not an unprotected main", refused.status, refused.message)
	}
}

func TestTODOPrHostPublicationDisablesRepositoryPrograms(t *testing.T) {
	f := newMythicalFixture(t)
	base := f.commit("base", map[string]string{"first.txt": "first\n"})
	prefix := f.commit("prefix", map[string]string{"prefix.txt": "earlier TODO\n"})
	head := f.commit("item", map[string]string{"item.txt": "this TODO\n", ".gitattributes": "*.txt diff=hostile merge=hostile\n"})
	_ = base
	canary := filepath.Join(t.TempDir(), "executed")
	program := filepath.Join(t.TempDir(), "hostile")
	require.NoError(t, os.WriteFile(program, []byte("#!/bin/sh\n: > '"+canary+"'\nexit 0\n"), 0700))
	// Positive control proves the independent host marker can be written.
	require.NoError(t, exec.Command(program).Run())
	require.FileExists(t, canary)
	require.NoError(t, os.Remove(canary))
	hooks := filepath.Join(t.TempDir(), "hooks")
	require.NoError(t, os.Mkdir(hooks, 0700))
	bytes, err := os.ReadFile(program)
	require.NoError(t, err)
	for _, hook := range []string{"pre-push", "post-update", "pre-auto-gc"} {
		require.NoError(t, os.WriteFile(filepath.Join(hooks, hook), bytes, 0700))
	}
	f.run("config", "core.hooksPath", hooks)
	f.run("config", "diff.external", program)
	f.run("config", "diff.hostile.textconv", program)
	f.run("config", "merge.hostile.driver", program)
	f.run("config", "credential.helper", program)
	t.Setenv("GIT_EXTERNAL_DIFF", program)
	t.Setenv("GIT_CONFIG_PARAMETERS", "'core.hooksPath="+hooks+"'")
	st := &mythicalItemStep{r: &mythicalRun{g: f.git}}
	diff, err := st.proposalDiff(context.Background(), db.MythicalItem{PRHead: head, CandidateBase: prefix})
	require.NoError(t, err)
	require.Contains(t, diff, "this TODO")
	require.NotContains(t, diff, "earlier TODO")
	require.NoFileExists(t, canary)
	target := newMythicalFixture(t)
	require.ErrorContains(t, (&mythicalItemStep{r: &mythicalRun{g: f.git}}).pushProposal(context.Background(), db.MythicalItem{}, mythicalGitHubRepo{GitURL: target.git.dir}, mythicalProposalOp{Branch: "smithers/retry", Head: head}), "publication is held")
	// Exercise the controlled transport separately while publication is dark.
	_, err = f.git.git(context.Background(), "push", "--porcelain", target.git.dir, head+":refs/heads/smithers/retry")
	require.NoError(t, err)
	require.NoFileExists(t, canary)
	require.Equal(t, head, target.run("rev-parse", "smithers/retry"))
	// Attribute source also prevents a repository-defined merge driver.
	left := f.commit("left", map[string]string{"item.txt": "left\n"})
	f.run("checkout", "--quiet", head)
	right := f.commit("right", map[string]string{"item.txt": "right\n"})
	_, _ = f.git.git(context.Background(), "merge-tree", "--write-tree", left, right)
	require.NoFileExists(t, canary)
}

func TestTODOPrPublicationMissingProviderRefusesBeforeAnyEffect(t *testing.T) {
	st := &mythicalItemStep{s: &MythicalService{}}
	called := false
	st.s.prFacts = func(context.Context, db.MythicalItem) (mythicalPRShape, error) {
		called = true
		return mythicalPRShape{}, nil
	}
	next, err := st.propose(context.Background(), db.MythicalItem{CandidateVerified: true, PendingOp: []byte(`{"branch":"recorded","head":"head"}`)})
	require.NoError(t, err)
	require.NotNil(t, next)
	require.Equal(t, mythicalPublicationUnavailable, next.Reason)
	require.False(t, called)
	require.JSONEq(t, `{"branch":"recorded","head":"head"}`, string(next.PendingOp))
	next, err = st.openPull(context.Background(), db.MythicalItem{}, mythicalGitHubRepo{}, "smithers/recorded")
	require.Nil(t, next)
	var unavailable *mythicalPRUnavailable
	require.ErrorAs(t, err, &unavailable)
	raw, err := json.Marshal(unavailable)
	require.NoError(t, err)
	require.JSONEq(t, `{"code":"dependency_unavailable","class":"infra","message":"TODO PR publication dependencies are unavailable"}`, string(raw))
}

func TestTODOPrOutOfOrderRequiresRetainedManifestForActualHead(t *testing.T) {
	t2 := mythicalManifestItem{ID: "two", Number: 2, Head: "retained-two", Change: "change-two"}
	t3 := mythicalManifestItem{ID: "three", Number: 3, Head: "retained-three", Change: "change-three"}
	fact := mythicalGitHubFact{Kind: "merged", Number: 4, PRNumber: 14, Head: "actual-head", MergeCommit: "merge", OnMain: true, Earlier: []mythicalManifestItem{t2, t3}, Manifest: &mythicalMergedManifest{Head: "actual-head", Included: []mythicalManifestItem{t2, t3}}}
	d := decideGitHubFact(fact, mythicalGitHubFactItem{State: "in_review"}, time.Now())
	require.Equal(t, []mythicalManifestItem{t2, t3}, d.Contained)
	require.Equal(t, "T4 merged before T2; T2's change is in T4's commit\nT4 merged before T3; T3's change is in T4's commit", d.AttentionText)
	require.Equal(t, []string{"T4 merged before T2; T2's change is in T4's commit", "T4 merged before T3; T3's change is in T4's commit"}, d.Notes)
	fact.Manifest.Included = []mythicalManifestItem{t3}
	d = decideGitHubFact(fact, mythicalGitHubFactItem{State: "in_review"}, time.Now())
	require.Equal(t, []mythicalManifestItem{t3}, d.Contained)
	require.Equal(t, "T4 merged out of order; containment of T2 is unverified\nT4 merged before T3; T3's change is in T4's commit", d.AttentionText)
	for _, tc := range []struct {
		name     string
		manifest *mythicalMergedManifest
		head     string
	}{
		{"missing manifest", nil, "actual-head"},
		{"foreign head", &mythicalMergedManifest{Head: "accepted-head", Included: []mythicalManifestItem{t2, t3}}, "foreign-head"},
		{"missing head read", &mythicalMergedManifest{Head: "actual-head", Included: []mythicalManifestItem{t2, t3}}, ""},
		{"head equality lacks inclusion", &mythicalMergedManifest{Head: "actual-head"}, "actual-head"},
		{"changed generation", &mythicalMergedManifest{Head: "actual-head", Included: []mythicalManifestItem{{ID: "two", Number: 2, Head: "new-two", Change: "change-two"}}}, "actual-head"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fact.Manifest = tc.manifest
			fact.Head = tc.head
			d := decideGitHubFact(fact, mythicalGitHubFactItem{State: "in_review"}, time.Now())
			require.Equal(t, "merged", d.Event)
			require.Empty(t, d.Contained)
			require.Empty(t, d.Notes)
			require.Equal(t, "order", d.Attention)
		})
	}
	// A superseded, retained accepted head still proves the work actually landed.
	fact.Head = "retained-old-head"
	fact.Manifest = &mythicalMergedManifest{Head: "retained-old-head", Included: []mythicalManifestItem{t2, t3}}
	d = decideGitHubFact(fact, mythicalGitHubFactItem{State: "dropped"}, time.Now())
	require.Len(t, d.Contained, 2)
	fact.OnMain = false
	d = decideGitHubFact(fact, mythicalGitHubFactItem{State: "in_review"}, time.Now())
	require.Empty(t, d.Contained)
	require.Equal(t, "merge_not_on_main", d.Noop)
}

func TestTODOPrBodyNeutralizesAllClosingReferences(t *testing.T) {
	p := mythicalPRShape{Branch: "smithers/docs", Title: "Add docs", Prompt: "Closes #7. Resolves: o/r#8, fixed https://github.com/o/r/issues/9 and closes  #10.\nA fix for #11 stays; prefixes #12 stays.", Acceptance: "Fixes #13", Evidence: "Resolved #14", URL: "http://localhost/todos/2", Owner: "ben"}
	title, body, err := p.render()
	require.NoError(t, err)
	require.Equal(t, "Add docs", title)
	require.Contains(t, body, "Refs #7. Refs o/r#8, Refs https://github.com/o/r/issues/9 and Refs #10.")
	require.Contains(t, body, "A fix for #11 stays; prefixes #12 stays.")
	require.Contains(t, body, "Refs #13")
	require.Contains(t, body, "Refs #14")
	require.NotRegexp(t, mythicalClosingKeyword, body)
}
