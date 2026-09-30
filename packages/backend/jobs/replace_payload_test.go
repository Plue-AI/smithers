package jobs

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestReplacePayloadKeepsFingerprintAndStateInStep(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	scope := Scope{TenantID: "repository:1", PrincipalID: "user:1"}
	receipt, err := store.Admit(ctx, testAdmission(scope, "replace-1", EffectUnsafe, `{"sealed":"old","n":1}`))
	require.NoError(t, err)
	before, err := store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)

	replaced, err := store.ReplacePayload(ctx, receipt.OperationID, json.RawMessage(`{"sealed":"stale","n":1}`), json.RawMessage(`{"sealed":"new","n":1}`))
	require.NoError(t, err)
	require.False(t, replaced, "a payload that changed since it was read is kept")

	replaced, err = store.ReplacePayload(ctx, receipt.OperationID, before.Payload, json.RawMessage(`{ "n": 1, "sealed": "new" }`))
	require.NoError(t, err)
	require.True(t, replaced)
	after, err := store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	canonical, err := canonicalJSON(json.RawMessage(`{"sealed":"new","n":1}`), false)
	require.NoError(t, err)
	require.Equal(t, payloadFingerprint(canonical), after.PayloadFingerprint)
	require.JSONEq(t, `{"sealed":"new","n":1}`, string(after.Payload))
	require.Equal(t, before.State, after.State)
	require.Equal(t, before.RequestReceipt, after.RequestReceipt)

	// Re-admitting the replaced payload joins the same request.
	joined, err := store.Admit(ctx, testAdmission(scope, "replace-1", EffectUnsafe, `{"n":1,"sealed":"new"}`))
	require.NoError(t, err)
	require.True(t, joined.Joined)
	require.Equal(t, receipt.OperationID, joined.OperationID)

	_, err = store.ReplacePayload(ctx, receipt.OperationID, after.Payload, nil)
	require.Error(t, err)
	_, err = store.ReplacePayload(ctx, "not-a-uuid", after.Payload, after.Payload)
	require.Error(t, err)
}
