package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// retiringGateways models the deployment's repo_gateways table: a tombstone
// keeps a box-bound row's credential until the verified stop clears it.
type retiringGateways struct {
	mu      sync.Mutex
	rows    map[string]*runtimeports.RepoGateway
	listErr error
	touched []string
}

func newRetiringGateways(rows ...runtimeports.RepoGateway) *retiringGateways {
	store := &retiringGateways{rows: map[string]*runtimeports.RepoGateway{}}
	for index := range rows {
		row := rows[index]
		store.rows[row.ID] = &row
	}
	return store
}

func (s *retiringGateways) list(match func(runtimeports.RepoGateway) bool) []runtimeports.RepoGateway {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []runtimeports.RepoGateway
	for _, row := range s.rows {
		if match(*row) {
			out = append(out, *row)
		}
	}
	return out
}

func (s *retiringGateways) ListActiveRepoGateways(context.Context) ([]runtimeports.RepoGateway, error) {
	return s.list(func(row runtimeports.RepoGateway) bool {
		return !row.DeletedAt.Valid && (row.Status == "running" || row.Status == "suspended")
	}), s.listErr
}

func (s *retiringGateways) ListStaleRepoGateways(_ context.Context, age int64) ([]runtimeports.RepoGateway, error) {
	if age != 0 {
		return nil, errors.New("the retirement lists every unfinished row")
	}
	return s.list(func(row runtimeports.RepoGateway) bool {
		return !row.DeletedAt.Valid && (row.Status == "pending" || row.Status == "starting" || row.Status == "failed")
	}), nil
}

func (s *retiringGateways) SoftDeleteRepoGateway(_ context.Context, id string) (runtimeports.RepoGateway, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.rows[id]
	row.DeletedAt, row.Status = pgtype.Timestamptz{Time: time.Now(), Valid: true}, "stopped"
	return *row, nil
}

func (s *retiringGateways) ListPendingWorkspaceGatewayCleanup(context.Context) ([]runtimeports.RepoGateway, error) {
	return s.list(func(row runtimeports.RepoGateway) bool {
		return row.WorkspaceID.Valid && row.DeletedAt.Valid && row.AuthTokenHash != ""
	}), nil
}

func (s *retiringGateways) TouchDiscardedWorkspaceGatewayCleanup(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.touched = append(s.touched, id)
	return nil
}

func (s *retiringGateways) ClearDiscardedWorkspaceGatewayCredential(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows[id].AuthTokenHash, s.rows[id].LandingTokenID = "", pgtype.Int8{}
	return nil
}

type retiringBoxes struct {
	mu       sync.Mutex
	commands map[string][]string
	revoked  []string
	deleted  []string
	execErr  error
	status   int32
}

func (b *retiringBoxes) Execute(_ context.Context, vmID string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.commands == nil {
		b.commands = map[string][]string{}
	}
	b.commands[vmID] = append(b.commands[vmID], request.Command)
	status := b.status
	return sandbox.ExecResult{StatusCode: &status}, b.execErr
}

func (b *retiringBoxes) RevokeIngress(_ context.Context, domain string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.revoked = append(b.revoked, domain)
	return nil
}

func (b *retiringBoxes) DeleteSandbox(_ context.Context, vmID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.deleted = append(b.deleted, vmID)
	return nil
}

type retiringTokens struct {
	tokens  []db.AccessToken
	deleted []int64
}

func (t *retiringTokens) CreateAccessToken(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
	return db.AccessToken{}, errors.New("the retirement never mints")
}

func (t *retiringTokens) DeleteAccessToken(_ context.Context, arg db.DeleteAccessTokenParams) error {
	t.deleted = append(t.deleted, arg.ID)
	return nil
}

func (t *retiringTokens) ListAccessTokensByUserID(context.Context, int64) ([]db.AccessToken, error) {
	return t.tokens, nil
}

func boxGateway(id, status string) runtimeports.RepoGateway {
	return runtimeports.RepoGateway{ID: id, UserID: 7, RepositoryID: 3, VmID: "vm-box",
		WorkspaceID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, AuthTokenHash: "hash", Status: status}
}

