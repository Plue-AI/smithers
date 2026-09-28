package chat

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The real lazy pool uses its public connection hook to refuse acquisition.
// No SQL is emulated and the dial guard prevents accidental network access.
func chatListenerUnitPool(t *testing.T) (*pgxpool.Pool, *atomic.Int32) {
	t.Helper()
	config, err := pgxpool.ParseConfig("postgres://unit:unit@127.0.0.1:1/unit?sslmode=disable&connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	config.MinConns = 0
	config.MaxConns = 1
	attempts := new(atomic.Int32)
	config.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
		attempts.Add(1)
		return syscall.ECONNREFUSED
	}
	config.ConnConfig.DialFunc = func(context.Context, string, string) (net.Conn, error) {
		t.Error("listener unit attempted network access after connection refusal")
		return nil, syscall.ECONNREFUSED
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	return pool, attempts
}

func TestChatListenerUnitRequiresPool(t *testing.T) {
	store, err := NewStore(nil)
	if store != nil || err == nil || err.Error() != "chat store requires a PostgreSQL pool" {
		t.Fatalf("nil pool admission = (%v, %v)", store, err)
	}
}

func TestChatListenerUnitPreCancelledListenerDoesNotReportFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		pool, _ := chatListenerUnitPool(t)
		defer pool.Close()
		store, err := NewStore(pool)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		start := time.Now()
		if err := store.Listen(ctx, func(err error) { t.Errorf("reported cancelled listener: %v", err) }); err != nil {
			t.Fatalf("cancelled Listen = %v", err)
		}
		if elapsed := time.Since(start); elapsed != 0 {
			t.Fatalf("cancelled listener delayed exit by %v", elapsed)
		}
	})
}

func TestChatListenerUnitRetriesRefusalAndCancelsDuringBackoff(t *testing.T) {
	for _, withReporter := range []bool{false, true} {
		name := "without_reporter"
		if withReporter {
			name = "with_reporter"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				pool, attempts := chatListenerUnitPool(t)
				defer pool.Close()
				store, err := NewStore(pool)
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				reports := make(chan error, 4)
				var reported int
				var report func(error)
				if withReporter {
					report = func(err error) {
						select {
						case reports <- err:
						case <-ctx.Done():
						}
					}
				}
				done := make(chan error, 1)
				go func() { done <- store.Listen(ctx, report) }()
				check := func(want int32) {
					t.Helper()
					synctest.Wait()
					if got := attempts.Load(); got != want {
						t.Fatalf("connection attempts = %d, want %d", got, want)
					}
					for len(reports) > 0 {
						err := <-reports
						reported++
						if !errors.Is(err, syscall.ECONNREFUSED) {
							t.Fatalf("report lost acquisition cause: %v", err)
						}
					}
					if withReporter && reported != int(want) {
						t.Fatalf("reported %d failures for %d connection attempts", reported, want)
					}
				}
				check(1)
				time.Sleep(time.Second - time.Nanosecond)
				check(1)
				time.Sleep(time.Nanosecond)
				check(2)
				time.Sleep(250 * time.Millisecond)
				cancelledAt := time.Now()
				cancel()
				synctest.Wait()
				select {
				case err := <-done:
					if err != nil {
						t.Fatalf("Listen after cancellation = %v", err)
					}
				default:
					t.Fatal("listener waited for the retry timer after cancellation")
				}
				if time.Now() != cancelledAt {
					t.Fatal("listener advanced the clock after cancellation")
				}
				time.Sleep(2 * time.Second)
				check(2)
				if pool.Stat().TotalConns() != 0 {
					t.Fatal("refused listener retained a connection")
				}
			})
		})
	}
}

func TestChatListenerUnitReporterCanStopRetries(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		pool, attempts := chatListenerUnitPool(t)
		defer pool.Close()
		store, err := NewStore(pool)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		var reports []error
		start := time.Now()
		err = store.Listen(ctx, func(err error) {
			reports = append(reports, err)
			cancel()
		})
		if err != nil || attempts.Load() != 1 || len(reports) != 1 || !errors.Is(reports[0], syscall.ECONNREFUSED) {
			t.Fatalf("Listen = %v; attempts = %d; reports = %v", err, attempts.Load(), reports)
		}
		if elapsed := time.Since(start); elapsed != 0 {
			t.Fatalf("reporter cancellation delayed exit by %v", elapsed)
		}
	})
}
