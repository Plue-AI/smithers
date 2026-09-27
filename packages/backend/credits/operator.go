package credits

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// NanosPerUSD converts dollars to nanos.
const NanosPerUSD = 100 * NanosPerCent

// OperatorCommand runs `credits grant|balance` for the operator of a
// self-hosted install, who funds platform-model calls on their own keys:
//
//	credits grant -owner user:alice -usd 25 -key 2026-10 [-expires 2027-01-01T00:00:00Z]
//	credits balance -owner user:alice
//
// A grant is idempotent by key: repeating it is a no-op, and reusing a key
// with a different amount or expiry fails.
func (l Ledger) OperatorCommand(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || (args[0] != "grant" && args[0] != "balance") {
		return errors.New("usage: credits grant|balance -owner user:NAME|org:NAME [-usd AMOUNT -key KEY [-expires RFC3339]]")
	}
	subcommand := args[0]
	fs := flag.NewFlagSet("credits "+subcommand, flag.ContinueOnError)
	fs.SetOutput(stderr)
	owner := fs.String("owner", "", "user:NAME or org:NAME")
	amount := fs.String("usd", "", "amount in USD, such as 25 or 0.50")
	key := fs.String("key", "", "idempotency key for the grant")
	expires := fs.String("expires", "", "optional RFC 3339 expiry")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("credits: unexpected argument %q", fs.Arg(0))
	}
	ownerType, ownerID, err := l.resolveOwner(ctx, *owner)
	if err != nil {
		return err
	}
	if subcommand == "grant" {
		nanos, err := ParseUSD(*amount)
		if err != nil {
			return err
		}
		if strings.TrimSpace(*key) == "" {
			return errors.New("credits: -key is required so a repeated grant is not applied twice")
		}
		var expiresAt *time.Time
		if strings.TrimSpace(*expires) != "" {
			at, err := time.Parse(time.RFC3339, strings.TrimSpace(*expires))
			if err != nil {
				return fmt.Errorf("credits: -expires: %w", err)
			}
			if !at.After(time.Now()) {
				return errors.New("credits: -expires must be in the future")
			}
			expiresAt = &at
		}
		accountID, err := l.EnsureAccount(ctx, ownerType, ownerID)
		if err != nil {
			return err
		}
		if err := l.Grant(ctx, accountID, "operator:"+strings.TrimSpace(*key), nanos, expiresAt); err != nil {
			return err
		}
	}
	balance, err := l.OwnerBalance(ctx, ownerType, ownerID)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "%s balance %s USD\n", strings.TrimSpace(*owner), FormatUSD(balance))
	return err
}

func (l Ledger) resolveOwner(ctx context.Context, owner string) (string, int64, error) {
	kind, name, ok := strings.Cut(strings.TrimSpace(owner), ":")
	name = strings.ToLower(strings.TrimSpace(name))
	var query string
	switch {
	case !ok || name == "":
		return "", 0, errors.New("credits: -owner must be user:NAME or org:NAME")
	case kind == "user":
		query = `SELECT id FROM users WHERE lower_username = $1`
	case kind == "org":
		query = `SELECT id FROM organizations WHERE lower_name = $1`
	default:
		return "", 0, errors.New("credits: -owner must be user:NAME or org:NAME")
	}
	var id int64
	if err := l.handle().QueryRow(ctx, query, name).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", 0, fmt.Errorf("credits: no %s named %q", kind, name)
		}
		return "", 0, err
	}
	return kind, id, nil
}

var decimalUSD = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)

// ParseUSD reads a positive decimal dollar amount exactly, to the nano.
func ParseUSD(amount string) (int64, error) {
	amount = strings.TrimSpace(amount)
	value, ok := new(big.Rat).SetString(amount)
	if !decimalUSD.MatchString(amount) || !ok || value.Sign() <= 0 {
		return 0, errors.New("credits: -usd must be a positive amount such as 25 or 0.50")
	}
	value.Mul(value, big.NewRat(NanosPerUSD, 1))
	if !value.IsInt() || !value.Num().IsInt64() {
		return 0, errors.New("credits: -usd must be a whole number of nanodollars within range")
	}
	return value.Num().Int64(), nil
}

// FormatUSD prints nanos as dollars with the sub-cent digits kept.
func FormatUSD(nanos int64) string {
	return strings.TrimRight(strings.TrimRight(new(big.Rat).SetFrac64(nanos, NanosPerUSD).FloatString(9), "0"), ".")
}
