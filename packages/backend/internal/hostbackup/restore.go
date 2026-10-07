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

// RestoreAuthority verifies the installing user, stopped-install lease and
// retained-disk isolation before any move. RestoreDatabase initializes only the
// supplied staging root using bundled PostgreSQL and forces machines asleep.
// StartRestored uses the recovery lifecycle while the marker remains durable;
// it returns only after readiness, with all restored machines asleep. The
// optional bundle path points into STATE, never to the source backup.
type RestoreAuthority interface {
	CheckStopped(context.Context) error
	CheckRetainedIsolation(context.Context, Manifest) error
	RestoreDatabase(context.Context, *os.Root, io.Reader, Version) error
	StartRestored(context.Context, string) error
}

type RestoreConfig struct {
	State, Backup string
	Version       Version
	Authority     RestoreAuthority
	Cloner        DirectoryCloner
}

// Restore stages verified trees and a fresh database before moving live data
// aside. On failure the retained live trees are never deleted and the recovery
// marker keeps ordinary startup closed until an owner restores again.
func Restore(ctx context.Context, cfg RestoreConfig) (at time.Time, err error) {
	snapshot, err := openSnapshot(cfg.Backup)
	if err != nil {
		return at, err
	}
	defer snapshot.Close()
	manifest, err := verifyPinnedManifest(snapshot, filepath.Base(cfg.Backup), &cfg.Version)
	if err != nil {
		return at, err
	}
	if cfg.Authority == nil || cfg.Cloner == nil {
		return at, errors.New("host_maintenance_unavailable: restore providers required")
	}
	if err = cfg.Authority.CheckStopped(ctx); err != nil {
		return at, err
	}
	if err = cfg.Authority.CheckRetainedIsolation(ctx, manifest); err != nil {
		return at, err
	}
	if !filepath.IsAbs(cfg.State) {
		return at, &Error{Code: UnsafePath, Path: cfg.State}
	}
	root, err := openSnapshot(cfg.State)
	if err != nil {
		return at, err
	}
	defer root.Close()
	if info, e := root.Lstat("backups"); e == nil {
		if !info.IsDir() || info.Mode().Perm() != 0700 {
			return at, &Error{Code: UnsafePath, Path: "backups"}
		}
	} else if !os.IsNotExist(e) {
		return at, e
	} else if e = root.Mkdir("backups", 0700); e != nil {
		return at, e
	}
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	stagingName := filepath.Join("backups", ".partial-restore-"+stamp)
	if err = root.Mkdir(stagingName, 0700); err != nil {
		return at, err
	}
	stage, err := root.OpenRoot(stagingName)
	if err != nil {
		return at, err
	}
	defer stage.Close()
	source, err := snapshot.OpenRoot("state")
	if err != nil {
		return at, err
	}
	defer source.Close()
	src, err := source.Open(".")
	if err != nil {
		return at, err
	}
	defer src.Close()
	dst, err := stage.Open(".")
	if err != nil {
		return at, err
	}
	defer dst.Close()
	entries, err := src.ReadDir(-1)
	if err != nil {
		return at, err
	}
	for _, entry := range entries {
		switch entry.Name() {
		case "backups", "postgres", "logs", ".upgrade-incomplete":
			return at, &Error{Code: UnsafePath, Path: "state/" + entry.Name()}
		}
		if err := ctx.Err(); err != nil {
			return at, err
		}
		if err = cfg.Cloner.CloneAt(src, entry.Name(), dst, entry.Name()); err != nil {
			return at, err
		}
	}
	// Check the cloned bytes against the pre-operation manifest before any live
	// tree is moved. This also rejects a substituted source after verification.
	files, err := inventoryRoot(stage)
	if err != nil {
		return at, err
	}
	expected := map[string]File{}
	for _, file := range manifest.Files {
		if strings.HasPrefix(file.Path, "state/") {
			expected[strings.TrimPrefix(file.Path, "state/")] = file
		}
	}
	for _, file := range files {
		want, ok := expected[file.Path]
		if !ok || want.Size != file.Size || want.SHA256 != file.SHA256 {
			return at, &Error{Code: HashMismatch, Path: file.Path}
		}
		delete(expected, file.Path)
	}
	if len(expected) != 0 {
		return at, &Error{Code: MissingFile, Path: "state"}
	}
	bundle := ""
	if info, e := snapshot.Lstat("bundle"); e == nil {
		if !info.IsDir() {
			return at, &Error{Code: UnsafePath, Path: "bundle"}
		}
		// A previous restore may have left a state bundle. Replace only the
		// staged copy after its state bytes have already been verified.
		if err = stage.RemoveAll("bundle"); err != nil {
			return at, err
		}
		backupDirectory, e := snapshot.Open(".")
		if e != nil {
			return at, e
		}
		err = cfg.Cloner.CloneAt(backupDirectory, "bundle", dst, "bundle")
		err = errors.Join(err, backupDirectory.Close())
		if err != nil {
			return at, err
		}
		if err = verifyRestoredBundle(stage, manifest); err != nil {
			return at, err
		}
		bundle = filepath.Join(cfg.State, "bundle")
	} else if !os.IsNotExist(e) {
		return at, e
	}
	dump, err := openRegular(snapshot, "postgres.dump")
	if err != nil {
		return at, err
	}
	restoreErr := cfg.Authority.RestoreDatabase(ctx, stage, dump, Version{manifest.Version, manifest.SchemaVersion, manifest.PostgresMajor})
	err = errors.Join(restoreErr, dump.Close())
	if err != nil {
		return at, err
	}
	// Revalidate the pinned source after loading: a source modified during the
	// database import cannot become an authority for this restore.
	if _, err = verifyPinnedManifest(snapshot, filepath.Base(cfg.Backup), &cfg.Version); err != nil {
		return at, err
	}
	if err = ctx.Err(); err != nil {
		return at, err
	}
	aside := filepath.Join("backups", "pre-restore-"+stamp)
	if err = root.Mkdir(aside, 0700); err != nil {
		return at, err
	}
	// Publish the guard atomically, including replacement of an old guard.
	// Never expose a marker-free interval before moving live authority trees.
	markerName := ".restore-marker-" + stamp
	marker, err := root.OpenFile(markerName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return at, err
	}
	_, err = fmt.Fprintln(marker, cfg.Backup)
	err = errors.Join(err, marker.Sync(), marker.Close())
	if err != nil {
		return at, err
	}
	if err = root.Rename(markerName, ".upgrade-incomplete"); err != nil {
		return at, err
	}
	if err = syncRoot(root); err != nil {
		return at, err
	}
	if err = syncTree(stage); err != nil {
		return at, err
	}
	live, err := root.Open(".")
	if err != nil {
		return at, err
	}
	defer live.Close()
	liveEntries, err := live.ReadDir(-1)
	if err != nil {
		return at, err
	}
	for _, entry := range liveEntries {
		if entry.Name() == "backups" || entry.Name() == ".upgrade-incomplete" {
			continue
		}
		if err = root.Rename(entry.Name(), filepath.Join(aside, entry.Name())); err != nil {
			return at, err
		}
	}
	restored, err := dst.ReadDir(-1)
	if err != nil {
		return at, err
	}
	for _, entry := range restored {
		if err = root.Rename(filepath.Join(stagingName, entry.Name()), entry.Name()); err != nil {
			return at, err
		}
	}
	if err = root.Remove(stagingName); err != nil {
		return at, err
	}
	if err = live.Sync(); err != nil {
		return at, err
	}
	// Ordinary starts remain refused throughout recovery startup. The lifecycle
	// authority must explicitly support this guarded owner operation.
	if err = cfg.Authority.StartRestored(ctx, bundle); err != nil {
		return at, err
	}
	if err = root.Remove(".upgrade-incomplete"); err != nil {
		return at, err
	}
	if err = live.Sync(); err != nil {
		return at, err
	}
	return manifest.QuiesceTime, nil
}

func verifyRestoredBundle(stage *os.Root, manifest Manifest) error {
	root, err := stage.OpenRoot("bundle")
	if err != nil {
		return err
	}
	defer root.Close()
	files, err := inventoryRoot(root)
	if err != nil {
		return err
	}
	expected := map[string]File{}
	for _, file := range manifest.Files {
		if strings.HasPrefix(file.Path, "bundle/") {
			expected[strings.TrimPrefix(file.Path, "bundle/")] = file
		}
	}
	for _, file := range files {
		want, ok := expected[file.Path]
		if !ok || want.Size != file.Size || want.SHA256 != file.SHA256 {
			return &Error{Code: HashMismatch, Path: "bundle/" + file.Path}
		}
		delete(expected, file.Path)
	}
	if len(expected) != 0 {
		return &Error{Code: MissingFile, Path: "bundle"}
	}
	return nil
}
