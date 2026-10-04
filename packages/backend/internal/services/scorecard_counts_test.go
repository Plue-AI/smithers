package services

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func scorecardCountFixture() (ScorecardWindow, scorecardFacts) {
	from := time.Date(2026, 10, 4, 6, 30, 0, 0, time.UTC)
	start, answer := from, from.Add(5*time.Minute)
	facts := scorecardFacts{Coverage: map[string]bool{}, InstallStart: &start, FirstAnswer: &answer,
		MainCommits: map[string]bool{}, Activations: map[string]time.Time{"v1": from, "v2": from.Add(24 * time.Hour)}}
	for _, ticket := range []string{"T-INS-06", "T-STK-01", "T-STK-04", "T-GH-02", "T-APP-16", "T-FLW-03", "T-COL-04", "T-COL-06", "T-FLW-06"} {
		facts.Coverage[ticket] = true
	}
	for i := 0; i < 60; i++ {
		at := from.Add(time.Duration(i%30) * time.Hour)
		if i >= 30 {
			at = at.Add(7 * 24 * time.Hour)
		}
		todo := scorecardTODO{ID: fmt.Sprint(i), Owner: "Alice", Accepted: at, State: "accepted"}
		if i < 52 {
			todo.State = "merged"
			todo.StateAt = at.Add(48 * time.Minute)
			facts.MainCommits[todo.ID] = true
		}
		facts.TODOs = append(facts.TODOs, todo)
	}
	for i := 0; i < 5; i++ {
		facts.MainCommits[fmt.Sprintf("outside-%d", i)] = false
	}
	for i := 0; i < 9; i++ {
		via := "terminal"
		if i >= 6 {
			via = "claude-code"
		}
		facts.Actions = append(facts.Actions, scorecardAction{SourceKey: fmt.Sprint(i), TODO: fmt.Sprint(i), Person: "Ben", Via: via, Kind: "edit", At: from.Add(time.Duration(i)*time.Hour + 10*time.Minute)})
	}
	facts.Actions = append(facts.Actions, facts.Actions[0]) // Duplicate delivery of one burst.
	facts.Actions = append(facts.Actions, scorecardAction{SourceKey: "agent", TODO: "10", Via: "terminal", Kind: "edit", At: from})
	facts.Actions = append(facts.Actions, scorecardAction{SourceKey: "", TODO: "11", Person: "Alice", Via: "ssh", Kind: "edit", At: from})
	return ScorecardWindow{From: from, To: from.Add(14 * 24 * time.Hour)}, facts
}

func TestScorecardCountsLiteral(t *testing.T) {
	window, facts := scorecardCountFixture()
	out := aggregateScorecard(window, facts)
	expected, err := os.ReadFile("testdata/scorecard/counts.json")
	require.NoError(t, err)
	actual := make(map[string]map[string]any)
	for name, measure := range out.Measures {
		actual[name] = map[string]any{"value": measure.Value, "verdict": measure.Verdict}
		require.Empty(t, measure.MissingTickets, name)
	}
	encoded, err := json.Marshal(actual)
	require.NoError(t, err)
	require.JSONEq(t, string(expected), string(encoded))
	require.Equal(t, ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}, out.PersonMinutes)
	// A reopened item is represented by its current state, never by counting its
	// historic drop event. Repeated delivery cannot create another TODO.
	facts.TODOs = append(facts.TODOs, facts.TODOs[0])
	require.Equal(t, out, aggregateScorecard(window, facts))
}

func TestScorecardCountsCoverageIndependent(t *testing.T) {
	window, facts := scorecardCountFixture()
	baseline := aggregateScorecard(window, facts)
	affected := map[string][]string{
		"T-INS-06": {"install_start", "activation"},
		"T-APP-16": {"first_answer"},
		"T-STK-01": {"accepted", "merged", "dropped", "failed", "first_merge", "dogfood", "activation", "core_value", "second_member_actions", "no_hand_written_code", "outside_work", "retention", "self_improvement"},
		"T-STK-04": {"merged", "first_merge", "dogfood", "activation", "no_hand_written_code", "self_improvement"},
		"T-GH-02":  {"merged", "first_merge", "dogfood", "activation", "no_hand_written_code", "outside_work"},
		"T-COL-04": {"terminal_edits", "second_member_actions", "no_hand_written_code"},
		"T-COL-06": {"multiplayer"}, "T-FLW-03": {"flow_revisions"}, "T-FLW-06": {"self_improvement"},
	}
	for ticket := range facts.Coverage {
		t.Run(ticket, func(t *testing.T) {
			facts.Coverage[ticket] = false
			defer func() { facts.Coverage[ticket] = true }()
			out := aggregateScorecard(window, facts)
			for name, original := range baseline.Measures {
				missing := false
				for _, measureName := range affected[ticket] {
					if measureName == name {
						missing = true
					}
				}
				if missing {
					require.Nil(t, out.Measures[name].Value, name)
					require.Equal(t, "source_missing", out.Measures[name].Verdict, name)
					require.Equal(t, []string{ticket}, out.Measures[name].MissingTickets, name)
				} else {
					require.Equal(t, original, out.Measures[name], name)
				}
			}
		})
	}
	empty := scorecardFacts{Coverage: facts.Coverage}
	out := aggregateScorecard(window, empty)
	require.Equal(t, 0, out.Measures["terminal_edits"].Value)
	require.Equal(t, map[string]any{"commits": 0, "total": 0, "percent": nil}, out.Measures["outside_work"].Value)
	require.Nil(t, out.Measures["activation"].Value)
	require.Equal(t, "between", out.Measures["activation"].Verdict)
}

