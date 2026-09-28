package credits

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	return pool
}

func testLedger(t *testing.T) (Ledger, int64) {
	t.Helper()
	l := Ledger{DB: testPool(t)}
	id, err := l.EnsureAccount(context.Background(), "user", 1)
	if err != nil {
		t.Fatal(err)
	}
	return l, id
}

func mustBalance(t *testing.T, l Ledger, id, want int64) {
	t.Helper()
	got, err := l.Balance(context.Background(), id)
	if err != nil || got != want {
		t.Fatalf("balance=%d err=%v want=%d", got, err, want)
	}
	assertInvariants(t, l)
}

func TestOwnerSummaryCompletedCharges(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	check := func(balance, charged, count int64) {
		t.Helper()
		b, n, c, err := l.OwnerSummary(ctx, "user", 1)
		if err != nil || b != balance || n != charged || c != count {
			t.Fatalf("summary=(%d, %d, %d), err=%v; want (%d, %d, %d)", b, n, c, err, balance, charged, count)
		}
	}
	if b, n, c, err := l.OwnerSummary(ctx, "user", 999); err != nil || b != 0 || n != 0 || c != 0 {
		t.Fatalf("absent account=(%d, %d, %d), err=%v", b, n, c, err)
	}
	if err := l.Grant(ctx, id, "intro", 2_000_000_000, nil); err != nil {
		t.Fatal(err)
	}
	check(2_000_000_000, 0, 0)
	if _, err := l.Reserve(ctx, id, "released", 100); err != nil {
		t.Fatal(err)
	}
	check(2_000_000_000-100, 0, 0)
	if _, err := l.Release(ctx, id, "released"); err != nil {
		t.Fatal(err)
	}
	check(2_000_000_000, 0, 0)
	if _, err := l.Reserve(ctx, id, "charged", 1_000_000_001); err != nil {
		t.Fatal(err)
	}
	check(999_999_999, 0, 0)
	if _, err := l.Settle(ctx, id, "charged", 1_000_000_001); err != nil {
		t.Fatal(err)
	}
	check(999_999_999, 1_000_000_001, 1)
	if _, err := l.Settle(ctx, id, "charged", 1_000_000_001); err != nil {
		t.Fatal(err)
	}
	check(999_999_999, 1_000_000_001, 1)
}

