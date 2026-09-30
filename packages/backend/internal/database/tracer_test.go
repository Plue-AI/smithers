package database

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

type dbQueryObservation struct {
	query   string
	seconds float64
}

type dbQueryMetricsStub struct {
	mu           sync.Mutex
	observations []dbQueryObservation
}

func (m *dbQueryMetricsStub) ObserveDBQueryDuration(query string, seconds float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.observations = append(m.observations, dbQueryObservation{query: query, seconds: seconds})
}

func (m *dbQueryMetricsStub) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.observations)
}

func (m *dbQueryMetricsStub) containsQuery(query string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, observation := range m.observations {
		if observation.query == query && observation.seconds > 0 {
			return true
		}
	}
	return false
}

func TestMetricsTracer_TraceQueryStartEndRecordsDuration(t *testing.T) {
	t.Parallel()

	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "SELECT 1"})
	time.Sleep(5 * time.Millisecond)
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	require.Equal(t, 1, metrics.count())
	assert.True(t, metrics.containsQuery("SELECT"))
}

func TestMetricsTracer_TraceQueryStartEndEmitsChildSpan(t *testing.T) {
	recorder := installRecordingTracerProvider(t)
	parentCtx, parent := otel.Tracer("test").Start(context.Background(), "GET /api/repos")
	defer parent.End()

	tracer := NewMetricsTracer(nil)
	ctx := tracer.TraceQueryStart(parentCtx, nil, pgx.TraceQueryStartData{SQL: "SELECT 1"})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	spans := recorder.Ended()
	require.Len(t, spans, 1)
	assert.Equal(t, "db.query SELECT", spans[0].Name())
	assert.Equal(t, parent.SpanContext().TraceID(), spans[0].SpanContext().TraceID())
	assert.Equal(t, parent.SpanContext().SpanID(), spans[0].Parent().SpanID())
	assert.Contains(t, spans[0].Attributes(), attribute.String("db.system.name", "postgresql"))
	assert.Contains(t, spans[0].Attributes(), attribute.String("db.operation.name", "SELECT"))
}

// A query outside any trace (a background worker) must not start its own root
// trace: each one would be sampled as a separate trace and exhaust the
// exporter quota. Its duration metric is still recorded.
func TestMetricsTracer_ParentlessQueryRecordsMetricWithoutSpan(t *testing.T) {
	recorder := installRecordingTracerProvider(t)
	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	for _, sql := range []string{"DELETE FROM leases", "BEGIN", "COMMIT"} {
		ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: sql})
		tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
	}

	assert.Empty(t, recorder.Started())
	assert.Empty(t, recorder.Ended())
	assert.Equal(t, 3, metrics.count())
}

func installRecordingTracerProvider(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	originalProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(originalProvider)
		require.NoError(t, provider.Shutdown(context.Background()))
	})
	return recorder
}

// TestMetricsTracer_ClassifiesSQLKeywords verifies that classifyQueryLabel
// extracts the correct uppercase verb from different SQL statements.
func TestMetricsTracer_ClassifiesSQLKeywords(t *testing.T) {
	t.Parallel()

	cases := []struct {
		sql      string
		expected string
	}{
		{"SELECT 1", "SELECT"},
		{"INSERT INTO users (name) VALUES ($1)", "INSERT"},
		{"UPDATE users SET name = $1 WHERE id = $2", "UPDATE"},
		{"DELETE FROM users WHERE id = $1", "DELETE"},
		{"select id from users", "SELECT"}, // lowercase input uppercased
		{"WITH cte AS (SELECT 1) SELECT * FROM cte", "WITH"},
		{"BEGIN", "BEGIN"},
		{"COMMIT", "COMMIT"},
		{"ROLLBACK", "ROLLBACK"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.expected, func(t *testing.T) {
			t.Parallel()

			metrics := &dbQueryMetricsStub{}
			tracer := NewMetricsTracer(metrics)

			ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: tc.sql})
			tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

			require.Equal(t, 1, metrics.count())
			assert.True(t, metrics.containsQuery(tc.expected),
				"SQL %q should be classified as %q", tc.sql, tc.expected)
		})
	}
}

// TestMetricsTracer_EmptySQL verifies that empty SQL is classified as OTHER.
func TestMetricsTracer_EmptySQL(t *testing.T) {
	t.Parallel()

	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: ""})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	require.Equal(t, 1, metrics.count())
	assert.True(t, metrics.containsQuery("OTHER"),
		"empty SQL should be classified as OTHER")
}

