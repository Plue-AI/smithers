package credits

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const usd = int64(1_000_000_000)

// cutoverArchive mirrors the live legacy inventory (plue#530): 23 billing
// Durable Objects, 19 with an account row but no ledger row, one ledger with
// no account row (7 promo grants, 7,000,000,000 nanos), one funded account
// whose owner is not in the identity join, one oversized account and one
// ordinary funded account.
func cutoverArchive(exportedAt time.Time) []LegacyAccount {
	var out []LegacyAccount
	for i := range 19 {
		out = append(out, LegacyAccount{SourceID: fmt.Sprintf("do%02d", i), OwnerType: "user", OwnerID: int64(100 + i),
			Source: json.RawMessage(fmt.Sprintf(`{"account":{"userId":"%d"}}`, 100+i))})
	}
	expires := exportedAt.Add(30 * 24 * time.Hour).UTC()
	var promos []LegacyGrant
	for i := range 7 {
		promos = append(promos, LegacyGrant{SourceKey: fmt.Sprintf("promo:%d", i), RemainingNanos: usd, ExpiresAt: &expires})
	}
	out = append(out, LegacyAccount{SourceID: "ledger-only", BalanceNanos: 7 * usd, Grants: promos, Source: json.RawMessage(`{"ledger":{"grants":7}}`)})
	out = append(out, LegacyAccount{SourceID: "unjoined", BalanceNanos: 500 * usd,
		Grants: []LegacyGrant{{SourceKey: "promo:launch", RemainingNanos: 500 * usd}}})
	spent := exportedAt.Add(-time.Hour).UTC()
	var many []LegacyGrant
	for i := range 2000 {
		many = append(many, LegacyGrant{SourceKey: fmt.Sprintf("stripe:pi_%04d", i), RemainingNanos: 1_234_567})
	}
	many = append(many, LegacyGrant{SourceKey: "expired", RemainingNanos: 9 * usd, ExpiresAt: &spent})
	out = append(out, LegacyAccount{SourceID: "oversized", OwnerType: "user", OwnerID: 200, BalanceNanos: 2000 * 1_234_567, Grants: many})
	out = append(out, LegacyAccount{SourceID: "funded", OwnerType: "org", OwnerID: 300, BalanceNanos: 12_345_678_901,
		Grants: []LegacyGrant{{SourceKey: "stripe:pi_x", RemainingNanos: 12_345_678_901}}})
	return out
}