func TestScorecardCountsBoundariesAndAuthorship(t *testing.T) {
	window, facts := scorecardCountFixture()
	facts.TODOs = nil
	for _, todo := range []scorecardTODO{
		{ID: "before", Accepted: window.From.Add(-time.Nanosecond)},
		{ID: "start", Accepted: window.From, State: "dropped", StateAt: window.From},
		{ID: "week2", Accepted: window.From.Add(7 * 24 * time.Hour), State: "failed", StateAt: window.From},
		{ID: "end", Accepted: window.To},
	} {
		facts.TODOs = append(facts.TODOs, todo)
	}
	out := aggregateScorecard(window, facts)
	require.Equal(t, 2, out.Measures["accepted"].Value)
	require.Equal(t, map[string]any{"accepted_per_week": []int{1, 1}}, out.Measures["core_value"].Value)
	require.Equal(t, "kill", out.Measures["core_value"].Verdict)
	require.Equal(t, 1, out.Measures["dropped"].Value)
	require.Equal(t, 1, out.Measures["failed"].Value)
	require.Equal(t, "between", out.Measures["retention"].Verdict)
	window, facts = scorecardCountFixture()
	before := aggregateScorecard(window, facts).Measures["core_value"]
	facts.Actions = nil
	require.Equal(t, before, aggregateScorecard(window, facts).Measures["core_value"])
	facts.TODOs[0].StateAt = window.From.Add(time.Hour)
	require.Equal(t, "pass", aggregateScorecard(window, facts).Measures["activation"].Verdict)
	facts.TODOs[0].StateAt = window.From.Add(time.Hour + time.Nanosecond)
	require.Equal(t, "between", aggregateScorecard(window, facts).Measures["activation"].Verdict)
}

func TestScorecardCountsPresence(t *testing.T) {
	window, facts := scorecardCountFixture()
	window.To = window.From.Add(7 * 24 * time.Hour)
	for i := 0; i < 2; i++ {
		at := window.From.Add(time.Duration(i) * time.Hour)
		for _, person := range []string{"Alice", "Ben"} {
			facts.Presence = append(facts.Presence, scorecardPresence{ID: fmt.Sprintf("%d-%s", i, person), Person: person, Branch: "branch", From: at, To: at.Add(2 * time.Minute)})
		}
	}
	facts.Presence = append(facts.Presence, facts.Presence[0], scorecardPresence{ID: "short", Person: "Carol", Branch: "branch", From: window.From, To: window.From.Add(2*time.Minute - time.Nanosecond)})
	out := aggregateScorecard(window, facts)
	require.Equal(t, map[string]any{"sessions": 4, "per_week": []int{4}}, out.Measures["multiplayer"].Value)
	require.Equal(t, "pass", out.Measures["multiplayer"].Verdict)
	facts.Presence = facts.Presence[:2]
	require.Equal(t, "between", aggregateScorecard(window, facts).Measures["multiplayer"].Verdict)
	facts.Presence[1].Branch = "other"
	require.Equal(t, map[string]any{"sessions": 0, "per_week": []int{0}}, aggregateScorecard(window, facts).Measures["multiplayer"].Value)
}