// TestMetricsTracer_WhitespaceOnlySQL verifies whitespace-only SQL is classified as OTHER.
func TestMetricsTracer_WhitespaceOnlySQL(t *testing.T) {
	t.Parallel()

	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "   \t\n  "})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	require.Equal(t, 1, metrics.count())
	assert.True(t, metrics.containsQuery("OTHER"),
		"whitespace-only SQL should be classified as OTHER")
}

// TestMetricsTracer_NilMetrics verifies that a tracer with nil metrics does not panic.
func TestMetricsTracer_NilMetrics(t *testing.T) {
	t.Parallel()

	tracer := NewMetricsTracer(nil)

	require.NotPanics(t, func() {
		ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "SELECT 1"})
		time.Sleep(1 * time.Millisecond)
		tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
	}, "nil metrics tracer must not panic")
}

// TestMetricsTracer_NilTracerNilMetrics verifies that a nil tracer is handled gracefully.
func TestMetricsTracer_NilTracerNilMetrics(t *testing.T) {
	t.Parallel()

	var tracer *MetricsTracer

	require.NotPanics(t, func() {
		// TraceQueryEnd has a nil guard; TraceQueryStart returns the context as-is.
		tracer.TraceQueryEnd(context.Background(), nil, pgx.TraceQueryEndData{})
	}, "nil tracer.TraceQueryEnd must not panic")
}

// TestMetricsTracer_QueryEndWithoutStart verifies that calling TraceQueryEnd
// without a prior TraceQueryStart does not panic (missing start key in context).
func TestMetricsTracer_QueryEndWithoutStart(t *testing.T) {
	t.Parallel()

	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	// Provide a context without the start time key (simulates missed TraceQueryStart).
	require.NotPanics(t, func() {
		tracer.TraceQueryEnd(context.Background(), nil, pgx.TraceQueryEndData{})
	}, "TraceQueryEnd with no prior start must not panic")

	// No observation should be recorded since there was no start time.
	assert.Equal(t, 0, metrics.count(), "no observation must be recorded if start was not recorded")
}

// TestMetricsTracer_ConcurrentQueriesAreGoroutineSafe verifies that concurrent
// query tracing is goroutine-safe (no data races).
func TestMetricsTracer_ConcurrentQueriesAreGoroutineSafe(t *testing.T) {
	t.Parallel()

	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	const concurrency = 20
	done := make(chan struct{}, concurrency)

	for i := 0; i < concurrency; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "SELECT 1"})
			tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
		}()
	}

	for i := 0; i < concurrency; i++ {
		<-done
	}

	assert.Equal(t, concurrency, metrics.count(),
		"all concurrent queries must be recorded without data races")
}

func TestNewPool_AttachesTracerAndRecordsQueryDuration(t *testing.T) {
	databaseURL := testdb.New(t).URL

	metrics := &dbQueryMetricsStub{}
	cfg := config.DatabaseConfig{
		URL:             databaseURL,
		MaxConns:        4,
		MinConns:        1,
		MaxConnLifetime: 60,
		MaxConnIdleTime: 30,
	}

	pool, err := NewPool(context.Background(), cfg, metrics)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	before := metrics.count()
	_, err = pool.Exec(context.Background(), "SELECT pg_sleep(0.01)")
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		return metrics.count() > before
	}, time.Second, 10*time.Millisecond)

	assert.True(t, metrics.containsQuery("SELECT"))
}

// ---------------------------------------------------------------------------
// Query classification (release review 2026-09-13, R013)
//
// Every sqlc-generated query constant begins with a "-- name: X :cmd" comment,
// so a classifier that takes the first whitespace token labeled the whole
// production workload "--". The classifier must skip SQL comments and bound
// the label set so the metric stays meaningful and low-cardinality.
// ---------------------------------------------------------------------------

func classifyViaTracer(t *testing.T, sql string) string {
	t.Helper()
	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)
	ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: sql})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	require.Len(t, metrics.observations, 1)
	return metrics.observations[0].query
}

