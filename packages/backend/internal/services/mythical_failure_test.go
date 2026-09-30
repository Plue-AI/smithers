package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// mythicalFaultItem is an issue item in state whose checks carry fault.
func mythicalFaultItem(t *testing.T, state string, fault *mythicalFault) db.MythicalItem {
	t.Helper()
	checks := mythicalChecks{Todo: true, Fault: fault}
	return db.MythicalItem{Source: "issue", State: state, Reason: "the lane's request ended outage: infra: dial tcp 10.0.0.7:5432: password authentication failed",
		Checks: checks.encode()}
}

// Every typed fault reads as its step, whose fault it was and one sentence,
// in every state it can stand in; a fault stored before kinds were is read
// from its class and tag.
func TestMythicalFailureOfEveryFault(t *testing.T) {
	for _, tc := range []struct {
		name     string
		state    string
		fault    mythicalFault
		kind     string
		class    string
		sentence string
	}{
		{"a lane that could not be set up", "queued", mythicalFault{Class: "infra", Tag: "launch", Kind: "provisioning"}, "provisioning", "infra", "Smithers could not set up a lane"},
		{"the runtime", "retrying", mythicalFault{Class: "infra", Tag: "coding/Error/check_infra", Kind: "runtime"}, "runtime", "infra", "Smithers' runtime failed"},
		{"a model provider down", "retrying", mythicalFault{Class: "dependency", Tag: "flows/model/ModelError/overloaded", Kind: "model"}, "model", "dependency", "The model provider did not answer"},
		{"a model provider's rate limit", "retrying", mythicalFault{Class: "wait", Tag: "flows/model/ModelError/quota_exceeded", Kind: "model"}, "model", "wait", "The model provider did not answer"},
		{"red checks", "retrying", mythicalFault{Class: "factory", Tag: "fast, lint", Kind: "checks"}, "checks", "factory", "Checks failed"},
		{"a failed plan", "retrying", mythicalFault{Class: "factory", Tag: "coding/Error/stalled", Kind: "plan"}, "plan", "factory", "This attempt did not produce a working change"},
		{"every plan failed", "blocked", mythicalFault{Class: "factory", Tag: "very_hard", Kind: "plan"}, "plan", "factory", "Every plan failed"},
		{"model outages past the bound", "blocked", mythicalFault{Class: "policy", Tag: "outages", Kind: "model"}, "model", "dependency", "The model provider did not answer after repeated tries"},
		{"lane outages past the bound", "blocked", mythicalFault{Class: "policy", Tag: "outages", Kind: "provisioning"}, "provisioning", "infra", "Smithers could not set up a lane after repeated tries"},
		{"GitHub down on an open pull request", "proposed", mythicalFault{Class: "infra", Tag: "github", Kind: "landing"}, "landing", "infra", "GitHub did not answer"},
		{"a cancelled run", "blocked", mythicalFault{Class: "user", Tag: "cancelled", Kind: "stopped"}, "stopped", "user", "The run was cancelled"},
		{"the run limit", "blocked", mythicalFault{Class: "policy", Tag: "launch_bound", Kind: "stopped"}, "stopped", "policy", "It reached its run limit"},
		{"protected paths", "blocked", mythicalFault{Class: "policy", Tag: "protected_paths", Kind: "stopped"}, "stopped", "policy", "It changes protected paths"},
		{"a defect", "blocked", mythicalFault{Class: "bug", Tag: "coding/Error/invariant", Kind: "stopped"}, "stopped", "bug", "Smithers hit a defect"},
		{"a person's stop", "blocked", mythicalFault{Class: "user", Tag: "flows/model/ModelError/authentication", Kind: "stopped"}, "stopped", "user", "The run was stopped"},
		{"another policy", "blocked", mythicalFault{Class: "policy", Tag: "coding/Error/spend_cap", Kind: "stopped"}, "stopped", "policy", "A repository policy stopped it"},
		{"legacy launch", "queued", mythicalFault{Class: "infra", Tag: "launch"}, "provisioning", "infra", "Smithers could not set up a lane"},
		{"legacy GitHub", "proposed", mythicalFault{Class: "infra", Tag: "github"}, "landing", "infra", "GitHub did not answer"},
		{"legacy plan", "retrying", mythicalFault{Class: "factory", Tag: "coding/Error/stalled"}, "plan", "factory", "This attempt did not produce a working change"},
		{"legacy model", "retrying", mythicalFault{Class: "wait", Tag: "flows/model/ModelError/quota_exceeded"}, "model", "wait", "The model provider did not answer"},
		{"legacy runtime", "retrying", mythicalFault{Class: "infra", Tag: "coding/Error/check_infra"}, "runtime", "infra", "Smithers' runtime failed"},
		{"legacy stop", "blocked", mythicalFault{Class: "user", Tag: "cancelled"}, "stopped", "user", "The run was cancelled"},
		{"legacy outage bound", "blocked", mythicalFault{Class: "policy", Tag: "outages"}, "runtime", "infra", "Smithers' runtime failed after repeated tries"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fault := tc.fault
			item := mythicalFaultItem(t, tc.state, &fault)
			failure, sentence := mythicalFailureOf(item)
			require.NotNil(t, failure)
			assert.Equal(t, MythicalFailureView{Kind: tc.kind, Fault: tc.class}, *failure)
			assert.Equal(t, tc.sentence, sentence)
			view := mythicalItemView(item)
			assert.Equal(t, tc.sentence, view.Reason, "the reason every surface shows is the sentence")
			raw, err := json.Marshal(view)
			require.NoError(t, err)
			assert.NotContains(t, string(raw), "password", "no raw error reaches the API")
			assert.NotContains(t, string(raw), "10.0.0.7")
		})
	}
}

