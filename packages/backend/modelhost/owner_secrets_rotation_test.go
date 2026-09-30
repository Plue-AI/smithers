package modelhost_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/modelhost"
)

// A credential saved before an operator key rotation still resolves while
// the replaced key is configured as previous, and only then.
func TestResolveChatModelAcrossOperatorKeyRotation(t *testing.T) {
	f := newOwnerModelsFixture(t)
	require.Equal(t, true, f.credential(t, "enroll", "enroll-rotation", "OPENAI_API_KEY", "https://api.openai.com", "owner-key")["ok"])
	request, err := json.Marshal(map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "m", "credential": "OPENAI_API_KEY"}})
	require.NoError(t, err)

	rotated, err := modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return "rotated-operator-key" },
		modelhost.WithPreviousSecretKeys(func() string { return "unrelated-key, " + ownerModelsSecretKey }))
	require.NoError(t, err)
	t.Cleanup(rotated.Close)
	binding, err := rotated.ResolveChatModel(context.Background(), f.owner, 0, request)
	require.NoError(t, err)
	require.Equal(t, "owner-key", binding.CredentialValue)

	retired, err := modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return "rotated-operator-key" })
	require.NoError(t, err)
	t.Cleanup(retired.Close)
	_, err = retired.ResolveChatModel(context.Background(), f.owner, 0, request)
	require.Error(t, err, "without the replaced key the credential does not open")
	require.NotContains(t, err.Error(), "owner-key")

	_, err = modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return "k" }, modelhost.WithPreviousSecretKeys(nil))
	require.Error(t, err)
	malformed, err := modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return "rotated-operator-key" },
		modelhost.WithPreviousSecretKeys(func() string { return ownerModelsSecretKey + ",," }))
	require.NoError(t, err)
	t.Cleanup(malformed.Close)
	_, err = malformed.ResolveChatModel(context.Background(), f.owner, 0, request)
	require.ErrorContains(t, err, "previous secret encryption key is empty")
}
