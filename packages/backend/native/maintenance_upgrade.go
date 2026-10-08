package native

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
)

// Homebrew's fixed places on Apple Silicon. Nothing is found through PATH.
const (
	homebrewProgram = "/opt/homebrew/bin/brew"
	// homebrewKeg is the link Homebrew repoints at the newest installed
	// version's bundle.
	homebrewKeg = "/opt/homebrew/opt/smithers/libexec"
)

// errHealthWakeUnavailable is why upgrade stays closed today. After the new
// release migrates, the health check wakes one machine as the freeze's only
// grant (spec §16.4 step 6). That grant belongs to machine admission, which
// has not composed it; an upgrade must not reopen an install it could not
// prove wakes a machine.
var errHealthWakeUnavailable = errors.New("host_maintenance_unavailable: upgrade health wake requires machine admission (T-MCH-06)")

// upgradeAuthority is the installing user's half of `smthrs host upgrade`
// (spec §16.4): the owner bridge takes the backup, Homebrew replaces the
// bundle, and this process becomes the new bundle's backend to finish.
type upgradeAuthority struct {
	*maintenanceAuthority
	host *maintenanceHost
	// brew and keg are homebrewProgram and homebrewKeg; tests point them at
	// a stand-in.
	brew, keg string
	// healthWake is the new release's isolated wake. Nil refuses the upgrade
	// before it freezes.
	healthWake func(ctx context.Context, op string) error
	// replace turns this process into another program (execve). It returns
	// only on failure.
	replace func(program string, args, env []string) error
}

// CheckUpgrade refuses before any freeze, backup or Homebrew run unless the
// whole upgrade can finish.
func (a *upgradeAuthority) CheckUpgrade(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.healthWake == nil {
		return errHealthWakeUnavailable
	}
	// Homebrew upgrades the keg it links. An install started from another
	// bundle would keep running that bundle after the upgrade.
	linked, err := filepath.EvalSymlinks(a.keg)
	if err != nil || linked != a.host.bundle.Root() {
		return fmt.Errorf("host_maintenance_unavailable: upgrade requires the Homebrew install at %s; this install runs %s", a.keg, a.host.bundle.Root())
	}
	info, err := os.Stat(a.brew)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return fmt.Errorf("host_maintenance_unavailable: Homebrew is not installed at %s", a.brew)
	}
	return nil
}

// homebrewLimit bounds `brew upgrade`, which downloads the next bundle.
const homebrewLimit = 30 * time.Minute

// BrewUpgrade runs `brew upgrade smithers` as the installing user. The backup
// already holds the running bundle, so the previous version survives a
// `brew cleanup`.
func (a *upgradeAuthority) BrewUpgrade(ctx context.Context) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	bounded, cancel := context.WithTimeout(ctx, homebrewLimit)
	defer cancel()
	status, err := a.host.run(bounded, a.brew, []string{"upgrade", "smithers"}, []string{"HOME=" + home, "PATH=" + filepath.Dir(a.brew) + ":/usr/bin:/bin:/usr/sbin:/sbin"})
	if err := ctx.Err(); err != nil {
		return err
	}
	if err != nil || status != 0 {
		return errors.New("brew upgrade smithers failed; run it for the reason")
	}
	return nil
}

// Continue replaces this process with the upgraded bundle's backend, which
// migrates, checks health and reopens. `brew upgrade` has replaced the
// programs this process came from, so nothing more runs from them.
func (a *upgradeAuthority) Continue(ctx context.Context, backup string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	linked, err := filepath.EvalSymlinks(a.keg)
	if err != nil {
		return fmt.Errorf("locate the upgraded bundle: %w", err)
	}
	if linked == a.host.bundle.Root() {
		return errors.New("Homebrew installed no newer bundle; smithers is already up to date")
	}
	upgraded, err := installbundle.Open(linked)
	if err != nil {
		return err
	}
	backend := upgraded.Program(installbundle.BackendPath)
	if err := backend.Check(); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	env := []string{"HOME=" + home, "PATH=" + upgraded.Path("bin") + ":/usr/bin:/bin:/usr/sbin:/sbin"}
	replace := a.replace
	if replace == nil {
		replace = syscall.Exec
	}
	return replace(backend.Path(), []string{filepath.Base(backend.Path()), "host-maintenance", "upgrade-continue", backup}, env)
}

