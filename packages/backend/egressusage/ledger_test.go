package egressusage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

var testDay = time.Date(2026, time.September, 29, 0, 0, 0, 0, time.UTC)

var testSuite postgresfixture.Suite

func TestMain(m *testing.M) { os.Exit(testSuite.Run(m)) }

func chargeRequest(sandbox string, owner, quota, bytes int64) ChargeRequest {
	return ChargeRequest{ID: uuid.NewString(), SandboxID: sandbox, BillingUserID: owner,
		DailyQuotaBytes: quota, Bytes: bytes, Day: testDay}
}

func commitCharge(ctx context.Context, pool *pgxpool.Pool, request ChargeRequest) (int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(context.Background())
	allowed, err := Charge(ctx, tx, request)
	if err != nil {
		return 0, err
	}
	return allowed, tx.Commit(ctx)
}

func dailyUsed(t *testing.T, pool *pgxpool.Pool, scope string, day time.Time) int64 {
	t.Helper()
	var used int64
	if err := pool.QueryRow(context.Background(), `SELECT bytes FROM sandbox_egress_daily_usage WHERE scope=$1 AND day=$2`, scope, day).Scan(&used); err != nil {
		t.Fatal(err)
	}
	return used
}

func TestChargePersistsPartialAllowanceAndIdempotentRetry(t *testing.T) {
	pool, url := testSuite.Pool(t), testSuite.URL(t)
	ctx := context.Background()
	first := chargeRequest("sandbox-a", 42, 100, 70)
	second := chargeRequest("sandbox-b", 42, 100, 50)
	for _, step := range []struct {
		request ChargeRequest
		want    int64
	}{{first, 70}, {second, 30}, {second, 30}} {
		got, err := commitCharge(ctx, pool, step.request)
		if err != nil || got != step.want {
			t.Fatalf("charge %s: allowed=%d err=%v, want=%d", step.request.SandboxID, got, err, step.want)
		}
	}
	if got := dailyUsed(t, pool, "user:42", testDay); got != 100 {
		t.Fatalf("daily spend=%d, want 100", got)
	}
	var count, granted, requested int64
	if err := pool.QueryRow(ctx, `SELECT count(*),sum(bytes),sum(requested_bytes) FROM sandbox_egress_usage WHERE billing_user_id=42`).Scan(&count, &granted, &requested); err != nil {
		t.Fatal(err)
	}
	if count != 2 || granted != 100 || requested != 120 {
		t.Fatalf("receipts count=%d granted=%d requested=%d", count, granted, requested)
	}
	// Reconnect through a fresh pool to prove a replacement worker sees the ledger.
	restarted, err := postgresfixture.Open(ctx, url, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if got, err := commitCharge(ctx, restarted, second); err != nil || got != 30 {
		t.Fatalf("retry after reconnect: allowed=%d err=%v", got, err)
	}
	conflict := second
	conflict.Bytes = 49
	tx, err := restarted.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := Charge(ctx, tx, conflict); got != 0 || !errors.Is(err, ErrConflict) {
		t.Fatalf("changed receipt: allowed=%d err=%v", got, err)
	}
	_ = tx.Rollback(ctx)
	policyChanged := second
	policyChanged.DailyQuotaBytes = 0
	if got, err := commitCharge(ctx, restarted, policyChanged); got != 30 || err != nil {
		t.Fatalf("retry after policy change: allowed=%d err=%v", got, err)
	}
	var originalQuota int64
	if err := restarted.QueryRow(ctx, `SELECT quota_bytes FROM sandbox_egress_usage WHERE id=$1`, second.ID).Scan(&originalQuota); err != nil || originalQuota != 100 {
		t.Fatalf("receipt quota=%d err=%v", originalQuota, err)
	}
	if got := dailyUsed(t, pool, "user:42", testDay); got != 100 {
		t.Fatalf("retry changed spend to %d", got)
	}
}

func TestChargeQuotaBoundariesDayResetAndSandboxScope(t *testing.T) {
	pool := testSuite.Pool(t)
	ctx := context.Background()
	zero := chargeRequest("zero", 7, 0, 1)
	if got, err := commitCharge(ctx, pool, zero); err != nil || got != 0 {
		t.Fatalf("zero quota: %d, %v", got, err)
	}
	if got := dailyUsed(t, pool, "user:7", testDay); got != 0 {
		t.Fatalf("zero quota charged %d", got)
	}
	for i := 0; i < 20; i++ {
		denied := chargeRequest("zero", 7, 0, 1)
		if got, err := commitCharge(ctx, pool, denied); err != nil || got != 0 {
			t.Fatalf("denied retry %d: allowed=%d err=%v", i, got, err)
		}
	}
	var deniedReceipts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sandbox_egress_usage WHERE billing_user_id=7`).Scan(&deniedReceipts); err != nil || deniedReceipts != 0 {
		t.Fatalf("denied receipt count=%d err=%v", deniedReceipts, err)
	}
	unlimited := chargeRequest("unlimited", 8, -1, MaxChargeBytes)
	if got, err := commitCharge(ctx, pool, unlimited); err != nil || got != MaxChargeBytes {
		t.Fatalf("unlimited quota: %d, %v", got, err)
	}
	if got := dailyUsed(t, pool, "user:8", testDay); got != MaxChargeBytes {
		t.Fatalf("unlimited spend=%d", got)
	}
	tomorrow := chargeRequest("unlimited", 8, 1, 2)
	tomorrow.Day = testDay.AddDate(0, 0, 1)
	if got, err := commitCharge(ctx, pool, tomorrow); err != nil || got != 1 {
		t.Fatalf("new day: %d, %v", got, err)
	}
	if got := dailyUsed(t, pool, "user:8", tomorrow.Day); got != 1 {
		t.Fatalf("next-day spend=%d", got)
	}
	for _, sandbox := range []string{"guest-a", "guest-b"} {
		request := chargeRequest(sandbox, 0, 4, 4)
		if got, err := commitCharge(ctx, pool, request); err != nil || got != 4 {
			t.Fatalf("sandbox %s: %d, %v", sandbox, got, err)
		}
		if got := dailyUsed(t, pool, "sandbox:"+sandbox, testDay); got != 4 {
			t.Fatalf("sandbox %s spend=%d", sandbox, got)
		}
	}
}

func TestChargeNormalizesEquivalentUTCDateBeforeBinding(t *testing.T) {
	pool := testSuite.Pool(t)
	ctx := context.Background()
	west := chargeRequest("offset", 81, 10, 6)
	west.Day = testDay.In(time.FixedZone("west", -7*3600))
	if got, err := commitCharge(ctx, pool, west); err != nil || got != 6 {
		t.Fatalf("west-offset charge: allowed=%d err=%v", got, err)
	}
	utc := chargeRequest("utc", 81, 10, 6)
	if got, err := commitCharge(ctx, pool, utc); err != nil || got != 4 {
		t.Fatalf("UTC charge after west-offset charge: allowed=%d err=%v", got, err)
	}
	if got, err := commitCharge(ctx, pool, west); err != nil || got != 6 {
		t.Fatalf("west-offset receipt retry: allowed=%d err=%v", got, err)
	}
	if got := dailyUsed(t, pool, "user:81", testDay); got != 10 {
		t.Fatalf("UTC-day usage=%d, want 10", got)
	}
	var priorRows, receipts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sandbox_egress_daily_usage WHERE scope='user:81' AND day=$1`, testDay.AddDate(0, 0, -1)).Scan(&priorRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sandbox_egress_usage WHERE billing_user_id=81 AND day=$1`, testDay).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if priorRows != 0 || receipts != 2 {
		t.Fatalf("prior-day rows=%d UTC receipts=%d, want 0 and 2", priorRows, receipts)
	}
}

func TestChargeRollbackGrantsNothing(t *testing.T) {
	pool := testSuite.Pool(t)
	ctx := context.Background()
	request := chargeRequest("rolled-back", 9, 5, 5)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := Charge(ctx, tx, request); err != nil || got != 5 {
		t.Fatalf("uncommitted charge: %d, %v", got, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := commitCharge(ctx, pool, request); err != nil || got != 5 {
		t.Fatalf("charge after rollback: %d, %v", got, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sandbox_egress_usage WHERE id=$1`, request.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("receipt count=%d err=%v", count, err)
	}
}

