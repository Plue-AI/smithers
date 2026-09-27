package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestIssueSyncWakeIsOwnerScoped(t *testing.T) {
	for _, payload := range []string{"sync:7", "sync:8", "123", "sync:07", ""} {
		event, ok := issueSyncWake(7)(sse.Event{Data: payload})
		require.Equal(t, payload == "sync:7", ok)
		if ok {
			require.Equal(t, "issue.sync", event.Type)
			require.Equal(t, "{}", event.Data)
			require.Empty(t, event.ID)
		}
	}
}
