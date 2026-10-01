package services

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type AdminGrantRequest struct {
	Login        string      `json:"login"`
	AmountUSD    json.Number `json:"amountUsd"`
	OperationKey string      `json:"operationKey"`
}

type AdminGrantResult struct {
	Granted      bool        `json:"granted"`
	GrantID      string      `json:"grantId"`
	Login        string      `json:"login"`
	AmountUSD    json.Number `json:"amountUsd"`
	OperationKey string      `json:"operationKey"`
	Duplicate    bool        `json:"duplicate"`
}

type adminGrantBeginner interface {
	Begin(context.Context) (pgx.Tx, error)
}

// AdminGrantService uses the product ledger, independently of optional commerce.
type AdminGrantService struct {
	pool   adminGrantBeginner
	ledger credits.Ledger
}

func NewAdminGrantService(pool *pgxpool.Pool, ledger credits.Ledger) *AdminGrantService {
	s := &AdminGrantService{ledger: ledger}
	if pool != nil {
		s.pool = pool
	}
	return s
}

var adminGrantNumber = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

var adminGrantKey = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func validateAdminGrant(req AdminGrantRequest) (string, int64, error) {
	login := strings.ToLower(strings.TrimSpace(req.Login))
	if login == "" || len(login) > 255 || !adminGrantKey.MatchString(req.OperationKey) {
		return "", 0, pkgerrors.BadRequest("login and a bounded operationKey are required")
	}
	// JSON numbers may use exponent notation. Bound parsing first, then keep
	// the exact rational value: binary floating point never chooses the credit.
	if len(req.AmountUSD) > 64 || !adminGrantNumber.MatchString(string(req.AmountUSD)) {
		return "", 0, pkgerrors.BadRequest("invalid amountUsd")
	}
	f, err := strconv.ParseFloat(string(req.AmountUSD), 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) || f <= 0 || f > 10_000_000_000 {
		return "", 0, pkgerrors.BadRequest("amountUsd must be positive whole nanodollars within range")
	}
	// The accepted JSON decimal grammar is also the Rat decimal grammar.
	value, _ := new(big.Rat).SetString(string(req.AmountUSD))
	nanos, err := credits.ParseUSD(value.FloatString(9))
	if err != nil || value.Cmp(big.NewRat(nanos, credits.NanosPerUSD)) != 0 {
		return "", 0, pkgerrors.BadRequest("amountUsd must be positive whole nanodollars within range")
	}
	return login, nanos, nil
}

func (s *AdminGrantService) Grant(ctx context.Context, actor *db.User, req AdminGrantRequest) (AdminGrantResult, error) {
	if actor == nil || actor.ID <= 0 {
		return AdminGrantResult{}, pkgerrors.Unauthorized("authentication required")
	}
	if !actor.IsAdmin {
		return AdminGrantResult{}, pkgerrors.Forbidden("admin access required")
	}
	login, nanos, err := validateAdminGrant(req)
	if err != nil {
		return AdminGrantResult{}, err
	}
	if s.pool == nil {
		return AdminGrantResult{}, pkgerrors.Internal("credit ledger unavailable")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AdminGrantResult{}, pkgerrors.Internal("start credit grant").WithCause(err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	q := db.New(tx)
	verified, err := q.GetUserByID(ctx, actor.ID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (!verified.IsAdmin || !verified.IsActive || verified.ProhibitLogin || verified.DeletedAt.Valid)) {
		return AdminGrantResult{}, pkgerrors.Forbidden("admin access required")
	}
	if err != nil {
		return AdminGrantResult{}, pkgerrors.Internal("verify administrator").WithCause(err)
	}
	key := "admin:" + req.OperationKey
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
		return AdminGrantResult{}, pkgerrors.Internal("lock credit grant").WithCause(err)
	}
	target, err := q.GetUserByLowerUsername(ctx, login)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (!target.IsActive || target.ProhibitLogin || target.DeletedAt.Valid)) {
		return AdminGrantResult{}, pkgerrors.NotFound("user not found")
	}
	if err != nil {
		return AdminGrantResult{}, pkgerrors.Internal("look up grant recipient").WithCause(err)
	}
	// Ledger keys are account-scoped. This product operation binds its key
	// globally so changing the recipient or administrator cannot grant again.
	var count, grantID, ownerID, amount int64
	var ownerType, by, reason string
	var expiry *time.Time
	err = tx.QueryRow(ctx, `SELECT count(*) OVER(), g.id, a.owner_type, a.owner_id,
		g.original_nanos, g.actor, g.reason, g.expires_at FROM credit_grants g
		JOIN credit_accounts a ON a.id = g.account_id WHERE g.source_key = $1`, key).
		Scan(&count, &grantID, &ownerType, &ownerID, &amount, &by, &reason, &expiry)
	duplicate := err == nil
	attribution := credits.GrantAudit{Actor: "user:" + strconv.FormatInt(verified.ID, 10), Reason: "admin.grant"}
	if duplicate && (count != 1 || ownerType != "user" || ownerID != target.ID || amount != nanos || by != attribution.Actor || reason != attribution.Reason || expiry != nil) {
		return AdminGrantResult{}, pkgerrors.Conflict("operationKey belongs to another grant")
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return AdminGrantResult{}, pkgerrors.Internal("read credit grant").WithCause(err)
	}
	if !duplicate {
		ledger := s.ledger.InTransaction(tx)
		accountID, err := ledger.EnsureAccount(ctx, "user", target.ID)
		if err != nil {
			return AdminGrantResult{}, pkgerrors.Internal("open credit account").WithCause(err)
		}
		if err := ledger.Grant(ctx, accountID, key, nanos, nil, attribution); err != nil {
			return AdminGrantResult{}, pkgerrors.Internal("post credit grant").WithCause(err)
		}
		if err := tx.QueryRow(ctx, `SELECT id FROM credit_grants WHERE account_id = $1 AND source_key = $2`, accountID, key).Scan(&grantID); err != nil {
			return AdminGrantResult{}, pkgerrors.Internal("read posted grant").WithCause(err)
		}
		// All fields have concrete JSON-safe types; this encoding cannot fail.
		metadata, _ := json.Marshal(struct {
			Key   string `json:"operation_key"`
			Nanos int64  `json:"amount_nanos"`
		}{req.OperationKey, nanos})
		audit, _ := AdminAuditActorFromContext(ctx)
		if err := q.InsertAuditLog(ctx, db.InsertAuditLogParams{EventType: "admin.credit.grant",
			ActorID: pgtype.Int8{Int64: verified.ID, Valid: true}, ActorName: verified.Username,
			TargetType: "user", TargetID: pgtype.Int8{Int64: target.ID, Valid: true}, TargetName: target.Username, Action: "grant", Metadata: metadata, IpAddress: audit.IPAddress}); err != nil {
			return AdminGrantResult{}, pkgerrors.Internal("record credit grant audit").WithCause(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return AdminGrantResult{}, pkgerrors.Internal("commit credit grant").WithCause(err)
	}
	return AdminGrantResult{Granted: true, GrantID: "credit-grant:" + strconv.FormatInt(grantID, 10), Login: login,
		AmountUSD: json.Number(credits.FormatUSD(nanos)), OperationKey: req.OperationKey, Duplicate: duplicate}, nil
}
