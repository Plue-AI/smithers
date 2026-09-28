package credits

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLegacyReportOverflowBeforeDatabaseAccess(t *testing.T) {
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name     string
		balances []int64
		claimed  bool
		want     string
	}{
		{"positive total", []int64{math.MaxInt64, 1}, false, "balance_nanos total 9223372036854775808 overflows int64"},
		{"negative total", []int64{-math.MaxInt64, -2}, false, "balance_nanos total -9223372036854775809 overflows int64"},
		{"positive sealed", []int64{math.MaxInt64, 1, -1}, true, "sealed_nanos total 9223372036854775808 overflows int64"},
		{"negative sealed", []int64{-math.MaxInt64, -2, 2}, true, "sealed_nanos total -9223372036854775809 overflows int64"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			archive := make([]LegacyAccount, len(tc.balances))
			for i, balance := range tc.balances {
				archive[i] = LegacyAccount{SourceID: fmt.Sprintf("source-%d", i), BalanceNanos: balance}
			}
			if tc.claimed {
				archive[2].OwnerType, archive[2].OwnerID = "user", 1
			}
			l := Ledger{}
			operations := map[string]func() (ImportReport, error){
				"dry run": func() (ImportReport, error) { return DryRun(at, archive) },
			}
			// Dispositions can change after owner resolution or attachment;
			// only the overall total can reject Import/Verify without a DB.
			if !tc.claimed {
				operations["import"] = func() (ImportReport, error) { return l.Import(context.Background(), at, archive) }
				operations["verify"] = func() (ImportReport, error) { return l.Verify(context.Background(), at, archive) }
			}
			for name, run := range operations {
				t.Run(name, func(t *testing.T) {
					report, err := run()
					if err == nil || !strings.Contains(err.Error(), tc.want) {
						t.Fatalf("report=%+v err=%v, want %q", report, err, tc.want)
					}
					if !reflect.DeepEqual(report, ImportReport{}) {
						t.Fatalf("unrepresentable totals returned a report: %+v", report)
					}
				})
			}
		})
	}
}

func TestLegacyReportExactTotalsAcrossPermutations(t *testing.T) {
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		balances [3]int64
		want     int64
	}{
		{[3]int64{math.MaxInt64, 1, -1}, math.MaxInt64},
		{[3]int64{-math.MaxInt64, -2, 2}, -math.MaxInt64},
		{[3]int64{-math.MaxInt64, -1, 0}, math.MinInt64},
	} {
		for _, order := range [][3]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}} {
			archive := make([]LegacyAccount, 3)
			for i, source := range order {
				archive[i] = LegacyAccount{SourceID: fmt.Sprintf("source-%d", source), BalanceNanos: tc.balances[source]}
			}
			report, err := DryRun(at, archive)
			if err != nil || report.BalanceNanos != tc.want || report.SealedNanos != tc.want || report.Sealed != 3 {
				t.Fatalf("balances=%v order=%v: report=%+v err=%v", tc.balances, order, report, err)
			}
		}
	}
}

