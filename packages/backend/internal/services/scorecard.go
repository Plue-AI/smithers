package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ScorecardWindow is half-open. Weeks are seven UTC days from From, not local
// calendar boundaries, including when the caller supplies an offset timestamp.
type ScorecardWindow struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

type ScorecardMeasure struct {
	Value          any             `json:"value"`
	Target         string          `json:"target"`
	KillSignal     string          `json:"kill_signal"`
	Verdict        string          `json:"verdict"`
	Window         ScorecardWindow `json:"window"`
	SourceTables   []string        `json:"source_tables"`
	MissingTickets []string        `json:"missing_tickets,omitempty"`
}

type Scorecard struct {
	Window        ScorecardWindow             `json:"window"`
	Measures      map[string]ScorecardMeasure `json:"measures"`
	PersonMinutes ScorecardPersonMinutes      `json:"person_minutes"`
}

type ScorecardPersonMinutes struct {
	Source  string `json:"source"`
	Verdict string `json:"verdict"`
}

func ValidateScorecardWindow(from, to time.Time) (ScorecardWindow, error) {
	if from.IsZero() || to.IsZero() || !from.Before(to) {
		return ScorecardWindow{}, pkgerrors.BadRequest("from must precede to")
	}
	return ScorecardWindow{From: from.UTC(), To: to.UTC()}, nil
}

// ScorecardService deliberately has no producer-coverage override. Existing
// tables do not prove that their writers emit the spec §20.4b lifecycle receipts.
// Each owning ticket must integrate its real source contract before that source
// can return a number. Admin analytics is not an alternative source of evidence.
type ScorecardService struct{ Pool *pgxpool.Pool }