// Only a failure that stands is typed: a settled item keeps no stale fault,
// a closed pull request and a held review are failures without one, and an
// item without a fault keeps its own reason.
func TestMythicalFailureOfStates(t *testing.T) {
	stale := &mythicalFault{Class: "infra", Tag: "github", Kind: "landing"}
	for _, state := range []string{"landed", "cancelled", "declined", "skipped"} {
		failure, _ := mythicalFailureOf(mythicalFaultItem(t, state, stale))
		assert.Nil(t, failure, state)
	}

	rejected := mythicalFaultItem(t, "rejected", nil)
	failure, sentence := mythicalFailureOf(rejected)
	assert.Equal(t, &MythicalFailureView{Kind: "landing", Fault: "user"}, failure)
	assert.Equal(t, "The pull request closed without merging", sentence)

	held := db.MythicalItem{Source: "issue", State: "proposed", PRHead: "head", Reason: "the review of this head was stopped; a person decides",
		Checks: mythicalChecks{Todo: true, Review: &mythicalReview{Head: "head", Verdict: mythicalCancelled}}.encode()}
	failure, sentence = mythicalFailureOf(held)
	assert.Equal(t, &MythicalFailureView{Kind: "review", Fault: "factory"}, failure)
	assert.Equal(t, "The review did not finish", sentence)
	assert.True(t, mythicalItemView(held).ReviewHeld, "and it offers Retry")

	// A chat item's held review is not a person's retry.
	held.Source = "chat"
	failure, _ = mythicalFailureOf(held)
	assert.Nil(t, failure)

	waiting := db.MythicalItem{Source: "issue", State: "queued", Reason: "waiting for a free lane to review this change"}
	failure, _ = mythicalFailureOf(waiting)
	assert.Nil(t, failure)
	view := mythicalItemView(waiting)
	assert.Nil(t, view.Failure)
	assert.Equal(t, waiting.Reason, view.Reason)
}

// A run's outcome is typed by its registered fault and the step it failed
// at: a plan's own failure is the plan's, a check run's is the checks'.
func TestMythicalOutcomeFault(t *testing.T) {
	assert.Equal(t, mythicalFault{Class: "user", Tag: "cancelled", Kind: "stopped"}, mythicalOutcomeFault(mythicalFailPlan, mythicalCancelled))
	assert.Equal(t, mythicalFault{Class: "bug", Tag: "coding/Error/x", Kind: "stopped"}, mythicalOutcomeFault(mythicalFailPlan, "stopped: bug: coding/Error/x"))
	assert.Equal(t, mythicalFault{Class: "dependency", Tag: "flows/model/ModelError/overloaded", Kind: "model"},
		mythicalOutcomeFault(mythicalFailChecks, "outage: dependency: flows/model/ModelError/overloaded"))
	assert.Equal(t, mythicalFault{Class: "infra", Tag: "runtime_binding_unavailable", Kind: "runtime"},
		mythicalOutcomeFault(mythicalFailPlan, "outage: infra: runtime_binding_unavailable"))
	assert.Equal(t, mythicalFault{Class: "factory", Tag: "fast, lint", Kind: "checks"}, mythicalOutcomeFault(mythicalFailChecks, "failed: fast, lint"))
	assert.Equal(t, mythicalFault{Class: "factory", Tag: "coding/Error/stalled", Kind: "plan"}, mythicalOutcomeFault(mythicalFailPlan, "failed: coding/Error/stalled"))
}

