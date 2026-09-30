package repohostserver

import (
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestUploadPackConcurrencyFromEnvironment(t *testing.T) {
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "test")
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", "/unused")
	t.Setenv("SMITHERS_REPO_STORAGE_PATH", t.TempDir())
	t.Setenv("SMITHERS_REPO_HOST_MAX_CONCURRENT_UPLOAD_PACKS", "2")
	cfg, err := LoadConfig()
	require.NoError(t, err)
	require.Equal(t, 2, cfg.maxConcurrentUploadPacks())
}

func TestUploadPackAdmissionEnvironmentValidation(t *testing.T) {
	for _, tc := range []struct{ name, value string }{
		{"SMITHERS_REPO_HOST_MAX_CONCURRENT_UPLOAD_PACKS", "0"},
		{"SMITHERS_REPO_HOST_MAX_CONCURRENT_UPLOAD_PACKS", "1025"},
		{"SMITHERS_REPO_HOST_MAX_CONCURRENT_UPLOAD_PACKS", "oops"},
		{"SMITHERS_REPO_HOST_MAX_QUEUED_UPLOAD_PACKS", "-1"},
		{"SMITHERS_REPO_HOST_MAX_QUEUED_UPLOAD_PACKS", "1025"},
		{"SMITHERS_REPO_HOST_MAX_QUEUED_UPLOAD_PACKS", "1.5"},
		{"SMITHERS_REPO_HOST_UPLOAD_PACK_QUEUE_TIMEOUT", "0s"},
		{"SMITHERS_REPO_HOST_UPLOAD_PACK_QUEUE_TIMEOUT", "-1s"},
		{"SMITHERS_REPO_HOST_UPLOAD_PACK_QUEUE_TIMEOUT", "bad"},
	} {
		t.Run(tc.name+"/"+tc.value, func(t *testing.T) {
			t.Setenv(tc.name, tc.value)
			_, err := LoadConfig()
			require.ErrorContains(t, err, tc.name)
		})
	}
	t.Run("accepted", func(t *testing.T) {
		t.Setenv("SMITHERS_REPO_HOST_MAX_CONCURRENT_UPLOAD_PACKS", " 1024 ")
		t.Setenv("SMITHERS_REPO_HOST_MAX_QUEUED_UPLOAD_PACKS", "1")
		t.Setenv("SMITHERS_REPO_HOST_UPLOAD_PACK_QUEUE_TIMEOUT", "250ms")
		var cfg Config
		require.NoError(t, uploadPackBoundsFromEnv(&cfg))
		require.Equal(t, 1024, cfg.maxConcurrentUploadPacks())
		require.Equal(t, 1, cfg.maxQueuedUploadPacks())
		require.Equal(t, 250*time.Millisecond, cfg.uploadPackQueueTimeout())
	})
	t.Run("defaults", func(t *testing.T) {
		for _, name := range []string{"SMITHERS_REPO_HOST_MAX_CONCURRENT_UPLOAD_PACKS", "SMITHERS_REPO_HOST_MAX_QUEUED_UPLOAD_PACKS", "SMITHERS_REPO_HOST_UPLOAD_PACK_QUEUE_TIMEOUT"} {
			t.Setenv(name, "")
		}
		var cfg Config
		require.NoError(t, uploadPackBoundsFromEnv(&cfg))
		require.Equal(t, 4, cfg.maxConcurrentUploadPacks())
		require.Equal(t, 16, cfg.maxQueuedUploadPacks())
		require.Equal(t, 30*time.Second, cfg.uploadPackQueueTimeout())
	})
}
