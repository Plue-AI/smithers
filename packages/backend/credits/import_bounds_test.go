package credits

import (
	"context"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLegacyDebtOverflowRejectedBeforeDatabaseAccess(t *testing.T) {
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	archive := []LegacyAccount{
		{SourceID: "valid-first", BalanceNanos: 1},
		{SourceID: "minimum-balance", BalanceNanos: math.MinInt64},
	}
	// An unconfigured ledger proves validation happens before any database
	// access, including committing the valid account preceding the bad one.
	l := Ledger{}
	for name, run := range map[string]func() (ImportReport, error){
		"dry run": func() (ImportReport, error) { return DryRun(at, archive) },
		"import":  func() (ImportReport, error) { return l.Import(context.Background(), at, archive) },
		"verify":  func() (ImportReport, error) { return l.Verify(context.Background(), at, archive) },
	} {
		t.Run(name, func(t *testing.T) {
			report, err := run()
			if err == nil || !strings.Contains(err.Error(), "minimum-balance: opening debt overflows") {
				t.Fatalf("expected source-specific debt overflow error, got %v", err)
			}
			if !reflect.DeepEqual(report, ImportReport{}) {
				t.Fatalf("invalid archive returned a report: %+v", report)
			}
		})
	}
}

func TestLegacyBalanceBoundsRoundTrip(t *testing.T) {
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	archive := []LegacyAccount{
		{SourceID: "maximum-debt", BalanceNanos: math.MinInt64 + 1},
		{SourceID: "maximum-credit", BalanceNanos: math.MaxInt64},
		{SourceID: "zero"},
	}
	dry, err := DryRun(at, archive)
	if err != nil {
		t.Fatal(err)
	}
	if dry.Count != 3 || dry.Sealed != 3 || dry.SyntheticOpenings != 1 || dry.BalanceNanos != 0 || dry.SealedNanos != 0 {
		t.Fatalf("boundary report: %+v", dry)
	}
	for i, account := range archive {
		if dry.Items[i].BalanceNanos != account.BalanceNanos {
			t.Fatalf("source %s balance = %d, want %d", account.SourceID, dry.Items[i].BalanceNanos, account.BalanceNanos)
		}
	}
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	for i := range 2 {
		got, err := l.Import(ctx, at, archive)
		if err != nil || !reflect.DeepEqual(got, dry) {
			t.Fatalf("import %d: report=%+v err=%v", i, got, err)
		}
	}
	verified, err := l.Verify(ctx, at, archive)
	if err != nil || !reflect.DeepEqual(verified, dry) {
		t.Fatalf("verify: report=%+v err=%v", verified, err)
	}
	var openingDebt, debt, eventDebt int64
	if err := l.DB.QueryRow(ctx, `SELECT i.opening_debt_nanos, a.debt_nanos,
		(SELECT sum(e.debt_delta_nanos) FROM credit_events e WHERE e.account_id = a.id)
		FROM credit_legacy_imports i JOIN credit_accounts a ON a.id = i.account_id
		WHERE i.source_id = 'maximum-debt'`).Scan(&openingDebt, &debt, &eventDebt); err != nil {
		t.Fatal(err)
	}
	if openingDebt != math.MaxInt64 || debt != math.MaxInt64 || eventDebt != math.MaxInt64 {
		t.Fatalf("opening debt=%d account debt=%d event debt=%d, want %d", openingDebt, debt, eventDebt, int64(math.MaxInt64))
	}
	assertInvariants(t, l)
}
