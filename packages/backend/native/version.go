package native

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
)

// Version is the existing version.env contract, shared by the bundle and state.
type Version struct{ Version, Schema, Postgres string }

// GuardError preserves the refusal and the exact recovery command.
type GuardError struct {
	Reason, Backup string
	Cause          error
}

func (e *GuardError) Error() string {
	text := e.Reason
	if e.Cause != nil {
		text += ": " + e.Cause.Error()
	}
	if e.Backup != "" {
		text += "; smthrs host restore " + shellArg(e.Backup)
	}
	return text
}
func (e *GuardError) Unwrap() error { return e.Cause }
func shellArg(s string) string {
	if shellValue.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

var shellValue = regexp.MustCompile(`^[A-Za-z0-9/._+-]+$`)

var fieldValue = regexp.MustCompile(`^[A-Za-z0-9._+-]+$`)

func fields(path string) (map[string]string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, line := range strings.Split(string(body), "\n") {
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || !fieldValue.MatchString(value) || out[key] != "" {
			return nil, fmt.Errorf("invalid field in %s", path)
		}
		out[key] = value
	}
	return out, nil
}
func versionFields(f map[string]string) (Version, error) {
	v := Version{f["SMITHERS_DISTRIBUTION_VERSION"], f["SMITHERS_SCHEMA_VERSION"], f["SMITHERS_POSTGRES_MAJOR"]}
	if err := v.validate(); err != nil {
		return Version{}, err
	}
	return v, nil
}
func (v Version) validate() error {
	for _, value := range []string{v.Version, v.Schema, v.Postgres} {
		if !fieldValue.MatchString(value) {
			return errors.New("version manifest requires version, schema and PostgreSQL major")
		}
	}
	return nil
}
func ReadVersion(path string) (Version, error) {
	f, err := fields(path)
	if err != nil {
		return Version{}, err
	}
	return versionFields(f)
}
func versionText(v Version) string {
	return fmt.Sprintf("SMITHERS_DISTRIBUTION_VERSION=%s\nSMITHERS_SCHEMA_VERSION=%s\nSMITHERS_POSTGRES_MAJOR=%s\n", v.Version, v.Schema, v.Postgres)
}
func syncDir(root string) error {
	f, err := os.Open(root)
	if err != nil {
		return err
	}
	return errors.Join(f.Sync(), f.Close())
}
func writeDurable(path string, body string) error {
	root := filepath.Dir(path)
	f, err := os.CreateTemp(root, filepath.Base(path)+".tmp.*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := io.WriteString(f, body)
	err = errors.Join(writeErr, f.Sync(), f.Close())
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	return syncDir(root)
}
func WriteVersion(root string, v Version) error {
	if err := v.validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	return writeDurable(filepath.Join(root, "version.env"), versionText(v))
}
func requireCompleteUpgrade(root string) error {
	path := filepath.Join(root, ".upgrade-incomplete")
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return &GuardError{Reason: "upgrade incomplete; recovery marker is unreadable", Cause: err}
	}
	backup := strings.TrimSpace(string(body))
	if backup == "" {
		return &GuardError{Reason: "upgrade incomplete; recovery marker has no verified backup"}
	}
	return &GuardError{Reason: "upgrade incomplete; keep the app stopped", Backup: backup}
}
func matchVersion(state, release Version) error {
	if state.Postgres != release.Postgres {
		return &GuardError{Reason: fmt.Sprintf("backup tools require PostgreSQL %s, state declares %s", release.Postgres, state.Postgres)}
	}
	oldSchema, oldErr := strconv.ParseUint(state.Schema, 10, 64)
	newSchema, newErr := strconv.ParseUint(release.Schema, 10, 64)
	if oldErr != nil || newErr != nil {
		return &GuardError{Reason: "schema versions must be numeric"}
	}
	if oldSchema > newSchema {
		return &GuardError{Reason: fmt.Sprintf("state schema %s is newer than binary schema %s", state.Schema, release.Schema), Backup: "<backup>"}
	}
	if state.Version != "dev" && release.Version != "dev" {
		order, err := compareRelease(state.Version, release.Version)
		if err != nil {
			return err
		}
		if order > 0 {
			return &GuardError{Reason: fmt.Sprintf("state version %s is newer than binary version %s", state.Version, release.Version), Backup: "<backup>"}
		}
	}
	return nil
}

// compareRelease orders two release versions by SemVer precedence: X.Y.Z
// numerically, then a prerelease (1.0.0-rc.1) before its release, prerelease
// identifiers numerically when both are numbers and in ASCII order otherwise.
func compareRelease(a, b string) (int, error) {
	order, err := hostbackup.CompareRelease(a, b)
	if err != nil {
		return 0, &GuardError{Reason: "release versions must be X.Y.Z, X.Y.Z-prerelease or dev", Cause: err}
	}
	return order, nil
}

func VerifyVersion(root string, release Version) error {
	if err := requireCompleteUpgrade(root); err != nil {
		return err
	}
	state, err := ReadVersion(filepath.Join(root, "version.env"))
	if err != nil {
		return &GuardError{Reason: "state version manifest is missing or invalid; restore it with the data", Cause: err}
	}
	return matchVersion(state, release)
}

// EnsureVersion checks persisted guards before PostgreSQL starts. Unversioned
// state is adopted by Run only after the database migration guard succeeds.
func EnsureVersion(root string, release Version) error {
	if root == "" {
		return errors.New("install state directory is required")
	}
	if err := requireCompleteUpgrade(root); err != nil {
		return err
	}
	if err := release.validate(); err != nil {
		return err
	}
	if _, err := os.Lstat(filepath.Join(root, "version.env")); !os.IsNotExist(err) {
		return VerifyVersion(root, release)
	}
	return nil
}

// VerifyBackup uses the canonical Mac manifest verifier. The legacy archive
// decoder remains solely for previously persisted backups.
func VerifyBackup(root string) (Version, error) {
	if _, err := os.Lstat(filepath.Join(root, "MANIFEST.json")); err == nil {
		// The JSON contract is verified by hostbackup only. Use the recorded
		// version as the minimum here; callers separately check their bundle.
		m, err := hostbackup.VerifySnapshot(root)
		if err != nil {
			return Version{}, err
		}
		return Version{m.Version, strconv.Itoa(m.SchemaVersion), strconv.Itoa(m.PostgresMajor)}, nil
	} else if !os.IsNotExist(err) {
		return Version{}, err
	}
	f, err := fields(filepath.Join(root, "MANIFEST"))
	if err != nil {
		return Version{}, &GuardError{Reason: "backup is incomplete", Backup: root, Cause: err}
	}
	v, err := versionFields(f)
	if err != nil {
		return Version{}, err
	}
	for _, file := range []struct{ name, key string }{{"postgres.dump", "POSTGRES_SHA256"}, {"files.tar", "FILES_SHA256"}} {
		input, err := os.Open(filepath.Join(root, file.name))
		if err != nil {
			return Version{}, err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, input)
		err = errors.Join(copyErr, input.Close())
		if err != nil {
			return Version{}, err
		}
		if fmt.Sprintf("%x", hash.Sum(nil)) != f[file.key] {
			return Version{}, &GuardError{Reason: file.name + " checksum failed", Backup: root}
		}
	}
	input, err := os.Open(filepath.Join(root, "files.tar"))
	if err != nil {
		return Version{}, err
	}
	defer input.Close()
	reader := tar.NewReader(input)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Version{}, err
		}
		if strings.HasPrefix(header.Name, "/") {
			return Version{}, errors.New("file archive contains an unsafe path")
		}
		for _, part := range strings.Split(header.Name, "/") {
			if part == ".." {
				return Version{}, errors.New("file archive contains an unsafe path")
			}
		}
	}
	return v, nil
}

