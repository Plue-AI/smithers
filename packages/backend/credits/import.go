package credits

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// LegacyAccount is one legacy billing account as exported at cutover. The
// importer reads only this record; it never contacts the legacy source.
type LegacyAccount struct {
	// SourceID is the stable legacy identity (the Durable Object id).
	SourceID string `json:"source_id"`
	// OwnerType and OwnerID name the verified product owner, if one is known.
	OwnerType string `json:"owner_type,omitempty"`
	OwnerID   int64  `json:"owner_id,omitempty"`
	// BalanceNanos is the legacy balance at ExportedAt. Negative is owed.
	BalanceNanos int64 `json:"balance_nanos"`
	// Grants are the legacy grants with their unspent remainder. A missing
	// legacy ledger is an empty list.
	Grants []LegacyGrant `json:"grants"`
	// Source holds the raw legacy records verbatim for audit.
	Source json.RawMessage `json:"source,omitempty"`
}

type LegacyGrant struct {
	SourceKey      string     `json:"source_key"`
	RemainingNanos int64      `json:"remaining_nanos"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
}

// Disposition is where one legacy account landed.
type Disposition string

const (
	// Owned: credited to an existing product owner.
	Owned Disposition = "owned"
	// OwnerClaimed: dry run only; the archive names an owner not yet checked.
	OwnerClaimed Disposition = "owner_claimed"
	// OwnerUnknown: sealed; the archive names no owner.
	OwnerUnknown Disposition = "owner_unknown"
	// OwnerMissing: sealed; the named owner does not exist in the product.
	OwnerMissing Disposition = "owner_missing"
)

type ImportItem struct {
	SourceID     string      `json:"source_id"`
	Checksum     string      `json:"checksum"`
	Disposition  Disposition `json:"disposition"`
	BalanceNanos int64       `json:"balance_nanos"`
	// SyntheticOpening is true when the source had a balance but no grant
	// detail; the balance is carried as one non-expiring opening grant.
	SyntheticOpening bool `json:"synthetic_opening"`
}

type ImportReport struct {
	Count             int   `json:"count"`
	Owned             int   `json:"owned"`
	Claimed           int   `json:"owner_claimed"`
	Sealed            int   `json:"sealed"`
	SyntheticOpenings int   `json:"synthetic_openings"`
	BalanceNanos      int64 `json:"balance_nanos"`
	OwnedNanos        int64 `json:"owned_nanos"`
	SealedNanos       int64 `json:"sealed_nanos"`
	// Checksum digests every source record in order. Dry run, import and
	// verify of the same archive report the same checksum.
	Checksum string       `json:"checksum"`
	Items    []ImportItem `json:"items"`
}

const openingGrantKey = "opening"

type normalized struct {
	LegacyAccount
	raw       []byte
	checksum  string
	grants    []LegacyGrant
	synthetic bool
}

func grantKey(sourceID, key string) string { return "legacy:" + sourceID + ":" + key }

// normalize validates the archive against its own export time, so the result
// does not depend on when the import runs.
func normalize(exportedAt time.Time, input []LegacyAccount) ([]normalized, error) {
	if exportedAt.IsZero() {
		return nil, errors.New("credits: archive export time required")
	}
	seen := map[string]bool{}
	var total, amount big.Int
	out := make([]normalized, 0, len(input))
	for _, a := range input {
		if a.SourceID == "" || strings.TrimSpace(a.SourceID) != a.SourceID || strings.Contains(a.SourceID, ":") {
			return nil, fmt.Errorf("credits: invalid legacy source id %q", a.SourceID)
		}
		if seen[a.SourceID] {
			return nil, fmt.Errorf("credits: duplicate legacy source %s", a.SourceID)
		}
		seen[a.SourceID] = true
		// Opening debt is stored as a positive int64. MinInt64 cannot be
		// negated, so reject it before import or verification touches the DB.
		if a.BalanceNanos == math.MinInt64 {
			return nil, fmt.Errorf("%s: opening debt overflows", a.SourceID)
		}
		if a.OwnerType != "" || a.OwnerID != 0 {
			if !validOwner(a.OwnerType, a.OwnerID) {
				return nil, fmt.Errorf("%s: invalid owner", a.SourceID)
			}
		}
		if len(a.Source) == 0 {
			a.Source = json.RawMessage("null")
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, a.Source); err != nil {
			return nil, fmt.Errorf("%s: source JSON: %w", a.SourceID, err)
		}
		a.Source = compact.Bytes()
		if a.Grants == nil {
			a.Grants = []LegacyGrant{}
		}
		grants := make([]LegacyGrant, len(a.Grants))
		for i, g := range a.Grants {
			g.ExpiresAt = storedTime(g.ExpiresAt)
			grants[i] = g
		}
		a.Grants = grants
		keys := map[string]bool{}
		var live int64
		for _, g := range a.Grants {
			if g.SourceKey == "" || keys[g.SourceKey] || g.RemainingNanos < 0 || g.SourceKey == openingGrantKey {
				return nil, fmt.Errorf("%s: invalid grant %q", a.SourceID, g.SourceKey)
			}
			keys[g.SourceKey] = true
			if g.ExpiresAt == nil || g.ExpiresAt.After(exportedAt) {
				if live > math.MaxInt64-g.RemainingNanos {
					return nil, fmt.Errorf("%s: grant total overflows", a.SourceID)
				}
				live += g.RemainingNanos
			}
		}
		n := normalized{LegacyAccount: a, grants: a.Grants}
		switch {
		case len(a.Grants) == 0 && a.BalanceNanos > 0:
			n.grants, n.synthetic = []LegacyGrant{{SourceKey: openingGrantKey, RemainingNanos: a.BalanceNanos}}, true
		case a.BalanceNanos >= 0 && live != a.BalanceNanos:
			return nil, fmt.Errorf("%s: live grants %d nanos differ from balance %d nanos", a.SourceID, live, a.BalanceNanos)
		case a.BalanceNanos < 0 && live != 0:
			return nil, fmt.Errorf("%s: an owing account cannot hold live grants", a.SourceID)
		}
		raw, err := json.Marshal(a)
		if err != nil {
			return nil, err
		}
		n.raw, n.checksum = raw, digest(raw)
		out = append(out, n)
		amount.SetInt64(a.BalanceNanos)
		total.Add(&total, &amount)
	}
	// Only the overall total is independent of database state. Ownership
	// subtotals can change when owners resolve or sealed receipts attach.
	if _, err := reportTotal("balance_nanos", &total); err != nil {
		return nil, err
	}
	return out, nil
}

func reportTotal(name string, total *big.Int) (int64, error) {
	if !total.IsInt64() {
		return 0, fmt.Errorf("credits: report %s total %s overflows int64", name, total.String())
	}
	return total.Int64(), nil
}

func digest(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func (r ImportReport) tally() (ImportReport, error) {
	r.Owned, r.Claimed, r.Sealed, r.SyntheticOpenings = 0, 0, 0, 0
	// Sum exactly before checking bounds: a representable final total must
	// not depend on the order of credits and debts in the archive.
	var balance, owned, sealed, amount big.Int
	digest := sha256.New()
	for _, item := range r.Items {
		digest.Write([]byte(item.SourceID + "\x00" + item.Checksum + "\n"))
		amount.SetInt64(item.BalanceNanos)
		balance.Add(&balance, &amount)
		switch item.Disposition {
		case Owned:
			r.Owned++
			owned.Add(&owned, &amount)
		case OwnerClaimed:
			r.Claimed++
		default:
			r.Sealed++
			sealed.Add(&sealed, &amount)
		}
		if item.SyntheticOpening {
			r.SyntheticOpenings++
		}
	}
	for _, total := range []struct {
		name  string
		value *big.Int
		dest  *int64
	}{
		{"balance_nanos", &balance, &r.BalanceNanos},
		{"owned_nanos", &owned, &r.OwnedNanos},
		{"sealed_nanos", &sealed, &r.SealedNanos},
	} {
		value, err := reportTotal(total.name, total.value)
		if err != nil {
			return ImportReport{}, err
		}
		*total.dest = value
	}
	r.Count = len(r.Items)
	r.Checksum = hex.EncodeToString(digest.Sum(nil))
	return r, nil
}

func dryRun(accounts []normalized) (ImportReport, error) {
	report := ImportReport{Items: make([]ImportItem, 0, len(accounts))}
	for _, a := range accounts {
		d := OwnerUnknown
		if a.OwnerID > 0 {
			d = OwnerClaimed
		}
		report.Items = append(report.Items, ImportItem{SourceID: a.SourceID, Checksum: a.checksum, Disposition: d,
			BalanceNanos: a.BalanceNanos, SyntheticOpening: a.synthetic})
	}
	return report.tally()
}

// DryRun validates an archive and reports counts, totals and checksums
// without a database.
func DryRun(exportedAt time.Time, input []LegacyAccount) (ImportReport, error) {
	accounts, err := normalize(exportedAt, input)
	if err != nil {
		return ImportReport{}, err
	}
	return dryRun(accounts)
}

// Import credits each legacy account to its owner, or seals it when the owner
// is unknown or missing. Each account commits in its own transaction with a
// receipt, so an interrupted run resumes; an exact replay is a no-op and a
// changed record for an imported source is ErrConflict.
// On failure, the report contains only successfully committed or replayed
// accounts. If its totals cannot fit int64, the report is empty and the error
// gives the exact overflowing total; per-account receipts may already exist.
func (l Ledger) Import(ctx context.Context, exportedAt time.Time, input []LegacyAccount) (ImportReport, error) {
	accounts, err := normalize(exportedAt, input)
	if err != nil {
		return ImportReport{}, err
	}
	var now time.Time
	if err = l.handle().QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return ImportReport{}, err
	}
	if exportedAt.After(now) {
		// Grants live at a future export time may already be expired.
		return ImportReport{}, fmt.Errorf("credits: archive export time %s is after the database clock %s", exportedAt, now)
	}
	report := ImportReport{Items: make([]ImportItem, 0, len(accounts))}
	for _, a := range accounts {
		var disposition Disposition
		err = l.transaction(ctx, func(tx pgx.Tx) error {
			d, e := importOne(ctx, tx, a)
			disposition = d
			return e
		})
		if err != nil {
			partial, tallyErr := report.tally()
			return partial, errors.Join(fmt.Errorf("import %s: %w", a.SourceID, err), tallyErr)
		}
		report.Items = append(report.Items, ImportItem{SourceID: a.SourceID, Checksum: a.checksum, Disposition: disposition,
			BalanceNanos: a.BalanceNanos, SyntheticOpening: a.synthetic})
	}
	result, err := report.tally()
	if err != nil {
		return ImportReport{}, fmt.Errorf("import report (per-account receipts may already exist): %w", err)
	}
	return result, nil
}

func ownerExists(ctx context.Context, tx pgx.Tx, ownerType string, ownerID int64) (bool, error) {
	query := `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`
	if ownerType == "org" {
		query = `SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1)`
	}
	var exists bool
	err := tx.QueryRow(ctx, query, ownerID).Scan(&exists)
	return exists, err
}

func importOne(ctx context.Context, tx pgx.Tx, a normalized) (Disposition, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "credits:legacy:"+a.SourceID); err != nil {
		return "", err
	}
	var recorded, disposition string
	err := tx.QueryRow(ctx, `SELECT checksum, disposition FROM credit_legacy_imports WHERE source_id = $1`, a.SourceID).Scan(&recorded, &disposition)
	if err == nil {
		if recorded != a.checksum {
			return Disposition(disposition), ErrConflict
		}
		return Disposition(disposition), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	d := OwnerUnknown
	if a.OwnerID > 0 {
		exists, err := ownerExists(ctx, tx, a.OwnerType, a.OwnerID)
		if err != nil {
			return "", err
		}
		d = OwnerMissing
		if exists {
			d = Owned
		}
	}
	var accountID int64
	if d == Owned {
		if accountID, _, err = ensureAccount(ctx, tx, a.OwnerType, a.OwnerID); err != nil {
			return "", err
		}
	} else if err = tx.QueryRow(ctx, `INSERT INTO credit_accounts (disposition) VALUES ($1) RETURNING id`, string(d)).Scan(&accountID); err != nil {
		return "", err
	}
	locked, err := lockAccount(ctx, tx, accountID)
	if err != nil {
		return "", err
	}
	for _, g := range a.grants {
		inserted, err := insertGrant(ctx, tx, locked, grantKey(a.SourceID, g.SourceKey), g.RemainingNanos, g.ExpiresAt, "import", GrantAudit{})
		if err != nil {
			return "", err
		}
		if !inserted {
			return "", ErrConflict
		}
	}
	var openingDebt int64
	if a.BalanceNanos < 0 {
		openingDebt = -a.BalanceNanos
		if err = addDebt(ctx, tx, accountID, nil, "debt", openingDebt); err != nil {
			return "", err
		}
	} else if err = repayDebt(ctx, tx, accountID); err != nil {
		return "", err
	}
	if err = expire(ctx, tx, accountID); err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `INSERT INTO credit_legacy_imports (source_id, account_id, checksum, raw_account, opening_debt_nanos, disposition)
		VALUES ($1, $2, $3, $4, $5, $6)`, a.SourceID, accountID, a.checksum, string(a.raw), openingDebt, string(d))
	return d, err
}

// Verify reads every imported account back and compares it with the archive:
// the receipt checksum, the stored source record, each grant's amount and
// expiry, and the opening debt. Any difference is an error.
// On failure, the report contains only the verified prefix, or is empty if
// those totals cannot fit int64. Verification never changes stored receipts.
func (l Ledger) Verify(ctx context.Context, exportedAt time.Time, input []LegacyAccount) (ImportReport, error) {
	accounts, err := normalize(exportedAt, input)
	if err != nil {
		return ImportReport{}, err
	}
	var receipts int
	if err = l.handle().QueryRow(ctx, `SELECT count(*) FROM credit_legacy_imports`).Scan(&receipts); err != nil {
		return ImportReport{}, err
	}
	if receipts != len(accounts) {
		return ImportReport{}, fmt.Errorf("verify: %d receipts stored, %d accounts in the archive: %w", receipts, len(accounts), ErrConflict)
	}
	report := ImportReport{Items: make([]ImportItem, 0, len(accounts))}
	for _, a := range accounts {
		d, err := l.verifyOne(ctx, a)
		if err != nil {
			partial, tallyErr := report.tally()
			return partial, errors.Join(fmt.Errorf("verify %s: %w", a.SourceID, err), tallyErr)
		}
		report.Items = append(report.Items, ImportItem{SourceID: a.SourceID, Checksum: a.checksum, Disposition: d,
			BalanceNanos: a.BalanceNanos, SyntheticOpening: a.synthetic})
	}
	return report.tally()
}

func (l Ledger) verifyOne(ctx context.Context, a normalized) (Disposition, error) {
	var accountID, openingDebt int64
	var recorded, disposition string
	var raw string
	err := l.handle().QueryRow(ctx, `SELECT account_id, checksum, raw_account, opening_debt_nanos, disposition FROM credit_legacy_imports WHERE source_id = $1`,
		a.SourceID).Scan(&accountID, &recorded, &raw, &openingDebt, &disposition)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("receipt: %w", ErrNotFound)
	}
	if err != nil {
		return "", err
	}
	if recorded != a.checksum || digest([]byte(raw)) != a.checksum {
		return "", fmt.Errorf("checksum: %w", ErrConflict)
	}
	if want := max(0, -a.BalanceNanos); openingDebt != want {
		return "", fmt.Errorf("opening debt %d, want %d: %w", openingDebt, want, ErrConflict)
	}
	var accountDisposition string
	var ownerType *string
	var ownerID *int64
	var drift bool
	if err = l.handle().QueryRow(ctx, `SELECT a.disposition, a.owner_type, a.owner_id,
			a.debt_nanos <> COALESCE((SELECT sum(debt_delta_nanos) FROM credit_events e WHERE e.account_id = a.id), 0)
			OR EXISTS (SELECT 1 FROM credit_grants g WHERE g.account_id = a.id
				AND g.available_nanos <> COALESCE((SELECT sum(available_delta_nanos) FROM credit_events e WHERE e.grant_id = g.id), 0))
		FROM credit_accounts a WHERE a.id = $1`, accountID).Scan(&accountDisposition, &ownerType, &ownerID, &drift); err != nil {
		return "", err
	}
	if accountDisposition != disposition || (disposition == string(Owned)) != (ownerID != nil) {
		return "", fmt.Errorf("account disposition %s, receipt %s: %w", accountDisposition, disposition, ErrConflict)
	}
	if ownerID != nil && a.OwnerID > 0 && (*ownerType != a.OwnerType || *ownerID != a.OwnerID) {
		return "", fmt.Errorf("owner %s:%d, archive %s:%d: %w", *ownerType, *ownerID, a.OwnerType, a.OwnerID, ErrConflict)
	}
	if drift {
		return "", fmt.Errorf("account %d amounts differ from its event log: %w", accountID, ErrConflict)
	}
	rows, err := l.handle().Query(ctx, `SELECT source_key, original_nanos, expires_at FROM credit_grants WHERE account_id = $1 AND source_key LIKE $2`,
		accountID, escapeLike(grantKey(a.SourceID, ""))+"%")
	if err != nil {
		return "", err
	}
	type grant struct {
		nanos   int64
		expires *time.Time
	}
	stored2 := map[string]grant{}
	for rows.Next() {
		var key string
		var g grant
		if err = rows.Scan(&key, &g.nanos, &g.expires); err != nil {
			rows.Close()
			return "", err
		}
		stored2[key] = g
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return "", err
	}
	if len(stored2) != len(a.grants) {
		return "", fmt.Errorf("%d grants stored, %d exported: %w", len(stored2), len(a.grants), ErrConflict)
	}
	for _, g := range a.grants {
		s, ok := stored2[grantKey(a.SourceID, g.SourceKey)]
		if !ok || s.nanos != g.RemainingNanos || !sameTime(s.expires, g.ExpiresAt) {
			return "", fmt.Errorf("grant %s: %w", g.SourceKey, ErrConflict)
		}
	}
	return Disposition(disposition), nil
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// AttachOwner moves a sealed legacy account's grants and debt to its verified
// owner once an identity join exists. The owner must exist. A replay for the
// same owner is a no-op; a different owner is ErrConflict.
func (l Ledger) AttachOwner(ctx context.Context, sourceID, ownerType string, ownerID int64) error {
	if sourceID == "" || !validOwner(ownerType, ownerID) {
		return errors.New("credits: legacy source and a verified owner required")
	}
	return l.transaction(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "credits:legacy:"+sourceID); err != nil {
			return err
		}
		var sealedID int64
		var disposition, raw string
		err := tx.QueryRow(ctx, `SELECT account_id, disposition, raw_account FROM credit_legacy_imports WHERE source_id = $1`, sourceID).Scan(&sealedID, &disposition, &raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("legacy source %s: %w", sourceID, ErrNotFound)
		}
		if err != nil {
			return err
		}
		var archived LegacyAccount
		if err = json.Unmarshal([]byte(raw), &archived); err != nil {
			return err
		}
		if archived.OwnerID > 0 && (archived.OwnerType != ownerType || archived.OwnerID != ownerID) {
			// The archive already names this source's owner.
			return ErrConflict
		}
		if disposition == string(Owned) {
			var same bool
			if err = tx.QueryRow(ctx, `SELECT owner_type = $2 AND owner_id = $3 FROM credit_accounts WHERE id = $1`, sealedID, ownerType, ownerID).Scan(&same); err != nil {
				return err
			}
			if !same {
				return ErrConflict
			}
			return nil
		}
		exists, err := ownerExists(ctx, tx, ownerType, ownerID)
		if err != nil {
			return err
		}
		if !exists {
			return ErrSealed
		}
		ownerAccount, _, err := ensureAccount(ctx, tx, ownerType, ownerID)
		if err != nil {
			return err
		}
		// Lock in id order so concurrent attaches cannot deadlock.
		first, second := min(sealedID, ownerAccount), max(sealedID, ownerAccount)
		if _, err = lockAccount(ctx, tx, first); err != nil {
			return err
		}
		if _, err = lockAccount(ctx, tx, second); err != nil {
			return err
		}
		sealed, err := lockAccount(ctx, tx, sealedID)
		if err != nil {
			return err
		}
		if err = expire(ctx, tx, sealedID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT id, available_nanos FROM credit_grants WHERE account_id = $1 ORDER BY id`, sealedID)
		if err != nil {
			return err
		}
		moved, err := collect(rows)
		if err != nil {
			return err
		}
		for _, g := range moved {
			if _, err = tx.Exec(ctx, `UPDATE credit_grants SET account_id = $2 WHERE id = $1`, g.id, ownerAccount); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO credit_events (account_id, grant_id, kind, available_delta_nanos)
				VALUES ($1, $3, 'merge', -$4::bigint), ($2, $3, 'merge', $4)`, sealedID, ownerAccount, g.id, g.nanos); err != nil {
				return err
			}
		}
		if sealed.debt > 0 {
			if _, err = tx.Exec(ctx, `INSERT INTO credit_events (account_id, kind, available_delta_nanos, debt_delta_nanos) VALUES ($1, 'merge', 0, $2)`,
				sealedID, -sealed.debt); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE credit_accounts SET disposition = 'merged', merged_into = $2, debt_nanos = 0 WHERE id = $1`, sealedID, ownerAccount); err != nil {
			return err
		}
		if err = addDebt(ctx, tx, ownerAccount, nil, "merge", sealed.debt); err != nil {
			return err
		}
		if err = repayDebt(ctx, tx, ownerAccount); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE credit_legacy_imports SET account_id = $2, disposition = 'owned' WHERE source_id = $1`, sourceID, ownerAccount)
		return err
	})
}
