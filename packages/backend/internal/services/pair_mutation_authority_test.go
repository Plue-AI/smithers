package services

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// pairWriteBarrierStore parks the first guarded write after the service has
// authorized the caller. A membership change that completes while the write is
// parked would let the write land on stale authority.
type pairWriteBarrierStore struct {
	PairSessionStore
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func (s *pairWriteBarrierStore) pause() {
	s.once.Do(func() {
		close(s.entered)
		<-s.release
	})
}

func (s *pairWriteBarrierStore) UpsertPairSessionDraft(ctx context.Context, arg db.UpsertPairSessionDraftParams) (db.PairSessionDraft, error) {
	s.pause()
	return s.PairSessionStore.UpsertPairSessionDraft(ctx, arg)
}

func (s *pairWriteBarrierStore) ClaimPairPrompt(ctx context.Context, arg db.ClaimPairPromptParams) (db.PairPromptQueue, error) {
	s.pause()
	return s.PairSessionStore.ClaimPairPrompt(ctx, arg)
}

func (s *pairWriteBarrierStore) StartPairPrompt(ctx context.Context, arg db.StartPairPromptParams) (db.PairPromptQueue, error) {
	s.pause()
	return s.PairSessionStore.StartPairPrompt(ctx, arg)
}

func (s *pairWriteBarrierStore) RenewPairPromptLease(ctx context.Context, arg db.RenewPairPromptLeaseParams) (db.PairPromptQueue, error) {
	s.pause()
	return s.PairSessionStore.RenewPairPromptLease(ctx, arg)
}

func (s *pairWriteBarrierStore) FinishPairPrompt(ctx context.Context, arg db.FinishPairPromptParams) (db.PairPromptQueue, error) {
	s.pause()
	return s.PairSessionStore.FinishPairPrompt(ctx, arg)
}

func (s *pairWriteBarrierStore) CancelOwnQueuedPairPrompt(ctx context.Context, arg db.CancelOwnQueuedPairPromptParams) (db.PairPromptQueue, error) {
	s.pause()
	return s.PairSessionStore.CancelOwnQueuedPairPrompt(ctx, arg)
}

func (s *pairWriteBarrierStore) CancelAnyPendingPairPrompt(ctx context.Context, arg db.CancelAnyPendingPairPromptParams) (db.PairPromptQueue, error) {
	s.pause()
	return s.PairSessionStore.CancelAnyPendingPairPrompt(ctx, arg)
}

func (s *pairWriteBarrierStore) RevokePairSessionLink(ctx context.Context, arg db.RevokePairSessionLinkParams) (db.PairSessionLink, error) {
	s.pause()
	return s.PairSessionStore.RevokePairSessionLink(ctx, arg)
}

func (s *pairWriteBarrierStore) CreatePairSessionInvite(ctx context.Context, arg db.CreatePairSessionInviteParams) (db.PairSessionInvite, error) {
	s.pause()
	return s.PairSessionStore.CreatePairSessionInvite(ctx, arg)
}

func (s *pairWriteBarrierStore) RevokePairSessionInvite(ctx context.Context, arg db.RevokePairSessionInviteParams) (db.PairSessionInvite, error) {
	s.pause()
	return s.PairSessionStore.RevokePairSessionInvite(ctx, arg)
}

func (s *pairWriteBarrierStore) RevokePairSessionInviteByUsername(ctx context.Context, arg db.RevokePairSessionInviteByUsernameParams) (db.PairSessionInvite, error) {
	s.pause()
	return s.PairSessionStore.RevokePairSessionInviteByUsername(ctx, arg)
}

// pairAuthorityCase is one Pair mutation. setup runs with full authority and
// returns the call; the call must succeed before the change and be refused
// after it.
type pairAuthorityCase struct {
	name    string
	byOwner bool
	// viewerAllowed marks mutations a viewer may still perform, so demotion is
	// not a loss of authority for them.
	viewerAllowed bool
	setup         func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, owner, editor int64, linkID string) func(*PairSessionService) error
}

func pairEditorPrompt(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, editor int64) string {
	t.Helper()
	prompt, err := svc.Enqueue(ctx, sessionID, editor, pairPromptSourceSolo, "editor prompt")
	require.NoError(t, err)
	return prompt.ID
}

