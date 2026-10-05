package services

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

// M-28: "This Mac only" binds loopback; "Network" binds the address the owner chose.
func TestNetworkBindDecision(t *testing.T) {
	for bind, want := range map[string]string{
		"":                "",
		"bad":             "",
		"127.0.0.1:4000":  "",
		"127.0.0.2:4000":  "",
		"localhost:4000":  "",
		"LOCALHOST:4000":  "",
		"[::1]:4000":      "",
		"mini.local:4000": "",
		"0.0.0.0:4000":    "0.0.0.0:4000",
		"10.0.0.5:4000":   "10.0.0.5:4000",
		" 10.0.0.5:4000 ": "10.0.0.5:4000",
		"[::]:4000":       "[::]:4000",
		"[fd00::5]:4000":  "[fd00::5]:4000",
		"10.0.0.5:":       "",
	} {
		require.Equal(t, want, NetworkBind(bind), bind)
	}
}

func TestInstallAddressOriginsJoinConfiguredThenSaved(t *testing.T) {
	var missing *InstallAddress
	require.Nil(t, missing.Origins())
	address := &InstallAddress{Configured: []string{"http://127.0.0.1:4000"}}
	require.Equal(t, []string{"http://127.0.0.1:4000"}, address.Origins())
	address.commit("0.0.0.0:4000", []string{"http://mini.local:4000", "HTTP://127.0.0.1:4000/", " https://box.example "})
	require.Equal(t, []string{"http://127.0.0.1:4000", "http://mini.local:4000", "https://box.example"}, address.Origins())
	// An Address an earlier install saved as typed reads as the browser's origin.
	address.commit("0.0.0.0:4000", []string{"http://Williams-Mac-mini.local:4000", "http://williams-mac-mini.local:4000"})
	require.Equal(t, []string{"http://127.0.0.1:4000", "http://williams-mac-mini.local:4000"}, address.Origins())
	// Saving replaces the saved origins; a removed origin is unknown on the next request.
	address.commit("127.0.0.1:4000", []string{"http://localhost:4000"})
	require.Equal(t, []string{"http://127.0.0.1:4000", "http://localhost:4000"}, address.Origins())
}

func TestInstallAddressListensOnlyOnChangeAndRevertsUncommitted(t *testing.T) {
	var calls []string
	refuse := ""
	address := &InstallAddress{Listen: func(bind string) error {
		calls = append(calls, bind)
		if bind != "" && bind == refuse {
			return errors.New("address in use")
		}
		return nil
	}}
	// This Mac only is the loopback listener alone: nothing opens.
	require.NoError(t, address.apply("127.0.0.1:4000"))
	require.Empty(t, calls)
	require.NoError(t, address.apply("0.0.0.0:4000"))
	require.NoError(t, address.apply("0.0.0.0:4000"))
	require.Equal(t, []string{"0.0.0.0:4000"}, calls)
	// The step did not commit: the listener returns to the Address in effect (none).
	address.revert()
	require.Equal(t, []string{"0.0.0.0:4000", ""}, calls)

	require.NoError(t, address.apply("10.0.0.5:4000"))
	address.commit("10.0.0.5:4000", []string{"http://10.0.0.5:4000"})
	refuse = "0.0.0.0:4000"
	err := address.apply("0.0.0.0:4000")
	var typed *InstallReadinessError
	require.ErrorAs(t, err, &typed)
	require.Equal(t, InstallReadinessError{Code: "address_unavailable", Class: "user", Message: "Can't listen on 0.0.0.0:4000"}, *typed)
	// A refused bind changed nothing, so restoring needs no listener change.
	address.revert()
	require.Equal(t, []string{"0.0.0.0:4000", "", "10.0.0.5:4000", "0.0.0.0:4000"}, calls)

	// Back to This Mac only closes the network listener.
	require.NoError(t, address.apply("localhost:4000"))
	require.Equal(t, "", calls[len(calls)-1])
}

func TestInstallAddressWithoutListenerSavesOnly(t *testing.T) {
	var missing *InstallAddress
	require.NoError(t, missing.apply("0.0.0.0:4000"))
	missing.commit("0.0.0.0:4000", []string{"http://mini.local:4000"})
	missing.revert()
	missing.Serve()
	address := &InstallAddress{}
	require.NoError(t, address.apply("0.0.0.0:4000"))
	address.commit("0.0.0.0:4000", []string{"http://mini.local:4000"})
	require.Equal(t, []string{"http://mini.local:4000"}, address.Origins())
}