// Red checks retry as the checks' failure and, when every plan failed,
// the issue hears which step failed, never the run's diagnostic.
func TestMythicalChecksFailureIsTyped(t *testing.T) {
	now := time.Now()
	item := db.MythicalItem{Source: "issue", State: "verifying", Attempt: 1, Checks: mythicalChecks{Todo: true}.encode()}
	next := mythicalFailure(item, "checks on the rebased result ended", mythicalFailChecks, "failed: fast, lint", now)
	require.Equal(t, "retrying", next.State)
	assert.Equal(t, "checks on the rebased result ended failed: fast, lint", next.Reason, "the diagnostic stays on the item")
	view := mythicalItemView(*next)
	assert.Equal(t, &MythicalFailureView{Kind: "checks", Fault: "factory"}, view.Failure)
	assert.Equal(t, "Checks failed", view.Reason)

	last := item
	last.Attempt = mythicalAttempts
	hard := mythicalFailure(last, "checks on the rebased result ended", mythicalFailChecks, "failed: fast", now)
	assert.Equal(t, "This TODO is very hard. Checks failed. Smithers continues the last plan once.", mythicalChecksOf(*hard).Notice.Body)
	hard.Attempt = mythicalAttempts
	stopped := mythicalFailure(*hard, "checks on the rebased result ended", mythicalFailChecks, "failed: fast", now)
	require.Equal(t, "blocked", stopped.State)
	assert.Equal(t, "Smithers stopped this TODO: it is very hard. Checks failed. Press Retry on it in Smithers to go on.", mythicalChecksOf(*stopped).Notice.Body)
	assert.Equal(t, "Every plan failed", mythicalItemView(*stopped).Reason)
	assert.Equal(t, "", mythicalSentence(""))
}

// leakyLanes cannot provision a lane, and says why in words no person
// should read.
type leakyLanes struct{ *fakeMythicalLanes }

func (leakyLanes) Create(context.Context, db.Repository, string, int64, string, MythicalPlacement, func(string) error) (string, error) {
	return "", errors.New("dial tcp 10.0.0.7:5432: password authentication failed for user admin")
}

// mythicalSnapshotItem is the item for issue number as the API serves it.
func mythicalSnapshotItem(t *testing.T, o *mythicalOrchestration, number int64) (map[string]any, string) {
	t.Helper()
	view, err := o.service.Snapshot(context.Background(), o.repoID, "o/smithers", "", MythicalViewer{UserID: o.userID})
	require.NoError(t, err)
	raw, err := json.Marshal(view)
	require.NoError(t, err)
	var body struct {
		Items []map[string]any `json:"items"`
	}
	require.NoError(t, json.Unmarshal(raw, &body))
	for _, item := range body.Items {
		if issue, ok := item["issue"].(map[string]any); ok && issue["number"] == float64(number) {
			return item, string(raw)
		}
	}
	t.Fatalf("issue %d is not on the snapshot", number)
	return nil, ""
}

