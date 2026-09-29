package compose

import (
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

func TestChatMountBindsDeliveryToAuthenticationRevocationBus(t *testing.T) {
	previous := revocationChecker
	t.Cleanup(func() { revocationChecker = previous })
	bus := revocation.NewBus(nil, nil)
	revocationChecker = bus
	runtime := &chat.Runtime{Handler: &chat.Handler{}}
	mountChatPublic(chi.NewRouter(), runtime, nil, &config.Config{})
	require.Same(t, bus, runtime.Handler.Revocations,
		"chat deliveries must observe the same revocations as request authentication")
}
