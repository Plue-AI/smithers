package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

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
