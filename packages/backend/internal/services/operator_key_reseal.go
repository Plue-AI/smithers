package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/jobs"
)

// OperatorKeyResealer moves one stored ciphertext to the current operator
// key (webhook.AESGCMSecretCodec). It reports false for a value already under
// the current key and fails for a value no configured key opens.
type OperatorKeyResealer interface {
	Reseal(ciphertext string) (string, bool, error)
}

// OperatorKeyResealCount is one store's outcome: values moved to the current
// key, values already under it, and values a concurrent write replaced first
// (which the writer sealed under its own current key).
type OperatorKeyResealCount struct {
	Store    string `json:"store"`
	Resealed int64  `json:"resealed"`
	Current  int64  `json:"current"`
	Raced    int64  `json:"raced"`
}

// operatorKeyColumn is one column the operator key seals. keys is the
// table's primary key, each with its SQL type.
type operatorKeyColumn struct {
	table, column string
	keys          [][2]string
	bytea         bool
}

// operatorKeyColumns lists every durable column sealed with the operator key.
// operatorKeyResealAll adds the workspace command payloads the job queue holds.
var operatorKeyColumns = []operatorKeyColumn{
	{table: "provider_connections", column: "access_token_encrypted", keys: [][2]string{{"id", "uuid"}}, bytea: true},
	{table: "provider_connections", column: "refresh_token_encrypted", keys: [][2]string{{"id", "uuid"}}, bytea: true},
	{table: "provider_connection_device_logins", column: "device_auth_id_encrypted", keys: [][2]string{{"id", "uuid"}}, bytea: true},
	{table: "owner_model_credentials", column: "value_encrypted", keys: [][2]string{{"user_id", "bigint"}, {"name", "text"}}},
	{table: "repository_secrets", column: "value_encrypted", keys: [][2]string{{"id", "bigint"}}, bytea: true},
	{table: "organization_secrets", column: "value_encrypted", keys: [][2]string{{"id", "bigint"}}, bytea: true},
	{table: "repository_agent_environment_secrets", column: "value_encrypted", keys: [][2]string{{"repository_id", "bigint"}, {"name", "text"}}, bytea: true},
	{table: "webhooks", column: "secret", keys: [][2]string{{"id", "bigint"}}},
	{table: "flow_runtime_host_bindings", column: "credential_ciphertext", keys: [][2]string{{"id", "uuid"}}},
	{table: "github_app", column: "pem_sealed", keys: [][2]string{{"id", "bigint"}}},
	{table: "github_app", column: "webhook_secret_sealed", keys: [][2]string{{"id", "bigint"}}},
	{table: "github_app", column: "client_secret_sealed", keys: [][2]string{{"id", "bigint"}}},
}

const operatorKeyResealPage = 256

// operatorKeyResealPasses bounds the passes ResealOperatorKeySecrets makes.
const operatorKeyResealPasses = 5

// ResealOperatorKeySecrets moves every stored value sealed with a previous
// operator key to the current one, one compare-and-swap row at a time, so it
// runs beside a server that already holds the current key. A writer that read
// a row before its reseal can write the old ciphertext back (a token refresh
// keeps the refresh token it read), so passes repeat until one finds every
// value under the current key; only then may the previous key retire. It
// stops at the first value no configured key opens and names its row, never
// its value. Counts total the passes; Current is the final pass's.
func ResealOperatorKeySecrets(ctx context.Context, pool *pgxpool.Pool, codec OperatorKeyResealer) ([]OperatorKeyResealCount, error) {
	if pool == nil || codec == nil {
		return nil, errors.New("reseal: database pool and codec are required")
	}
	var total []OperatorKeyResealCount
	for range operatorKeyResealPasses {
		counts, err := resealOperatorKeyPass(ctx, pool, codec)
		settled := true
		for i, count := range counts {
			if count.Resealed != 0 || count.Raced != 0 {
				settled = false
			}
			if i < len(total) {
				count.Resealed += total[i].Resealed
				count.Raced += total[i].Raced
				counts[i] = count
			}
		}
		total = counts
		if err != nil || settled {
			return total, err
		}
	}
	return total, fmt.Errorf("reseal: values under a previous key kept reappearing after %d passes; run it again before retiring the previous key", operatorKeyResealPasses)
}

func resealOperatorKeyPass(ctx context.Context, pool *pgxpool.Pool, codec OperatorKeyResealer) ([]OperatorKeyResealCount, error) {
	counts := make([]OperatorKeyResealCount, 0, len(operatorKeyColumns)+1)
	for _, column := range operatorKeyColumns {
		count, err := column.reseal(ctx, pool, codec)
		counts = append(counts, count)
		if err != nil {
			return counts, err
		}
	}
	store, err := jobs.NewStore(pool)
	if err != nil {
		return counts, err
	}
	count, err := resealWorkspaceCommandPayloads(ctx, pool, store, codec)
	return append(counts, count), err
}

