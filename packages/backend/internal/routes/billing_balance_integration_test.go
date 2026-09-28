package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func TestBalanceReflectsSettledCharges(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var userID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ('balance-test', 'balance-test', 'balance-test@example.com', 'balance-test@example.com', 'Balance Test') RETURNING id`).Scan(&userID))
	ledger := credits.Ledger{DB: pool}
	accountID, err := ledger.EnsureAccount(ctx, "user", userID)
	require.NoError(t, err)
	require.NoError(t, ledger.Grant(ctx, accountID, "intro", 2_000_000_000, nil))
	handler := BillingHandler{Service: services.NewBillingService(db.New(pool), nil, services.BillingServiceConfig{}, services.WithBillingCreditLedger(ledger))}
	balance := func(total, charged string, count float64) {
		t.Helper()
		rec := httptest.NewRecorder()
		handler.GetUserBalance(rec, withAuth(httptest.NewRequest(http.MethodGet, "/api/billing/balance", nil), userID, "balance-test"))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body struct {
			Balance struct {
				TotalUsd           string  `json:"totalUsd"`
				LifetimeChargedUsd string  `json:"lifetimeChargedUsd"`
				ChargeCount        float64 `json:"chargeCount"`
			} `json:"balance"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Equal(t, total, body.Balance.TotalUsd)
		require.Equal(t, charged, body.Balance.LifetimeChargedUsd)
		require.Equal(t, count, body.Balance.ChargeCount)
	}
	balance("2.00", "0.00", 0)
	_, err = ledger.Reserve(ctx, accountID, "released", 100)
	require.NoError(t, err)
	balance("2.00", "0.00", 0)
	_, err = ledger.Release(ctx, accountID, "released")
	require.NoError(t, err)
	_, err = ledger.Reserve(ctx, accountID, "settled", 1_000_000_000)
	require.NoError(t, err)
	balance("1.00", "0.00", 0)
	_, err = ledger.Settle(ctx, accountID, "settled", 1_000_000_000)
	require.NoError(t, err)
	balance("1.00", "1.00", 1)
	_, err = ledger.Settle(ctx, accountID, "settled", 1_000_000_000)
	require.NoError(t, err)
	balance("1.00", "1.00", 1)
}
