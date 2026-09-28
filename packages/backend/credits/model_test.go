package credits

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/modelprice"
)

func TestPricedModelCallRejectsInvalidBoundsBeforeDatabase(t *testing.T) {
	l := Ledger{}
	for _, tc := range []struct {
		name    string
		model   string
		maximum modelprice.Usage
		want    string
	}{
		{name: "unknown model", model: "not-offered", maximum: modelprice.Usage{InputTokens: 1}, want: "not offered"},
		{name: "negative token ceiling", model: "gpt-oss-120b", maximum: modelprice.Usage{InputTokens: -1}, want: "negative model usage"},
		{name: "zero cost ceiling", model: "gpt-oss-120b", want: "bound must be positive"},
		{name: "cost overflow", model: "gpt-oss-120b", maximum: modelprice.Usage{InputTokens: math.MaxInt64, OutputTokens: math.MaxInt64}, want: "model cost overflow"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			r, err := l.ExecutePricedModelCall(context.Background(), 41, "key", tc.model, tc.maximum, func(context.Context) (ModelOutcome, modelprice.Usage, error) {
				called = true
				return ModelSucceeded, modelprice.Usage{}, nil
			})
			if err == nil || !strings.Contains(err.Error(), tc.want) || called || r.AccountID != 41 || r.ID != 0 {
				t.Fatalf("reservation=%+v err=%v provider called=%t, want %q", r, err, called, tc.want)
			}
		})
	}
}

func TestPricedModelCallConvertsProviderOutcomes(t *testing.T) {
	l, id := testLedger(t)
	ctx := context.Background()
	if err := l.Grant(ctx, id, "funding", 5_000_000, nil); err != nil {
		t.Fatal(err)
	}
	maximum := modelprice.Usage{InputTokens: 1000, OutputTokens: 1000}
	const bound int64 = 1_100_000
	providerErr := errors.New("provider failed")
	failed, err := l.ExecutePricedModelCall(ctx, id, "failed", "gpt-oss-120b", maximum,
		func(context.Context) (ModelOutcome, modelprice.Usage, error) {
			return ModelFailed, modelprice.Usage{InputTokens: -1}, providerErr
		})
	if !errors.Is(err, providerErr) || failed.Status != "released" || failed.ChargedNanos != 0 {
		t.Fatalf("failed result=%+v err=%v", failed, err)
	}
	unknown, err := l.ExecutePricedModelCall(ctx, id, "unknown", "gpt-oss-120b", maximum,
		func(context.Context) (ModelOutcome, modelprice.Usage, error) {
			return ModelUnknown, modelprice.Usage{}, providerErr
		})
	if !errors.Is(err, ErrOutcomeUnknown) || !errors.Is(err, providerErr) || unknown.ChargedNanos != bound {
		t.Fatalf("unknown result=%+v err=%v", unknown, err)
	}
	invalidUsage, err := l.ExecutePricedModelCall(ctx, id, "invalid-usage", "gpt-oss-120b", maximum,
		func(context.Context) (ModelOutcome, modelprice.Usage, error) {
			return ModelSucceeded, modelprice.Usage{OutputTokens: -1}, nil
		})
	if !errors.Is(err, ErrOutcomeUnknown) || !strings.Contains(err.Error(), "negative model usage") || invalidUsage.ChargedNanos != bound {
		t.Fatalf("invalid usage result=%+v err=%v", invalidUsage, err)
	}
	mustBalance(t, l, id, 5_000_000-2*bound)
}
