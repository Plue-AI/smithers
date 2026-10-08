package machined

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

// noteConnectionKey carries the authenticated connection whose registry fence
// BurstIngest holds through commit. Do not re-enter Registry.Current or
// RequireReady here: those acquire that same fence.
type noteConnectionKey struct{}

// RegisteredCodingNoteHost qualifies only the installed coding artifact and
// an acknowledged daemon run registration. The installed artifact composes the
// durable notification consumer and daemon-backed std mutation provider; an
// older retained host must not inherit those capabilities from a new install.
// Selection reads the existing launch checkpoint and spawn receipt in the
// burst transaction. No host is started, and no guest claim grants authority.
type RegisteredCodingNoteHost struct{ ArtifactDigest string }

func (h *RegisteredCodingNoteHost) CodingNoteParticipant(ctx context.Context, tx pgx.Tx, branch, run string, pin flowruntime.Pin) (string, string, error) {
	connection, _ := ctx.Value(noteConnectionKey{}).(*Connection)
	if h == nil {
		return "", "", ErrNotReady
	}
	digest, err := hex.DecodeString(h.ArtifactDigest)
	if err != nil || len(digest) != 32 || tx == nil || connection == nil || !pin.Valid() || pin.Flow != flowdispatch.TodoFlow || run == "" {
		return "", "", ErrNotReady
	}
	if connection.boot.branch != branch || !connection.current() || connection.boot.link == nil {
		return "", "", ErrNotReady
	}
	var host, source, item string
	var repository, owner, generation int64
	var checkpointJSON, payloadJSON []byte
	rows, err := tx.Query(ctx, `SELECT h.id::text,h.source_revision,h.owner_generation,h.repository_id,h.user_id,
 i.id::text,d.external_receipt,r.payload
 FROM mythical_items i
 JOIN workspaces w ON w.id::text=i.workspace_id AND w.repository_id=i.repository_id
 JOIN flow_runtime_host_bindings h ON h.workspace_id=w.id AND h.repository_id=w.repository_id AND h.user_id=i.owner_id
 JOIN users u ON u.id=h.user_id
 JOIN collaborators c ON c.repository_id=h.repository_id AND c.user_id=h.user_id
 JOIN product_job_requests r ON r.tenant_id=h.tenant_id AND r.principal_id=h.principal_id
 JOIN product_job_dispatches d ON d.operation_id=r.id
 WHERE w.id=$1 AND w.vm_id=$2 AND w.kind='vm' AND w.status='running' AND w.deleted_at IS NULL
 AND i.state='running' AND i.request_run_id=$3 AND i.request_outcome=''
 AND h.binding_kind='mythical-item' AND h.binding_id=i.id::text
 AND h.tenant_id='repository:' || i.repository_id::text AND h.principal_id='user:' || i.owner_id::text
 AND h.catalog_key='coding' AND h.state='running' AND h.runtime_artifact_digest=$4
 AND c.suspended_at IS NULL AND c.permission IN ('write','admin') AND c.unix_uid>=20000
 AND u.is_active AND NOT u.prohibit_login AND u.deleted_at IS NULL
 AND r.operation=$5 AND r.state IN ('accepted','dispatching','running','waiting') AND NOT r.cancellation_requested
 AND d.external_receipt->>'runId'=$3
 FOR SHARE OF h,u,c,r`, branch, connection.boot.machine, run, h.ArtifactDigest, flowdispatch.OperationLaunch)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", "", err
		}
		return "", "", ErrNotReady
	}
	if err := rows.Scan(&host, &source, &generation, &repository, &owner, &item, &checkpointJSON, &payloadJSON); err != nil {
		return "", "", err
	}
	if rows.Next() {
		return "", "", ErrUnauthorized
	}
	if err := rows.Err(); err != nil {
		return "", "", err
	}
	rows.Close()
	var checkpoint flowdispatch.RuntimeCheckpoint
	var payload struct {
		Target flowruntime.Target `json:"target"`
		FlowID string             `json:"flowId"`
		Pin    *flowruntime.Pin   `json:"pin"`
	}
	target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repository), PrincipalID: fmt.Sprintf("user:%d", owner), WorkspaceID: branch, BindingKind: flowdispatch.StackBindingKind, BindingID: item}
	identity := flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: h.ArtifactDigest, SourceRevision: source, OwnerGeneration: generation}
	if json.Unmarshal(checkpointJSON, &checkpoint) != nil || json.Unmarshal(payloadJSON, &payload) != nil ||
		checkpoint.Version != 1 || checkpoint.PinRefused || checkpoint.FlowID != pin.Flow || checkpoint.RunID != run || checkpoint.Target != target ||
		checkpoint.ExecutionDigest != pin.ExecutionDigest || checkpoint.Identity != identity || payload.Target != target || payload.FlowID != pin.Flow || payload.Pin == nil || *payload.Pin != pin {
		return "", "", ErrNotReady
	}
	// The successful register_run acknowledgement is persisted by the same
	// authenticated admission as the spawn. It survives a host reconnect;
	// another boot or owner generation cannot reuse it.
	var recorded bool
	err = tx.QueryRow(ctx, `SELECT true FROM product_job_events opened
    JOIN product_job_events registered ON registered.principal_id=opened.principal_id
      AND registered.tenant_id=opened.tenant_id AND registered.event_type='branch.run_registered'
      AND registered.data->>'boot'=opened.data->>'boot'
      AND registered.data->>'session'=opened.data->>'session'
      AND registered.data->>'run'=$5
    WHERE opened.principal_id=$1 AND opened.tenant_id=$2 AND opened.event_type='branch.session_opened'
      AND opened.data->>'boot'=$3 AND opened.data->>'login'='agent' AND opened.data->>'uid'='19999'
      AND opened.data->>'via'=$4 AND opened.data->>'owner_generation'=$6 AND opened.data->>'member_id'=$7`,
		"branch:"+branch, fmt.Sprint(repository), hex.EncodeToString(connection.boot.id[:]), "agent:"+host, host, fmt.Sprint(generation), fmt.Sprint(owner)).Scan(&recorded)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotReady
	}
	if err != nil {
		return "", "", err
	}
	return "run:" + host, run, nil
}