// upgradeContinuation is the upgraded release's half: it starts the install
// on its own bundle while the marker is durable, which migrates forward,
// then checks health and reopens. Every failure keeps the marker, so the
// install stays closed and the command prints the restore that returns to
// the previous version.
type upgradeContinuation struct {
	owner         *maintenanceAuthority
	host          *maintenanceHost
	state, backup string
	release       Version
	healthWake    func(ctx context.Context, op string) error
	// revoke removes the start grant. It is set once Migrate has granted it.
	revoke func() error
}

func (c *upgradeContinuation) Check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.healthWake == nil {
		return errHealthWakeUnavailable
	}
	if _, err := c.host.program(bundleCLI); err != nil {
		return fmt.Errorf("host_maintenance_unavailable: %w", err)
	}
	return nil
}

// Migrate restarts the install on the upgraded bundle. Its backend applies
// the forward migrations before it serves; the freeze stays closed because
// the marker exists. The grant covers every start until the command ends.
func (c *upgradeContinuation) Migrate(ctx context.Context) error {
	cli, err := c.host.program(bundleCLI)
	if err != nil {
		return fmt.Errorf("host_maintenance_unavailable: %w", err)
	}
	env, err := c.host.environment()
	if err != nil {
		return err
	}
	if c.revoke, err = grantRecoveryStart(c.state, c.backup); err != nil {
		return err
	}
	bounded, cancel := context.WithTimeout(ctx, recoveryStartLimit)
	defer cancel()
	target := c.host.bundle.Root()
	status, runErr := c.host.run(bounded, cli, []string{"host", "start", "--bundle", target}, env)
	if err := ctx.Err(); err != nil {
		return err
	}
	if runErr != nil || (status != 0 && status != 3) {
		return fmt.Errorf("host_start_failed: the upgraded install did not start on %s", target)
	}
	return nil
}

// Ready requires the upgraded backend to have published its version: it
// writes version.env only after every migration applied.
func (c *upgradeContinuation) Ready(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	published, err := ReadVersion(filepath.Join(c.state, "version.env"))
	if err != nil {
		return fmt.Errorf("upgraded install published no version: %w", err)
	}
	if published != c.release {
		return fmt.Errorf("upgraded install serves version %s, schema %s; expected %s, schema %s", published.Version, published.Schema, c.release.Version, c.release.Schema)
	}
	return nil
}

func (c *upgradeContinuation) HealthWake(ctx context.Context, op string) error {
	if c.healthWake == nil {
		return errHealthWakeUnavailable
	}
	return c.healthWake(ctx, op)
}

func (c *upgradeContinuation) Reopen(ctx context.Context, op string) error {
	return c.owner.Reopen(ctx, op)
}

// revokeGrant removes the start grant. It runs however the continuation ends:
// a failed upgrade must leave no start the marker does not refuse.
func (c *upgradeContinuation) revokeGrant() error {
	if c.revoke == nil {
		return nil
	}
	return c.revoke()
}

// continueUpgrade is `host-maintenance upgrade-continue <backup>`, the
// command the previous release's Continue becomes.
func continueUpgrade(ctx context.Context, executable func() (string, error), state, backup string, version hostbackup.Version, healthWake func(context.Context, string) error) (err error) {
	host, hostErr := openMaintenanceHost(executable, state)
	if hostErr != nil {
		// Still report through ContinueUpgrade, so the refusal carries the
		// restore command.
		return hostbackup.ContinueUpgrade(ctx, hostbackup.UpgradeContinuationConfig{State: state, Backup: backup, Version: version, Authority: unavailableContinuation{fmt.Errorf("host_maintenance_unavailable: upgrade continues from an installed bundle: %w", hostErr)}})
	}
	continuation := &upgradeContinuation{
		owner: &maintenanceAuthority{state: state, version: version}, host: host, state: state, backup: backup,
		release:    Version{version.Release, fmt.Sprint(version.Schema), fmt.Sprint(version.PostgresMajor)},
		healthWake: healthWake,
	}
	defer func() { err = errors.Join(err, continuation.revokeGrant()) }()
	return hostbackup.ContinueUpgrade(ctx, hostbackup.UpgradeContinuationConfig{State: state, Backup: backup, Version: version, Authority: continuation})
}

// unavailableContinuation refuses at its first step.
type unavailableContinuation struct{ err error }

func (u unavailableContinuation) Check(context.Context) error              { return u.err }
func (u unavailableContinuation) Migrate(context.Context) error            { return u.err }
func (u unavailableContinuation) Ready(context.Context) error              { return u.err }
func (u unavailableContinuation) HealthWake(context.Context, string) error { return u.err }
func (u unavailableContinuation) Reopen(context.Context, string) error     { return u.err }
