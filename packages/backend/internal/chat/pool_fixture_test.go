package chat

import (
	"context"
	"net"
	"sync/atomic"
	"syscall"
	"testing"

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