func TestMetricsTracer_SkipsLeadingCommentsBeforeClassifying(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		sql  string
		want string
	}{
		{"sqlc select", "-- name: GetAuthInfoByTokenHash :one\nSELECT t.id FROM access_tokens t WHERE t.token_hash = $1", "SELECT"},
		{"sqlc insert", "-- name: CreateUser :one\nINSERT INTO users (username) VALUES ($1) RETURNING id", "INSERT"},
		{"sqlc update", "-- name: RefreshAuthSession :one\nUPDATE auth_sessions SET expires_at = $1 WHERE session_key = $2 RETURNING session_key", "UPDATE"},
		{"sqlc delete", "-- name: DeleteAccessToken :exec\nDELETE FROM access_tokens WHERE id = $1", "DELETE"},
		{"sqlc cte", "-- name: AdminAnalyticsDaily :many\nWITH days AS (SELECT 1) SELECT * FROM days", "WITH"},
		{"sqlc with blank line", "-- name: ListAlertIncidents :many\n\nSELECT id FROM alert_incidents", "SELECT"},
		{"nested comments", "/* outer /* inner */ outer */ SELECT 1", "SELECT"},
		{"adjacent comment", "SELECT/* explanation */ 1", "SELECT"},
		{"adjacent parenthesis", "SELECT(1)", "SELECT"},
		{"transaction semicolon", "BEGIN;", "BEGIN"},
		{"keyword prefix is not verb", "SELECTOR something", "OTHER"},
		{"block comment", "/* hint */ UPDATE users SET name = $1", "UPDATE"},
		{"multi-line block comment", "/*\n  planner hint\n*/\nINSERT INTO t VALUES (1)", "INSERT"},
		{"stacked comments", "-- one\n  -- two\n/* three */\n\tDELETE FROM t", "DELETE"},
		{"raw query still works", "SELECT 1", "SELECT"},
		{"lowercase", "select id from users", "SELECT"},
		{"begin", "BEGIN", "BEGIN"},
		{"commit", "COMMIT", "COMMIT"},
		{"rollback", "ROLLBACK", "ROLLBACK"},
		{"comment only", "-- nothing here", "OTHER"},
		{"unterminated block comment", "/* never closed", "OTHER"},
		{"empty", "", "OTHER"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, classifyViaTracer(t, tc.sql), "sql %q", tc.sql)
		})
	}
}

func TestMetricsTracer_LabelSetIsBounded(t *testing.T) {
	t.Parallel()

	for _, sql := range []string{
		"EXPLAIN ANALYZE SELECT 1",
		"TRUNCATE users",
		"VACUUM",
		"SET statement_timeout = 1000",
		"SAVEPOINT sp1",
		"CREATE TABLE t (id int)",
		"-- name: Weird :exec\nLOCK TABLE users",
		"$1", // unparsable junk must not become a label
	} {
		assert.Equal(t, "OTHER", classifyViaTracer(t, sql), "sql %q must collapse into the bounded OTHER label", sql)
	}
}

// sqlcQueryConstants extracts every "-- name:" query string constant from the
// generated internal/db/*.sql.go files so the classifier is exercised against
// the real production query text, not hand-written approximations.
func sqlcQueryConstants(t *testing.T) map[string]string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("..", "db", "*.sql.go"))
	require.NoError(t, err)
	require.NotEmpty(t, files, "internal/db/*.sql.go must exist (run sqlc generate in db/product)")

	queries := map[string]string{}
	fset := token.NewFileSet()
	for _, file := range files {
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		require.NoError(t, err, file)
		for _, decl := range parsed.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			for _, spec := range gen.Specs {
				valueSpec, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, value := range valueSpec.Values {
					lit, ok := value.(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING {
						continue
					}
					text, err := strconv.Unquote(lit.Value)
					if err != nil || !strings.HasPrefix(text, "-- name:") {
						continue
					}
					queries[filepath.Base(file)+":"+valueSpec.Names[i].Name] = text
				}
			}
		}
	}
	require.Greater(t, len(queries), 500, "expected the full sqlc query set")
	return queries
}

// sqlcExpectedVerb is an independent oracle for generated queries: sqlc emits
// exactly one "-- name:" header line, so the verb is the first word after it.
func sqlcExpectedVerb(sql string) string {
	_, rest, _ := strings.Cut(sql, "\n")
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return "OTHER"
	}
	return strings.ToUpper(fields[0])
}

