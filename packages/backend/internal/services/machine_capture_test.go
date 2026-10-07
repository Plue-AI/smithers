package services

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

func TestPendingCaptureDoesNotRetryOrAcceptOldVerification(t *testing.T) {
	for _, state := range []string{"integrating", "verifying", "proposing", "waiting", "proposed"} {
		t.Run(state, func(t *testing.T) {
			item := db.MythicalItem{Source: "todo", State: state, Attempt: 3, Generation: 9, CandidateHead: strings.Repeat("a", 40), CandidateBase: strings.Repeat("b", 40), VerifyOutcome: "passed", RequestRunID: "same-run"}
			item.Checks = mythicalChecks{Todo: true, Capture: &MachineCapturePending{Head: strings.Repeat("c", 40), Tree: strings.Repeat("d", 40), Base: strings.Repeat("a", 40), Onto: strings.Repeat("c", 40)}}.encode()
			original := item
			// No launch, host or GitHub providers: pending capture must not attempt any.
			step := new(mythicalItemStep)
			next, saved, err := step.advance(t.Context(), item)
			require.NoError(t, err)
			require.Nil(t, next)
			require.False(t, saved)
			require.Equal(t, original, item)
		})
	}
}

func TestPendingCaptureBlocksMergeDespiteLateCandidateResult(t *testing.T) {
	head := strings.Repeat("a", 40)
	item := db.MythicalItem{State: "proposed", PRNumber: pgtype.Int8{Int64: 1, Valid: true}, PRState: "open", PRHead: head, CandidateVerified: true, Checks: mythicalChecks{Todo: true}.encode()}
	require.NoError(t, mythicalMergeReady(item, 0, head, false))
	item.Checks = mythicalChecks{Todo: true, Capture: &MachineCapturePending{Head: strings.Repeat("b", 40)}}.encode()
	for _, verified := range []bool{false, true} {
		item.CandidateVerified = verified
		err := mythicalMergeReady(item, 0, head, false)
		var refusal *TodoControlError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, "pending_work", refusal.Code)
	}
}
