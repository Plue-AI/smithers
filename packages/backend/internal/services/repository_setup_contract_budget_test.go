package services

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The app, the rpc schema and flows/repository/schema.ts all allow a six-hour
// setup budget; the backend agrees.
func TestSetupDraftBudgetAllowsSixHours(t *testing.T) {
	draft := func(minutes int) *SetupDraft {
		return &SetupDraft{Steps: []SetupStep{}, Checks: []SetupCheck{}, Cases: []SetupCase{}, Replies: "draft", Landing: "ask",
			Scope: "future", BudgetMinutes: minutes, ConnectIssues: new(bool), TrialTitle: "Trial"}
	}
	require.NoError(t, draft(360).validate())
	require.Error(t, draft(361).validate())
}