// CheckRestore retains the shell's stopped-install and empty-target guards,
// accepting a forward-compatible installed bundle for the Mac JSON contract.
// Actual restore stays dark until the quiesce and bundle contracts are available.
func CheckRestore(backup string, release Version, target string, running bool) error {
	if running {
		return &GuardError{Reason: "restore refuses a running install", Backup: backup}
	}
	v, err := VerifyBackup(backup)
	if err != nil {
		return err
	}
	_, jsonErr := os.Lstat(filepath.Join(backup, "MANIFEST.json"))
	if os.IsNotExist(jsonErr) && v != release {
		return &GuardError{Reason: "backup is incompatible with the bundle", Backup: backup}
	}
	if err := matchVersion(v, release); err != nil {
		return &GuardError{Reason: "backup is incompatible with the bundle", Backup: backup, Cause: err}
	}
	entries, err := os.ReadDir(target)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != ".maintenance.lock" {
			return &GuardError{Reason: "restore target data root is not empty", Backup: backup}
		}
	}
	return nil
}

// UpgradeSteps is the unmounted migration boundary. The caller must own the
// quiesce and verified backup; absent dependencies refuse before writing a marker.
type UpgradeSteps struct {
	Migrate      func(context.Context) error
	writeVersion func(string, Version) error
}