// A running box gateway is tombstoned, its service stopped and disabled on the
// box, its ingress unmapped and its landing and model credentials revoked;
// only then is its credential marker cleared. The next sweep finds nothing.
func TestRepoGatewayRetirementStopsABoxGatewayAndItsCredentials(t *testing.T) {
	store := newRetiringGateways(boxGateway("gw-1", "running"))
	boxes := &retiringBoxes{}
	tokens := &retiringTokens{tokens: []db.AccessToken{
		{ID: 11, Name: "workspace-gateway-landing-gw-1"},
		{ID: 12, Name: "model-proxy-gateway-gw-1"},
		{ID: 13, Name: "flow-host-landing-binding"},
		{ID: 14, Name: "workspace-gateway-landing-gw-2"},
	}}
	retirement := NewRepoGatewayRetirement(store, tokens, boxes)

	require.False(t, retirement.Sweep(context.Background()), "a sweep that retired a row is not the last")
	row := store.rows["gw-1"]
	require.True(t, row.DeletedAt.Valid)
	require.Empty(t, row.AuthTokenHash, "the verified stop clears the credential marker")
	require.Len(t, boxes.commands["vm-box"], 1)
	require.Contains(t, boxes.commands["vm-box"][0], "systemctl disable --now 'smithers-gateway-gw-1.service'")
	require.Equal(t, []string{"smithers-gw-gw-1.preview.jjhub.tech"}, boxes.revoked)
	require.Empty(t, boxes.deleted, "the box's VM is the box's")
	require.Subset(t, tokens.deleted, []int64{11, 12})
	require.NotContains(t, tokens.deleted, int64(13), "the box's coding host keeps its credential")
	require.NotContains(t, tokens.deleted, int64(14))

	require.True(t, retirement.Sweep(context.Background()))
}

// A box that is asleep cannot run the stop: the tombstone keeps its credential
// marker and is retried, and a sweep never reports done while it remains. A
// box that is gone counts as stopped.
func TestRepoGatewayRetirementRetriesAnAsleepBox(t *testing.T) {
	store := newRetiringGateways(boxGateway("gw-1", "suspended"))
	boxes := &retiringBoxes{execErr: &sandbox.StatusError{StatusCode: 409}}
	retirement := NewRepoGatewayRetirement(store, &retiringTokens{}, boxes)

	require.False(t, retirement.Sweep(context.Background()))
	require.False(t, retirement.Sweep(context.Background()))
	require.Equal(t, "hash", store.rows["gw-1"].AuthTokenHash)
	require.Equal(t, []string{"gw-1", "gw-1"}, store.touched)

	boxes.execErr = nil
	boxes.status = 75
	require.False(t, retirement.Sweep(context.Background()), "a service still running is not stopped")
	require.Equal(t, "hash", store.rows["gw-1"].AuthTokenHash)

	boxes.execErr = &sandbox.StatusError{StatusCode: 404}
	require.False(t, retirement.Sweep(context.Background()))
	require.Empty(t, store.rows["gw-1"].AuthTokenHash)
	require.True(t, retirement.Sweep(context.Background()))
}

// A box-less (repository-level) gateway owned its VM: the VM and its ingress
// go with the row. Unfinished rows ('pending', 'starting', 'failed') are
// tombstoned like live ones.
func TestRepoGatewayRetirementDiscardsBoxlessAndUnfinishedRows(t *testing.T) {
	boxless := runtimeports.RepoGateway{ID: "gw-repo", UserID: 7, VmID: "vm_repo", AuthTokenHash: "hash", Status: "running"}
	pending := boxGateway("gw-pending", "pending")
	pending.VmID, pending.AuthTokenHash = "", ""
	failed := boxGateway("gw-failed", "failed")
	failed.AuthTokenHash = ""
	store := newRetiringGateways(boxless, pending, failed)
	boxes := &retiringBoxes{}
	retirement := NewRepoGatewayRetirement(store, &retiringTokens{}, boxes)

	require.False(t, retirement.Sweep(context.Background()))
	for _, id := range []string{"gw-repo", "gw-pending", "gw-failed"} {
		require.True(t, store.rows[id].DeletedAt.Valid, id)
	}
	require.Equal(t, []string{"vm_repo"}, boxes.deleted)
	require.Equal(t, []string{"smithers-gw-vm-repo.preview.jjhub.tech"}, boxes.revoked)
	require.Empty(t, boxes.commands)
	require.True(t, retirement.Sweep(context.Background()))
}

func TestRepoGatewayRetirementRunStopsOnceNothingRemains(t *testing.T) {
	store := newRetiringGateways(boxGateway("gw-1", "running"))
	retirement := NewRepoGatewayRetirement(store, &retiringTokens{}, &retiringBoxes{})
	retirement.interval = time.Millisecond
	done := make(chan struct{})
	go func() { retirement.Run(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the retirement kept running after every row was retired")
	}

	failing := newRetiringGateways()
	failing.listErr = errors.New("store unavailable")
	retirement = NewRepoGatewayRetirement(failing, &retiringTokens{}, &retiringBoxes{})
	require.False(t, retirement.Sweep(context.Background()), "an unreadable inventory is never reported empty")
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() { retirement.Run(ctx); close(stopped) }()
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the retirement ignored cancellation")
	}
}