func TestMetricsTracer_ClassifiesEveryGeneratedQueryByVerb(t *testing.T) {
	t.Parallel()

	allowed := map[string]bool{"SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true, "WITH": true}
	seen := map[string]int{}
	for name, sql := range sqlcQueryConstants(t) {
		got := classifyViaTracer(t, sql)
		seen[got]++
		assert.Equal(t, sqlcExpectedVerb(sql), got, "%s classified as %q", name, got)
		assert.True(t, allowed[got], "%s produced label %q outside the sqlc verb set", name, got)
	}
	assert.Zero(t, seen["--"], "no generated query may be labeled with the comment marker")
	for verb := range allowed {
		assert.Greater(t, seen[verb], 0, "expected at least one generated %s query", verb)
	}
}

func TestMetricsTracer_SpanCarriesSqlcQueryNameNotMetricLabel(t *testing.T) {
	recorder := installRecordingTracerProvider(t)
	parentCtx, parent := otel.Tracer("test").Start(context.Background(), "request")
	defer parent.End()

	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	named := "-- name: GetAuthInfoByTokenHash :one\nSELECT t.id FROM access_tokens t WHERE t.token_hash = $1"
	ctx := tracer.TraceQueryStart(parentCtx, nil, pgx.TraceQueryStartData{SQL: named})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	raw := "SELECT pg_sleep(0.01)"
	ctx = tracer.TraceQueryStart(parentCtx, nil, pgx.TraceQueryStartData{SQL: raw})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	spans := recorder.Ended()
	require.Len(t, spans, 2)

	assert.Equal(t, "db.query SELECT", spans[0].Name())
	assert.Contains(t, spans[0].Attributes(), attribute.String("db.operation.name", "SELECT"))
	assert.Contains(t, spans[0].Attributes(), attribute.String("db.query.name", "GetAuthInfoByTokenHash"))

	assert.Equal(t, "db.query SELECT", spans[1].Name())
	for _, attr := range spans[1].Attributes() {
		assert.NotEqual(t, attribute.Key("db.query.name"), attr.Key, "a raw query has no sqlc name to report")
	}

	// The query name is trace-only: the metric label stays the bounded verb.
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	require.Len(t, metrics.observations, 2)
	assert.Equal(t, "SELECT", metrics.observations[0].query)
	assert.Equal(t, "SELECT", metrics.observations[1].query)
}

// Exercise the sqlc -> production pgx pool -> telemetry boundary against
// PostgreSQL. Roll back the transaction so no notification is delivered.
func TestMetricsTracer_GeneratedQueryThroughPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	recorder := installRecordingTracerProvider(t)
	ctx, parent := otel.Tracer("test").Start(ctx, "request")
	defer parent.End()
	// Same convention as the other PostgreSQL-backed tests in this package:
	// the unit gate runs without a database and skips; the PostgreSQL step
	// runs the package with SMITHERS_TEST_DATABASE_URL set.
	databaseURL := testdb.New(t).URL
	metrics := &dbQueryMetricsStub{}
	pool, err := NewPool(ctx, config.DatabaseConfig{URL: databaseURL, MaxConns: 2, MaxConnLifetime: 60, MaxConnIdleTime: 30}, metrics)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	const payload = "private-notification-payload"
	require.NoError(t, db.New(tx).NotifyWorkflowLog(ctx, db.NotifyWorkflowLogParams{StepID: -1, Payload: payload}))
	require.NoError(t, tx.Rollback(ctx))
	var named int
	for _, span := range recorder.Ended() {
		for _, attr := range span.Attributes() {
			assert.NotContains(t, attr.Value.String(), payload)
			assert.NotEqual(t, attribute.Key("db.statement"), attr.Key)
			if attr.Key == "db.query.name" && attr.Value.AsString() == "NotifyWorkflowLog" {
				named++
				assert.Equal(t, "db.query SELECT", span.Name())
				assert.Contains(t, span.Attributes(), attribute.String("db.operation.name", "SELECT"))
			}
		}
	}
	assert.Equal(t, 1, named, "the generated query must export its sqlc name")
	assert.True(t, metrics.containsQuery("SELECT"))
	assert.False(t, metrics.containsQuery("--"))
	assert.False(t, metrics.containsQuery("NotifyWorkflowLog"), "query names are span attributes only")
}

func TestMetricsTracer_OnlyWellFormedBoundedSqlcNamesReachSpans(t *testing.T) {
	recorder := installRecordingTracerProvider(t)
	parentCtx, parent := otel.Tracer("test").Start(context.Background(), "request")
	defer parent.End()
	tracer := NewMetricsTracer(nil)
	headers := []string{
		"-- name: " + strings.Repeat("X", 129) + " :one",
		"-- name: password=secret :one",
		"-- name: MissingCommand",
		"-- name: BadCommand :unrecognized",
	}
	for _, header := range headers {
		ctx := tracer.TraceQueryStart(parentCtx, nil, pgx.TraceQueryStartData{SQL: header + "\nSELECT 1"})
		tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
	}
	require.Len(t, recorder.Ended(), len(headers))
	for _, span := range recorder.Ended() {
		for _, attr := range span.Attributes() {
			assert.NotEqual(t, attribute.Key("db.query.name"), attr.Key, "malformed annotations must not become telemetry")
		}
	}
}
