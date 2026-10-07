package services

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConflictAttemptLimit(t *testing.T) {
	for _, tc := range []struct {
		config string
		limit  int
	}{
		{`{}`, 1}, {`{"conflictAttempts":0}`, 0},
		{`{"conflictAttempts":1}`, 1}, {`{"conflictAttempts":8}`, 8},
	} {
		t.Run(tc.config, func(t *testing.T) {
			limit, err := conflictAttemptLimit([]byte(tc.config))
			require.NoError(t, err)
			require.Equal(t, tc.limit, limit)
		})
	}
	for _, raw := range []string{`null`, `[]`, `{`, `{"conflictAttempts":null}`, `{"conflictAttempts":-1}`, `{"conflictAttempts":9}`, `{"conflictAttempts":1.5}`, `{"conflictAttempts":"1"}`, `{"conflictAttempts":true}`} {
		t.Run(raw, func(t *testing.T) {
			_, err := conflictAttemptLimit([]byte(raw))
			require.Error(t, err)
		})
	}
}