func (column operatorKeyColumn) reseal(ctx context.Context, pool *pgxpool.Pool, codec OperatorKeyResealer) (OperatorKeyResealCount, error) {
	count := OperatorKeyResealCount{Store: column.table + "." + column.column}
	names := make([]string, len(column.keys))
	selected := make([]string, len(column.keys))
	typed := make([]string, len(column.keys))
	matched := make([]string, len(column.keys))
	for i, key := range column.keys {
		names[i] = key[0]
		selected[i] = key[0] + "::text"
		typed[i] = fmt.Sprintf("$%d::%s", i+1, key[1])
		matched[i] = fmt.Sprintf("%s = $%d::%s", key[0], i+1, key[1])
	}
	order := strings.Join(names, ", ")
	first := fmt.Sprintf(`SELECT %s, %s FROM %s WHERE %s IS NOT NULL ORDER BY %s LIMIT %d`,
		strings.Join(selected, ", "), column.column, column.table, column.column, order, operatorKeyResealPage)
	next := fmt.Sprintf(`SELECT %s, %s FROM %s WHERE %s IS NOT NULL AND (%s) > (%s) ORDER BY %s LIMIT %d`,
		strings.Join(selected, ", "), column.column, column.table, column.column, order, strings.Join(typed, ", "), order, operatorKeyResealPage)
	update := fmt.Sprintf(`UPDATE %s SET %s = $%d WHERE %s AND %s = $%d`,
		column.table, column.column, len(column.keys)+1, strings.Join(matched, " AND "), column.column, len(column.keys)+2)

	var after []any
	for {
		query, args := first, []any(nil)
		if after != nil {
			query, args = next, after
		}
		type sealedRow struct {
			key   []any
			value string
		}
		var page []sealedRow
		rows, err := pool.Query(ctx, query, args...)
		if err != nil {
			return count, fmt.Errorf("reseal %s: %w", count.Store, err)
		}
		for rows.Next() {
			keys := make([]string, len(column.keys))
			targets := make([]any, 0, len(keys)+1)
			for i := range keys {
				targets = append(targets, &keys[i])
			}
			var raw []byte
			targets = append(targets, &raw)
			if err := rows.Scan(targets...); err != nil {
				rows.Close()
				return count, fmt.Errorf("reseal %s: %w", count.Store, err)
			}
			key := make([]any, len(keys))
			for i := range keys {
				key[i] = keys[i]
			}
			page = append(page, sealedRow{key: key, value: string(raw)})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return count, fmt.Errorf("reseal %s: %w", count.Store, err)
		}
		for _, row := range page {
			resealed, changed, err := codec.Reseal(row.value)
			if err != nil {
				return count, fmt.Errorf("reseal %s row %v: no configured operator key opens the stored value", count.Store, row.key)
			}
			if !changed {
				count.Current++
				continue
			}
			var replacement, expected any = resealed, row.value
			if column.bytea {
				replacement, expected = []byte(resealed), []byte(row.value)
			}
			tag, err := pool.Exec(ctx, update, append(append([]any{}, row.key...), replacement, expected)...)
			if err != nil {
				return count, fmt.Errorf("reseal %s row %v: %w", count.Store, row.key, err)
			}
			if tag.RowsAffected() == 1 {
				count.Resealed++
			} else {
				count.Raced++
			}
		}
		if len(page) < operatorKeyResealPage {
			return count, nil
		}
		after = page[len(page)-1].key
	}
}

// resealWorkspaceCommandPayloads reseals the command a queued or finished
// workspace.command request carries; replaying a request compares it.
func resealWorkspaceCommandPayloads(ctx context.Context, pool *pgxpool.Pool, store *jobs.Store, codec OperatorKeyResealer) (OperatorKeyResealCount, error) {
	count := OperatorKeyResealCount{Store: "product_job_requests.payload(" + workspaceCommandOperation + ")"}
	after := ""
	for {
		rows, err := pool.Query(ctx, `
			SELECT id::text, payload FROM product_job_requests
			WHERE operation = $1 AND (NULLIF($2, '') IS NULL OR id > NULLIF($2, '')::uuid)
			ORDER BY id LIMIT $3`, workspaceCommandOperation, after, operatorKeyResealPage)
		if err != nil {
			return count, fmt.Errorf("reseal %s: %w", count.Store, err)
		}
		type request struct {
			id      string
			payload json.RawMessage
		}
		page, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (request, error) {
			var r request
			return r, row.Scan(&r.id, &r.payload)
		})
		if err != nil {
			return count, fmt.Errorf("reseal %s: %w", count.Store, err)
		}
		for _, r := range page {
			var payload workspaceCommandPayload
			if err := json.Unmarshal(r.payload, &payload); err != nil {
				return count, fmt.Errorf("reseal %s row %s: payload is not a workspace command", count.Store, r.id)
			}
			resealed, changed, err := codec.Reseal(payload.EncryptedInput)
			if err != nil {
				return count, fmt.Errorf("reseal %s row %s: no configured operator key opens the stored value", count.Store, r.id)
			}
			if !changed {
				count.Current++
				continue
			}
			payload.EncryptedInput = resealed
			replacement, err := json.Marshal(payload)
			if err != nil {
				return count, err
			}
			replaced, err := store.ReplacePayload(ctx, r.id, r.payload, replacement)
			if err != nil {
				return count, fmt.Errorf("reseal %s row %s: %w", count.Store, r.id, err)
			}
			if replaced {
				count.Resealed++
			} else {
				count.Raced++
			}
		}
		if len(page) < operatorKeyResealPage {
			return count, nil
		}
		after = page[len(page)-1].id
	}
}
