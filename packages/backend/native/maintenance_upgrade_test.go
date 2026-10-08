package native

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// ownerHome is a home directory short enough for the owner socket below it
// (Darwin allows a socket path 104 bytes), with the install state inside.
func ownerHome(t *testing.T) (home, state string) {
	t.Helper()
	base, err := os.UserHomeDir()
	require.NoError(t, err)
	home, err = os.MkdirTemp(base, ".ins07-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(home)) })
	home, err = filepath.EvalSymlinks(home)
	require.NoError(t, err)
	_, err = installbundle.ProtectedDirectory("owner home", home)
	require.NoError(t, err)
	t.Setenv("HOME", home)
	state = filepath.Join(home, "Library/Application Support/Smithers")
	require.NoError(t, os.MkdirAll(state, 0700))
	return home, state
}

// ownerSocket serves the installing-owner socket and records each request.
func ownerSocket(t *testing.T, state string, status int) *[]string {
	t.Helper()
	var mu sync.Mutex
	requests := &[]string{}
	closeSocket, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		*requests = append(*requests, r.Method+" "+r.URL.RequestURI())
		mu.Unlock()
		w.WriteHeader(status)
	}))
	require.NoError(t, err)
	t.Cleanup(func() { _ = closeSocket() })
	return requests
}

func release(t *testing.T, version string) {
	t.Helper()
	old := compose.BuildVersion
	compose.BuildVersion = version
	t.Cleanup(func() { compose.BuildVersion = old })
}

// `smthrs host upgrade` refuses before it asks the install anything: no
// preflight, no freeze, no backup and no Homebrew run. The health check's
// isolated wake must be composed by machine admission.
func TestUpgradeRefusesBeforeFreezingWithoutHealthWake(t *testing.T) {
	originalHealthWake := composedHealthWake
	composedHealthWake = nil
	t.Cleanup(func() { composedHealthWake = originalHealthWake })
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	release(t, "1.2.3")
	_, state := ownerHome(t)
	require.NoError(t, os.WriteFile(filepath.Join(state, "sentinel"), []byte("live"), 0600))
	requests := ownerSocket(t, state, 204)
	bundle := newMaintenanceBundle(t, nil)

	handled, err := DispatchMaintenance(t.Context(), []string{"host-maintenance", "upgrade"}, bundle.executable)
	require.True(t, handled)
	require.EqualError(t, err, "host_maintenance_unavailable: upgrade health wake requires machine admission (T-MCH-06)")
	require.Empty(t, *requests, "the install was never asked to check or freeze")
	require.NoDirExists(t, filepath.Join(state, "backups"))
	require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
	sentinel, err := os.ReadFile(filepath.Join(state, "sentinel"))
	require.NoError(t, err)
	require.Equal(t, "live", string(sentinel))
}

func noWake(context.Context, string) error { return nil }

// With every provider present, the upgrade still requires the Homebrew
// install it is about to replace.
func TestUpgradeCheckRequiresTheHomebrewInstall(t *testing.T) {
	bundle := newMaintenanceBundle(t, nil)
	host, runs := bundle.host(t.TempDir(), 0, nil, nil)
	homebrew := t.TempDir()
	keg, brew := filepath.Join(homebrew, "opt/smithers/libexec"), filepath.Join(homebrew, "bin/brew")
	require.NoError(t, os.MkdirAll(filepath.Dir(keg), 0755))
	require.NoError(t, os.MkdirAll(filepath.Dir(brew), 0755))
	authority := &upgradeAuthority{host: host, brew: brew, keg: keg, healthWake: noWake}

	other := newMaintenanceBundle(t, nil)
	require.NoError(t, os.Symlink(other.root, keg))
	require.EqualError(t, authority.CheckUpgrade(t.Context()), "host_maintenance_unavailable: upgrade requires the Homebrew install at "+keg+"; this install runs "+bundle.root)
	require.NoError(t, os.Remove(keg))
	require.EqualError(t, authority.CheckUpgrade(t.Context()), "host_maintenance_unavailable: upgrade requires the Homebrew install at "+keg+"; this install runs "+bundle.root)

	require.NoError(t, os.Symlink(bundle.root, keg))
	require.EqualError(t, authority.CheckUpgrade(t.Context()), "host_maintenance_unavailable: Homebrew is not installed at "+brew)
	require.NoError(t, os.WriteFile(brew, []byte("#!/bin/sh\n"), 0644))
	require.EqualError(t, authority.CheckUpgrade(t.Context()), "host_maintenance_unavailable: Homebrew is not installed at "+brew)
	require.NoError(t, os.Chmod(brew, 0755))
	require.NoError(t, authority.CheckUpgrade(t.Context()))

	authority.healthWake = nil
	require.EqualError(t, authority.CheckUpgrade(t.Context()), "host_maintenance_unavailable: upgrade health wake requires machine admission (T-MCH-06)")
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, authority.CheckUpgrade(cancelled), context.Canceled)
	require.Empty(t, *runs, "a check runs nothing")
}

