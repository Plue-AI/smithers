package hostbackup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// UpgradeAuthority is the installing-user release/lifecycle seam. Continue
// execs the new bundle, carrying the backup path into migration and health-wake.
// Neither method may execute repository-produced programs on the host.
type UpgradeAuthority interface {
	BackupAuthority
	CheckUpgrade(context.Context) error
	BrewUpgrade(context.Context) error
	Continue(context.Context, string) error
}

type UpgradeConfig struct {
	BackupConfig
	Upgrade UpgradeAuthority
}

type UpgradeError struct {
	Backup string
	Cause  error
}

func (e *UpgradeError) Error() string {
	return fmt.Sprintf("upgrade incomplete: %v; restore with smthrs host restore %s", e.Cause, shellArgument(e.Backup))
}
func (e *UpgradeError) Unwrap() error { return e.Cause }
func shellArgument(s string) string   { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

// Upgrade publishes a verified bundle backup before invoking Homebrew. Once
// the durable marker exists, every error preserves the freeze and restore hint.
func Upgrade(ctx context.Context, cfg UpgradeConfig) (directory string, err error) {
	if cfg.Upgrade == nil || cfg.Bundle == "" {
		return "", errors.New("host_maintenance_unavailable: upgrade lifecycle and bundle required")
	}
	if err := cfg.Upgrade.CheckUpgrade(ctx); err != nil {
		return "", err
	}
	root, err := openSnapshot(cfg.State)
	if err != nil {
		return "", err
	}
	defer root.Close()
	if _, e := root.Lstat(".upgrade-incomplete"); !os.IsNotExist(e) {
		return "", errors.New("upgrade incomplete: restore the previous backup before upgrading")
	}
	lease := &upgradeLease{UpgradeAuthority: cfg.Upgrade}
	cfg.BackupConfig.Authority = lease
	directory, err = backup(ctx, cfg.BackupConfig, true)
	if err != nil {
		return directory, err
	}
	marked := false
	defer func() {
		if marked {
			if err != nil {
				err = &UpgradeError{Backup: directory, Cause: err}
			}
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		err = errors.Join(err, cfg.Upgrade.Reopen(cleanup, lease.op))
	}()
	work, stopRenewal := renewLease(ctx, cfg.Upgrade, lease.op)
	defer stopRenewal()
	if _, err = VerifySnapshotContext(work, directory); err != nil {
		return directory, err
	}
	if err = context.Cause(work); err != nil {
		return directory, err
	}
	marker, err := root.OpenFile(".upgrade-incomplete", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return directory, err
	}
	marked = true
	_, err = fmt.Fprintln(marker, directory)
	err = errors.Join(err, marker.Sync(), marker.Close(), syncRoot(root))
	if err != nil {
		return directory, err
	}
	if err = cfg.Upgrade.BrewUpgrade(work); err != nil {
		return directory, err
	}
	if err = cfg.Upgrade.Continue(work, directory); err != nil {
		return directory, err
	}
	// A successful exec never returns. Returning nil cannot substitute for the
	// new binary's authenticated migration/readiness/isolation receipts.
	return directory, errors.New("upgrade continuation returned without replacing the process")
}

func syncRoot(root *os.Root) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}

// Remember the exact operation so cleanup cannot reopen another owner lease.
type upgradeLease struct {
	UpgradeAuthority
	op string
}

func (a *upgradeLease) Freeze(ctx context.Context, op string) (time.Time, error) {
	a.op = op
	return a.UpgradeAuthority.Freeze(ctx, op)
}

// UpgradeContinuationAuthority is supplied by the new, verified release. Check
// refuses missing lifecycle and retained-disk validation providers before any
// migration. HealthWake permits only the freeze's isolated health grant.
type UpgradeContinuationAuthority interface {
	Check(context.Context) error
	Migrate(context.Context) error
	Ready(context.Context) error
	HealthWake(context.Context, string) error
	Reopen(context.Context, string) error
}

type UpgradeContinuationConfig struct {
	State, Backup string
	Version       Version
	Authority     UpgradeContinuationAuthority
}

// ContinueUpgrade is the new-binary half of upgrade. A return from migration
// alone never authorizes reopening. The durable guard survives failed checks.
func ContinueUpgrade(ctx context.Context, cfg UpgradeContinuationConfig) (err error) {
	defer func() {
		if err != nil {
			err = &UpgradeError{Backup: cfg.Backup, Cause: err}
		}
	}()
	if err = ctx.Err(); err != nil {
		return err
	}
	root, err := openSnapshot(cfg.State)
	if err != nil {
		return err
	}
	defer root.Close()
	marker, err := openRegular(root, ".upgrade-incomplete")
	if err != nil {
		return err
	}
	bytes, readErr := io.ReadAll(io.LimitReader(marker, 4097))
	err = errors.Join(readErr, marker.Close())
	if err != nil {
		return err
	}
	if len(bytes) > 4096 || string(bytes) != cfg.Backup+"\n" {
		return errors.New("upgrade recovery marker does not match backup")
	}
	snapshot, err := openSnapshot(cfg.Backup)
	if err != nil {
		return err
	}
	defer snapshot.Close()
	manifest, err := verifyPinnedManifest(ctx, snapshot, filepath.Base(cfg.Backup), &cfg.Version)
	if err != nil {
		return err
	}
	if cfg.Authority == nil {
		return errors.New("host_maintenance_unavailable: upgrade continuation providers required")
	}
	steps := []func(context.Context) error{cfg.Authority.Check, cfg.Authority.Migrate, cfg.Authority.Ready,
		func(ctx context.Context) error { return cfg.Authority.HealthWake(ctx, manifest.QuiesceOp) }}
	for _, step := range steps {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = step(ctx); err != nil {
			return err
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = root.Remove(".upgrade-incomplete"); err != nil {
		return err
	}
	err = syncRoot(root)
	if err == nil {
		err = cfg.Authority.Reopen(ctx, manifest.QuiesceOp)
	}
	if err != nil {
		// Failed resume keeps the next ordinary start on the recovery path.
		marker, e := root.OpenFile(".upgrade-incomplete", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e == nil {
			_, e = fmt.Fprintln(marker, cfg.Backup)
			e = errors.Join(e, marker.Sync(), marker.Close(), syncRoot(root))
		}
		return errors.Join(err, e)
	}
	return nil
}
