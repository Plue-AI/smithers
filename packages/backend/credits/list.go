package credits

import (
	"context"
	"errors"
	"time"
)

// GrantRecord is the persisted attribution and current balance of a grant.
type GrantRecord struct {
	ID             int64      `json:"id"`
	Key            string     `json:"key"`
	AmountUSD      string     `json:"amount_usd"`
	AvailableNanos int64      `json:"available_nanos"`
	ExpiresAt      *time.Time `json:"expires_at"`
	Actor          string     `json:"actor"`
	Reason         string     `json:"reason"`
	CreatedAt      time.Time  `json:"created_at"`
}

// ListOwnerGrants includes expired and spent grants, ordered by creation ID.
// It does not create an account or mutate the ledger.
func (l Ledger) ListOwnerGrants(ctx context.Context, ownerType string, ownerID int64) ([]GrantRecord, error) {
	if !validOwner(ownerType, ownerID) {
		return nil, errors.New("credits: owner type user or org and a positive owner id required")
	}
	database, err := l.db()
	if err != nil {
		return nil, err
	}
	rows, err := database.Query(ctx, `SELECT g.id, g.source_key, g.original_nanos, g.available_nanos,
		g.expires_at, g.actor, g.reason, g.created_at FROM credit_grants g
		JOIN credit_accounts a ON a.id = g.account_id
		WHERE a.owner_type = $1 AND a.owner_id = $2 ORDER BY g.id`, ownerType, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := []GrantRecord{}
	for rows.Next() {
		var grant GrantRecord
		var nanos int64
		if err := rows.Scan(&grant.ID, &grant.Key, &nanos, &grant.AvailableNanos, &grant.ExpiresAt,
			&grant.Actor, &grant.Reason, &grant.CreatedAt); err != nil {
			return nil, err
		}
		grant.AmountUSD = FormatUSD(nanos)
		grants = append(grants, grant)
	}
	return grants, rows.Err()
}
