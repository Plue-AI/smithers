package credits

import (
	"context"
	"encoding/json"
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

// OperatorCommand runs credits grant|balance|list for a process operator.
func (l Ledger) OperatorCommand(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	command, err := ParseOperatorCommand(args, stderr)
	if err != nil {
		return err
	}
	return command.Run(ctx, l, stdout)
}

// OperatorRequest is a validated command. Parse it before opening a database.
type OperatorRequest struct {
	command, owner, key string
	nanos               int64
	expiresAt           *time.Time
	audit               GrantAudit
}

func ParseOperatorCommand(args []string, stderr io.Writer) (*OperatorRequest, error) {
	if len(args) == 0 || (args[0] != "grant" && args[0] != "balance" && args[0] != "list") {
		return nil, errors.New("usage: credits grant|balance|list -owner user:NAME|org:NAME [-usd AMOUNT -key KEY -actor ACTOR -reason REASON [-expires RFC3339]]")
	}
	c := &OperatorRequest{command: args[0]}
	fs := flag.NewFlagSet("credits "+c.command, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&c.owner, "owner", "", "user:NAME or org:NAME")
	var amount, expires string
	if c.command == "grant" {
		fs.StringVar(&amount, "usd", "", "amount in USD")
		fs.StringVar(&c.key, "key", "", "idempotency key")
		fs.StringVar(&expires, "expires", "", "optional RFC 3339 expiry")
		fs.StringVar(&c.audit.Actor, "actor", "", "operator identity")
		fs.StringVar(&c.audit.Reason, "reason", "", "grant reason")
	}
	if err := fs.Parse(args[1:]); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("credits: unexpected argument %q", fs.Arg(0))
	}
	if c.command == "grant" {
		c.audit.Actor = strings.TrimSpace(c.audit.Actor)
		c.audit.Reason = strings.TrimSpace(c.audit.Reason)
		if c.audit.Actor == "" {
			return nil, errors.New("credits: -actor is required")
		}
		if c.audit.Reason == "" {
			return nil, errors.New("credits: -reason is required")
		}
		var err error
		c.nanos, err = ParseUSD(amount)
		if err != nil {
			return nil, err
		}
		c.key = strings.TrimSpace(c.key)
		if c.key == "" {
			return nil, errors.New("credits: -key is required so a repeated grant is not applied twice")
		}
		if strings.TrimSpace(expires) != "" {
			at, err := time.Parse(time.RFC3339, strings.TrimSpace(expires))
			if err != nil {
				return nil, fmt.Errorf("credits: -expires: %w", err)
			}
			if !at.After(time.Now()) {
				return nil, errors.New("credits: -expires must be in the future")
			}
			c.expiresAt = &at
		}
	}
	if _, _, err := ParseOwner(c.owner); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *OperatorRequest) Run(ctx context.Context, l Ledger, stdout io.Writer) error {
	ownerType, ownerID, err := l.ResolveOwner(ctx, c.owner)
	if err != nil {
		return err
	}
	if c.command == "grant" {
		accountID, err := l.EnsureAccount(ctx, ownerType, ownerID)
		if err != nil {
			return err
		}
		if err := l.Grant(ctx, accountID, "operator:"+c.key, c.nanos, c.expiresAt, c.audit); err != nil {
			return err
		}
	}
	if c.command == "list" {
		grants, err := l.ListOwnerGrants(ctx, ownerType, ownerID)
		if err != nil {
			return err
		}
		return json.NewEncoder(stdout).Encode(grants)
	}
	balance, err := l.OwnerBalance(ctx, ownerType, ownerID)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "%s balance %s USD\n", strings.TrimSpace(c.owner), FormatUSD(balance))
	return err
}

// ParseOwner validates an operator's owner selector without database access.
func ParseOwner(owner string) (string, string, error) {
	kind, name, ok := strings.Cut(strings.TrimSpace(owner), ":")
	name = strings.ToLower(strings.TrimSpace(name))
	if !ok || name == "" || (kind != "user" && kind != "org") {
		return "", "", errors.New("credits: -owner must be user:NAME or org:NAME")
	}
	return kind, name, nil
}

// ResolveOwner finds an existing user or organization by operator selector.
func (l Ledger) ResolveOwner(ctx context.Context, owner string) (string, int64, error) {
	kind, name, err := ParseOwner(owner)
	if err != nil {
		return "", 0, err
	}
	database, err := l.db()
	if err != nil {
		return "", 0, err
	}
	query := `SELECT id FROM users WHERE lower_username = $1`
	if kind == "org" {
		query = `SELECT id FROM organizations WHERE lower_name = $1`
	}
	var id int64
	if err := database.QueryRow(ctx, query, name).Scan(&id); err != nil {
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
