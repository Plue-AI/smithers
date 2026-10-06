package db

import (
	"context"
	"encoding/json"
)

// EffectiveInstallAgentModel resolves each new call from the owner's current
// role settings. Removing the fast key immediately restores the coding fallback.
func (q *Queries) EffectiveInstallAgentModel(ctx context.Context, role string) (json.RawMessage, error) {
	var value []byte
	err := q.db.QueryRow(ctx, `WITH candidates AS (
 SELECT s.value, CASE WHEN s.key=$1 THEN 0 WHEN s.key='agent:fast' THEN 1 ELSE 2 END AS priority
 FROM install_settings s WHERE (s.key=$1 OR ($2 AND s.key='agent:fast') OR ($3 AND s.key='agent:coding'))
 AND NOT (s.key='agent:fast' AND EXISTS (SELECT 1 FROM install_settings WHERE key='agent:fast.source' AND value='"coding"'::jsonb))
 ), eligible AS (
 SELECT value,priority FROM candidates WHERE priority<>1 OR EXISTS (
 SELECT 1 FROM owner_model_credentials c JOIN self_host_owners o ON o.user_id=c.user_id
 WHERE c.name=candidates.value->>'credential' AND c.value_encrypted IS NOT NULL)
 UNION ALL SELECT d.model,3 FROM owner_model_defaults d JOIN self_host_owners o ON o.user_id=d.user_id WHERE $3
 ) SELECT value FROM eligible ORDER BY priority LIMIT 1`, "agent:"+role, role == "app", role != "jev").Scan(&value)
	return json.RawMessage(value), err
}

// AssignInstallAgentModel keeps inherited fast bindings live while allowing an
// explicit fast assignment to keep its own choice. Legacy setup copied coding
// into fast; recognize that copy before changing coding, in the same statement.
func (q *Queries) AssignInstallAgentModel(ctx context.Context, role string, value json.RawMessage) error {
	_, err := q.db.Exec(ctx, `WITH source AS (
 INSERT INTO install_settings(key,value)
 SELECT 'agent:fast.source',to_jsonb((CASE WHEN $1='fast' THEN 'owner' ELSE 'coding' END)::text)
 WHERE $1='fast' OR ($1='coding' AND
 NOT EXISTS (SELECT 1 FROM install_settings WHERE key='agent:fast.source') AND
 EXISTS (SELECT 1 FROM install_settings f JOIN install_settings c ON c.key='agent:coding' WHERE f.key='agent:fast' AND f.value=c.value))
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()
 ), defaults AS (
 INSERT INTO owner_model_defaults(user_id,model) SELECT user_id,$2 FROM self_host_owners WHERE singleton AND $1='coding'
 ON CONFLICT(user_id) DO UPDATE SET model=excluded.model
 ) INSERT INTO install_settings(key,value) VALUES('agent:'||$1,$2)
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`, role, value)
	return err
}
