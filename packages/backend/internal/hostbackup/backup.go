package hostbackup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// BackupAuthority is the installing-owner maintenance bridge. Check includes
// merge/burst fences and all capture, persistence and runtime providers. Size
// and Summary are read from the database authority, never inferred from files.
type BackupAuthority interface {
	Check(context.Context) error
	DatabaseSize(context.Context) (uint64, error)
	Freeze(context.Context, string) (time.Time, error)
	Renew(context.Context, string) error
	Dump(context.Context, io.Writer) error
	Summary(context.Context) (Manifest, error)
	Reopen(context.Context, string) error
}

type BackupConfig struct {
	State, Bundle string
	Version       Version
	Authority     BackupAuthority
	Cloner        DirectoryCloner
}

// Backup coordinates a single quiescent snapshot and publishes MANIFEST.json
// last. Standalone backups reopen after capture; upgrade must keep its freeze
// independently until its recovery marker is durable.
// No incomplete directory is ever treated as a restorable backup.
func Backup(ctx context.Context, cfg BackupConfig) (directory string, err error) {
	if cfg.Authority == nil || cfg.Cloner == nil {
		return "", errors.New("host_maintenance_unavailable: backup providers required")
	}
	if err := cfg.Authority.Check(ctx); err != nil {
		return "", err
	}
	if cfg.Version.Schema < 1 || cfg.Version.PostgresMajor != 18 {
		return "", &Error{Code: WrongVersion, Path: "backup version"}
	}
	if _, _, err := releaseParts(cfg.Version.Release); err != nil {
		return "", err
	}
	if !filepath.IsAbs(cfg.State) {
		return "", &Error{Code: UnsafePath, Path: cfg.State}
	}
	root, err := openSnapshot(cfg.State)
	if err != nil {
		return "", err
	}
	defer root.Close()
	size, err := cfg.Authority.DatabaseSize(ctx)
	if err != nil {
		return "", err
	}
	if cfg.Bundle != "" {
		files, err := inventory(cfg.Bundle)
		if err != nil {
			return "", err
		}
		for _, file := range files {
			if file.Size < 0 || uint64(file.Size) > ^uint64(0)-size {
				return "", errors.New("backup size overflow")
			}
			size += uint64(file.Size)
		}
	}
	if err := CheckFreeSpace(cfg.State, size, FreeSpaceFloor); err != nil {
		return "", err
	}
	op := fmt.Sprintf("backup-%d", time.Now().UTC().UnixNano())
	since, err := cfg.Authority.Freeze(ctx, op)
	if err != nil {
		return "", err
	}
	// Cleanup uses a live context even after cancellation. Reopen must preserve
	// .upgrade-incomplete and failures remain part of the command's result.
	reopened := false
	defer func() {
		if reopened {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		err = errors.Join(err, cfg.Authority.Reopen(cleanup, op))
	}()
	work, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	renewDone := make(chan struct{})
	defer func() { cancel(nil); <-renewDone }()
	go func() {
		defer close(renewDone)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-work.Done():
				return
			case <-ticker.C:
				renewal, stop := context.WithTimeout(work, 5*time.Second)
				e := cfg.Authority.Renew(renewal, op)
				stop()
				if e != nil {
					cancel(e)
					return
				}
			}
		}
	}()
	// Validate the backup ancestor using the pinned STATE root before creating
	// secrets. A symlink at backups is never followed, even if confined.
	if info, e := root.Lstat("backups"); e == nil {
		if !info.IsDir() || info.Mode().Perm() != 0700 {
			return "", &Error{Code: UnsafePath, Path: "backups"}
		}
	} else if !os.IsNotExist(e) {
		return "", e
	} else if e = root.Mkdir("backups", 0700); e != nil {
		return "", e
	}
	partial := filepath.Join("backups", ".partial-"+op)
	if err := root.Mkdir(partial, 0700); err != nil {
		return "", err
	}
	backups, err := root.OpenRoot("backups")
	if err != nil {
		return "", err
	}
	defer backups.Close()
	stage, err := backups.OpenRoot(filepath.Base(partial))
	if err != nil {
		return "", err
	}
	defer stage.Close()
	dump, err := stage.OpenFile("postgres.dump", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	dumpErr := cfg.Authority.Dump(work, dump)
	if err := errors.Join(dumpErr, dump.Sync(), dump.Close()); err != nil {
		return "", err
	}
	if err := stage.Mkdir("state", 0700); err != nil {
		return "", err
	}
	source, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer source.Close()
	target, err := stage.Open("state")
	if err != nil {
		return "", err
	}
	defer target.Close()
	entries, err := source.ReadDir(-1)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		switch entry.Name() {
		case "backups", "logs", "postgres":
			continue
		}
		if err := context.Cause(work); err != nil {
			return "", err
		}
		if err := cfg.Cloner.CloneAt(source, entry.Name(), target, entry.Name()); err != nil {
			return "", err
		}
	}
	if cfg.Bundle != "" {
		bundleParent, err := openSnapshot(filepath.Dir(cfg.Bundle))
		if err != nil {
			return "", err
		}
		defer bundleParent.Close()
		bundleSource, err := bundleParent.Open(".")
		if err != nil {
			return "", err
		}
		defer bundleSource.Close()
		stageTarget, err := stage.Open(".")
		if err != nil {
			return "", err
		}
		defer stageTarget.Close()
		if err := cfg.Cloner.CloneAt(bundleSource, filepath.Base(cfg.Bundle), stageTarget, "bundle"); err != nil {
			return "", err
		}
	}
	manifest, err := cfg.Authority.Summary(work)
	if err != nil {
		return "", err
	}
	manifest.Version, manifest.SchemaVersion, manifest.PostgresMajor = cfg.Version.Release, cfg.Version.Schema, cfg.Version.PostgresMajor
	manifest.QuiesceOp, manifest.QuiesceTime = op, since
	if err := context.Cause(work); err != nil {
		return "", err
	}
	// Verify all authority bytes before publishing; sync files in addition to
	// the manifest and directory so power loss cannot publish unsynced payloads.
	files, err := inventoryRoot(stage)
	if err != nil {
		return "", err
	}
	for _, file := range files {
		f, e := openRegular(stage, file.Path)
		if e == nil {
			e = errors.Join(f.Sync(), f.Close())
		}
		if e != nil {
			return "", e
		}
	}
	if err := writeManifestRoot(backups, filepath.Base(partial), manifest); err != nil {
		return "", err
	}
	directory = filepath.Join(cfg.State, "backups", backupName(manifest))
	if err := cfg.Authority.Reopen(work, op); err != nil {
		return directory, err
	}
	reopened = true
	if err := Prune(filepath.Join(cfg.State, "backups"), 3); err != nil {
		return directory, err
	}
	return directory, nil
}
