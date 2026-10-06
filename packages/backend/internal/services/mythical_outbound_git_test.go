package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMythicalOutboundHostIgnoresHookAndHelper(t *testing.T) {
	f := newMythicalFixture(t)
	head := f.commit("candidate", map[string]string{"README": "safe objects"})
	marker := filepath.Join(t.TempDir(), "executed")
	hook := filepath.Join(t.TempDir(), "pre-push")
	script := fmt.Sprintf("#!/bin/sh\necho executed > %q\nexit 1\n", marker)
	require.NoError(t, os.WriteFile(hook, []byte(script), 0700))
	f.run("config", "core.hooksPath", filepath.Dir(hook))
	f.run("config", "credential.helper", "!"+hook)
	remote := filepath.Join(t.TempDir(), "remote.git")
	f.run("init", "--bare", "--quiet", remote)
	_, err := f.git.git(context.Background(), "push", remote, head+":refs/heads/proposal")
	require.NoError(t, err)
	refs, err := f.git.lsRemote(context.Background(), remote)
	require.NoError(t, err)
	require.Equal(t, head, refs["refs/heads/proposal"])
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="GitHub"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer denied.Close()
	_, err = f.git.lsRemote(context.Background(), denied.URL+"/remote.git")
	require.Error(t, err)
	_, err = os.Stat(marker)
	require.True(t, os.IsNotExist(err), "host executed repository hook or helper: %v", err)
}

func TestMythicalOutboundCanonicalCommentProviderRequired(t *testing.T) {
	api := &mythicalGitHubAPI{}
	_, err := api.findComment(context.Background(), stackRepo, 1, mythicalCommentMarker("abc"))
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
}

func TestMythicalOutboundCloseRequiresCanonicalEventSinceDrop(t *testing.T) {
	at := time.Date(2026, 10, 5, 7, 0, 0, 500000000, time.UTC)
	for _, tc := range []struct {
		name, actor, event string
		app                int64
		at                 time.Time
		applied            bool
	}{
		{"person quoting App", "User", "closed", 7, at, false},
		{"another App", "Bot", "closed", 8, at, false},
		{"old close", "Bot", "closed", 7, at.Add(-time.Hour), false},
		{"reopen is not close", "Bot", "reopened", 7, at, false},
		{"canonical close", "Bot", "closed", 7, at.Truncate(time.Second), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorded := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/issues/4/events?per_page=100&page=1": answer(200, []any{map[string]any{"event": tc.event, "created_at": tc.at, "actor": map[string]string{"type": tc.actor}, "performed_via_github_app": map[string]int64{"id": tc.app}}}),
			}}
			got, err := recorded.api(t).AppliedClose(context.Background(), stackRepo, 4, at)
			require.NoError(t, err)
			require.Equal(t, tc.applied, got)
		})
	}
}
