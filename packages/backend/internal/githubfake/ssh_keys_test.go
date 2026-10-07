package githubfake

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPublicSSHKeysConditionalReads(t *testing.T) {
	seed, err := LocalSeed()
	require.NoError(t, err)
	seed.SSHKeys = map[string][]string{seed.OwnerLogin: {"ssh-ed25519 fixture-key"}}
	server, err := New(seed)
	require.NoError(t, err)
	defer server.Close()
	endpoint := server.URL + "/users/" + seed.OwnerLogin + "/keys?per_page=100"
	response, err := http.Get(endpoint)
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode)
	var keys []struct {
		ID  int    `json:"id"`
		Key string `json:"key"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&keys))
	response.Body.Close()
	require.Len(t, keys, 1)
	require.Equal(t, 1, keys[0].ID)
	require.Equal(t, "ssh-ed25519 fixture-key", keys[0].Key)
	etag := response.Header.Get("ETag")
	require.NotEmpty(t, etag)
	request, err := http.NewRequest("GET", endpoint, nil)
	require.NoError(t, err)
	request.Header.Set("If-None-Match", etag)
	response, err = http.DefaultClient.Do(request)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 304, response.StatusCode)
	response, err = http.Get(server.URL + "/users/not-listed/keys")
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 404, response.StatusCode)
	reads := server.Reads()
	require.Len(t, reads, 3)
	require.Equal(t, etag, reads[1].IfNoneMatch)
	require.Equal(t, 304, reads[1].Status)
}
