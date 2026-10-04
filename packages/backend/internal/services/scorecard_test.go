package services

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestScorecardWindow(t *testing.T) {
	from, err := time.Parse(time.RFC3339, "2026-10-03T23:30:00-07:00")
	require.NoError(t, err)
	to := from.Add(14 * 24 * time.Hour)
	window, err := ValidateScorecardWindow(from, to)
	require.NoError(t, err)
	require.Equal(t, "2026-10-04T06:30:00Z", window.From.Format(time.RFC3339))
	require.Equal(t, "2026-10-18T06:30:00Z", window.To.Format(time.RFC3339))
	for _, pair := range [][2]time.Time{{from, from}, {to, from}, {{}, to}, {from, {}}} {
		_, err := ValidateScorecardWindow(pair[0], pair[1])
		require.Error(t, err)
	}
}

func TestScorecardMissingCoverage(t *testing.T) {
	from := time.Date(2026, 10, 4, 6, 30, 0, 0, time.UTC)
	out := unavailableScorecard(ScorecardWindow{From: from, To: from.Add(14 * 24 * time.Hour)})
	require.Equal(t, ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}, out.PersonMinutes)
	// Literal provider expectations; table existence cannot upgrade these to zero.
	expected := map[string][]string{
		"install_start": {"T-INS-06"}, "first_answer": {"T-APP-16"},
		"first_merge": {"T-STK-01", "T-STK-04", "T-GH-02"},
		"accepted":    {"T-STK-01"}, "merged": {"T-STK-01", "T-STK-04", "T-GH-02"},
		"dropped": {"T-STK-01"}, "failed": {"T-STK-01"},
		"dogfood":    {"T-STK-01", "T-STK-04", "T-GH-02"},
		"activation": {"T-INS-06", "T-STK-01", "T-STK-04", "T-GH-02"},
		"core_value": {"T-STK-01"}, "terminal_edits": {"T-COL-04"},
		"second_member_actions": {"T-STK-01", "T-COL-04"},
		"no_hand_written_code":  {"T-COL-04", "T-STK-01", "T-STK-04", "T-GH-02"},
		"flow_revisions":        {"T-FLW-03"}, "outside_work": {"T-GH-02", "T-STK-01"},
		"multiplayer": {"T-COL-06"}, "retention": {"T-STK-01"},
		"self_improvement": {"T-FLW-06", "T-STK-01", "T-STK-04"},
	}
	require.Len(t, out.Measures, len(expected))
	for name, tickets := range expected {
		measure, ok := out.Measures[name]
		require.True(t, ok, name)
		require.Nil(t, measure.Value, name)
		require.Equal(t, "source_missing", measure.Verdict, name)
		require.Equal(t, tickets, measure.MissingTickets, name)
		require.NotEmpty(t, measure.Target, name)
		require.NotEmpty(t, measure.KillSignal, name)
		require.Equal(t, out.Window, measure.Window, name)
	}
}

func TestScorecardMissingCoveragePostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	tracer := &scorecardSQLTrace{}
	config := pool.Config()
	config.ConnConfig.Tracer = tracer
	observed, err := pgxpool.NewWithConfig(context.Background(), config)
	require.NoError(t, err)
	defer observed.Close()
	ctx := context.Background()
	// Table presence and even rows are not evidence of the new producer contract.
	_, err = pool.Exec(ctx, `CREATE TABLE burst_files (id text); INSERT INTO burst_files VALUES ('unqualified');`)
	require.NoError(t, err)
	from := time.Date(2026, 10, 4, 6, 30, 0, 0, time.UTC)
	service := &ScorecardService{Pool: observed}
	first, err := service.Summary(ctx, from, from.Add(14*24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, "begin isolation level repeatable read read only", tracer.statements[0])
	require.Equal(t, "commit", tracer.statements[len(tracer.statements)-1])
	for _, statement := range tracer.statements[1 : len(tracer.statements)-1] {
		require.True(t, strings.HasPrefix(strings.TrimSpace(statement), "--") || strings.HasPrefix(strings.TrimSpace(statement), "SELECT"), statement)
		require.NotContains(t, strings.ToUpper(statement), "INSERT ")
		require.NotContains(t, strings.ToUpper(statement), "UPDATE ")
		require.NotContains(t, strings.ToUpper(statement), "DELETE ")
	}
	require.Len(t, first.Measures, 18)
	require.Equal(t, ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}, first.PersonMinutes)
	for name, measure := range first.Measures {
		require.Nil(t, measure.Value, name)
		require.Equal(t, "source_missing", measure.Verdict, name)
		require.NotEmpty(t, measure.MissingTickets, name)
		require.NotEmpty(t, measure.Target, name)
		require.NotEmpty(t, measure.KillSignal, name)
		require.Equal(t, first.Window, measure.Window, name)
	}
	require.Equal(t, []string{"T-COL-04"}, first.Measures["terminal_edits"].MissingTickets)
	require.Equal(t, []string{"T-COL-06"}, first.Measures["multiplayer"].MissingTickets)
	require.Equal(t, "50 merged TODOs in 14 days", first.Measures["dogfood"].Target)
	_, err = pool.Exec(ctx, `DROP TABLE burst_files; DROP TABLE audit_log CASCADE`)
	require.NoError(t, err)
	second, err := service.Summary(ctx, from, from.Add(14*24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, first, second)
	rows, err := db.New(pool).ScorecardSourceRelations(ctx)
	require.NoError(t, err)
	for _, row := range rows {
		if row.Name == "audit_log" || row.Name == "burst_files" {
			require.False(t, row.Present)
		}
		if row.Name == "mythical_items" {
			require.True(t, row.Present)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = service.Summary(cancelled, from, from.Add(time.Hour))
	require.Error(t, err)
	_, err = service.Summary(ctx, from, from)
	require.Error(t, err)
}

// Observes SQL sent to the real PostgreSQL server, without replacing execution.
type scorecardSQLTrace struct{ statements []string }

func (s *scorecardSQLTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	s.statements = append(s.statements, data.SQL)
	return ctx
}
func (*scorecardSQLTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
