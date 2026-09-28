package credits_test

import (
	"math"
	"strconv"
	"testing"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/stretchr/testify/require"
)

func TestNanosFromCentsBoundaries(t *testing.T) {
	const largestSafeCents int64 = 922_337_203_685
	for _, tc := range []struct {
		name  string
		cents int64
		want  int64
	}{
		{"zero", 0, 0},
		{"one cent", 1, 10_000_000},
		{"dollar and a cent", 101, 1_010_000_000},
		{"largest safe", largestSafeCents, 9_223_372_036_850_000_000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := credits.NanosFromCents(tc.cents)
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
	for _, cents := range []int64{-1, math.MinInt64, 922_337_203_686, math.MaxInt64} {
		t.Run(strconv.FormatInt(cents, 10), func(t *testing.T) {
			got, err := credits.NanosFromCents(cents)
			require.Zero(t, got)
			require.EqualError(t, err, "credits: cents cannot be represented as non-negative nanos")
		})
	}
}
