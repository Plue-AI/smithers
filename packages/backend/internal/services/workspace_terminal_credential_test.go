package services

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeTerminalTokens struct {
	mu      sync.Mutex
	next    int64
	live    map[int64]db.CreateAccessTokenParams
	created int
}

func (f *fakeTerminalTokens) CreateAccessToken(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	f.created++
	if f.live == nil {
		f.live = map[int64]db.CreateAccessTokenParams{}
	}
	f.live[f.next] = arg
	return db.AccessToken{ID: f.next}, nil
}

func (f *fakeTerminalTokens) DeleteAccessToken(_ context.Context, arg db.DeleteAccessTokenParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.live[arg.ID].UserID == arg.UserID {
		delete(f.live, arg.ID)
	}
	return nil
}

func (f *fakeTerminalTokens) liveIDs() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	ids := make([]int64, 0, len(f.live))
	for id := range f.live {
		ids = append(ids, id)
	}
	return ids
}

type fakeSessionFiles struct {
	mu    sync.Mutex
	files map[string]string
	fail  error
}

func (f *fakeSessionFiles) PutSessionToken(_ context.Context, workspaceID, sessionID string, token []byte) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return "", f.fail
	}
	if f.files == nil {
		f.files = map[string]string{}
	}
	f.files[sessionID] = string(token)
	return "/run/smithers/sessions/" + sessionID + "/token", nil
}

func (f *fakeSessionFiles) DeleteSessionToken(_ context.Context, _, sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.files, sessionID)
	return nil
}

func (f *fakeSessionFiles) token(sessionID string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	token, ok := f.files[sessionID]
	return token, ok
}

// A terminal's delegated credential lives while a WebSocket is attached: the
// open mints one bound to the person, branch and session with the stage-1
// profile; the last detach revokes it and deletes its file; a reattach mints a
// fresh one into the same file; close revokes it for good (T-TRM-02).
func TestTerminalCredentialLifecycle(t *testing.T) {
	ctx := context.Background()
	tokens, files, registry := &fakeTerminalTokens{}, &fakeSessionFiles{}, &sync.Map{}
	c := &terminalCredential{registry: registry, tokens: tokens, writer: files, workspaceID: "0b1c-branch", sessionID: "5e55-session", userID: 2, repositoryID: 7, url: "http://127.0.0.1:4000"}
	registry.Store(c.sessionID, c)
	c.mu.Lock()
	require.NoError(t, c.issueLocked(ctx))
	c.mu.Unlock()
	t.Cleanup(c.Close)

	require.Equal(t, []int64{1}, tokens.liveIDs())
	minted := tokens.live[1]
	assert.Equal(t, int64(2), minted.UserID)
	assert.True(t, minted.SystemIssued)
	assert.Equal(t, "terminal-session-5e55-session", minted.Name)
	assert.Equal(t, "read:repository,read:user,repo:7,via:terminal,branch:0b1c-branch,profile:terminal_s1,terminal-session:5e55-session", minted.Scopes)
	assert.WithinDuration(t, time.Now().Add(time.Hour), minted.ExpiresAt.Time, time.Minute, "terminal credentials last an hour")
	written, ok := files.token(c.sessionID)
	require.True(t, ok)
	assert.True(t, strings.HasPrefix(written, "smithers_"))
	assert.Equal(t, map[string]string{"SMITHERS_TOKEN_FILE": "/run/smithers/sessions/5e55-session/token", "SMITHERS_URL": "http://127.0.0.1:4000"}, c.environment())

	require.NoError(t, c.AcquireCredential(ctx), "the first attach uses the credential the open minted")
	require.NoError(t, c.AcquireCredential(ctx), "a second viewer shares it")
	assert.Equal(t, 1, tokens.created)
	c.ReleaseCredential()
	assert.Equal(t, []int64{1}, tokens.liveIDs(), "a remaining viewer keeps it live")
	c.ReleaseCredential()
	assert.Empty(t, tokens.liveIDs(), "the last close revokes it")
	_, ok = files.token(c.sessionID)
	assert.False(t, ok, "and deletes its file")

	require.NoError(t, c.AcquireCredential(ctx))
	assert.Equal(t, []int64{2}, tokens.liveIDs(), "a reattach mints a fresh credential")
	rewritten, ok := files.token(c.sessionID)
	require.True(t, ok)
	assert.NotEqual(t, written, rewritten)

	c.mu.Lock()
	require.NoError(t, c.issueLocked(ctx), "renewal")
	c.mu.Unlock()
	assert.Equal(t, []int64{3}, tokens.liveIDs(), "renewal writes the new credential, then revokes the old")

	c.Close()
	assert.Empty(t, tokens.liveIDs())
	_, ok = files.token(c.sessionID)
	assert.False(t, ok)
	_, ok = registry.Load(c.sessionID)
	assert.False(t, ok, "close forgets the session")
	assert.ErrorIs(t, c.AcquireCredential(ctx), errTerminalClosed)
	assert.Empty(t, tokens.liveIDs(), "a closed terminal mints nothing")
}

func TestTerminalCredentialRevokesWhenItsFileCannotBeWritten(t *testing.T) {
	tokens := &fakeTerminalTokens{}
	c := &terminalCredential{tokens: tokens, writer: &fakeSessionFiles{fail: errors.New("no guest")}, workspaceID: "w", sessionID: "s", userID: 2, repositoryID: 7}
	c.mu.Lock()
	err := c.issueLocked(context.Background())
	c.mu.Unlock()
	require.Error(t, err)
	assert.Equal(t, 1, tokens.created)
	assert.Empty(t, tokens.liveIDs(), "a credential that never reached its file is revoked")
}