// assertInvariants proves the event log explains every stored amount and that
// every charged nano was paid from credit or is recorded as debt.
func assertInvariants(t *testing.T, l Ledger) {
	t.Helper()
	ctx := context.Background()
	var drift int
	if err := l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_grants g
		WHERE g.available_nanos <> COALESCE((SELECT sum(available_delta_nanos) FROM credit_events e WHERE e.grant_id = g.id), 0)`).Scan(&drift); err != nil || drift != 0 {
		t.Fatalf("grants whose events do not sum to available: %d err=%v", drift, err)
	}
	if err := l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_accounts a
		WHERE a.debt_nanos <> COALESCE((SELECT sum(debt_delta_nanos) FROM credit_events e WHERE e.account_id = a.id), 0)`).Scan(&drift); err != nil || drift != 0 {
		t.Fatalf("accounts whose events do not sum to debt: %d err=%v", drift, err)
	}
	if err := l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_reservations r
		WHERE r.status = 'reserved' AND r.reserved_nanos <> (SELECT sum(reserved_nanos) FROM credit_reservation_grants WHERE reservation_id = r.id)`).Scan(&drift); err != nil || drift != 0 {
		t.Fatalf("open reservations not fully held: %d err=%v", drift, err)
	}
	var charged, paid, owed, imported int64
	if err := l.DB.QueryRow(ctx, `SELECT
		COALESCE((SELECT sum(charged_nanos) FROM credit_reservations WHERE status <> 'reserved'), 0)::bigint,
		COALESCE((SELECT sum(spent_nanos) FROM credit_events), 0)::bigint,
		COALESCE((SELECT sum(debt_nanos) FROM credit_accounts), 0)::bigint,
		COALESCE((SELECT sum(opening_debt_nanos) FROM credit_legacy_imports), 0)::bigint`).Scan(&charged, &paid, &owed, &imported); err != nil {
		t.Fatal(err)
	}
	if charged+imported != paid+owed {
		t.Fatalf("charged %d + imported debt %d != paid %d + owed %d", charged, imported, paid, owed)
	}
}

func TestConcurrentReserveNeverOverspends(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	soon := time.Now().Add(time.Hour)
	if err := l.Grant(ctx, id, "promo", 60, &soon); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant(ctx, id, "paid", 40, nil); err != nil {
		t.Fatal(err)
	}
	const callers = 64
	var wg sync.WaitGroup
	var won, refused atomic.Int64
	errs := make(chan error, callers)
	start := make(chan struct{})
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := l.Reserve(ctx, id, fmt.Sprintf("call:%d", i), 7)
			switch {
			case err == nil:
				won.Add(1)
			case errors.Is(err, ErrInsufficient):
				refused.Add(1)
			default:
				errs <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if won.Load() != 14 || refused.Load() != callers-14 {
		t.Fatalf("won=%d refused=%d; 100 nanos admit exactly 14 holds of 7", won.Load(), refused.Load())
	}
	mustBalance(t, l, id, 2)
	var held int64
	if err := l.DB.QueryRow(ctx, `SELECT sum(reserved_nanos) FROM credit_reservations WHERE status = 'reserved'`).Scan(&held); err != nil || held != 98 {
		t.Fatalf("held=%d err=%v", held, err)
	}
	var promoLeft int64
	if err := l.DB.QueryRow(ctx, `SELECT available_nanos FROM credit_grants WHERE source_key = 'promo'`).Scan(&promoLeft); err != nil || promoLeft != 0 {
		t.Fatalf("the expiring grant must be spent first: promo left %d err=%v", promoLeft, err)
	}
}

func TestSettleAndReleaseAreIdempotentUnderConcurrentRetries(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	if err := l.Grant(ctx, id, "grant", 1000, nil); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"settle", "release"} {
		if _, err := l.Reserve(ctx, id, key, 300); err != nil {
			t.Fatal(err)
		}
	}
	retry, err := l.Reserve(ctx, id, "settle", 300)
	if err != nil || retry.Fresh || retry.Status != "reserved" {
		t.Fatalf("reserve retry=%+v err=%v", retry, err)
	}
	if _, err = l.Reserve(ctx, id, "settle", 301); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed reserve retry: %v", err)
	}
	mustBalance(t, l, id, 400)

	const retries = 24
	var wg sync.WaitGroup
	results := make(chan error, 2*retries)
	start := make(chan struct{})
	for range retries {
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			r, err := l.Settle(ctx, id, "settle", 120)
			if err == nil && (r.Status != "settled" || r.ChargedNanos != 120) {
				err = fmt.Errorf("settle result %+v", r)
			}
			results <- err
		}()
		go func() {
			defer wg.Done()
			<-start
			r, err := l.Release(ctx, id, "release")
			if err == nil && (r.Status != "released" || r.ChargedNanos != 0) {
				err = fmt.Errorf("release result %+v", r)
			}
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	// 1000 - 120 charged once; the released hold returned once.
	mustBalance(t, l, id, 880)
	var events int
	if err = l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_events WHERE kind IN ('settle', 'release')`).Scan(&events); err != nil || events != 2 {
		t.Fatalf("finish events=%d err=%v; each reservation finishes exactly once", events, err)
	}
	if _, err = l.Settle(ctx, id, "settle", 121); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed settlement: %v", err)
	}
	if _, err = l.Settle(ctx, id, "release", 5); !errors.Is(err, ErrConflict) {
		t.Fatalf("settle after release: %v", err)
	}
	if _, err = l.Settle(ctx, id, "never-reserved", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown key: %v", err)
	}
	finished, err := l.Reserve(ctx, id, "settle", 300)
	if err != nil || finished.Fresh || finished.Status != "settled" || finished.ChargedNanos != 120 {
		t.Fatalf("reserve after settle=%+v err=%v", finished, err)
	}
	mustBalance(t, l, id, 880)
}

