package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestEmailInstallQueuedVerificationPostgres(t *testing.T) {
	for _, scenario := range []string{"live", "expired", "revoked", "deleted address"} {
		t.Run(scenario, func(t *testing.T) {
			f := newConfirmationFixture(t)
			receipt := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d,"last_access_check_at":%q}`, f.repo, time.Now().UTC().Format(time.RFC3339))
			require.NoError(t, f.q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(receipt)}))
			owner, err := f.q.GetUserByLowerUsername(t.Context(), "maya")
			require.NoError(t, err)
			ctx := f.session(owner, "email-owner")
			var commands []string
			ctx = WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
			mailbox := &email.NoopTransport{}
			service := NewEmailService(f.q, mailbox, testEmailServiceConfig(), WithEmailInstallAuthorization(f.pool))
			address, err := service.AddEmail(ctx, owner.ID, AddEmailRequest{Email: "owner@example.test"})
			require.NoError(t, err)
			require.Equal(t, []string{"account.email.add"}, commands)
			commands = nil
			var pending func()
			service.spawn = func(deliver func()) { require.Nil(t, pending); pending = deliver }
			require.NoError(t, service.RequestVerification(ctx, owner.ID, address.ID))
			require.NotNil(t, pending)
			require.Empty(t, mailbox.Sent)
			require.Equal(t, 1, f.count("email_verification_tokens"))
			require.Equal(t, []string{"account.email.verify"}, commands)
			info := middleware.AuthInfoFromContext(ctx)
			switch scenario {
			case "expired":
				f.exec(`UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, info.SessionHash)
			case "revoked":
				f.exec(`DELETE FROM auth_sessions WHERE session_key=$1`, info.SessionHash)
			case "deleted address":
				require.NoError(t, f.q.DeleteEmail(t.Context(), db.DeleteEmailParams{ID: address.ID, UserID: owner.ID}))
			}
			pending()
			require.Equal(t, []string{"account.email.verify"}, commands)
			if scenario == "live" {
				require.Len(t, mailbox.Sent, 1)
				require.Equal(t, []string{"owner@example.test"}, mailbox.Sent[0].To)
			} else {
				require.Empty(t, mailbox.Sent)
			}
			// A direct service call cannot borrow an account id without authentication.
			_, err = service.AddEmail(context.Background(), owner.ID, AddEmailRequest{Email: "unbound@example.test"})
			var denied *AccessError
			require.ErrorAs(t, err, &denied)
			require.Equal(t, 401, denied.Status)
		})
	}
}
