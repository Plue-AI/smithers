package services

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWikiAttachmentSlug(t *testing.T) {
	digest := "3f2a9c1b0d4e" + strings.Repeat("0", 52)
	for name, tc := range map[string]struct{ path, want string }{
		"spaces and dots":    {"assets/Logo v2.png", "assets-logo-v2-png-3f2a9c1b0d4e"},
		"plain":              {"asset.bin", "asset-bin-3f2a9c1b0d4e"},
		"punctuation runs":   {"a//..__b.png", "a-b-png-3f2a9c1b0d4e"},
		"no slug characters": {"日本語", "attachment-3f2a9c1b0d4e"},
	} {
		t.Run(name, func(t *testing.T) {
			require.Equal(t, tc.want, WikiAttachmentSlug(tc.path, digest))
		})
	}
	require.NotEqual(t, WikiAttachmentSlug("a.png", digest), WikiAttachmentSlug("a.png", strings.Repeat("f", 64)), "bytes distinguish equal paths")
}