func TestModelCallReachesProviderOnceUnderConcurrentRetries(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	if err := l.Grant(ctx, id, "grant", 1000, nil); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int64
	release := make(chan struct{})
	spend := func(context.Context) (ModelResult, error) {
		calls.Add(1)
		<-release
		return ModelResult{Outcome: ModelSucceeded, ActualNanos: 42}, nil
	}
	const retries = 16
	var wg sync.WaitGroup
	outcomes := make(chan error, retries)
	for range retries {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := l.ExecuteModelCall(ctx, id, "turn-1", 500, spend)
			outcomes <- err
		}()
	}
	for calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	close(outcomes)
	var ok, inFlight, finished int
	for err := range outcomes {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrInFlight):
			inFlight++
		case errors.Is(err, ErrFinished):
			finished++
		default:
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 || ok != 1 || inFlight+finished != retries-1 {
		t.Fatalf("calls=%d ok=%d inFlight=%d finished=%d", calls.Load(), ok, inFlight, finished)
	}
	mustBalance(t, l, id, 958)
	if _, err := l.ExecuteModelCall(ctx, id, "turn-1", 500, spend); !errors.Is(err, ErrFinished) || calls.Load() != 1 {
		t.Fatalf("retry after settle err=%v calls=%d", err, calls.Load())
	}
}

func TestModelCallOutcomes(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	if err := l.Grant(ctx, id, "grant", 1000, nil); err != nil {
		t.Fatal(err)
	}
	refused := errors.New("provider refused")
	r, err := l.ExecuteModelCall(ctx, id, "failed", 300, func(context.Context) (ModelResult, error) {
		return ModelResult{Outcome: ModelFailed}, refused
	})
	if !errors.Is(err, refused) || r.Status != "released" {
		t.Fatalf("failed=%+v err=%v", r, err)
	}
	mustBalance(t, l, id, 1000)
	lost := errors.New("stream cut")
	r, err = l.ExecuteModelCall(ctx, id, "unknown", 300, func(context.Context) (ModelResult, error) {
		return ModelResult{}, lost
	})
	if !errors.Is(err, ErrOutcomeUnknown) || !errors.Is(err, lost) || r.ChargedNanos != 300 {
		t.Fatalf("unknown=%+v err=%v; an unreadable outcome is charged its bound", r, err)
	}
	mustBalance(t, l, id, 700)
	cancelled, cancel := context.WithCancel(ctx)
	r, err = l.ExecuteModelCall(cancelled, id, "cancelled", 100, func(context.Context) (ModelResult, error) {
		cancel()
		return ModelResult{Outcome: ModelSucceeded, ActualNanos: 30}, nil
	})
	if err != nil || r.ChargedNanos != 30 {
		t.Fatalf("settlement must survive request cancellation: %+v err=%v", r, err)
	}
	mustBalance(t, l, id, 670)
	if _, err = l.ExecuteModelCall(ctx, id, "too-big", 671, nil); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("over-balance bound: %v", err)
	}
}