// Homebrew runs as `brew upgrade smithers` with the installing user's home
// and its own directory first on PATH, and nothing the caller exported.
func TestBrewUpgradeRunsHomebrewAlone(t *testing.T) {
	bundle := newMaintenanceBundle(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	hostile(t)
	host, runs := bundle.host(t.TempDir(), 0, nil, nil)
	authority := &upgradeAuthority{host: host, brew: "/opt/homebrew/bin/brew", keg: homebrewKeg}
	require.NoError(t, authority.BrewUpgrade(t.Context()))
	require.Equal(t, []bundledRun{{
		program: "/opt/homebrew/bin/brew",
		args:    []string{"upgrade", "smithers"},
		env:     []string{"HOME=" + home, "PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
	}}, *runs)

	host, _ = bundle.host(t.TempDir(), 1, nil, nil)
	authority.host = host
	require.EqualError(t, authority.BrewUpgrade(t.Context()), "brew upgrade smithers failed; run it for the reason")
	host, _ = bundle.host(t.TempDir(), -1, errors.New("no such file"), nil)
	authority.host = host
	require.EqualError(t, authority.BrewUpgrade(t.Context()), "brew upgrade smithers failed; run it for the reason")
}

type replacement struct {
	program string
	args    []string
	env     []string
}

// After Homebrew repoints its link, the command becomes the upgraded
// bundle's backend: the bundle swap. It refuses a link that did not move and
// a backend the upgraded bundle's manifest does not approve.
func TestUpgradeContinueBecomesTheUpgradedBackend(t *testing.T) {
	previous := newMaintenanceBundle(t, nil)
	upgraded := newMaintenanceBundle(t, map[string]string{"bin/smithers-backend": "#!/bin/sh\n# next release\nexit 0\n"})
	home := t.TempDir()
	t.Setenv("HOME", home)
	hostile(t)
	keg := filepath.Join(t.TempDir(), "libexec")
	host, _ := previous.host(t.TempDir(), 0, nil, nil)
	var replaced []replacement
	authority := &upgradeAuthority{host: host, keg: keg, replace: func(program string, args, env []string) error {
		replaced = append(replaced, replacement{program, args, env})
		return errors.New("exec refused")
	}}
	const backup = "/Users/owner/Library/Application Support/Smithers/backups/1.2.3-20261007T010203.000000000Z"

	require.NoError(t, os.Symlink(previous.root, keg))
	require.EqualError(t, authority.Continue(t.Context(), backup), "Homebrew installed no newer bundle; smithers is already up to date")
	require.Empty(t, replaced)

	require.NoError(t, os.Remove(keg))
	require.NoError(t, os.Symlink(upgraded.root, keg))
	require.EqualError(t, authority.Continue(t.Context(), backup), "exec refused")
	require.Equal(t, []replacement{{
		program: upgraded.path("bin/smithers-backend"),
		args:    []string{"smithers-backend", "host-maintenance", "upgrade-continue", backup},
		env:     []string{"HOME=" + home, "PATH=" + upgraded.path("bin") + ":/usr/bin:/bin:/usr/sbin:/sbin"},
	}}, replaced)

	replaced = nil
	upgraded.write("bin/smithers-backend", "#!/bin/sh\necho replaced after install\n")
	err := authority.Continue(t.Context(), backup)
	require.ErrorIs(t, err, installbundle.ErrUnapproved)
	require.Empty(t, replaced, "an unapproved backend is never executed")

	require.NoError(t, os.Remove(keg))
	require.ErrorContains(t, authority.Continue(t.Context(), backup), "locate the upgraded bundle")
}

// upgradedInstall is the state after Homebrew replaced the bundle: a durable
// marker for the upgrade's backup, an answering owner socket, and the
// upgraded bundle whose CLI stands in for `smthrs host start`. The CLI
// records the marker and grant it saw and publishes version, as the upgraded
// backend does once its migrations applied.
type upgradedInstall struct {
	state, backup, record string
	bundle                maintenanceBundle
	requests              *[]string
	version               hostbackup.Version
}

func newUpgradedInstall(t *testing.T, startStatus int, published string) upgradedInstall {
	t.Helper()
	release(t, "1.3.0")
	head, err := product.HeadVersion()
	require.NoError(t, err)
	_, state := ownerHome(t)
	require.NoError(t, os.Mkdir(filepath.Join(state, "backups"), 0700))
	backup := jsonBackup(t)
	require.NoError(t, os.WriteFile(filepath.Join(state, ".upgrade-incomplete"), []byte(backup+"\n"), 0600))
	require.NoError(t, WriteVersion(state, Version{"1.2.3", "2", "18"}))
	record := filepath.Join(t.TempDir(), "record")
	stateInScript := "$HOME/Library/Application Support/Smithers"
	cli := "#!/bin/sh\nprintf 'start %s\\n' \"$*\" >> '" + record + "'\n" +
		"printf 'marker ' >> '" + record + "'\n/bin/cat \"" + stateInScript + "/.upgrade-incomplete\" >> '" + record + "'\n" +
		"if [ -f \"" + stateInScript + "/backups/.recovery-start\" ]; then echo granted >> '" + record + "'; fi\n" +
		"printf '" + published + "' > \"" + stateInScript + "/version.env\"\n" +
		fmt.Sprintf("exit %d\n", startStatus)
	return upgradedInstall{
		state: state, backup: backup, record: record,
		bundle:   newMaintenanceBundle(t, map[string]string{"bin/smthrs": cli}),
		requests: ownerSocket(t, state, 204),
		version:  hostbackup.Version{Release: "1.3.0", Schema: head, PostgresMajor: 18},
	}
}

func currentVersionText(t *testing.T) string {
	t.Helper()
	head, err := product.HeadVersion()
	require.NoError(t, err)
	return fmt.Sprintf(`SMITHERS_DISTRIBUTION_VERSION=1.3.0\nSMITHERS_SCHEMA_VERSION=%d\nSMITHERS_POSTGRES_MAJOR=18\n`, head)
}

// The upgraded release finishes the upgrade: it starts the install on its
// own bundle under the marker, requires the published version, wakes one
// machine as the freeze's only grant, clears the marker and reopens.
func TestUpgradeContinuationMigratesChecksAndReopens(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	u := newUpgradedInstall(t, 3, currentVersionText(t))
	var woke []string
	wake := func(_ context.Context, op string) error {
		require.FileExists(t, filepath.Join(u.state, ".upgrade-incomplete"), "the wake runs while the install is still closed")
		require.True(t, recoveryStartGranted(u.state, u.backup))
		woke = append(woke, op)
		return nil
	}
	require.NoError(t, continueUpgrade(t.Context(), u.bundle.executable, u.state, u.backup, u.version, wake))

	recorded, err := os.ReadFile(u.record)
	require.NoError(t, err)
	require.Equal(t, "start host start --bundle "+u.bundle.root+"\nmarker "+u.backup+"\ngranted\n", string(recorded))
	require.Equal(t, []string{"backup-fixture"}, woke, "the wake names the backup's quiesce operation")
	require.Equal(t, []string{"DELETE /maintenance/quiesce?op=backup-fixture"}, *u.requests)
	require.NoFileExists(t, filepath.Join(u.state, ".upgrade-incomplete"))
	require.NoFileExists(t, filepath.Join(u.state, recoveryGrantPath))
}

// Every failure keeps the marker, names the restore command, and leaves no
// grant: the install stays closed until the owner restores.
func TestFailedUpgradeContinuationKeepsTheMarkerAndPrintsTheRestore(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	for _, tc := range []struct {
		name      string
		status    int
		published string
		wake      func(context.Context, string) error
		cause     string
		started   bool
		reopened  bool
	}{
		{name: "the upgraded install does not start", status: 1, published: "", wake: noWake, cause: "host_start_failed: the upgraded install did not start on ", started: true},
		{name: "the upgraded install serves the old version", status: 3, published: `SMITHERS_DISTRIBUTION_VERSION=1.2.3\nSMITHERS_SCHEMA_VERSION=2\nSMITHERS_POSTGRES_MAJOR=18\n`, wake: noWake, cause: "upgraded install serves version 1.2.3, schema 2; expected 1.3.0", started: true},
		{name: "no machine wakes", status: 3, wake: func(context.Context, string) error { return errors.New("machine did not wake") }, cause: "machine did not wake", started: true},
		{name: "the health wake is not composed", status: 3, cause: "host_maintenance_unavailable: upgrade health wake requires machine admission (T-MCH-06)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			published := tc.published
			if published == "" {
				published = currentVersionText(t)
			}
			u := newUpgradedInstall(t, tc.status, published)
			err := continueUpgrade(t.Context(), u.bundle.executable, u.state, u.backup, u.version, tc.wake)
			require.ErrorContains(t, err, "upgrade incomplete: "+tc.cause)
			require.ErrorContains(t, err, "; restore with smthrs host restore '"+u.backup+"'")
			marker, readErr := os.ReadFile(filepath.Join(u.state, ".upgrade-incomplete"))
			require.NoError(t, readErr)
			require.Equal(t, u.backup+"\n", string(marker))
			require.NoFileExists(t, filepath.Join(u.state, recoveryGrantPath))
			require.Error(t, requireStartAllowed(u.state), "every later start refuses")
			require.Empty(t, *u.requests, "a failed upgrade never reopens the install")
			_, statErr := os.Stat(u.record)
			require.Equal(t, tc.started, statErr == nil, "start ran: %v", statErr)
		})
	}
}

// The command the previous release becomes is dispatched like any other. As
// missing health composition refuses at its first step and keeps the marker.
func TestDispatchedUpgradeContinuationRefusesWithoutHealthWake(t *testing.T) {
	originalHealthWake := composedHealthWake
	composedHealthWake = nil
	t.Cleanup(func() { composedHealthWake = originalHealthWake })
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	u := newUpgradedInstall(t, 3, currentVersionText(t))
	handled, err := DispatchMaintenance(t.Context(), []string{"host-maintenance", "upgrade-continue", u.backup}, u.bundle.executable)
	require.True(t, handled)
	require.EqualError(t, err, "upgrade incomplete: host_maintenance_unavailable: upgrade health wake requires machine admission (T-MCH-06); restore with smthrs host restore '"+u.backup+"'")
	require.FileExists(t, filepath.Join(u.state, ".upgrade-incomplete"))
	require.NoFileExists(t, u.record, "nothing started")
	require.Empty(t, *u.requests)

	for _, args := range [][]string{
		{"host-maintenance", "upgrade-continue"},
		{"host-maintenance", "upgrade-continue", "relative/backup"},
		{"host-maintenance", "upgrade-continue", u.backup + "/../other"},
		{"host-maintenance", "upgrade-continue", u.backup, "extra"},
	} {
		handled, err := DispatchMaintenance(t.Context(), args, u.bundle.executable)
		require.True(t, handled)
		require.EqualError(t, err, "invalid_backup: upgrade-continue requires the upgrade's backup directory", strings.Join(args, " "))
	}
	// A backend outside a bundle cannot continue; the refusal still carries
	// the restore command.
	handled, err = DispatchMaintenance(t.Context(), []string{"host-maintenance", "upgrade-continue", u.backup}, os.Executable)
	require.True(t, handled)
	require.ErrorContains(t, err, "upgrade incomplete: host_maintenance_unavailable: upgrade continues from an installed bundle: ")
	require.ErrorContains(t, err, "; restore with smthrs host restore '"+u.backup+"'")
	require.FileExists(t, filepath.Join(u.state, ".upgrade-incomplete"))
}

func TestComposedHealthWakeUsesInstallingOwnerSocket(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	_, state := ownerHome(t)
	requests := ownerSocket(t, state, 204)
	authority := &maintenanceAuthority{state: state}
	require.NoError(t, authority.checkHealthWake(t.Context()))
	require.NoError(t, composedHealthWake(t.Context(), "upgrade-proof"))
	require.Equal(t, []string{"GET /maintenance/health/check", "POST /maintenance/health/wake"}, *requests)
}
