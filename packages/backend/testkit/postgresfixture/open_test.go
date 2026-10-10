package postgresfixture

import (
	"context"
	"testing"
)

// The fixture pool is sized like the product's, not by the host's CPU count:
// pgxpool's default gave a 4-CPU runner four connections and a 48-core host
// forty-eight, so composed tests starved only on CI.
func TestOpenSizesThePoolLikeTheProduct(t *testing.T) {
	const url = "postgres://smithers@127.0.0.1:1/postgres?sslmode=disable"
	pool, err := Open(context.Background(), url, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if got := pool.Config().MaxConns; got != DefaultMaxConns {
		t.Fatalf("default pool holds %d connections, want %d", got, DefaultMaxConns)
	}
	sized, err := Open(context.Background(), url, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer sized.Close()
	if got := sized.Config().MaxConns; got != 3 {
		t.Fatalf("explicit pool holds %d connections, want 3", got)
	}
}