func TestChargeConcurrentSandboxesShareOwnerQuota(t *testing.T) {
	pool := testSuite.Pool(t)
	ctx := context.Background()
	const workers = 12
	start := make(chan struct{})
	results := make(chan int64, workers)
	errs := make(chan error, workers)
	var group sync.WaitGroup
	for i := 0; i < workers; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			<-start
			allowed, err := commitCharge(ctx, pool, chargeRequest(fmt.Sprintf("sandbox-%d", i), 33, 101, 20))
			results <- allowed
			errs <- err
		}(i)
	}
	close(start)
	group.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var total, full, partial int64
	for allowed := range results {
		total += allowed
		if allowed == 20 {
			full++
		} else if allowed == 1 {
			partial++
		} else if allowed != 0 {
			t.Errorf("unexpected allowance %d", allowed)
		}
	}
	if total != 101 || full != 5 || partial != 1 || dailyUsed(t, pool, "user:33", testDay) != 101 {
		t.Fatalf("concurrent grant total=%d full=%d partial=%d", total, full, partial)
	}
}

func TestChargeRejectsInvalidInputsBeforeDatabase(t *testing.T) {
	base := chargeRequest("sandbox", 1, 100, 1)
	cases := map[string]func(*ChargeRequest){
		"invalid ID":       func(r *ChargeRequest) { r.ID = "not-a-uuid" },
		"empty sandbox":    func(r *ChargeRequest) { r.SandboxID = "" },
		"long sandbox":     func(r *ChargeRequest) { r.SandboxID = string(make([]byte, 201)) },
		"negative owner":   func(r *ChargeRequest) { r.BillingUserID = -1 },
		"invalid quota":    func(r *ChargeRequest) { r.DailyQuotaBytes = -2 },
		"zero bytes":       func(r *ChargeRequest) { r.Bytes = 0 },
		"negative bytes":   func(r *ChargeRequest) { r.Bytes = -1 },
		"oversize bytes":   func(r *ChargeRequest) { r.Bytes = MaxChargeBytes + 1 },
		"zero day":         func(r *ChargeRequest) { r.Day = time.Time{} },
		"non-midnight day": func(r *ChargeRequest) { r.Day = testDay.Add(time.Second) },
		"non-UTC midnight": func(r *ChargeRequest) { r.Day = time.Date(2026, 9, 29, 0, 0, 0, 0, time.FixedZone("PDT", -7*3600)) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			request := base
			change(&request)
			// A nonnil transaction makes any database access fail the test.
			if allowed, err := Charge(context.Background(), forbiddenTx{}, request); err == nil || allowed != 0 {
				t.Fatalf("allowed=%d err=%v", allowed, err)
			}
		})
	}
}

func TestChargeUnavailableTransactionGrantsNothing(t *testing.T) {
	if got, err := Charge(context.Background(), nil, chargeRequest("no-transaction", 55, 10, 10)); got != 0 || err == nil {
		t.Fatalf("nil transaction: allowed=%d err=%v", got, err)
	}
	pool := testSuite.Pool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := Charge(ctx, tx, chargeRequest("unavailable", 55, 10, 10)); got != 0 || err == nil {
		t.Fatalf("closed transaction: allowed=%d err=%v", got, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sandbox_egress_usage WHERE billing_user_id=55`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unexpected receipts=%d err=%v", count, err)
	}
}
