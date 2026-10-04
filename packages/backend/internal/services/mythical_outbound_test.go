package services

import (
	"context"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

type outboundTestCredentials struct{}

func (outboundTestCredentials) Load(context.Context) (GitHubAppCredentials, error) {
	return GitHubAppCredentials{ID: 7}, nil
}
func (outboundTestCredentials) InstallURL(context.Context) (string, error) { return "", nil }
func (outboundTestCredentials) AppJWT(context.Context) (string, error)     { return "", nil }

func TestMythicalOutboundLegacyAndInvalidSlots(t *testing.T) {
	op, err := decodeMythicalOutbound([]byte(`{"branch":"smithers/issue-1","head":"new","expected":"old"}`))
	require.NoError(t, err)
	require.Equal(t, MythicalOutboundOp{Kind: "push", Target: "smithers/issue-1", Desired: "new", Precondition: "old", State: "unknown"}, op)
	for _, raw := range []string{`null`, `{`, `{}`, `{"kind":"labels"}`, `{"kind":"push","target":"x","desired":"y","state":"sent"}`, `{"kind":"push","desired":"y","state":"unknown"}`} {
		_, err := decodeMythicalOutbound([]byte(raw))
		require.Error(t, err, raw)
	}
}

func TestMythicalOutboundLookupResults(t *testing.T) {
	for _, kind := range []string{"push", "open", "body", "merge", "close"} {
		t.Run(kind, func(t *testing.T) {
			op := MythicalOutboundOp{Kind: kind, Desired: "new", Precondition: "old"}
			require.Equal(t, "done", outboundResult(op, "new", false))
			require.Equal(t, "intended", outboundResult(op, "old", false))
			require.Equal(t, "conflict", outboundResult(op, "foreign", false))
		})
	}
	require.Equal(t, "done", outboundResult(MythicalOutboundOp{Kind: "close", Desired: "closed", Precondition: "open"}, "open", true), "an App close followed by a human reopen never closes again")
}

func TestMythicalOutboundAbsentProvidersPreserveSlots(t *testing.T) {
	allow := func(context.Context, db.MythicalItem, string) error { return nil }
	for missing := 0; missing < 6; missing++ {
		t.Run([]string{"app", "lease", "budget", "membership", "authorization", "candidate"}[missing], func(t *testing.T) {
			guards := []func(context.Context, db.MythicalItem, string) error{allow, allow, allow, allow, allow, allow}
			guards[missing] = nil
			s := &MythicalService{outbound: MythicalOutboundProviders{CanonicalApp: guards[0], StackLease: guards[1], Budget: guards[2], Membership: guards[3], Authorization: guards[4], AcceptedGeneration: guards[5]}}
			for _, kind := range []string{"push", "open", "body", "merge", "close"} {
				slot := []byte(`{"kind":"` + kind + `","target":"x","desired":"new","precondition":"old","state":"unknown"}`)
				item := db.MythicalItem{PendingOp: slot}
				sends, reads := 0, 0
				s.outbound.Lookup = func(context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
					reads++
					return "old", false, nil
				}
				s.outbound.Send = func(context.Context, db.MythicalItem, MythicalOutboundOp) error { sends++; return nil }
				st := mythicalItemStep{s: s}
				_, err := st.recoverOutbound(context.Background(), item)
				require.Error(t, err)
				require.Equal(t, 1, reads)
				require.Zero(t, sends)
				require.Equal(t, slot, []byte(item.PendingOp))
			}
		})
	}
	s := &MythicalService{}
	st := mythicalItemStep{s: s}
	_, err := st.recoverOutbound(context.Background(), db.MythicalItem{PendingOp: []byte(`{"kind":"push","target":"x","desired":"new","state":"unknown"}`)})
	require.ErrorContains(t, err, "reconciliation")
	s.outbound.CanonicalApp = func(context.Context, db.MythicalItem, string) error { return errors.New("revoked") }
	require.ErrorContains(t, s.outboundReady(context.Background(), db.MythicalItem{}, "merge"), "revoked")
}

func TestMythicalOutboundMergeDecisionRequired(t *testing.T) {
	allow := func(context.Context, db.MythicalItem, string) error { return nil }
	s := &MythicalService{outbound: MythicalOutboundProviders{CanonicalApp: allow, StackLease: allow, Budget: allow, Membership: allow, Authorization: allow, AcceptedGeneration: allow}}
	sends := 0
	s.outbound.Lookup = func(context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
		return "old", false, nil
	}
	s.outbound.Send = func(context.Context, db.MythicalItem, MythicalOutboundOp) error { sends++; return nil }
	st := mythicalItemStep{s: s}
	item := db.MythicalItem{PendingOp: []byte(`{"kind":"merge","target":"1","desired":"head","precondition":"old","state":"unknown"}`)}
	_, err := st.recoverOutbound(context.Background(), item)
	require.ErrorContains(t, err, "merge readiness")
	require.Zero(t, sends)
	s.outbound.MergeDecision = func(context.Context, db.MythicalItem, MythicalOutboundOp) error {
		return errors.New("approver revoked")
	}
	_, err = st.recoverOutbound(context.Background(), item)
	require.ErrorContains(t, err, "approver revoked")
	require.Zero(t, sends)
	s.outbound.Lookup = func(context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
		return "head", false, nil
	}
	_, err = st.recoverOutbound(context.Background(), item)
	require.ErrorContains(t, err, "settlement integration", "applied merge needs projection, never a second send or old approval")
	require.Zero(t, sends)
}

func TestMythicalOutboundProposalRefusesBeforeResolve(t *testing.T) {
	// No run, store or token resolver exists: a missing provider must stop first.
	st := mythicalItemStep{s: &MythicalService{}}
	slot := []byte(`{"branch":"x","head":"new","expected":"old"}`)
	item := db.MythicalItem{PendingOp: slot, CandidateVerified: true, State: "proposing"}
	next, err := st.propose(context.Background(), item)
	require.NoError(t, err)
	require.NotNil(t, next)
	require.Equal(t, slot, []byte(next.PendingOp))
	require.Equal(t, "TODO publication is held until GitHub facts, own-push reconciliation and independent waits are available", next.Reason)
}