// A lane that cannot be set up, then a model provider's outage: the API
// serves each as its typed reason, the issue hears it without the error's
// words, and a person's Retry clears it.
func TestMythicalFailureReasonsReachTheAPI(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	o.service.SetOrchestration(o.github, o.launcher, leakyLanes{o.lanes})
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 331, Title: "Leak", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	o.wake()
	item, raw := mythicalSnapshotItem(t, o, 331)
	assert.Equal(t, "queued", item["state"])
	assert.Equal(t, "Smithers could not set up a lane", item["reason"])
	assert.Equal(t, map[string]any{"kind": "provisioning", "fault": "infra"}, item["failure"])
	assert.NotContains(t, raw, "password")
	assert.Contains(t, o.item(331).Reason, "password authentication failed", "the diagnostic stays on the row")

	for range mythicalOutageBound + 1 {
		o.wake()
	}
	require.Equal(t, "blocked", o.item(331).State)
	o.wake()
	item, raw = mythicalSnapshotItem(t, o, 331)
	assert.Equal(t, "Smithers could not set up a lane after repeated tries", item["reason"])
	assert.Equal(t, map[string]any{"kind": "provisioning", "fault": "infra"}, item["failure"])
	assert.NotContains(t, raw, "password")
	require.Equal(t, []string{"#331 Smithers stopped this TODO. Smithers could not set up a lane after repeated tries."}, o.github.comments)

	// A person retries it; the lanes are back and the model provider fails.
	o.service.SetOrchestration(o.github, o.launcher, o.lanes)
	retried, err := o.service.RetryItem(ctx, o.repoID, uuidString(o.item(331).ID))
	require.NoError(t, err)
	assert.Equal(t, "queued", retried.State)
	assert.Nil(t, retried.Failure)
	assert.Empty(t, retried.Reason)
	o.wake()
	require.Equal(t, "running", o.item(331).State)
	item, _ = mythicalSnapshotItem(t, o, 331)
	assert.Nil(t, item["failure"], "a launch clears the failure")
	o.fail(o.launcher.last("coding/request"), "run-overloaded", "dependency", "flows/model/ModelError/overloaded", "")
	o.wake()
	item, _ = mythicalSnapshotItem(t, o, 331)
	assert.Equal(t, "retrying", item["state"])
	assert.Equal(t, "The model provider did not answer", item["reason"], "Smithers retries it on its own")
	assert.Equal(t, map[string]any{"kind": "model", "fault": "dependency"}, item["failure"])
}

// unresolvedGitHub cannot resolve the repository's GitHub destination, and
// says why in words no person should read.
type unresolvedGitHub struct{ *fakeMythicalGitHub }

func (unresolvedGitHub) Resolve(context.Context, db.Repository, string, int64) (mythicalGitHubRepo, error) {
	return mythicalGitHubRepo{}, errors.New("installation token for app 42 expired: ghs_secret")
}

// A verified result GitHub cannot be reached for waits once in words, then
// counts an outage the API serves as a landing failure; neither says the
// error's text.
func TestMythicalUnreachedGitHubIsALandingFailure(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 341, Title: "Land", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	stack := o.wake()
	item := o.item(341)
	require.Equal(t, "running", item.State, item.Reason)
	o.project(o.launcher.last("coding/request"), jobs.StateCompleted, "run-341", validatedRequest)
	o.wake()
	candidate := o.laneResult(item.WorkspaceID, stack.TipCommit, map[string]string{"land.md": "x\n"}, "📝 docs: add land.md")
	_, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-341", Summary: "📝 docs: add land.md"})
	require.NoError(t, err)
	o.wake() // integrating -> proposing
	o.service.SetOrchestration(unresolvedGitHub{o.github}, o.launcher, o.lanes)
	o.wake()
	item = o.item(341)
	require.Equal(t, "waiting", item.State)
	assert.Equal(t, mythicalGitHubUnreached, item.Reason)
	view, raw := mythicalSnapshotItem(t, o, 341)
	assert.Equal(t, mythicalGitHubUnreached, view["reason"])
	assert.Nil(t, view["failure"], "one miss is a wait, not a failure")
	assert.NotContains(t, raw, "ghs_secret")

	o.wake()
	item = o.item(341)
	assert.Equal(t, &mythicalFault{Class: "infra", Tag: "github", Kind: "landing"}, mythicalChecksOf(item).Fault)
	view, raw = mythicalSnapshotItem(t, o, 341)
	assert.Equal(t, "GitHub did not answer", view["reason"])
	assert.Equal(t, map[string]any{"kind": "landing", "fault": "infra"}, view["failure"])
	assert.NotContains(t, raw, "ghs_secret")
	assert.Contains(t, item.Reason, "ghs_secret", "the diagnostic stays on the row")
}