func seedOwners(t *testing.T, l Ledger) {
	t.Helper()
	ctx := context.Background()
	for _, id := range append([]int64{200}, rangeIDs(100, 19)...) {
		if _, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES ($1, $2, $2)`, id, fmt.Sprintf("u%d", id)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := l.DB.Exec(ctx, `INSERT INTO organizations (id, name, lower_name) VALUES (300, 'acme', 'acme')`); err != nil {
		t.Fatal(err)
	}
}

func rangeIDs(from int64, n int) []int64 {
	out := make([]int64, n)
	for i := range out {
		out[i] = from + int64(i)
	}
	return out
}

func TestLegacyImportDisposesEveryAccountIdempotently(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	seedOwners(t, l)
	exportedAt := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	archive := cutoverArchive(exportedAt)

	dry, err := DryRun(exportedAt, archive)
	if err != nil {
		t.Fatal(err)
	}
	if dry.Count != 23 || dry.Claimed != 21 || dry.Sealed != 2 || dry.SyntheticOpenings != 0 {
		t.Fatalf("dry run=%+v", dry)
	}
	total := 7*usd + 500*usd + 2000*1_234_567 + 12_345_678_901
	if dry.BalanceNanos != total {
		t.Fatalf("dry total=%d want %d", dry.BalanceNanos, total)
	}

	// Concurrent first runs: every source is imported exactly once.
	var wg sync.WaitGroup
	reports := make([]ImportReport, 4)
	errs := make([]error, 4)
	for i := range reports {
		wg.Add(1)
		go func() {
			defer wg.Done()
			reports[i], errs[i] = l.Import(ctx, exportedAt, archive)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
		r := reports[i]
		if r.Count != 23 || r.Owned != 21 || r.Sealed != 2 || r.Checksum != dry.Checksum || r.OwnedNanos != 2000*1_234_567+12_345_678_901 || r.SealedNanos != 507*usd {
			t.Fatalf("import %d=%+v", i, r)
		}
	}
	var receipts, grants int
	if err = l.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM credit_legacy_imports), (SELECT count(*) FROM credit_grants)`).Scan(&receipts, &grants); err != nil {
		t.Fatal(err)
	}
	if receipts != 23 || grants != 7+1+2001+1 {
		t.Fatalf("receipts=%d grants=%d", receipts, grants)
	}
	verified, err := l.Verify(ctx, exportedAt, archive)
	if err != nil || verified.Owned != 21 || verified.Sealed != 2 || verified.Checksum != dry.Checksum {
		t.Fatalf("verify=%+v err=%v", verified, err)
	}
	oversized, err := l.OwnerBalance(ctx, "user", 200)
	if err != nil || oversized != 2000*1_234_567 {
		t.Fatalf("oversized balance=%d err=%v; the expired grant must not be spendable", oversized, err)
	}
	if empty, err := l.OwnerBalance(ctx, "user", 105); err != nil || empty != 0 {
		t.Fatalf("missing ledger must import as empty: %d err=%v", empty, err)
	}
	assertInvariants(t, l)

	// A changed record for an imported source is refused, and nothing moves.
	tampered := cutoverArchive(exportedAt)
	tampered[22].BalanceNanos++
	tampered[22].Grants[0].RemainingNanos++
	if _, err = l.Import(ctx, exportedAt, tampered); !errors.Is(err, ErrConflict) {
		t.Fatalf("tampered import: %v", err)
	}
	if _, err = l.Verify(ctx, exportedAt, tampered); !errors.Is(err, ErrConflict) {
		t.Fatalf("tampered verify: %v", err)
	}
	// An archive missing an imported account does not verify.
	if _, err = l.Verify(ctx, exportedAt, archive[1:]); !errors.Is(err, ErrConflict) {
		t.Fatalf("verify of a partial archive: %v", err)
	}
	// Tampering with committed rows fails readback.
	if _, err = l.DB.Exec(ctx, `UPDATE credit_grants SET available_nanos = 0 WHERE source_key = 'legacy:unjoined:promo:launch'`); err != nil {
		t.Fatal(err)
	}
	if _, err = l.Verify(ctx, exportedAt, archive); !errors.Is(err, ErrConflict) {
		t.Fatalf("verify after zeroing credit: %v", err)
	}
	if _, err = l.DB.Exec(ctx, `UPDATE credit_grants SET original_nanos = original_nanos + 1 WHERE source_key = 'legacy:funded:stripe:pi_x'`); err != nil {
		t.Fatal(err)
	}
	if _, err = l.Verify(ctx, exportedAt, archive); !errors.Is(err, ErrConflict) {
		t.Fatalf("verify after row tamper: %v", err)
	}
}

