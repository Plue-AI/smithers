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
 SELECT s.key, s.value, CASE WHEN s.key=$1 THEN 0 WHEN s.key='agent:fast' THEN 1 ELSE 2 END AS priority
 FROM install_settings s WHERE (s.key=$1 OR ($2 AND s.key='agent:fast') OR ($3 AND s.key='agent:coding'))
 AND NOT (s.key='agent:fast' AND EXISTS (SELECT 1 FROM install_settings WHERE key='agent:fast.source' AND value='"coding"'::jsonb))
 ), eligible AS (
 SELECT value,priority FROM candidates WHERE key<>'agent:fast' OR EXISTS (
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

// AgentModelRun is an actual model receipt for a shared app-agent turn.
// Private conversations and unbound calls do not enter the team Agent card.
type AgentModelRun struct {
	ID    string `json:"id"`
	Model string `json:"model"`
}

func (q *Queries) RecentAppAgentRuns(ctx context.Context) ([]AgentModelRun, error) {
	runs := []AgentModelRun{}
	rows, err := q.db.Query(ctx, `SELECT t.run_id, u.model FROM model_usage u
 JOIN chat_turns t ON t.id=u.reference AND t.repository_id=u.repository_id
 WHERE u.source='app' AND u.repository_id=(SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository')
 AND t.request_payload->>'sharedConversation'='true'
 AND u.outcome IN ('pending','succeeded','unknown')
 ORDER BY u.created_at DESC,u.id DESC LIMIT 10`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var run AgentModelRun
		if err := rows.Scan(&run.ID, &run.Model); err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

// RecentFactoryAgentRuns projects only persisted, run-bound factory steps.
// Unattributed proxy calls and other repositories never become agent runs.
func (q *Queries) RecentFactoryAgentRuns(ctx context.Context, role string) ([]AgentModelRun, error) {
	runs := []AgentModelRun{}
	rows, err := q.db.Query(ctx, `SELECT run,model FROM (
 SELECT u.workflow_run_id::text AS run,u.model,u.created_at,u.id FROM model_usage u
 JOIN workflow_steps s ON s.id=u.workflow_step_id AND s.workflow_run_id=u.workflow_run_id AND s.repository_id=u.repository_id
 WHERE u.source='agent_run' AND s.name=CASE $1 WHEN 'planner' THEN 'coding/plan' WHEN 'implementer' THEN 'coding/implement' WHEN 'reviewer' THEN 'coding/review' ELSE '' END
 AND u.repository_id=(SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository')
 AND u.outcome IN ('pending','succeeded','unknown')
 UNION ALL
 SELECT b.binding_id,u.model,u.created_at,u.id FROM model_usage u
 JOIN flow_runtime_host_bindings b ON b.id::text=split_part(u.reference,'#',1) AND b.repository_id=u.repository_id AND b.workspace_id::text=u.workspace_id
 WHERE u.source='flow_host' AND split_part(u.reference,'#',2)=$1
 AND b.binding_kind='mythical-item'
 AND u.repository_id=(SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository')
 AND u.outcome IN ('pending','succeeded','unknown')
 ) receipts ORDER BY created_at DESC,id DESC LIMIT 10`, role)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var run AgentModelRun
		if err := rows.Scan(&run.ID, &run.Model); err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

// PinInstallSetting records immutable host bootstrap data in the existing
// install store. Concurrent starts agree on the first committed value.
func (q *Queries) PinInstallSetting(ctx context.Context, key string, value json.RawMessage) error {
	_, err := q.db.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, key, value)
	return err
}
