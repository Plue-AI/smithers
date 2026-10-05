package services

import (
	"context"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// MemberRecheckTick drives the existing periodic worker. Actual reads retain
// their hourly cadence, doubled only by the shared low-budget policy.
const MemberRecheckTick = time.Second

type memberPollBinding struct {
	repository int64
	stream     gitHubStreamKey
}
type memberPermissionValidator struct{ etag, version string }
type memberPermissionPoll struct {
	mu                 sync.Mutex
	synced             *GitHubSyncedRepoService
	wake               func()
	binding            memberPollBinding
	state              gitHubPollState
	requested, running bool
	validators         map[int64]memberPermissionValidator
}

// UseInstallPermissionPolling joins the existing roster worker to shared sync.
// Qualification is supplied by the same install provider as other streams.
func (m *Members) UseInstallPermissionPolling(synced *GitHubSyncedRepoService, wake func()) {
	m.permissionPoll = &memberPermissionPoll{synced: synced, wake: wake}
	if synced != nil {
		m.Budget = synced.budget
	}
}

func (m *Members) permissionPollReady(ctx context.Context) (memberRepository, db.GithubSyncedRepo, error) {
	if m == nil || m.Pool == nil || m.Credentials == nil || m.Minter == nil || m.permissionPoll == nil || m.permissionPoll.wake == nil || m.permissionPoll.synced == nil || m.permissionPoll.synced.install == nil || m.permissionPoll.synced.install.authorize == nil {
		return memberRepository{}, db.GithubSyncedRepo{}, githubSyncUnavailable()
	}
	repo, err := m.repository(ctx)
	if err != nil {
		return repo, db.GithubSyncedRepo{}, err
	}
	synced := m.permissionPoll.synced
	row, err := synced.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: repo.Owner, RepoName: repo.Name})
	if err == nil {
		err = synced.authorizeFetched(ctx, row)
	}
	return repo, row, err
}

func permissionBinding(repo memberRepository, row db.GithubSyncedRepo) memberPollBinding {
	return memberPollBinding{repo.ID, syncedStreamKey(row, "permissions")}
}
func (p *memberPermissionPoll) bind(binding memberPollBinding) {
	if p.binding != binding {
		p.binding = binding
		p.state = gitHubPollState{}
		p.validators = make(map[int64]memberPermissionValidator)
	}
}
func (m *Members) permissionPause(row db.GithubSyncedRepo) time.Time {
	pause := m.Budget.StreamRetryAt(row.InstallationID.Int64, "permissions")
	mint := m.Budget.StreamRetryAt(row.InstallationID.Int64, gitHubInstallationTokenPath(row.InstallationID.Int64))
	if mint.After(pause) {
		return mint
	}
	return pause
}

// RequiredStreams reports only the permission owner's observation, including
// an unread state after boot or rebinding. It never fetches GitHub.
func (m *Members) RequiredStreams(ctx context.Context) ([]GitHubSyncStream, error) {
	repo, row, err := m.permissionPollReady(ctx)
	if err != nil {
		return nil, err
	}
	p := m.permissionPoll
	p.mu.Lock()
	p.bind(permissionBinding(repo, row))
	state := p.state
	p.mu.Unlock()
	return []GitHubSyncStream{gitHubSyncObservation(state, m.permissionPause(row), p.synced.now())}, nil
}

// RetryStreams is a fetch hint; it preserves cadence and shared pauses.
func (m *Members) RetryStreams(ctx context.Context) error {
	repo, row, err := m.permissionPollReady(ctx)
	if err != nil {
		return err
	}
	p := m.permissionPoll
	p.mu.Lock()
	p.bind(permissionBinding(repo, row))
	p.requested = true
	p.mu.Unlock()
	p.wake()
	return nil
}

// PollPermissions is run by cleanup.Periodic, not a second polling goroutine.
func (m *Members) PollPermissions(ctx context.Context) error {
	if m == nil || m.permissionPoll == nil || m.permissionPoll.synced == nil || m.permissionPoll.synced.install == nil || m.permissionPoll.synced.install.authorize == nil {
		return nil // Unqualified production providers stay disabled.
	}
	repo, row, err := m.permissionPollReady(ctx)
	if err != nil {
		return err
	}
	p := m.permissionPoll
	now := p.synced.now()
	binding := permissionBinding(repo, row)
	p.mu.Lock()
	if p.running {
		p.mu.Unlock()
		return nil
	}
	p.bind(binding)
	pause := m.permissionPause(row)
	if pause.After(now) {
		p.state.retryAt = pause
		p.mu.Unlock()
		return nil
	}
	cadence := m.Budget.StreamCadence(row.InstallationID.Int64, "permissions", MemberRecheckInterval)
	scheduled := p.state.cadenceAt.IsZero() || !now.Before(p.state.cadenceAt.Add(cadence))
	retry := !p.state.retryAt.IsZero() && !now.Before(p.state.retryAt)
	if !scheduled && !p.requested && !retry {
		p.mu.Unlock()
		return nil
	}
	if scheduled {
		p.state.cadenceAt = now
	}
	p.requested = false
	p.running = true
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.running = false; p.mu.Unlock() }()
	// The qualified registry binding already identifies the installation. No
	// separate App-JWT discovery read or second permission-token cache is needed.
	token, err := m.memberToken(ctx, row.InstallationID.Int64)
	if err == nil {
		err = m.recheckRepository(ctx, repo, token, p, binding)
	}
	current, currentRow, bindingErr := m.permissionPollReady(ctx)
	if bindingErr != nil {
		err = bindingErr
	} else if permissionBinding(current, currentRow) != binding {
		err = githubSyncUnavailable()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.binding == binding {
		p.state.lastError = err
		p.state.retryAt = m.permissionPause(row)
		if err == nil {
			p.state.lastSuccess = p.synced.now()
		}
	}
	return err
}
