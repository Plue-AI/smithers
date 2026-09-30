package compose

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestLogStartupConfig_TransportBranches(t *testing.T) {
	smtpCfg := &config.Config{}
	smtpCfg.Email.SMTPHost = "smtp.example.com"

	for _, tc := range []struct {
		name   string
		cfg    *config.Config
		expect string
	}{
		{"smtp", smtpCfg, `"email_transport":"smtp"`},
		{"disabled", &config.Config{}, `"email_transport":"disabled"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			prev := slog.Default()
			t.Cleanup(func() { slog.SetDefault(prev) })
			slog.SetDefault(middleware.NewServerLogger(&buf, "info"))
			logStartupConfig(tc.cfg)
			assert.Contains(t, buf.String(), tc.expect)
			var entry map[string]any
			require.NoError(t, json.Unmarshal(buf.Bytes(), &entry))
			assert.Equal(t, tc.name, entry["email_transport"])
			assert.Equal(t, "server configuration summary", entry["message"])
		})
	}
}