func TestLegacyReportDatabaseDispositionOverflow(t *testing.T) {
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	for _, disposition := range []Disposition{Owned, OwnerMissing} {
		for _, negative := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/negative=%t", disposition, negative), func(t *testing.T) {
				l := Ledger{DB: testPool(t)}
				ctx := context.Background()
				balances := [3]int64{math.MaxInt64, 1, -1}
				want := "9223372036854775808"
				if negative {
					balances = [3]int64{-math.MaxInt64, -2, 2}
					want = "-9223372036854775809"
				}
				archive := []LegacyAccount{
					{SourceID: "first", OwnerType: "user", OwnerID: 101, BalanceNanos: balances[0]},
					{SourceID: "second", OwnerType: "user", OwnerID: 102, BalanceNanos: balances[1]},
					{SourceID: "offset", BalanceNanos: balances[2]},
				}
				field := "sealed_nanos"
				if disposition == Owned {
					field = "owned_nanos"
					if _, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (101, 'bounds101', 'bounds101'), (102, 'bounds102', 'bounds102')`); err != nil {
						t.Fatal(err)
					}
				} else {
					archive[2].OwnerType, archive[2].OwnerID = "user", 103
					if _, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (103, 'bounds103', 'bounds103')`); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := DryRun(at, archive); err != nil {
					t.Fatal(err)
				}
				for _, operation := range []string{"import", "replay", "verify"} {
					var report ImportReport
					var err error
					if operation == "verify" {
						report, err = l.Verify(ctx, at, archive)
					} else {
						report, err = l.Import(ctx, at, archive)
					}
					if err == nil || !strings.Contains(err.Error(), field+" total "+want+" overflows int64") || !reflect.DeepEqual(report, ImportReport{}) {
						t.Fatalf("%s: report=%+v err=%v", operation, report, err)
					}
					var receipts int
					if err := l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_legacy_imports`).Scan(&receipts); err != nil || receipts != 3 {
						t.Fatalf("%s: receipts=%d err=%v", operation, receipts, err)
					}
				}
				// A failed verification must retain both the original conflict
				// and the fact that its successfully verified prefix overflows.
				if negative {
					archive[2].BalanceNanos++
				} else {
					archive[2].BalanceNanos--
				}
				partial, err := l.Verify(ctx, at, archive)
				if !errors.Is(err, ErrConflict) || !strings.Contains(err.Error(), "balance_nanos total "+want+" overflows int64") || !reflect.DeepEqual(partial, ImportReport{}) {
					t.Fatalf("failed verification: report=%+v err=%v", partial, err)
				}
			})
		}
	}
}

func TestLegacyImportFailureReportsOnlyCommittedAccounts(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	if _, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (101, 'bounds101', 'bounds101')`); err != nil {
		t.Fatal(err)
	}
	original := LegacyAccount{SourceID: "conflict", BalanceNanos: 1}
	if _, err := l.Import(ctx, at, []LegacyAccount{original}); err != nil {
		t.Fatal(err)
	}
	archive := []LegacyAccount{
		{SourceID: "committed", OwnerType: "user", OwnerID: 101, BalanceNanos: 5},
		{SourceID: "conflict", BalanceNanos: 2},
		{SourceID: "unvisited", BalanceNanos: 7},
	}
	report, err := l.Import(ctx, at, archive)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
	if report.Count != 1 || report.Owned != 1 || report.Sealed != 0 || report.Claimed != 0 || report.BalanceNanos != 5 || report.OwnedNanos != 5 || len(report.Items) != 1 || report.Items[0].SourceID != "committed" {
		t.Fatalf("partial report=%+v", report)
	}
	var receipts int
	if err := l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_legacy_imports`).Scan(&receipts); err != nil || receipts != 2 {
		t.Fatalf("receipts=%d err=%v", receipts, err)
	}
	archive[1] = original
	recovered, err := l.Import(ctx, at, archive)
	if err != nil || recovered.Count != 3 || recovered.OwnedNanos != 5 || recovered.SealedNanos != 8 || recovered.BalanceNanos != 13 {
		t.Fatalf("recovery: report=%+v err=%v", recovered, err)
	}
	archive[1].BalanceNanos++
	verified, err := l.Verify(ctx, at, archive)
	if !errors.Is(err, ErrConflict) || !reflect.DeepEqual(verified, report) {
		t.Fatalf("verified prefix: report=%+v err=%v", verified, err)
	}
}

func TestLegacyReportMixedOwnershipCancellation(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	if _, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES
		(101, 'bounds101', 'bounds101'), (102, 'bounds102', 'bounds102'), (103, 'bounds103', 'bounds103')`); err != nil {
		t.Fatal(err)
	}
	archive := []LegacyAccount{
		{SourceID: "owned-first", OwnerType: "user", OwnerID: 101, BalanceNanos: math.MaxInt64},
		{SourceID: "owned-second", OwnerType: "user", OwnerID: 102, BalanceNanos: 1},
		{SourceID: "sealed-first", BalanceNanos: -math.MaxInt64},
		{SourceID: "sealed-second", BalanceNanos: -2},
		{SourceID: "owned-offset", OwnerType: "user", OwnerID: 103, BalanceNanos: -1},
		{SourceID: "sealed-offset", BalanceNanos: 2},
	}
	dry, err := DryRun(at, archive)
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"import", "replay", "verify"} {
		var report ImportReport
		if operation == "verify" {
			report, err = l.Verify(ctx, at, archive)
		} else {
			report, err = l.Import(ctx, at, archive)
		}
		if err != nil || report.Count != 6 || report.Owned != 3 || report.Sealed != 3 || report.BalanceNanos != 0 || report.OwnedNanos != math.MaxInt64 || report.SealedNanos != -math.MaxInt64 || report.Checksum != dry.Checksum {
			t.Fatalf("%s: report=%+v err=%v", operation, report, err)
		}
	}
}

