package product

import (
	"context"
	"encoding/csv"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
)

// ownershipRows reads ../ownership.csv as table -> target owner.
func ownershipRows(t *testing.T) map[string]string {
	t.Helper()
	manifest, err := os.Open("../ownership.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer manifest.Close()
	rows, err := csv.NewReader(manifest).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) < 2 || len(rows[0]) != 3 || rows[0][0] != "table" || rows[0][1] != "target_owner" || rows[0][2] != "status" {
		t.Fatalf("invalid schema ownership manifest header: %v", rows[0])
	}
	owners := make(map[string]string, len(rows)-1)
	for _, row := range rows[1:] {
		if len(row) != 3 || row[0] == "" || row[2] == "" {
			t.Fatalf("invalid schema ownership manifest row: %v", row)
		}
		if !slices.Contains([]string{"product", "private", "retired"}, row[1]) {
			t.Fatalf("table %s has unknown owner %q", row[0], row[1])
		}
		if _, dup := owners[row[0]]; dup {
			t.Fatalf("table %s is listed twice", row[0])
		}
		owners[row[0]] = row[1]
	}
	return owners
}

// The ownership inventory names exactly the tables a fresh product database
// installs: every installed table is a product row, and every product row is
// installed. A new migration that adds or drops a table must update it.
func TestOwnershipManifestMatchesFreshProductSchema(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	if err := Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT c.relname FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
		ORDER BY c.relname`)
	if err != nil {
		t.Fatal(err)
	}
	installed, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	owners := ownershipRows(t)
	for _, table := range installed {
		switch owner, listed := owners[table]; {
		case !listed:
			t.Errorf("fresh product schema installs %s, which ownership.csv does not list", table)
		case owner != "product":
			t.Errorf("fresh product schema installs %s, which ownership.csv marks %s", table, owner)
		}
	}
	for table, owner := range owners {
		if owner == "product" && !slices.Contains(installed, table) {
			t.Errorf("ownership.csv lists product table %s, which a fresh product schema does not install", table)
		}
	}
}
