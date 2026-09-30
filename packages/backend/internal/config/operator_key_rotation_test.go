package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoad_PreviousSecretEncryptionKeysEnv(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "new-key")
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS", " old-key , older-key ")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, []string{"old-key", "older-key"}, cfg.Webhook.PreviousKeys())
}

func TestWebhookPreviousKeys(t *testing.T) {
	t.Parallel()
	assert.Nil(t, WebhookConfig{}.PreviousKeys())
	assert.Nil(t, WebhookConfig{PreviousSecretEncryptionKeys: "  "}.PreviousKeys())
	assert.Equal(t, []string{"a"}, WebhookConfig{PreviousSecretEncryptionKeys: "a"}.PreviousKeys())
	assert.Equal(t, []string{"a", "", "b"}, WebhookConfig{PreviousSecretEncryptionKeys: "a,,b"}.PreviousKeys())
}

func TestValidateServerStartup_PreviousSecretEncryptionKeys(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, previous, want string }{
		{name: "none"},
		{name: "one", previous: "old-key"},
		{name: "several", previous: "old-key,older-key"},
		{name: "empty entry", previous: "old-key,,older-key", want: "must not hold an empty key"},
		{name: "trailing comma", previous: "old-key,", want: "must not hold an empty key"},
		{name: "repeats current", previous: "old-key, webhook-secret-key ", want: "must not repeat the current key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validStartupConfig()
			cfg.Webhook.PreviousSecretEncryptionKeys = tc.previous
			err := ValidateServerStartup(cfg)
			if tc.want == "" {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, tc.want)
			}
		})
	}
}
