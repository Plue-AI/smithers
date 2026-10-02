package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOAuth2IssuanceRejectsRetiredClientsBeforeStoreAccess(t *testing.T) {
	svc := NewOAuth2Service(nil)
	for _, id := range []string{"historical-third-party", "", FirstPartyClientID + "-spoof"} {
		_, err := svc.AuthorizeGrant(context.Background(), OAuth2AuthorizeInput{ClientID: id})
		require.Equal(t, 401, httpStatus(err))
		_, err = svc.ExchangeCode(context.Background(), id, "old-secret", "old-code", "https://example.test/callback", "verifier")
		require.Equal(t, 401, httpStatus(err))
		_, err = svc.RefreshToken(context.Background(), id, "old-secret", "old-refresh")
		require.Equal(t, 401, httpStatus(err))
	}
}
