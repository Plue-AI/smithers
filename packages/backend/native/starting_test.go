package native

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// While the owned PostgreSQL starts and migrates, the install's address
// answers its progress: the launcher's deadline follows it, and a browser
// sees a page instead of a refused connection.
func TestStartingPageAnswersProgressUntilTheAppTakesTheAddress(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := probe.Addr().String()
	require.NoError(t, probe.Close())

	page := serveStartingPage(addr)
	client := &http.Client{Timeout: 5 * time.Second}
	readyz := func() (int, startingStatus) {
		response, err := client.Get("http://" + addr + "/readyz")
		require.NoError(t, err)
		defer response.Body.Close()
		var status startingStatus
		require.NoError(t, json.NewDecoder(response.Body).Decode(&status))
		return response.StatusCode, status
	}
	code, status := readyz()
	require.Equal(t, http.StatusServiceUnavailable, code)
	require.Equal(t, startingStatus{Status: "starting", Phase: "database"}, status)

	page.migrating(54, 116)
	code, status = readyz()
	require.Equal(t, http.StatusServiceUnavailable, code)
	require.Equal(t, startingStatus{Status: "starting", Phase: "migrating", Applied: 54, Total: 116}, status)

	response, err := client.Get("http://" + addr + "/setup?token=x")
	require.NoError(t, err)
	body, err := io.ReadAll(response.Body)
	require.NoError(t, response.Body.Close())
	require.NoError(t, err)
	require.Equal(t, http.StatusServiceUnavailable, response.StatusCode)
	require.Equal(t, "2", response.Header.Get("Retry-After"))
	require.Contains(t, string(body), "Updating the database · 54 of 116")
	require.Contains(t, string(body), `http-equiv="refresh"`)

	// close frees the address for the app's own listener.
	page.close()
	page.close()
	app, err := net.Listen("tcp", addr)
	require.NoError(t, err, "the app listens where the page was")
	require.NoError(t, app.Close())
}

func TestStartingPageWithoutAnAddressServesNothing(t *testing.T) {
	page := serveStartingPage("")
	require.Nil(t, page.server)
	page.migrating(1, 2)
	page.close()

	busy, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer busy.Close()
	// An address already taken leaves startup to the app's listener, which
	// reports the conflict itself.
	page = serveStartingPage(busy.Addr().String())
	require.Nil(t, page.server)
	page.close()
}