var pairAuthorityCases = []pairAuthorityCase{
	{name: "put draft", setup: func(t *testing.T, ctx context.Context, _ *PairSessionService, sessionID string, _, editor int64, _ string) func(*PairSessionService) error {
		version := int64(0)
		return func(svc *PairSessionService) error {
			version++
			_, err := svc.PutDraft(ctx, sessionID, editor, "editor draft", version)
			return err
		}
	}},
	{name: "claim", setup: func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, _, editor int64, _ string) func(*PairSessionService) error {
		promptID := pairEditorPrompt(t, ctx, svc, sessionID, editor)
		return func(svc *PairSessionService) error {
			_, err := svc.Claim(ctx, sessionID, editor, promptID, "client", time.Minute)
			return err
		}
	}},
	{name: "start", setup: func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, _, editor int64, _ string) func(*PairSessionService) error {
		promptID := pairEditorPrompt(t, ctx, svc, sessionID, editor)
		_, err := svc.Claim(ctx, sessionID, editor, promptID, "client", time.Minute)
		require.NoError(t, err)
		return func(svc *PairSessionService) error {
			_, err := svc.Start(ctx, sessionID, editor, promptID, "client", "run-1")
			return err
		}
	}},
	{name: "renew", setup: func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, _, editor int64, _ string) func(*PairSessionService) error {
		promptID := pairEditorPrompt(t, ctx, svc, sessionID, editor)
		_, err := svc.Claim(ctx, sessionID, editor, promptID, "client", time.Minute)
		require.NoError(t, err)
		return func(svc *PairSessionService) error {
			_, err := svc.Renew(ctx, sessionID, editor, promptID, "client", time.Minute)
			return err
		}
	}},
	{name: "finish", setup: func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, _, editor int64, _ string) func(*PairSessionService) error {
		promptID := pairEditorPrompt(t, ctx, svc, sessionID, editor)
		_, err := svc.Claim(ctx, sessionID, editor, promptID, "client", time.Minute)
		require.NoError(t, err)
		_, err = svc.Start(ctx, sessionID, editor, promptID, "client", "run-1")
		require.NoError(t, err)
		return func(svc *PairSessionService) error {
			_, err := svc.Finish(ctx, sessionID, editor, promptID, "client", "done")
			return err
		}
	}},
	{name: "cancel own", viewerAllowed: true, setup: func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, _, editor int64, _ string) func(*PairSessionService) error {
		promptID := pairEditorPrompt(t, ctx, svc, sessionID, editor)
		return func(svc *PairSessionService) error {
			_, err := svc.Cancel(ctx, sessionID, editor, promptID)
			return err
		}
	}},
	{name: "cancel any", byOwner: true, setup: func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, owner, editor int64, _ string) func(*PairSessionService) error {
		promptID := pairEditorPrompt(t, ctx, svc, sessionID, editor)
		return func(svc *PairSessionService) error {
			_, err := svc.Cancel(ctx, sessionID, owner, promptID)
			return err
		}
	}},
	{name: "revoke link", byOwner: true, setup: func(_ *testing.T, ctx context.Context, _ *PairSessionService, sessionID string, owner, _ int64, linkID string) func(*PairSessionService) error {
		return func(svc *PairSessionService) error {
			return svc.RevokeLink(ctx, sessionID, owner, linkID)
		}
	}},
	{name: "create invite", byOwner: true, setup: func(_ *testing.T, ctx context.Context, _ *PairSessionService, sessionID string, owner, _ int64, _ string) func(*PairSessionService) error {
		return func(svc *PairSessionService) error {
			_, err := svc.CreateInvite(ctx, sessionID, owner, "guest@example.com", PairRoleViewer)
			return err
		}
	}},
	{name: "create username invite", byOwner: true, setup: func(_ *testing.T, ctx context.Context, _ *PairSessionService, sessionID string, owner, _ int64, _ string) func(*PairSessionService) error {
		return func(svc *PairSessionService) error {
			_, err := svc.CreateInviteByUsername(ctx, sessionID, owner, "guest-login", PairRoleViewer)
			return err
		}
	}},
	{name: "revoke invite", byOwner: true, setup: func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, owner, _ int64, _ string) func(*PairSessionService) error {
		_, err := svc.CreateInvite(ctx, sessionID, owner, "guest@example.com", PairRoleViewer)
		require.NoError(t, err)
		return func(svc *PairSessionService) error {
			return svc.RevokeInvite(ctx, sessionID, owner, "guest@example.com")
		}
	}},
	{name: "revoke username invite", byOwner: true, setup: func(t *testing.T, ctx context.Context, svc *PairSessionService, sessionID string, owner, _ int64, _ string) func(*PairSessionService) error {
		_, err := svc.CreateInviteByUsername(ctx, sessionID, owner, "guest-login", PairRoleViewer)
		require.NoError(t, err)
		return func(svc *PairSessionService) error {
			return svc.RevokeInviteByUsername(ctx, sessionID, owner, "guest-login")
		}
	}},
}

