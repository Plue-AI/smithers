package services

import (
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestPlanWikiCitationsSurviveSummaryAndAttemptSnapshot(t *testing.T) {
	output := `{"plan":{"wikiCitations":[{"slug":"retry-policy","pageID":"42","revision":3,"digest":"0590d40eefc0d1d5a9a5c8d407e4acfcb1cae6de15729033c56dc64ddb9abe47"}],"changes":[{"title":"Retry","atoms":[{"changeId":null,"message":"Retry"}],"checks":[]}]}}`
	update := flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{Run: &flowruntime.FlowRuntimeRun{FinalOutput: &output}}}
	plan := mythicalPlanSummary(update)
	require.NotEmpty(t, plan)
	item := db.MythicalItem{Source: "todo", Attempt: 1, CandidateHead: "first", Plan: plan}
	retained := retainTodoAttemptEvidence(item)
	item = retained
	item.Attempt = 2
	item.CandidateHead = "second"
	item.Plan = json.RawMessage(`{"wikiCitations":[{"slug":"retry-policy","pageID":"42","revision":7,"digest":"0b2889240d13d49add99a1daef222ddce288814a94826dbce1fbf456f03adc6b"}]}`)
	evidence := todoEvidence(item)
	require.Len(t, evidence, 2)
	require.EqualValues(t, int64(3), evidence[0].Items[0]["revision"])
	require.EqualValues(t, int64(7), evidence[1].Items[0]["revision"])
	require.Equal(t, "0590d40eefc0d1d5a9a5c8d407e4acfcb1cae6de15729033c56dc64ddb9abe47", evidence[0].Items[0]["digest"])
	item.Plan = nil
	require.Empty(t, currentTodoEvidence(item).Items)
	item.Plan = json.RawMessage(`{"wikiCitations":[{"slug":"retry-policy","pageID":"../42","revision":3,"digest":"bad"}]}`)
	require.Empty(t, currentTodoEvidence(item).Items)
}
