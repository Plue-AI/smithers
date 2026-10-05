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
				state := "unknown"
				if kind == "merge" {
					// A sent merge meets no guard: lookup alone settles it
					// (TestMythicalOutboundMergeDecisionRequired).
					state = "intended"
				}
				slot := []byte(`{"kind":"` + kind + `","target":"x","desired":"new","precondition":"old","state":"` + state + `"}`)
				item := db.MythicalItem{PendingOp: slot}
				sends, reads := 0, 0
				s.outbound.Lookup = func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
					reads++
					return "old", false, nil
				}
				s.outbound.Send = func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) error {
					sends++
					return nil
				}
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
	sends, decisions := 0, 0
	observed := "old"
	s.outbound.Lookup = func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
		return observed, false, nil
	}
	s.outbound.Send = func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) error {
		sends++
		return nil
	}
	st := mythicalItemStep{s: s}
	// A merge never sent needs a fresh decision before any send.
	intended := db.MythicalItem{PendingOp: []byte(`{"kind":"merge","target":"1","desired":"head","precondition":"old","state":"intended"}`)}
	_, err := st.recoverOutbound(context.Background(), intended)
	require.ErrorContains(t, err, "merge readiness")
	require.Zero(t, sends)
	s.outbound.MergeDecision = func(context.Context, db.MythicalItem, MythicalOutboundOp) error {
		decisions++
		return errors.New("approver revoked")
	}
	_, err = st.recoverOutbound(context.Background(), intended)
	require.ErrorContains(t, err, "approver revoked")
	require.Zero(t, sends)
	// A sent merge GitHub still shows open is neither decided nor sent again.
	sent := db.MythicalItem{PendingOp: []byte(`{"kind":"merge","target":"1","desired":"head","precondition":"old","state":"unknown"}`)}
	decisions = 0
	next, err := st.recoverOutbound(context.Background(), sent)
	require.NoError(t, err)
	require.Equal(t, sent.PendingOp, next.PendingOp)
	require.Zero(t, decisions)
	require.Zero(t, sends)
	// GitHub shows it merged: settlement, never a second send or an old approval.
	observed = "head"
	_, err = st.recoverOutbound(context.Background(), sent)
	require.ErrorContains(t, err, "settlement integration")
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
	require.Equal(t, "TODO publication is held until the install composes its GitHub App publication", next.Reason)
}

func TestMythicalOutboundDroppedProposalOnlyReconciles(t *testing.T) {
	for _, state := range []string{"cancelled", "dropped"} {
		for _, kind := range []string{"push", "open", "body"} {
			t.Run(state+"/"+kind, func(t *testing.T) {
				slot := []byte(`{"kind":"` + kind + `","target":"x","desired":"new","precondition":"old","state":"unknown"}`)
				reads, sends := 0, 0
				s := &MythicalService{outbound: MythicalOutboundProviders{
					Lookup: func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
						reads++
						return "old", false, nil
					},
					Send: func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) error {
						sends++
						return nil
					},
				}}
				st := mythicalItemStep{s: s}
				item := db.MythicalItem{State: state, PendingOp: slot}
				_, err := st.recoverOutbound(context.Background(), item)
				require.ErrorContains(t, err, "dropped proposal cannot be repeated")
				require.Equal(t, 1, reads)
				require.Zero(t, sends)
				require.Equal(t, slot, []byte(item.PendingOp))
			})
		}
	}
}

func TestMythicalOutboundSettlementRequiredBeforeRepeat(t *testing.T) {
	allow := func(context.Context, db.MythicalItem, string) error { return nil }
	for _, kind := range []string{"open", "body", "merge", "close"} {
		t.Run(kind, func(t *testing.T) {
			sends := 0
			s := &MythicalService{outbound: MythicalOutboundProviders{
				CanonicalApp: allow, StackLease: allow, Budget: allow, Membership: allow, Authorization: allow, AcceptedGeneration: allow,
				MergeDecision: func(context.Context, db.MythicalItem, MythicalOutboundOp) error { return nil },
				Lookup: func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
					return "old", false, nil
				},
				Send: func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) error {
					sends++
					return nil
				},
			}}
			st := mythicalItemStep{s: s}
			state := "unknown"
			if kind == "merge" {
				// A sent merge is never repeated; a never-sent one is the
				// case that would send.
				state = "intended"
			}
			slot := []byte(`{"kind":"` + kind + `","target":"1","desired":"new","precondition":"old","state":"` + state + `"}`)
			item := db.MythicalItem{PendingOp: slot}
			_, err := st.recoverOutbound(context.Background(), item)
			require.ErrorContains(t, err, "settlement integration")
			require.Zero(t, sends)
			require.Equal(t, slot, []byte(item.PendingOp))
		})
	}
}

func TestMythicalOutboundSettlementCannotResurrectDrop(t *testing.T) {
	for _, state := range []string{"cancelled", "dropped"} {
		t.Run(state, func(t *testing.T) {
			s := &MythicalService{outbound: MythicalOutboundProviders{
				Settle: func(_ *mythicalItemStep, _ context.Context, item db.MythicalItem, _ MythicalOutboundOp) (db.MythicalItem, error) {
					item.State = "proposed"
					return item, nil
				},
			}}
			st := mythicalItemStep{s: s}
			item := db.MythicalItem{State: state, PendingOp: []byte(`{"kind":"open","target":"x","desired":"head","state":"done"}`)}
			_, err := st.recoverOutbound(context.Background(), item)
			require.ErrorContains(t, err, "changed dropped item state")
			require.Equal(t, state, item.State)
			require.NotEmpty(t, item.PendingOp)
		})
	}
}

func TestMythicalOutboundOpenRequiresRecoveryBeforeGitHub(t *testing.T) {
	allow := func(context.Context, db.MythicalItem, string) error { return nil }
	shape := mythicalPRShape{Branch: "smithers/test", Title: "Test", Prompt: "Prompt", Acceptance: "Acceptance", Evidence: "Evidence", DiffStat: "1 file", Review: "Reviewed", URL: "http://localhost/todos/1", Owner: "ben", First: true}
	for _, missing := range []string{"lookup", "settlement"} {
		t.Run(missing, func(t *testing.T) {
			s := &MythicalService{outbound: MythicalOutboundProviders{
				CanonicalApp: allow, StackLease: allow, Budget: allow, Membership: allow, Authorization: allow, AcceptedGeneration: allow,
				Lookup: func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
					t.Fatal("unexpected lookup")
					return "", false, nil
				},
				Settle: func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (db.MythicalItem, error) {
					t.Fatal("unexpected settlement")
					return db.MythicalItem{}, nil
				},
			}}
			if missing == "lookup" {
				s.outbound.Lookup = nil
			} else {
				s.outbound.Settle = nil
			}
			// No GitHub client or database: refusal must precede both boundaries.
			st := mythicalItemStep{s: s, prShape: &shape}
			_, err := st.openPull(context.Background(), db.MythicalItem{}, mythicalGitHubRepo{}, "smithers/test")
			require.ErrorContains(t, err, "reconciliation and settlement integration")
		})
	}
}