// pairMutationLockWaiting reports whether another backend waits on the
// session's pair-session mutation lock.
func pairMutationLockWaiting(ctx context.Context, fx pairFixture, sessionID string) bool {
	var waiting bool
	err := fx.pool.QueryRow(ctx, `SELECT EXISTS (
      SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = current_database() AND l.locktype = 'advisory'
        AND l.mode = 'ExclusiveLock' AND NOT l.granted
        AND l.classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
        AND l.objid = (hashtext($1)::bigint & 4294967295)::oid AND l.objsubid = 1
     )`, "pair-session:"+sessionID).Scan(&waiting)
	return err == nil && waiting
}

// TestPairMutationsRecheckAuthorityAtWriteTime removes the actor's authority
// while each Pair mutation is parked between its role check and its write. The
// change must wait for the mutation (authorized at that time) and every retry
// after the change must be refused without writing.
func TestPairMutationsRecheckAuthorityAtWriteTime(t *testing.T) {
	for _, tc := range pairAuthorityCases {
		changes := []string{"revoke", "demote", "end"}
		if tc.byOwner {
			// The owner cannot be removed or demoted; ending is its only loss of authority.
			changes = []string{"end"}
		} else if tc.viewerAllowed {
			changes = []string{"revoke", "end"}
		}
		for _, change := range changes {
			t.Run(tc.name+"/"+change, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				fx := newPairFixture(t)
				owner := mkPairUser(t, fx.pool, "authority-owner")
				editor := mkPairUser(t, fx.pool, "authority-editor")
				ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
				svc := newPairService(fx, map[int64]bool{owner: true, editor: true}, false, nil)
				session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
				require.NoError(t, err)
				link, err := svc.MintLink(ctx, session.ID, owner, PairRoleEditor)
				require.NoError(t, err)
				_, err = svc.ResolveByLink(ctx, link.Slug, editor)
				require.NoError(t, err)

				call := tc.setup(t, ctx, svc, session.ID, owner, editor, link.ID)
				barrier := &pairWriteBarrierStore{PairSessionStore: fx.store, entered: make(chan struct{}), release: make(chan struct{})}
				parked := NewPairSessionService(barrier, &stubBilling{paid: map[int64]bool{owner: true, editor: true}}, &stubForker{pool: fx.pool, repoID: fx.repoID},
					PairSessionServiceConfig{EmailFrom: "pair@smithers.sh", InviteBaseURL: "https://smithers.sh", TxBeginner: fx.pool})

				mutation := make(chan error, 1)
				go func() { mutation <- call(parked) }()
				released := false
				defer func() {
					if !released {
						close(barrier.release)
					}
				}()
				select {
				case <-barrier.entered:
				case err := <-mutation:
					t.Fatalf("mutation never reached its write: %v", err)
				case <-ctx.Done():
					t.Fatal("mutation never reached its write")
				}

				changed := make(chan error, 1)
				go func() {
					switch change {
					case "revoke":
						changed <- svc.RevokeMember(ctx, session.ID, owner, editor)
					case "demote":
						_, err := svc.SetMemberRole(ctx, session.ID, owner, editor, PairRoleViewer)
						changed <- err
					default:
						changed <- svc.EndSession(ctx, session.ID, owner)
					}
				}()
				require.Eventually(t, func() bool {
					select {
					case err := <-changed:
						changed <- err
						return true
					default:
						return pairMutationLockWaiting(ctx, fx, session.ID)
					}
				}, 5*time.Second, 10*time.Millisecond, "authority change neither waited nor finished")
				select {
				case err := <-changed:
					t.Fatalf("%s completed while an authorized write was still pending (err=%v)", change, err)
				default:
				}

				close(barrier.release)
				released = true
				require.NoError(t, <-mutation, "the write authorized before the change must land")
				require.NoError(t, <-changed)

				err = call(svc)
				require.Error(t, err, "a write after the change must be refused")
				if change == "end" {
					require.Equal(t, 404, httpStatus(err), "ended session must reject the write")
				} else {
					require.Equal(t, 403, httpStatus(err), "revoked or demoted editor must not write")
				}
			})
		}
	}
}