func TestLegacyImportValidatesArchive(t *testing.T) {
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	later := at.Add(time.Hour)
	earlier := at.Add(-time.Hour)
	for name, tc := range map[string]struct {
		archive []LegacyAccount
		want    string
	}{
		"duplicate source":     {[]LegacyAccount{{SourceID: "a"}, {SourceID: "a"}}, "duplicate legacy source a"},
		"blank source":         {[]LegacyAccount{{SourceID: " "}}, "invalid legacy source id"},
		"bad owner":            {[]LegacyAccount{{SourceID: "a", OwnerType: "team", OwnerID: 1}}, "invalid owner"},
		"balance mismatch":     {[]LegacyAccount{{SourceID: "a", BalanceNanos: 5, Grants: []LegacyGrant{{SourceKey: "g", RemainingNanos: 4}}}}, "live grants 4 nanos differ from balance 5 nanos"},
		"expired counted":      {[]LegacyAccount{{SourceID: "a", BalanceNanos: 5, Grants: []LegacyGrant{{SourceKey: "g", RemainingNanos: 5, ExpiresAt: &earlier}}}}, "live grants 0 nanos differ from balance 5 nanos"},
		"duplicate grant":      {[]LegacyAccount{{SourceID: "a", BalanceNanos: 2, Grants: []LegacyGrant{{SourceKey: "g", RemainingNanos: 1}, {SourceKey: "g", RemainingNanos: 1}}}}, `invalid grant "g"`},
		"negative grant":       {[]LegacyAccount{{SourceID: "a", Grants: []LegacyGrant{{SourceKey: "g", RemainingNanos: -1}}}}, `invalid grant "g"`},
		"invalid source":       {[]LegacyAccount{{SourceID: "a", Source: json.RawMessage(`{`)}}, "source JSON"},
		"owing with grant":     {[]LegacyAccount{{SourceID: "a", BalanceNanos: -1, Grants: []LegacyGrant{{SourceKey: "g", RemainingNanos: 1, ExpiresAt: &later}}}}, "an owing account cannot hold live grants"},
		"source colon":         {[]LegacyAccount{{SourceID: "a:b"}}, "invalid legacy source id"},
		"owner id absent":      {[]LegacyAccount{{SourceID: "a", OwnerType: "user"}}, "invalid owner"},
		"owner type absent":    {[]LegacyAccount{{SourceID: "a", OwnerID: 1}}, "invalid owner"},
		"blank grant key":      {[]LegacyAccount{{SourceID: "a", Grants: []LegacyGrant{{SourceKey: ""}}}}, `invalid grant ""`},
		"reserved grant key":   {[]LegacyAccount{{SourceID: "a", Grants: []LegacyGrant{{SourceKey: openingGrantKey}}}}, `invalid grant "opening"`},
		"grant total overflow": {[]LegacyAccount{{SourceID: "a", BalanceNanos: math.MaxInt64, Grants: []LegacyGrant{{SourceKey: "one", RemainingNanos: math.MaxInt64}, {SourceKey: "two", RemainingNanos: 1}}}}, "grant total overflows"},
	} {
		report, err := DryRun(at, tc.archive)
		if err == nil || !strings.Contains(err.Error(), tc.want) || !reflect.DeepEqual(report, ImportReport{}) {
			t.Errorf("%s: report=%+v err=%v, want zero report and %q", name, report, err, tc.want)
		}
	}
	if _, err := DryRun(time.Time{}, nil); err == nil {
		t.Error("missing export time accepted")
	}
	report, err := DryRun(at, []LegacyAccount{{SourceID: "a", BalanceNanos: 9}, {SourceID: "b", BalanceNanos: -3}})
	if err != nil || report.SyntheticOpenings != 1 || report.BalanceNanos != 6 {
		t.Fatalf("report=%+v err=%v", report, err)
	}
}

func TestDryRunUsesExportTimeAndCanonicalSourceBytes(t *testing.T) {
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	expiresAtCutover := at
	expiresAfterCutover := at.Add(time.Microsecond)
	archive := []LegacyAccount{{
		SourceID: "with-expired-grant", BalanceNanos: 7,
		Grants: []LegacyGrant{
			{SourceKey: "expired", RemainingNanos: 3, ExpiresAt: &expiresAtCutover},
			{SourceKey: "live", RemainingNanos: 7, ExpiresAt: &expiresAfterCutover},
		},
		Source: json.RawMessage(`{ "audit": { "id": 1 } }`),
	}}
	first, err := DryRun(at, archive)
	if err != nil || first.Count != 1 || first.Sealed != 1 || first.BalanceNanos != 7 || first.SyntheticOpenings != 0 {
		t.Fatalf("cutover report=%+v err=%v", first, err)
	}
	archive[0].Source = json.RawMessage(`{"audit":{"id":1}}`)
	second, err := DryRun(at, archive)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatalf("equivalent source changed receipt: first=%+v second=%+v err=%v", first, second, err)
	}
	archive[0].Source = json.RawMessage(`{"audit":{"id":2}}`)
	third, err := DryRun(at, archive)
	if err != nil || first.Checksum == third.Checksum || first.Items[0].Checksum == third.Items[0].Checksum {
		t.Fatalf("changed source kept receipt: first=%+v third=%+v err=%v", first, third, err)
	}
	archive[0].Source = json.RawMessage(`{"audit":{"id":1}}`)
	if _, err := DryRun(at.Add(time.Microsecond), archive); err == nil {
		t.Fatal("grant expiring at the export time counted as live")
	}
}