func TestPricedModelCallChargesExactSubCentUsage(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	if err := l.Grant(ctx, id, "grant", 2_000_000, nil); err != nil {
		t.Fatal(err)
	}
	calls := 0
	r, err := l.ExecutePricedModelCall(ctx, id, "priced", "gpt-oss-120b", modelprice.Usage{InputTokens: 1000, OutputTokens: 1000},
		func(context.Context) (ModelOutcome, modelprice.Usage, error) {
			calls++
			return ModelSucceeded, modelprice.Usage{InputTokens: 100, OutputTokens: 100}, nil
		})
	// 100 x $0.35/MTok + 100 x $0.75/MTok = $0.00011 = 110,000 nanos.
	if err != nil || calls != 1 || r.ReservedNanos != 1_100_000 || r.ChargedNanos != 110_000 {
		t.Fatalf("priced=%+v calls=%d err=%v", r, calls, err)
	}
	mustBalance(t, l, id, 1_890_000)
	if _, err = l.ExecutePricedModelCall(ctx, id, "unpriced", "no-such-model", modelprice.Usage{OutputTokens: 1}, nil); err == nil {
		t.Fatal("an unpriced model must be refused before reserving")
	}
}

func TestExpiryOrderAndExpiredCredit(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	past, soon, later := time.Now().Add(-time.Hour), time.Now().Add(time.Hour), time.Now().Add(48*time.Hour)
	for _, g := range []struct {
		key     string
		nanos   int64
		expires *time.Time
	}{{"expired", 20, &past}, {"never", 50, nil}, {"later", 25, &later}, {"soon", 30, &soon}} {
		if err := l.Grant(ctx, id, g.key, g.nanos, g.expires); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.Grant(ctx, id, "soon", 30, &soon); err != nil {
		t.Fatalf("identical grant replay: %v", err)
	}
	if err := l.Grant(ctx, id, "soon", 31, &soon); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed grant replay: %v", err)
	}
	mustBalance(t, l, id, 105)
	if _, err := l.Reserve(ctx, id, "call", 40); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Settle(ctx, id, "call", 40); err != nil {
		t.Fatal(err)
	}
	left := map[string]int64{}
	rows, err := l.DB.Query(ctx, `SELECT source_key, available_nanos FROM credit_grants WHERE account_id = $1`, id)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var k string
		var n int64
		if err = rows.Scan(&k, &n); err != nil {
			t.Fatal(err)
		}
		left[k] = n
	}
	rows.Close()
	if left["expired"] != 0 || left["soon"] != 0 || left["later"] != 15 || left["never"] != 50 {
		t.Fatalf("spend order: %v", left)
	}
	var expired int64
	if err = l.DB.QueryRow(ctx, `SELECT -sum(available_delta_nanos) FROM credit_events WHERE kind = 'expire'`).Scan(&expired); err != nil || expired != 20 {
		t.Fatalf("expired=%d err=%v", expired, err)
	}
	mustBalance(t, l, id, 65)
}

func TestOverageBecomesDebtAndBlocksSpendUntilRepaid(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	if err := l.Grant(ctx, id, "initial", 100, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Reserve(ctx, id, "expensive", 80); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Settle(ctx, id, "expensive", 125); err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, -25)
	if _, err := l.Reserve(ctx, id, "blocked", 1); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("debt must block spend: %v", err)
	}
	if err := l.Grant(ctx, id, "top-up", 30, nil); err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, 5)
	if _, err := l.Settle(ctx, id, "expensive", 125); err != nil {
		t.Fatalf("settlement replay: %v", err)
	}
	mustBalance(t, l, id, 5)
	if _, err := l.Reserve(ctx, id, "next", 5); err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, 0)
}