func Upgrade(ctx context.Context, root, backup string, release Version, steps *UpgradeSteps) error {
	if err := requireCompleteUpgrade(root); err != nil {
		return err
	}
	if err := release.validate(); err != nil {
		return err
	}
	state, err := ReadVersion(filepath.Join(root, "version.env"))
	if err != nil {
		return err
	}
	v, err := VerifyBackup(backup)
	if err != nil {
		return err
	}
	if v != state {
		return &GuardError{Reason: "backup does not match the installed pre-upgrade state", Backup: backup}
	}
	if state.Postgres != release.Postgres {
		return &GuardError{Reason: "PostgreSQL major upgrades require a separate dump and restore", Backup: backup}
	}
	oldSchema, err := strconv.ParseUint(state.Schema, 10, 64)
	if err != nil {
		return &GuardError{Reason: "schema versions must be numeric", Backup: backup}
	}
	newSchema, err := strconv.ParseUint(release.Schema, 10, 64)
	if err != nil {
		return &GuardError{Reason: "schema versions must be numeric", Backup: backup}
	}
	if oldSchema > newSchema {
		return &GuardError{Reason: fmt.Sprintf("schema downgrade from %s to %s is refused", state.Schema, release.Schema), Backup: backup}
	}
	if state.Version == release.Version {
		return &GuardError{Reason: "state already matches bundle version " + release.Version, Backup: backup}
	}
	if state.Version != "dev" && release.Version != "dev" {
		order, err := compareRelease(state.Version, release.Version)
		if err != nil {
			return err
		}
		if order > 0 {
			return &GuardError{Reason: fmt.Sprintf("release downgrade from %s to %s is refused", state.Version, release.Version), Backup: backup}
		}
	}
	if steps == nil || steps.Migrate == nil {
		return errors.New("upgrade dependencies are unavailable")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := writeDurable(filepath.Join(root, ".upgrade-incomplete"), backup+"\n"); err != nil {
		return err
	}
	fail := func(err error) error {
		return &GuardError{Reason: "upgrade failed; keep the app stopped. Recovery returns to the backup point; later changes are lost", Backup: backup, Cause: err}
	}
	if err := steps.Migrate(ctx); err != nil {
		return fail(err)
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	write := steps.writeVersion
	if write == nil {
		write = WriteVersion
	}
	if err := write(root, release); err != nil {
		return fail(err)
	}
	if err := os.Remove(filepath.Join(root, ".upgrade-incomplete")); err != nil {
		return fail(err)
	}
	return syncDir(root)
}
