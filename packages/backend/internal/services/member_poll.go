package services

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// MemberRecheckTick drives the existing periodic worker. Actual reads retain
// their hourly cadence, doubled only by the shared low-budget policy.
const MemberRecheckTick = time.Second

type memberPollBinding struct {
	repository int64
	stream     gitHubStreamKey
}
type memberPermissionPoll struct {
	mu                 sync.Mutex
	synced             *GitHubSyncedRepoService
	wake               func()
	binding            memberPollBinding
	state              gitHubPollState
	requested, running bool
	healthReset        bool
}

// UseInstallPermissionPolling joins the existing roster worker to shared sync.
// Metadata qualification does not gate the roster security recheck.
func (m *Members) UseInstallPermissionPolling(synced *GitHubSyncedRepoService, wake func()) {
	m.permissionPoll = &memberPermissionPoll{synced: synced, wake: wake}
	if synced != nil {
		m.Budget = synced.budget
		if m.Budget != nil {
			m.Budget.mu.Lock()
			m.Budget.userRefused = m.requestPermissionRecheck
			m.Budget.mu.Unlock()
		}
	}
}

// A user-token refusal requests authoritative permission reads without doing
// database/network work in the failed caller or changing member state there.
func (m *Members) requestPermissionRecheck() {
	if m == nil || m.permissionPoll == nil || m.permissionPoll.wake == nil {
		return
	}
	p := m.permissionPoll
	p.mu.Lock()
	p.requested = true
	p.mu.Unlock()
	p.wake()
}

func (m *Members) permissionPollReady(ctx context.Context) (memberRepository, db.GithubSyncedRepo, error) {
	if m == nil || m.Pool == nil || m.Credentials == nil || m.Minter == nil || m.permissionPoll == nil || m.permissionPoll.wake == nil || m.permissionPoll.synced == nil || m.permissionPoll.synced.install == nil || m.permissionPoll.synced.install.authorize == nil {
		return memberRepository{}, db.GithubSyncedRepo{}, githubSyncUnavailable()
	}
	repo, row, err := m.permissionPollRepository(ctx)
	if err == nil {
		err = m.permissionPoll.synced.authorizeFetched(ctx, row)
	}
	return repo, row, err
}

// permissionPollRepository reads binding data without requiring metadata sync.
// Recheck independently proves installation access with the App token.
func (m *Members) permissionPollRepository(ctx context.Context) (memberRepository, db.GithubSyncedRepo, error) {
	repo, err := m.repository(ctx)
	if err != nil {
		return repo, db.GithubSyncedRepo{}, err
	}
	row, err := m.permissionPoll.synced.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: repo.Owner, RepoName: repo.Name})
	if errors.Is(err, pgx.ErrNoRows) {
		return repo, db.GithubSyncedRepo{}, nil
	}
	return repo, row, err
}

func permissionBinding(repo memberRepository, row db.GithubSyncedRepo) memberPollBinding {
	return memberPollBinding{repo.ID, syncedStreamKey(row, "permissions")}
}
func (p *memberPermissionPoll) bind(binding memberPollBinding) {
	if p.binding != binding {
		p.healthReset = p.binding.repository != 0
		p.binding = binding
		p.state = gitHubPollState{}
	}
}
func (m *Members) permissionPause(row db.GithubSyncedRepo) time.Time {
	if m.Budget == nil {
		return time.Time{}
	}
	pause := m.Budget.StreamRetryAt(row.InstallationID.Int64, "permissions")
	mint := m.Budget.StreamRetryAt(row.InstallationID.Int64, gitHubInstallationTokenPath(row.InstallationID.Int64))
	if mint.After(pause) {
		return mint
	}
	return pause
}

// RequiredStreams reports only the permission owner's observation, including
// persisted health after boot and an unread state after rebinding. It never fetches GitHub.
func (m *Members) RequiredStreams(ctx context.Context) ([]GitHubSyncStream, error) {
	repo, row, err := m.permissionPollReady(ctx)
	if err != nil {
		return nil, err
	}
	p := m.permissionPoll
	p.mu.Lock()
	p.bind(permissionBinding(repo, row))
	state := p.state
	healthReset := p.healthReset
	p.mu.Unlock()
	observation := GitHubSyncStream{Target: MemberRecheckInterval, Background: true}
	setting, readErr := db.New(m.Pool).GetInstallSetting(ctx, "github.permissions.health")
	if readErr == nil {
		if err := json.Unmarshal(setting.Value, &observation); err != nil {
			return nil, err
		}
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return nil, readErr
	}
	// Rebinding resets the scheduler's observation; retain durable refusal health.
	if state.lastSuccess.IsZero() && healthReset {
		observation.LastSuccessAt = nil
	} else if !state.lastSuccess.IsZero() {
		observation.LastSuccessAt = &state.lastSuccess
	}
	pause := m.permissionPause(row)
	if pause.After(p.synced.now()) {
		observation.RetryAt = &pause
	}
	observation.Background = true
	return []GitHubSyncStream{observation}, nil
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
	if m == nil || m.Pool == nil || m.permissionPoll == nil || m.permissionPoll.synced == nil {
		return nil
	}
	repo, row, err := m.permissionPollRepository(ctx)
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
	err = m.Recheck(ctx)
	current, currentRow, bindingErr := m.permissionPollRepository(ctx)
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
			p.healthReset = false
		}
	}
	return err
}