func TestAbandonedReservationIsChargedItsBound(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	if err := l.Grant(ctx, id, "grant", 100, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Reserve(ctx, id, "crashed", 40); err != nil {
		t.Fatal(err)
	}
	l.AbandonAfter = time.Nanosecond
	time.Sleep(5 * time.Millisecond)
	if _, err := l.Reserve(ctx, id, "next", 10); err != nil {
		t.Fatal(err)
	}
	var status string
	var charged int64
	if err := l.DB.QueryRow(ctx, `SELECT status, charged_nanos FROM credit_reservations WHERE request_key = 'crashed'`).Scan(&status, &charged); err != nil || status != "settled" || charged != 40 {
		t.Fatalf("crashed status=%s charged=%d err=%v", status, charged, err)
	}
	if r, err := l.Settle(ctx, id, "crashed", 12); err != nil || r.ChargedNanos != 40 {
		t.Fatalf("a late settlement below the bound keeps the bound charge: %+v err=%v", r, err)
	}
	mustBalance(t, l, id, 50)
	for range 2 {
		if r, err := l.Settle(ctx, id, "crashed", 70); err != nil || r.ChargedNanos != 70 {
			t.Fatalf("a late settlement above the bound=%+v err=%v", r, err)
		}
	}
	mustBalance(t, l, id, 20)
}

func TestRefundWhileOwingRepaysDebt(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	if err := l.Grant(ctx, id, "grant", 100, nil); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"a", "b"} {
		if _, err := l.Reserve(ctx, id, key, 50); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := l.Settle(ctx, id, "a", 80); err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, -30)
	if _, err := l.Release(ctx, id, "b"); err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, 20)
	if _, err := l.Reserve(ctx, id, "c", 20); err != nil {
		t.Fatalf("repaid account must spend again: %v", err)
	}
}

func TestGrantExpiryReplaysAtStoredPrecision(t *testing.T) {
	l, id := testLedger(t)
	expires := time.Now().Add(time.Hour).Truncate(time.Microsecond).Add(789 * time.Nanosecond)
	for range 2 {
		if err := l.Grant(context.Background(), id, "precise", 10, &expires); err != nil {
			t.Fatal(err)
		}
	}
	mustBalance(t, l, id, 10)
}

