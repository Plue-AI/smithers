package services

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Fable round 1, F2: the todo composition runs only from stack admission of
// a filed TODO. A repository job or trigger registration naming it is
// refused before it is stored, so no dispatch, machine wake, host start or
// token follows; other flows with similar names still register.
func TestTodoFlowIsNeverARepositoryJob(t *testing.T) {
	now := time.Date(2026, 10, 4, 9, 0, 0, 0, time.UTC)
	for _, flowID := range []string{"todo", "flows/todo/flow.ts"} {
		input := approvedFlowRegistrationInput()
		input.FlowID = flowID
		_, err := validateRepositoryJob("flow:nightly-lint", input, now)
		var typed *pkgerrors.APIError
		require.ErrorAs(t, err, &typed, flowID)
		require.Equal(t, pkgerrors.CodeForbidden, typed.Code, flowID)
		require.Contains(t, err.Error(), "File a TODO")
		// A factory registration of it is refused the same way.
		factory := input
		factory.FactoryRevision, factory.SourceRevision = strings.Repeat("a", 40), strings.Repeat("a", 40)
		factory.ApprovedPlanID, factory.ApprovedPlanDigest = "", ""
		_, err = validateRepositoryJob("flow:factory-0123456789abcdef0123456789abcdef", factory, now)
		require.ErrorAs(t, err, &typed, flowID)
		require.Equal(t, pkgerrors.CodeForbidden, typed.Code, flowID)
	}
	for _, flowID := range []string{"todos", "todo-list", "coding/todo-route"} {
		input := approvedFlowRegistrationInput()
		input.FlowID = flowID
		_, err := validateRepositoryJob("flow:nightly-lint", input, now)
		require.NoError(t, err, flowID)
	}
}

// A factory on main that declares todo as a prompt flow with trigger rules
// registers none of them; each is reported, and the factory's other rules
// still register.
func TestFactoryNeverRegistersTheTodoFlow(t *testing.T) {
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal([]byte(`{"flows":[
		{"id":"todo","kind":"mdx","capabilities":[],"flows":[],"budget":{"tokens":1000,"milliseconds":60000}},
		{"id":"assistant","kind":"mdx","capabilities":["memory:read:global-team"],"flows":[],"budget":{"tokens":2400000,"milliseconds":21600000}}],
		"on":[{"event":"issue.labeled:todo","flow":"todo"},{"event":"schedule:0 9 * * 1-5","flow":["todo","assistant"]},{"event":"issue_comment","flow":"flows/todo/flow.ts"}]}`), &projection))
	rules, warnings, err := planFactory(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	require.Len(t, rules, 1, "only the assistant rule registers")
	require.Equal(t, "assistant", rules[0].input.FlowID)
	var refused []string
	for _, warning := range warnings {
		if warning.Reason == "the todo flow runs only for a filed TODO" {
			refused = append(refused, warning.Event+" "+warning.Flow)
		}
	}
	require.ElementsMatch(t, []string{"issue.labeled:todo todo", "schedule:0 9 * * 1-5 todo", "issue_comment flows/todo/flow.ts"}, refused)
}
