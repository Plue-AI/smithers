package database

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// DBQueryDurationObserver records database query latency observations.
type DBQueryDurationObserver interface {
	ObserveDBQueryDuration(query string, seconds float64)
}

type queryStartTimeKey struct{}
type queryLabelKey struct{}
type querySpanKey struct{}

// MetricsTracer implements pgx.QueryTracer and records query durations.
type MetricsTracer struct {
	metrics DBQueryDurationObserver
}

var _ pgx.QueryTracer = (*MetricsTracer)(nil)

// NewMetricsTracer creates a query tracer that reports duration to metrics.
func NewMetricsTracer(metrics DBQueryDurationObserver) *MetricsTracer {
	return &MetricsTracer{metrics: metrics}
}

// TraceQueryStart stores query metadata in the context for end-of-query timing.
func (t *MetricsTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if t == nil {
		return ctx
	}
	label := classifyQueryLabel(data.SQL)
	ctx = context.WithValue(ctx, queryStartTimeKey{}, time.Now())
	ctx = context.WithValue(ctx, queryLabelKey{}, label)
	// Trace a query only inside an existing trace. A parentless query (a
	// background worker) would otherwise become its own root trace and be
	// sampled separately; its duration metric is still recorded.
	if !oteltrace.SpanContextFromContext(ctx).IsValid() {
		return ctx
	}
	attrs := []attribute.KeyValue{
		attribute.String("db.system.name", "postgresql"),
		attribute.String("db.operation.name", label),
	}
	// The sqlc query name is bounded by the generated query set, so it is
	// safe on a span. It is deliberately NOT a metric label: the metric keeps
	// the handful of verbs so its cardinality never tracks the query catalog.
	if name := sqlcQueryName(data.SQL); name != "" {
		attrs = append(attrs, attribute.String("db.query.name", name))
	}
	ctx, span := otel.Tracer("github.com/smithersai/smithers/packages/backend/internal/database").Start(
		ctx,
		"db.query "+label,
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(attrs...),
	)
	ctx = context.WithValue(ctx, querySpanKey{}, span)
	return ctx
}

// TraceQueryEnd records query duration and label.
func (t *MetricsTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if span, ok := ctx.Value(querySpanKey{}).(oteltrace.Span); ok && span != nil {
		if data.Err != nil {
			span.RecordError(data.Err)
			span.SetStatus(codes.Error, data.Err.Error())
		}
		span.End()
	}
	if t == nil || t.metrics == nil {
		return
	}

	start, ok := ctx.Value(queryStartTimeKey{}).(time.Time)
	if !ok {
		return
	}
	label, _ := ctx.Value(queryLabelKey{}).(string)
	if label == "" {
		label = queryLabelOther
	}

	durationSeconds := time.Since(start).Seconds()
	if durationSeconds < 0 {
		return
	}

	t.metrics.ObserveDBQueryDuration(label, durationSeconds)
}

const queryLabelOther = "OTHER"

// classifyQueryLabel returns the bounded operation label for a statement:
// the first SQL keyword after any leading whitespace and comments, uppercased
// and restricted to known verbs. sqlc-generated queries start with a
// "-- name: X :cmd" comment line, so taking the first raw token labeled the
// entire production workload "--".
func classifyQueryLabel(sql string) string {
	body := skipSQLCommentsAndSpace(sql)
	end := 0
	for end < len(body) && isSQLIdentifierByte(body[end]) {
		end++
	}
	// ROLLBACK is the longest allowed keyword. Avoid allocating a copy of
	// an arbitrary long identifier just to reject it.
	if end > len("ROLLBACK") {
		return queryLabelOther
	}
	keyword := strings.ToUpper(body[:end])
	switch keyword {
	case "SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "BEGIN", "COMMIT", "ROLLBACK":
		return keyword
	default:
		return queryLabelOther
	}
}

func isSQLIdentifierByte(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_'
}

// skipSQLCommentsAndSpace strips leading whitespace, "--" line comments and
// "/* */" block comments. An unterminated block comment consumes the rest of
// the statement, which is how PostgreSQL would read it too.
func skipSQLCommentsAndSpace(sql string) string {
	for {
		sql = strings.TrimLeft(sql, " \t\r\n\f\v")
		switch {
		case strings.HasPrefix(sql, "--"):
			newline := strings.IndexByte(sql, '\n')
			if newline < 0 {
				return ""
			}
			sql = sql[newline+1:]
		case strings.HasPrefix(sql, "/*"):
			// PostgreSQL allows nested block comments.
			depth, end := 1, 2
			for depth > 0 && end < len(sql) {
				switch {
				case strings.HasPrefix(sql[end:], "/*"):
					depth++
					end += 2
				case strings.HasPrefix(sql[end:], "*/"):
					depth--
					end += 2
				default:
					end++
				}
			}
			if depth != 0 {
				return ""
			}
			sql = sql[end:]
		default:
			return sql
		}
	}
}

// sqlcQueryName returns the query name from a sqlc "-- name: <Name> :<cmd>"
// header, or "" when the statement carries none.
func sqlcQueryName(sql string) string {
	header, _, _ := strings.Cut(strings.TrimLeft(sql, " \t\r\n"), "\n")
	rest, ok := strings.CutPrefix(header, "-- name:")
	if !ok {
		return ""
	}
	fields := strings.Fields(rest)
	if len(fields) != 2 || len(fields[0]) > 128 {
		return ""
	}
	// Only accept bounded identifiers from a well-formed sqlc annotation;
	// free-form comments and parameter values must not enter telemetry.
	for i := range len(fields[0]) {
		b := fields[0][i]
		if !isSQLIdentifierByte(b) || i == 0 && b >= '0' && b <= '9' {
			return ""
		}
	}
	switch fields[1] {
	case ":one", ":many", ":exec", ":execrows", ":execlastid", ":copyfrom", ":batchexec", ":batchone", ":batchmany":
	default:
		return ""
	}
	return fields[0]
}