func (s *ScorecardService) Summary(ctx context.Context, from, to time.Time) (Scorecard, error) {
	window, err := ValidateScorecardWindow(from, to)
	if err != nil {
		return Scorecard{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Scorecard{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	queries := db.New(tx)
	if err := queries.AnalyticsStatementTimeout(ctx); err != nil {
		return Scorecard{}, err
	}
	relations, err := queries.ScorecardSourceRelations(ctx)
	if err != nil {
		return Scorecard{}, err
	}
	present := make(map[string]bool)
	for _, relation := range relations {
		present[relation.Name] = relation.Present
	}
	facts := scorecardFacts{Coverage: make(map[string]bool), IncompleteStates: make(map[string]bool)}
	if present["install_settings"] {
		rows, err := queries.ScorecardInstallStart(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		if len(rows) == 1 {
			var started time.Time
			if json.Unmarshal(rows[0], &started) == nil && !started.IsZero() {
				facts.InstallStart = &started
				facts.Coverage["T-INS-06"] = true
			}
		}
	}
	if present["mythical_items"] && present["product_job_events"] {
		rows, err := queries.ScorecardTODOs(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		// Legacy TODOs without a creation receipt cannot be silently counted
		// as accepted. Empty installs likewise have no producer evidence yet.
		complete := len(rows) > 0
		for _, row := range rows {
			if !row.Covered {
				complete = false
				continue
			}
			state := todoState(db.MythicalItem{State: row.State, Checks: row.Checks, PausedAt: row.PausedAt})
			// A later title/control update must not move a terminal outcome
			// into another window. Use the last entry into this state.
			stateTimes := make(map[string]time.Time)
			decodeErr := json.Unmarshal(row.StateTimes, &stateTimes)
			stateAt := stateTimes[state]
			if (state == "merged" || state == "dropped" || state == "failed") && (decodeErr != nil || stateAt.IsZero()) {
				facts.IncompleteStates[state] = true
			}
			var signatures map[string]bool
			var checks mythicalChecks
			if json.Unmarshal(row.Checks, &checks) == nil && len(checks.Attempts) > 0 {
				completeAttempts := true
				for _, attempt := range checks.Attempts {
					if attempt.RunID == "" || attempt.Outcome == "" {
						completeAttempts = false
					}
				}
				if completeAttempts {
					signatures = make(map[string]bool)
					for _, failure := range learningFailures(checks) {
						signatures[failure.Signature] = true
					}
				}
			}
			facts.TODOs = append(facts.TODOs, scorecardTODO{Repository: row.RepositoryID, Signatures: signatures, ID: row.ID, Owner: fmt.Sprint(row.Owner), Accepted: row.Accepted, State: state, StateAt: stateAt})
		}
		answers, err := queries.ScorecardAnswers(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		for _, row := range answers {
			var checks mythicalChecks
			var answer struct {
				Wait  string `json:"wait"`
				Actor struct {
					Kind  string `json:"kind"`
					ID    int64  `json:"id"`
					Login string `json:"login"`
				} `json:"actor"`
			}
			if json.Unmarshal(row.Checks, &checks) != nil || json.Unmarshal(row.Data, &answer) != nil ||
				answer.Wait == "" || answer.Actor.Kind != "person" || answer.Actor.ID <= 0 {
				facts.IncompleteStates["second_member_actions"] = true
				continue
			}
			paired := false
			for _, wait := range checks.Waits {
				if wait.ID != answer.Wait {
					continue
				}
				if (wait.Kind != "question" && wait.Kind != "conflict") || wait.Since.IsZero() || wait.SettledAt == nil || wait.SettledAt.Before(wait.Since) ||
					wait.Answer == "" || wait.AnsweredBy == "" || wait.AnsweredBy != answer.Actor.Login {
					continue
				}
				paired = true
				facts.Actions = append(facts.Actions, scorecardAction{SourceKey: wait.ID, TODO: row.TodoID,
					Person: fmt.Sprint(answer.Actor.ID), Kind: "answer", At: *wait.SettledAt})
			}
			if !paired {
				facts.IncompleteStates["second_member_actions"] = true
			}
		}
		facts.Coverage["T-STK-01"] = complete
		mergedCoverage, err := queries.ScorecardMergeCoverage(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		facts.Coverage["T-STK-04"] = mergedCoverage
		// A covered merge stream does not prove the separate main-commit
		// inventory needed by outside work and dogfood.
		for _, name := range []string{"merged", "first_merge", "activation", "no_hand_written_code"} {
			facts.Coverage[name+":T-GH-02"] = mergedCoverage
		}
	}
	if present["chat_turns"] && present["chat_turn_batches"] {
		answer, err := queries.ScorecardFirstAnswer(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		if answer.Covered {
			facts.Coverage["T-APP-16"] = true
			facts.FirstAnswer = &answer.AnsweredAt
		}
	}
	if present["burst_files"] && present["product_job_events"] {
		branchTODOs := make(map[string]string)
		if present["mythical_items"] {
			items, err := queries.ScorecardBurstTODOs(ctx)
			if err != nil {
				return Scorecard{}, err
			}
			for _, item := range items {
				branchTODOs[item.TenantID+"/branch:"+item.WorkspaceID] = item.ID
			}
		}
		rows, err := queries.ScorecardBursts(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		complete := len(rows) > 0
		for _, row := range rows {
			var burst struct {
				ID        string `json:"id"`
				SourceKey string `json:"source_key"`
				Kind      string `json:"kind"`
				Actor     struct {
					Kind      string `json:"kind"`
					MemberID  int64  `json:"member_id"`
					Via       string `json:"via"`
					Run       string `json:"run"`
					AgentKind string `json:"agent_kind"`
				} `json:"actor"`
			}
			if json.Unmarshal(row.Data, &burst) != nil || burst.ID == "" || burst.SourceKey != burst.ID ||
				burst.Kind != "burst" || !row.FilesPresent || burst.Actor.MemberID <= 0 {
				complete = false
				continue
			}
			switch burst.Actor.Via {
			case "terminal", "ssh", "cli", "web", "agent":
			default:
				complete = false
				continue
			}
			if burst.Actor.Kind == "agent" && burst.Actor.Run != "" &&
				(burst.Actor.AgentKind == "coding" || burst.Actor.AgentKind == "reviewer" || burst.Actor.AgentKind == "external") {
				continue // Sponsor attribution never makes an agent edit a person edit.
			}
			if burst.Actor.Kind != "person" || burst.Actor.Run != "" || burst.Actor.AgentKind != "" || burst.Actor.Via == "agent" {
				complete = false
				continue
			}
			facts.Actions = append(facts.Actions, scorecardAction{SourceKey: burst.SourceKey, TODO: branchTODOs[row.TenantID+"/"+row.PrincipalID],
				Person: fmt.Sprint(burst.Actor.MemberID), Via: burst.Actor.Via, Kind: "edit", At: row.RecordedAt})
		}
		facts.Coverage["T-COL-04"] = complete
	}
	if present["audit_log"] {
		rows, err := queries.ScorecardPresence(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		// Empty legacy audit tables do not establish producer coverage. Once
		// the visit writer has persisted its contract, windows with no matching
		// visits can return zero. Invalid receipts leave this source missing.
		complete := len(rows) > 0
		for _, row := range rows {
			var visit struct {
				Branch string    `json:"branch"`
				Member int64     `json:"member"`
				Via    string    `json:"via"`
				Start  time.Time `json:"start"`
				End    time.Time `json:"end"`
			}
			if json.Unmarshal(row.Metadata, &visit) != nil || !row.ActorID.Valid || row.ActorID.Int64 <= 0 ||
				visit.Member != row.ActorID.Int64 || visit.Via != "app" || visit.Branch == "" ||
				visit.Branch != row.TargetName || visit.Start.IsZero() || visit.End.Sub(visit.Start) < 2*time.Minute {
				complete = false
				continue
			}
			facts.Presence = append(facts.Presence, scorecardPresence{ID: row.ID, Branch: visit.Branch,
				Person: fmt.Sprint(visit.Member), From: visit.Start, To: visit.End})
		}
		facts.Coverage["T-COL-06"] = complete
	}
	if present["approvals"] && present["mythical_items"] {
		rows, err := queries.ScorecardReviews(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		complete := len(rows) > 0
		for _, row := range rows {
			if row.TodoID == "" || !row.MemberID.Valid || row.MemberID.Int64 <= 0 || row.CreatedAt.IsZero() {
				complete = false
				continue
			}
			if row.State != "approved" {
				continue
			}
			if !row.DecidedAt.Valid || row.DecidedAt.Time.Before(row.CreatedAt) ||
				!row.DecidedBy.Valid || row.DecidedBy.Int64 != row.MemberID.Int64 || row.DecisionCredential == "" {
				complete = false
				continue
			}
			facts.Actions = append(facts.Actions, scorecardAction{SourceKey: row.ID, TODO: row.TodoID,
				Person: fmt.Sprint(row.DecidedBy.Int64), Kind: "review", At: row.DecidedAt.Time})
		}
		facts.Coverage["T-APP-04"] = complete
	}
	if present["memory_notes"] && present["mythical_items"] {
		rows, err := queries.ScorecardLearnings(ctx)
		if err != nil {
			return Scorecard{}, err
		}
		complete := len(rows) > 0
		for _, row := range rows {
			var note LearningProposalNote
			if json.Unmarshal([]byte(row.ProvenanceJson), &note) != nil ||
				!learningNoteBound(note, row.Repository) || !row.StatusAtMs.Valid {
				complete = false
				continue
			}
			for _, todo := range facts.TODOs {
				if todo.ID == row.TodoID {
					var merged time.Time
					if todo.State == "merged" {
						merged = todo.StateAt
					}
					facts.Learnings = append(facts.Learnings, scorecardLearning{ID: row.ID,
						TODO: row.TodoID, Repository: fmt.Sprint(row.RepositoryID), Signature: note.Signature,
						Accepted: time.UnixMilli(row.StatusAtMs.Int64), Merged: merged})
				}
			}
		}
		facts.Coverage["T-FLW-06"] = complete
	}
	out := aggregateScorecard(window, facts)
	if err := tx.Commit(ctx); err != nil {
		return Scorecard{}, err
	}
	return out, nil
}

func unavailableScorecard(window ScorecardWindow) Scorecard {
	out := Scorecard{Window: window, Measures: make(map[string]ScorecardMeasure),
		PersonMinutes: ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}}
	add := func(name, target, kill string, tables, tickets []string) {
		out.Measures[name] = ScorecardMeasure{Target: target, KillSignal: kill, Verdict: "source_missing", Window: window, SourceTables: tables, MissingTickets: tickets}
	}
	todoTables := []string{"mythical_items", "product_job_events"}
	merges := []string{"T-STK-01", "T-STK-04", "T-GH-02"}
	add("install_start", "diagnostic", "none", []string{"install_settings"}, []string{"T-INS-06"})
	add("first_answer", "diagnostic", "none", []string{"chat_turns", "chat_turn_batches"}, []string{"T-APP-16"})
	add("first_merge", "diagnostic", "none", todoTables, merges)
	add("accepted", "diagnostic", "none", todoTables, []string{"T-STK-01"})
	for _, name := range []string{"merged", "dropped", "failed"} {
		tickets := []string{"T-STK-01"}
		if name == "merged" {
			tickets = merges
		}
		add(name, "diagnostic", "none", todoTables, tickets)
	}
	add("dogfood", "50 merged TODOs in 14 days", "fewer than 20 merged TODOs or outside work exceeds 50%", append([]string{"github_synced_repos"}, todoTables...), merges)
	add("activation", "first merge within 60 minutes", "two of three teams need help (manual)", append([]string{"install_settings"}, todoTables...), append([]string{"T-INS-06"}, merges...))
	add("core_value", "at least 10 accepted TODOs per week; sampled median under 15 person-minutes (manual)", "fewer than 3 accepted in week 2 or rising sampled median (manual)", todoTables, []string{"T-STK-01"})
	add("terminal_edits", "diagnostic", "none", []string{"product_job_events", "burst_files"}, []string{"T-COL-04"})
	add("second_member_actions", "diagnostic", "none", append([]string{"approvals"}, todoTables...), []string{"T-STK-01", "T-COL-04", "T-APP-04"})
	add("no_hand_written_code", "diagnostic", "none", []string{"mythical_items", "product_job_events", "burst_files"}, append([]string{"T-COL-04"}, merges...))
	add("flow_revisions", "diagnostic", "none", []string{"workflow_definitions"}, []string{"T-FLW-03"})
	add("outside_work", "diagnostic", "over 50% of changes to main", []string{"github_synced_repos", "mythical_items"}, []string{"T-GH-02", "T-STK-01"})
	add("multiplayer", "at least 3 sessions per week with two members on one branch", "zero sessions in week 2", []string{"audit_log"}, []string{"T-COL-06"})
	add("retention", "at least 10 accepted TODOs in week 3", "fewer than 3 accepted TODOs in week 3", todoTables, []string{"T-STK-01"})
	add("self_improvement", "at least one merged learning proposal reduces its signature rate over the next 5 TODOs versus the previous 5", "no accepted proposal in two weeks", []string{"mythical_items", "memory_notes"}, []string{"T-FLW-06", "T-STK-01", "T-STK-04"})
	return out
}
