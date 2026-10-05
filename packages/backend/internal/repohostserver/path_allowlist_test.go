package repohostserver

import (
	"encoding/base64"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPushPathAllowlist(t *testing.T) {
	t.Parallel()
	headers := http.Header{}
	headers.Set("X-Smithers-Allowed-Paths", base64.RawURLEncoding.EncodeToString([]byte(`["src/**","README.md"]`)))
	paths, restricted, err := pushPathAllowlist(headers)
	require.NoError(t, err)
	assert.True(t, restricted)
	assert.Equal(t, []string{"src/**", "README.md"}, paths)

	headers.Set("X-Smithers-Allowed-Paths", "not-base64!")
	_, restricted, err = pushPathAllowlist(headers)
	assert.True(t, restricted)
	assert.Error(t, err)
}

func TestEnforcePushPathAllowlistRejectsAndRestoresRefs(t *testing.T) {
	installGitStub(t, `#!/bin/sh
case " $* " in
  *" log "*) printf 'src/main.go\000secret/key.txt\000'; exit 0 ;;
  *" update-ref "*) exit 0 ;;
  *" for-each-ref "*) exit 0 ;;
esac
exit 9
`)
	err := enforcePushPathAllowlist(t.Context(), "/repo.git", map[string]string{"refs/heads/main": "old"}, map[string]string{"refs/heads/main": "new"}, []string{"src/**"})
	require.Error(t, err)
	appErr, ok := err.(*appError)
	require.True(t, ok)
	assert.Equal(t, http.StatusForbidden, appErr.StatusCode)
	assert.Contains(t, appErr.Message, "secret/key.txt")
}
