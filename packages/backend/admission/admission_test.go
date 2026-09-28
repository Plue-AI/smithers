package admission_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/admission"
)

func TestMeteredConstructionValidatesUsageWithoutDatabase(t *testing.T) {
	// These paths only bind a handle and never open a connection.
	pool := &pgxpool.Pool{}
	for _, tc := range []struct {
		name string
		pool *pgxpool.Pool
		cfg  admission.Config
		want string
	}{
		{name: "missing pool", cfg: admission.Config{Usage: admission.ProductUsage}, want: "database pool is required"},
		{name: "missing usage factory", pool: pool, want: "usage factory is required"},
		{name: "factory returns no authority", pool: pool, cfg: admission.Config{Usage: func(admission.DBTX) (admission.Usage, error) { return nil, nil }}, want: "usage factory returned no authority"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy, err := admission.NewMetered(tc.pool, tc.cfg)
			if policy != nil || err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("policy=%v err=%v, want %q", policy, err, tc.want)
			}
		})
	}
	if usage, err := admission.ProductUsage(nil); usage != nil || err == nil || !strings.Contains(err.Error(), "usage database handle is required") {
		t.Fatalf("nil product usage=%v err=%v", usage, err)
	}
	if usage, err := admission.ProductUsage(pool); usage == nil || err != nil {
		t.Fatalf("product usage=%v err=%v", usage, err)
	}
}

func TestMeteredInitialUsageFactoryReceivesExactPool(t *testing.T) {
	pool := &pgxpool.Pool{}
	want := errors.New("private usage unavailable")
	called := 0
	policy, err := admission.NewMetered(pool, admission.Config{Usage: func(conn admission.DBTX) (admission.Usage, error) {
		called++
		if conn != pool {
			t.Fatalf("factory received %T %p, want pool %p", conn, conn, pool)
		}
		return nil, want
	}})
	if policy != nil || !errors.Is(err, want) || called != 1 {
		t.Fatalf("policy=%v err=%v calls=%d", policy, err, called)
	}
	policy, err = admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	if policy == nil || err != nil {
		t.Fatalf("policy=%v err=%v", policy, err)
	}
}