func TestSignupGrantOnlyWhenEnsureAccountCreates(t *testing.T) {
	ctx := context.Background()
	plain := Ledger{DB: testPool(t)}
	existing, err := plain.EnsureAccount(ctx, "user", 1)
	if err != nil {
		t.Fatal(err)
	}
	const signup = 1000 * NanosPerCent
	l := Ledger{DB: plain.DB, SignupGrantNanos: signup}

	// An account that already existed, or was imported, never receives it.
	if id, err := l.EnsureAccount(ctx, "user", 1); err != nil || id != existing {
		t.Fatalf("id=%d err=%v", id, err)
	}
	mustBalance(t, l, existing, 0)

	// Concurrent first uses create one account with exactly one grant.
	ids := make([]int64, 16)
	var wg sync.WaitGroup
	var failures atomic.Int32
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := l.EnsureAccount(ctx, "user", 2)
			if err != nil {
				failures.Add(1)
			}
			ids[i] = id
		}()
	}
	wg.Wait()
	if failures.Load() != 0 {
		t.Fatalf("%d concurrent EnsureAccount calls failed", failures.Load())
	}
	for _, id := range ids[1:] {
		if id != ids[0] {
			t.Fatalf("concurrent EnsureAccount returned different accounts: %v", ids)
		}
	}
	mustBalance(t, l, ids[0], signup)
	var grants int
	if err := l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_grants WHERE account_id = $1 AND source_key = $2`, ids[0], SignupGrantKey).Scan(&grants); err != nil || grants != 1 {
		t.Fatalf("signup grants=%d err=%v", grants, err)
	}

	// Ensuring an existing account again never grants it twice.
	if err := l.Grant(ctx, ids[0], "other", 1, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := l.EnsureAccount(ctx, "user", 2); err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, ids[0], signup+1)

	if _, err := (Ledger{DB: l.DB, SignupGrantNanos: -1}).EnsureAccount(ctx, "user", 3); err == nil {
		t.Fatal("a negative signup grant was accepted")
	}
}

// The signup grant is once per login identity and never for an organization
// (smithersai/plue#528, plue 4053bc1c4).
func TestSignupGrantOncePerLoginIdentityAndNeverForOrganizations(t *testing.T) {
	ctx := context.Background()
	const signup = 1000 * NanosPerCent
	l := Ledger{DB: testPool(t), SignupGrantNanos: signup}
	org, err := l.EnsureAccount(ctx, "org", 9)
	if err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, org, 0)

	user := func(name string) int64 {
		var id int64
		if err := l.DB.QueryRow(ctx, `INSERT INTO users (username, lower_username, display_name) VALUES ($1, $1, $1) RETURNING id`, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	login := func(userID int64, provider, providerUserID string) {
		if _, err := l.DB.Exec(ctx, `INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, $2, $3)`, userID, provider, providerUserID); err != nil {
			t.Fatal(err)
		}
	}
	first := user("first")
	login(first, "GitHub", "gh-1")
	id, err := l.EnsureAccount(ctx, "user", first)
	if err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, signup)

	// The same GitHub login, re-registered as a new user, gets nothing.
	if _, err = l.DB.Exec(ctx, `DELETE FROM oauth_accounts WHERE user_id = $1`, first); err != nil {
		t.Fatal(err)
	}
	again := user("again")
	login(again, "github", "gh-1")
	login(again, "google", "g-2")
	id, err = l.EnsureAccount(ctx, "user", again)
	if err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, 0)

	fresh := user("fresh")
	login(fresh, "github", "gh-3")
	id, err = l.EnsureAccount(ctx, "user", fresh)
	if err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, signup)
}

// Forfeit ends matching live grants now, including credit a held
// reservation returns later, and leaves other grants spendable.
func TestForfeitEndsMatchingGrants(t *testing.T) {
	ctx := context.Background()
	l, id := testLedger(t)
	later := time.Now().Add(time.Hour)
	if err := l.Grant(ctx, id, "invoice:in_1", 100, &later); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant(ctx, id, "gift", 50, nil); err != nil {
		t.Fatal(err)
	}
	if n, err := l.Forfeit(ctx, "user", 404, "invoice:"); err != nil || n != 0 {
		t.Fatalf("an owner without an account forfeited %d err=%v", n, err)
	}
	// The plan grant expires first, so the reservation holds it.
	if _, err := l.Reserve(ctx, id, "call", 60); err != nil {
		t.Fatal(err)
	}
	taken, err := l.Forfeit(ctx, "user", 1, "invoice:")
	if err != nil || taken != 40 {
		t.Fatalf("taken=%d err=%v", taken, err)
	}
	mustBalance(t, l, id, 50)
	if _, err = l.Settle(ctx, id, "call", 10); err != nil {
		t.Fatal(err)
	}
	mustBalance(t, l, id, 50)
	if taken, err = l.Forfeit(ctx, "user", 1, "invoice:"); err != nil || taken != 0 {
		t.Fatalf("second forfeit taken=%d err=%v", taken, err)
	}
	// Replaying the forfeited grant does not restore it.
	if err = l.Grant(ctx, id, "invoice:in_1", 100, &later); !errors.Is(err, ErrConflict) {
		t.Fatalf("replay err=%v", err)
	}
	mustBalance(t, l, id, 50)
}

// A ledger joined to a caller's transaction commits and rolls back with it.
func TestInTransactionFollowsTheCallersTransaction(t *testing.T) {
	ctx := context.Background()
	l, id := testLedger(t)
	for _, commit := range []bool{false, true} {
		tx, err := l.DB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		joined := l.InTransaction(tx)
		if err := joined.Grant(ctx, id, "gift", 70, nil); err != nil {
			t.Fatal(err)
		}
		// A refused write rolls back only its savepoint.
		if err := joined.Grant(ctx, id, "gift", 71, nil); !errors.Is(err, ErrConflict) {
			t.Fatalf("conflicting grant err=%v", err)
		}
		if n, err := joined.Balance(ctx, id); err != nil || n != 70 {
			t.Fatalf("joined read balance=%d err=%v", n, err)
		}
		mustBalance(t, l, id, 0) // not visible outside before commit
		if commit {
			err = tx.Commit(ctx)
		} else {
			err = tx.Rollback(ctx)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	mustBalance(t, l, id, 70)
	assertInvariants(t, l)
}
