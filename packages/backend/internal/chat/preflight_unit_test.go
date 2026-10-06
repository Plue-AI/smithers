package chat

import (
	"encoding/json"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

const literalPreflight = `{"runId":"run","type":"context.preflight","result":{"context":[{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123","reason":"Retry code"}],"candidates":[{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123"}],"model":"owner-fast","durationMs":12}}`

func TestContextPreflightJournalEnvelope(t *testing.T) {
	_, err := validateFrames([]json.RawMessage{json.RawMessage(literalPreflight)}, "run")
	require.NoError(t, err)
	for _, invalid := range []string{
		strings.Replace(literalPreflight, `"type":"context.preflight"`, `"type":"context.preflight","phase":"unknown"`, 1),
		strings.Replace(literalPreflight, `"reason":"Retry code"`, `"reason":null`, 1),
		strings.Replace(literalPreflight, `"label":"retry.ts"`, `"label":null`, 1),
		strings.Replace(literalPreflight, `"durationMs":12`, `"durationMs":-1`, 1),
		strings.Replace(literalPreflight, `"model":"owner-fast"`, `"model":""`, 1),
	} {
		_, err := validateFrames([]json.RawMessage{json.RawMessage(invalid)}, "run")
		require.ErrorIs(t, err, ErrInvalidFrame)
	}
}