func TestScorecardCountsLearning(t *testing.T) {
	window, facts := scorecardCountFixture()
	facts.TODOs = nil
	for i := 0; i < 10; i++ {
		facts.TODOs = append(facts.TODOs, scorecardTODO{ID: fmt.Sprint(i), Accepted: window.From.Add(time.Duration(i) * time.Hour), Signatures: map[string]bool{"build": i < 3}})
	}
	learning := scorecardLearning{ID: "note", TODO: "proposal", Signature: "build", Accepted: window.From, Merged: window.From.Add(5 * time.Hour)}
	facts.Learnings = []scorecardLearning{learning, learning}
	out := aggregateScorecard(window, facts)
	require.Equal(t, 1, out.Measures["self_improvement"].Value)
	require.Equal(t, "pass", out.Measures["self_improvement"].Verdict)
	for i := 5; i < 8; i++ {
		facts.TODOs[i].Signatures["build"] = true
	}
	require.Equal(t, 0, aggregateScorecard(window, facts).Measures["self_improvement"].Value)
	require.Equal(t, "between", aggregateScorecard(window, facts).Measures["self_improvement"].Verdict)
	facts.TODOs = facts.TODOs[:9]
	require.Equal(t, "between", aggregateScorecard(window, facts).Measures["self_improvement"].Verdict)
}

func TestScorecardCountsRetention(t *testing.T) {
	window, facts := scorecardCountFixture()
	window.From = window.To
	window.To = window.From.Add(7 * 24 * time.Hour)
	facts.TODOs = nil
	for i := 0; i < 11; i++ {
		facts.TODOs = append(facts.TODOs, scorecardTODO{ID: fmt.Sprint(i), Accepted: window.From})
	}
	require.Equal(t, 11, aggregateScorecard(window, facts).Measures["retention"].Value)
	require.Equal(t, "pass", aggregateScorecard(window, facts).Measures["retention"].Verdict)
	facts.TODOs = facts.TODOs[:2]
	require.Equal(t, "kill", aggregateScorecard(window, facts).Measures["retention"].Verdict)
}

func TestScorecardCountsConfirmingPerson(t *testing.T) {
	window, facts := scorecardCountFixture()
	facts.Actions = []scorecardAction{
		{SourceKey: "wait-1", TODO: "0", Kind: "answer", Person: "Ben", Via: "delegated", At: window.From},
		{SourceKey: "wait-1", TODO: "0", Kind: "answer", Person: "Ben", Via: "delegated", At: window.From},
		{SourceKey: "confirmation-1", TODO: "0", Kind: "review", Person: "Ben", At: window.From},
		{SourceKey: "agent-1", TODO: "0", Kind: "answer", Via: "agent", At: window.From},
		{SourceKey: "owner-1", TODO: "0", Kind: "answer", Person: "Alice", At: window.From},
	}
	out := aggregateScorecard(window, facts)
	require.Equal(t, 2, out.Measures["second_member_actions"].Value)
	require.Equal(t, 0, out.Measures["terminal_edits"].Value)
	// Answer and approval participation is not a code edit or an effort estimate.
	require.Equal(t, map[string]any{"todos": 52, "merged": 52, "percent": float64(100)}, out.Measures["no_hand_written_code"].Value)
	require.Equal(t, ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}, out.PersonMinutes)
}

func TestScorecardCountsDogfoodKillBoundaries(t *testing.T) {
	window, facts := scorecardCountFixture()
	facts.TODOs = facts.TODOs[:20]
	require.Equal(t, "between", aggregateScorecard(window, facts).Measures["dogfood"].Verdict)
	facts.TODOs = facts.TODOs[:19]
	require.Equal(t, "kill", aggregateScorecard(window, facts).Measures["dogfood"].Verdict)
	window, facts = scorecardCountFixture()
	facts.MainCommits = map[string]bool{"todo": true, "laptop": false}
	require.Equal(t, "pass", aggregateScorecard(window, facts).Measures["dogfood"].Verdict)
	facts.MainCommits["another-laptop"] = false
	require.Equal(t, "kill", aggregateScorecard(window, facts).Measures["dogfood"].Verdict)
}

func TestScorecardCountsPersonEditsBeforePlacement(t *testing.T) {
	window, facts := scorecardCountFixture()
	facts.Actions = []scorecardAction{
		{SourceKey: "before-placement", TODO: "0", Person: "Ben", Kind: "edit", At: window.From.Add(-time.Minute)},
		{SourceKey: "after-merge", TODO: "1", Person: "Ben", Kind: "edit", At: facts.TODOs[1].StateAt.Add(time.Minute)},
	}
	out := aggregateScorecard(window, facts)
	require.Equal(t, map[string]any{"todos": 51, "merged": 52, "percent": 98.1}, out.Measures["no_hand_written_code"].Value)
	require.Equal(t, "pass", out.Measures["core_value"].Verdict)
}