func TestLegacyImportOverflowingPartialReportPreservesFailure(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	if _, err := l.Import(ctx, at, []LegacyAccount{{SourceID: "conflict", BalanceNanos: -2}}); err != nil {
		t.Fatal(err)
	}
	archive := []LegacyAccount{
		{SourceID: "first", BalanceNanos: math.MaxInt64},
		{SourceID: "second", BalanceNanos: 1},
		{SourceID: "conflict", BalanceNanos: -1},
	}
	report, err := l.Import(ctx, at, archive)
	if !errors.Is(err, ErrConflict) || !strings.Contains(err.Error(), "balance_nanos total 9223372036854775808 overflows int64") || !reflect.DeepEqual(report, ImportReport{}) {
		t.Fatalf("partial import: report=%+v err=%v", report, err)
	}
	var receipts int
	if err := l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_legacy_imports`).Scan(&receipts); err != nil || receipts != 3 {
		t.Fatalf("receipts=%d err=%v", receipts, err)
	}
	archive[2].BalanceNanos = -2
	recovered, err := l.Import(ctx, at, archive)
	if err != nil || recovered.BalanceNanos != math.MaxInt64-1 || recovered.SealedNanos != math.MaxInt64-1 || recovered.Count != 3 {
		t.Fatalf("recovery: report=%+v err=%v", recovered, err)
	}
}

func TestLegacyReportUsesAttachedDisposition(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	if _, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (101, 'bounds101', 'bounds101')`); err != nil {
		t.Fatal(err)
	}
	archive := []LegacyAccount{
		{SourceID: "attach", BalanceNanos: math.MaxInt64},
		{SourceID: "sealed", BalanceNanos: math.MaxInt64},
		{SourceID: "owned", OwnerType: "user", OwnerID: 101, BalanceNanos: -math.MaxInt64},
	}
	if _, err := l.Import(ctx, at, archive[:1]); err != nil {
		t.Fatal(err)
	}
	if err := l.AttachOwner(ctx, "attach", "user", 101); err != nil {
		t.Fatal(err)
	}
	if _, err := DryRun(at, archive); err == nil || !strings.Contains(err.Error(), "sealed_nanos total 18446744073709551614 overflows int64") {
		t.Fatalf("expected provisional sealed overflow, got %v", err)
	}
	for _, operation := range []string{"import", "replay", "verify"} {
		var report ImportReport
		var err error
		if operation == "verify" {
			report, err = l.Verify(ctx, at, archive)
		} else {
			report, err = l.Import(ctx, at, archive)
		}
		if err != nil || report.Count != 3 || report.Owned != 2 || report.Sealed != 1 || report.BalanceNanos != math.MaxInt64 || report.OwnedNanos != 0 || report.SealedNanos != math.MaxInt64 {
			t.Fatalf("%s: report=%+v err=%v", operation, report, err)
		}
	}
}
