package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

type installWikiSource struct {
	setting *InstallWikiFolder
	err     error
	reads   int
}

func (s *installWikiSource) LoadAuthorizedWikiFolder(context.Context) (*InstallWikiFolder, error) {
	s.reads++
	return s.setting, s.err
}

func TestInstallObsidianPathBoundary(t *testing.T) {
	base := t.TempDir()
	state, vault := filepath.Join(base, "state"), filepath.Join(base, "vault")
	require.NoError(t, os.Mkdir(state, 0700))
	require.NoError(t, os.Mkdir(vault, 0700))
	canonical, identity, err := ValidateInstallObsidianFolder(vault, state)
	require.NoError(t, err)
	require.NotEmpty(t, identity)
	expected, err := filepath.EvalSymlinks(vault)
	require.NoError(t, err)
	require.Equal(t, expected, canonical)
	alias := filepath.Join(base, "alias")
	require.NoError(t, os.Symlink(state, alias))
	file := filepath.Join(base, "file")
	require.NoError(t, os.WriteFile(file, []byte("untouched"), 0600))
	for _, path := range []string{state, alias, filepath.Join(base, "absent"), file, "relative"} {
		_, _, err := ValidateInstallObsidianFolder(path, state)
		requireWikiSyncCode(t, err, api.CodeForbidden)
	}
	_, _, err = ValidateInstallObsidianFolder(vault, "relative")
	requireWikiSyncCode(t, err, api.CodeForbidden)
	_, _, err = ValidateInstallObsidianFolder(vault, filepath.Join(base, "missing-state"))
	requireWikiSyncCode(t, err, api.CodeForbidden)
	data, err := os.ReadFile(file)
	require.NoError(t, err)
	require.Equal(t, "untouched", string(data))
}

func TestInstallObsidianMissingAuthorityAndReplacement(t *testing.T) {
	svc := &WikiService{}
	require.Error(t, svc.SyncInstallWikiFolder(context.Background(), nil))
	source := &installWikiSource{err: api.Forbidden("owner_required")}
	requireWikiSyncCode(t, svc.SyncInstallWikiFolder(context.Background(), source), api.CodeForbidden)
	source.err = nil
	require.NoError(t, svc.SyncInstallWikiFolder(context.Background(), source))
	source.setting = &InstallWikiFolder{}
	require.Error(t, svc.SyncInstallWikiFolder(context.Background(), source))
	state, vault := t.TempDir(), t.TempDir()
	path, identity, err := ValidateInstallObsidianFolder(vault, state)
	require.NoError(t, err)
	source.setting = &InstallWikiFolder{WikiFolderSync: WikiFolderSync{Owner: "owner", Repo: "repo", Login: "owner", Connection: "vault", Visibility: "public", Folder: path}, StateDirectory: state, Identity: identity}
	// A valid setting still cannot sync without durable wiki storage.
	require.Error(t, svc.SyncInstallWikiFolder(context.Background(), source))
	require.NoError(t, os.Rename(path, path+"-old"))
	defer os.RemoveAll(path + "-old")
	require.NoError(t, os.Mkdir(path, 0700))
	requireWikiSyncCode(t, svc.SyncInstallWikiFolder(context.Background(), source), api.CodeConflict)
	source.setting.Identity = ""
	require.Error(t, svc.SyncInstallWikiFolder(context.Background(), source))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reads := source.reads
	require.ErrorIs(t, svc.SyncInstallWikiFolder(ctx, source), context.Canceled)
	RunInstallWikiFolderSync(ctx, svc, source, time.Minute)
	require.Equal(t, reads, source.reads)
}
