// Package operator exposes server-free commands shared by hosted and local
// binaries. Access to the executable and its database credentials is the
// authorization boundary; these commands are not registered as HTTP routes.
package operator

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Config supplies deployment-owned database configuration without starting a
// server. OpenDatabase transfers ownership of the returned pool to Dispatch.
type Config struct {
	OpenDatabase func(context.Context) (*pgxpool.Pool, error)
	// CreditLedger supplies the same signup policy as commerce/model billing.
	// Nil uses a ledger without automatic signup credit (self-host default).
	CreditLedger func(*pgxpool.Pool) (credits.Ledger, error)
	Stdout       io.Writer
	Stderr       io.Writer
}

// Dispatch recognizes credits and plans, returning false for other commands.
// All command syntax and audit inputs are checked before OpenDatabase runs.
func Dispatch(ctx context.Context, args []string, cfg Config) (bool, error) {
	if len(args) == 0 || (args[0] != "credits" && args[0] != "plans") {
		return false, nil
	}
	if cfg.Stdout == nil {
		cfg.Stdout = io.Discard
	}
	if cfg.Stderr == nil {
		cfg.Stderr = io.Discard
	}
	var run func(*pgxpool.Pool) error
	if args[0] == "credits" {
		request, err := credits.ParseOperatorCommand(args[1:], cfg.Stderr)
		if err != nil {
			return true, err
		}
		run = func(pool *pgxpool.Pool) error {
			ledger := credits.Ledger{DB: pool}
			if cfg.CreditLedger != nil {
				ledger, err = cfg.CreditLedger(pool)
				if err != nil {
					return err
				}
			}
			return request.Run(ctx, ledger, cfg.Stdout)
		}
	} else {
		grant, owner, err := parsePlanGrant(args[1:], cfg.Stderr)
		if err != nil {
			return true, err
		}
		run = func(pool *pgxpool.Pool) error {
			ledger := credits.Ledger{DB: pool}
			grant.OwnerType, grant.OwnerID, err = ledger.ResolveOwner(ctx, owner)
			if err != nil {
				return err
			}
			service := services.NewBillingService(db.New(pool), nil, services.BillingServiceConfig{})
			if err := service.GrantPlan(ctx, grant); err != nil {
				return err
			}
			_, err = fmt.Fprintf(cfg.Stdout, "%s %s until %s\n", strings.TrimSpace(owner), grant.PlanKey, grant.ExpiresAt.UTC().Format(time.RFC3339))
			return err
		}
	}
	if cfg.OpenDatabase == nil {
		return true, errors.New("operator: database opener required")
	}
	pool, err := cfg.OpenDatabase(ctx)
	if err != nil {
		return true, err
	}
	if pool == nil {
		return true, errors.New("operator: database pool required")
	}
	defer pool.Close()
	return true, run(pool)
}

func parsePlanGrant(args []string, stderr io.Writer) (services.PlanGrant, string, error) {
	var g services.PlanGrant
	if len(args) == 0 || args[0] != "grant" {
		return g, "", errors.New("usage: plans grant -owner user:NAME -plan pro|max -expires RFC3339 -key KEY -actor ACTOR -reason REASON")
	}
	fs := flag.NewFlagSet("plans grant", flag.ContinueOnError)
	fs.SetOutput(stderr)
	owner := fs.String("owner", "", "user:NAME")
	expires := fs.String("expires", "", "required RFC 3339 end date")
	fs.StringVar(&g.PlanKey, "plan", "", "pro or max")
	fs.StringVar(&g.Key, "key", "", "idempotency key")
	fs.StringVar(&g.Actor, "actor", "", "operator identity")
	fs.StringVar(&g.Reason, "reason", "", "grant reason")
	if err := fs.Parse(args[1:]); err != nil {
		return g, "", err
	}
	if fs.NArg() > 0 {
		return g, "", fmt.Errorf("plans: unexpected argument %q", fs.Arg(0))
	}
	kind, _, err := credits.ParseOwner(*owner)
	if err != nil {
		return g, "", err
	}
	g.OwnerType, g.OwnerID = kind, 1 // syntax only; resolve the actual owner after opening
	g.ExpiresAt, err = time.Parse(time.RFC3339, strings.TrimSpace(*expires))
	if err != nil {
		return g, "", fmt.Errorf("plans: -expires: %w", err)
	}
	return g, *owner, g.Validate()
}
