package services

import (
	"context"
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
	// No source SELECT is issued before its relation and producer coverage are
	// established. Currently no provider is integrated, including present tables.
	if _, err := queries.ScorecardSourceRelations(ctx); err != nil {
		return Scorecard{}, err
	}
	out := unavailableScorecard(window)
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
	add("second_member_actions", "diagnostic", "none", todoTables, []string{"T-STK-01", "T-COL-04"})
	add("no_hand_written_code", "diagnostic", "none", []string{"mythical_items", "product_job_events", "burst_files"}, append([]string{"T-COL-04"}, merges...))
	add("flow_revisions", "diagnostic", "none", []string{"workflow_definitions"}, []string{"T-FLW-03"})
	add("outside_work", "diagnostic", "over 50% of changes to main", []string{"github_synced_repos", "mythical_items"}, []string{"T-GH-02", "T-STK-01"})
	add("multiplayer", "at least 3 sessions per week with two members on one branch", "zero sessions in week 2", []string{"audit_log"}, []string{"T-COL-06"})
	add("retention", "at least 10 accepted TODOs in week 3", "fewer than 3 accepted TODOs in week 3", todoTables, []string{"T-STK-01"})
	add("self_improvement", "at least one merged learning proposal reduces its signature rate over the next 5 TODOs versus the previous 5", "no accepted proposal in two weeks", []string{"mythical_items"}, []string{"T-FLW-06", "T-STK-01", "T-STK-04"})
	return out
}
