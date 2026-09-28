package credits

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestLedgerRejectsInvalidInputsBeforeDatabase(t *testing.T) {
	l := Ledger{}
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		run  func() error
		want string
	}{
		{name: "unknown owner type", run: func() error { _, err := l.EnsureAccount(ctx, "team", 1); return err }, want: "owner type user or org"},
		{name: "zero owner id", run: func() error { _, err := l.EnsureAccount(ctx, "user", 0); return err }, want: "positive owner id"},
		{name: "negative owner id", run: func() error { _, err := l.EnsureAccount(ctx, "org", -1); return err }, want: "positive owner id"},
		{name: "grant without key", run: func() error { return l.Grant(ctx, 1, "", 1, nil) }, want: "grant key"},
		{name: "negative grant", run: func() error { return l.Grant(ctx, 1, "g", -1, nil) }, want: "non-negative amount"},
		{name: "forfeit without prefix", run: func() error { _, err := l.Forfeit(ctx, "user", 1, ""); return err }, want: "prefix required"},
		{name: "reserve without key", run: func() error { _, err := l.Reserve(ctx, 1, "", 1); return err }, want: "reservation key"},
		{name: "zero reservation", run: func() error { _, err := l.Reserve(ctx, 1, "r", 0); return err }, want: "positive bound"},
		{name: "negative reservation", run: func() error { _, err := l.Reserve(ctx, 1, "r", -1); return err }, want: "positive bound"},
		{name: "settle without key", run: func() error { _, err := l.Settle(ctx, 1, "", 0); return err }, want: "settlement key"},
		{name: "negative settlement", run: func() error { _, err := l.Settle(ctx, 1, "r", -1); return err }, want: "non-negative charge"},
		{name: "attach without source", run: func() error { return l.AttachOwner(ctx, "", "user", 1) }, want: "legacy source"},
		{name: "attach invalid owner", run: func() error { return l.AttachOwner(ctx, "source", "user", 0) }, want: "verified owner"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error=%v, want %q", err, tc.want)
			}
		})
	}
}

func TestMissingAccountCannotReadOrWriteCredit(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	const absentID int64 = 999999
	if balance, err := l.OwnerBalance(ctx, "user", absentID); err != nil || balance != 0 {
		t.Fatalf("absent owner balance=%d err=%v", balance, err)
	}
	for name, run := range map[string]func() error{
		"balance": func() error { _, err := l.Balance(ctx, absentID); return err },
		"grant":   func() error { return l.Grant(ctx, absentID, "g", 1, nil) },
		"reserve": func() error { _, err := l.Reserve(ctx, absentID, "r", 1); return err },
		"settle":  func() error { _, err := l.Settle(ctx, absentID, "r", 1); return err },
	} {
		t.Run(name, func(t *testing.T) {
			if err := run(); !errors.Is(err, ErrNotFound) {
				t.Fatalf("missing account error=%v, want ErrNotFound", err)
			}
		})
	}
	var grants, reservations, events int
	if err := l.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM credit_grants),
		(SELECT count(*) FROM credit_reservations), (SELECT count(*) FROM credit_events)`).Scan(&grants, &reservations, &events); err != nil {
		t.Fatal(err)
	}
	if grants != 0 || reservations != 0 || events != 0 {
		t.Fatalf("missing account created grants=%d reservations=%d events=%d", grants, reservations, events)
	}
}

func TestUnconfiguredLedgerRejectsTransactionalWrites(t *testing.T) {
	l := Ledger{}
	ctx := context.Background()
	for name, run := range map[string]func() error{
		"ensure account": func() error { _, err := l.EnsureAccount(ctx, "user", 1); return err },
		"grant":          func() error { return l.Grant(ctx, 1, "g", 1, nil) },
		"forfeit":        func() error { _, err := l.Forfeit(ctx, "user", 1, "g"); return err },
		"reserve":        func() error { _, err := l.Reserve(ctx, 1, "r", 1); return err },
		"settle":         func() error { _, err := l.Settle(ctx, 1, "r", 1); return err },
		"attach":         func() error { return l.AttachOwner(ctx, "source", "user", 1) },
	} {
		t.Run(name, func(t *testing.T) {
			if err := run(); err == nil || !strings.Contains(err.Error(), "PostgreSQL pool required") {
				t.Fatalf("missing database error=%v", err)
			}
		})
	}
}
