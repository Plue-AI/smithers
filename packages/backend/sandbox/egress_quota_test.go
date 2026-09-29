package sandbox

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEgressQuotaPolicySerializesForWorker(t *testing.T) {
	policy := EgressProxyPolicy{Enabled: true, Quota: &EgressQuota{BillingUserID: 42, DailyBytes: 10 << 30}}
	require.NoError(t, policy.Validate())
	encoded, err := json.Marshal(policy)
	require.NoError(t, err)
	assert.JSONEq(t, `{"enabled":true,"quota":{"billingUserId":42,"dailyBytes":10737418240}}`, string(encoded))

	var decoded EgressProxyPolicy
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	assert.Equal(t, policy.Quota, decoded.Quota)

	policy.Quota = nil
	encoded, err = json.Marshal(policy)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), `"quota"`)
}

func TestEgressQuotaPolicyRejectsInvalidGrant(t *testing.T) {
	for _, tc := range []struct {
		name  string
		quota EgressQuota
	}{
		{name: "missing user", quota: EgressQuota{DailyBytes: 1}},
		{name: "negative user", quota: EgressQuota{BillingUserID: -1, DailyBytes: 1}},
		{name: "below unlimited sentinel", quota: EgressQuota{BillingUserID: 42, DailyBytes: -2}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := EgressProxyPolicy{Enabled: true, Quota: &tc.quota}
			require.Error(t, policy.Validate())
		})
	}
	for _, bytes := range []int64{-1, 0, 1} {
		policy := EgressProxyPolicy{Enabled: true, Quota: &EgressQuota{BillingUserID: 42, DailyBytes: bytes}}
		require.NoError(t, policy.Validate())
	}
}