func TestSealedLegacyAccountAttachesToVerifiedOwner(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	at := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	future := at.Add(24 * time.Hour)
	archive := []LegacyAccount{
		{SourceID: "missing", OwnerType: "user", OwnerID: 999, BalanceNanos: 7 * usd, Grants: []LegacyGrant{{SourceKey: "promo", RemainingNanos: 7 * usd, ExpiresAt: &future}}},
		{SourceID: "owing", BalanceNanos: -2 * usd},
	}
	report, err := l.Import(ctx, at, archive)
	if err != nil || report.Sealed != 2 || report.Items[0].Disposition != OwnerMissing || report.Items[1].Disposition != OwnerUnknown {
		t.Fatalf("import=%+v err=%v", report, err)
	}
	if err = l.AttachOwner(ctx, "missing", "user", 999); !errors.Is(err, ErrSealed) {
		t.Fatalf("attach to a missing owner: %v", err)
	}
	if _, err = l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (999, 'u999', 'u999')`); err != nil {
		t.Fatal(err)
	}
	owner, err := l.EnsureAccount(ctx, "user", 999)
	if err != nil {
		t.Fatal(err)
	}
	if err = l.Grant(ctx, owner, "native", usd, nil); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = l.AttachOwner(ctx, "missing", "user", 999); err != nil {
			t.Fatalf("attach (replayed): %v", err)
		}
	}
	if err = l.AttachOwner(ctx, "owing", "org", 5); !errors.Is(err, ErrSealed) {
		t.Fatalf("attach to a missing org: %v", err)
	}
	if err = l.AttachOwner(ctx, "missing", "user", 1000); !errors.Is(err, ErrConflict) {
		t.Fatalf("attach to a second owner: %v", err)
	}
	if err = l.AttachOwner(ctx, "owing", "user", 999); err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, owner, 6*usd)
	verified, err := l.Verify(ctx, at, archive)
	if err != nil || verified.Owned != 2 || verified.Sealed != 0 {
		t.Fatalf("verify=%+v err=%v", verified, err)
	}
	replayed, err := l.Import(ctx, at, archive)
	if err != nil || replayed.Owned != 2 {
		t.Fatalf("replay after attach=%+v err=%v", replayed, err)
	}
	mustBalance(t, l, owner, 6*usd)
}

func TestSealedAccountsCannotSpendOrReceiveGrants(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	if _, err := l.Import(ctx, time.Now().Add(-time.Minute), []LegacyAccount{{SourceID: "sealed", BalanceNanos: 50}}); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := l.DB.QueryRow(ctx, `SELECT account_id FROM credit_legacy_imports WHERE source_id = 'sealed'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Reserve(ctx, id, "call", 1); !errors.Is(err, ErrSealed) {
		t.Fatalf("sealed reserve: %v", err)
	}
	if err := l.Grant(ctx, id, "g", 1, nil); !errors.Is(err, ErrSealed) {
		t.Fatalf("sealed grant: %v", err)
	}
	if _, err := l.EnsureAccount(ctx, "team", 1); err == nil {
		t.Fatal("invalid owner type accepted")
	}
}

func TestLegacyImportRefusesAFutureExportTime(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	future := time.Now().Add(48 * time.Hour)
	expires := time.Now().Add(24 * time.Hour)
	_, err := l.Import(context.Background(), future, []LegacyAccount{{SourceID: "a", Grants: []LegacyGrant{{SourceKey: "g", RemainingNanos: 1000, ExpiresAt: &expires}}}})
	if err == nil {
		t.Fatal("a future export time could revive expired grants")
	}
}
