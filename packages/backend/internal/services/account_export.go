package services

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AccountExport wires the stores an account export reads. Git reads go
// straight to repo-host's upload-pack, so private repositories are exported
// without granting the operator access to them.
type AccountExport struct {
	Pool db.DBTX
	Git  interface {
		InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error)
		ProxyUploadPackBody(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error
	}
}

// WithAccountExport enables ExportUser.
func WithAccountExport(e AccountExport) AdminUserServiceOption {
	return func(s *AdminUserService) {
		s.export = &e
	}
}

// AccountExportFormat names the archive layout manifest.json describes.
const AccountExportFormat = "smithers-account-export/v1"

// AccountExportFile is one archived file: its size and SHA-256, and for a
// JSON list the number of records in it.
type AccountExportFile struct {
	Path    string `json:"path"`
	Bytes   int64  `json:"bytes"`
	SHA256  string `json:"sha256"`
	Records int    `json:"records,omitempty"`
}

// AccountExportRepository is one owned repository. Bundle is empty when the
// repository has no refs.
type AccountExportRepository struct {
	Name   string `json:"name"`
	Refs   int    `json:"refs"`
	Bundle string `json:"bundle,omitempty"`
}

// AccountExportManifest is manifest.json, the last file in the archive. It
// lists every other file.
type AccountExportManifest struct {
	Format       string                    `json:"format"`
	UserID       int64                     `json:"user_id"`
	Username     string                    `json:"username"`
	ExportedAt   time.Time                 `json:"exported_at"`
	Files        []AccountExportFile       `json:"files"`
	Repositories []AccountExportRepository `json:"repositories"`
}

// ExportUser writes a gzip-compressed tar archive of the account's data to w:
// profile.json, repositories.json with one cloneable git bundle per owned
// repository under repositories/, issues.json, comments.json,
// landing_requests.json, runs.json, and manifest.json listing them all.
// Every export writes an admin.user.export audit event.
func (s *AdminUserService) ExportUser(ctx context.Context, username string, w io.Writer) (AccountExportManifest, error) {
	if s.export == nil {
		return AccountExportManifest{}, pkgerrors.Internal("account export not configured")
	}
	lower := strings.ToLower(strings.TrimSpace(username))
	if lower == "" {
		return AccountExportManifest{}, pkgerrors.BadRequest("username is required")
	}
	q := db.New(s.export.Pool)
	user, err := q.AdminGetUserForErasure(ctx, lower)
	if stdErrors.Is(err, pgx.ErrNoRows) || err == nil && isErasedUser(user) {
		return AccountExportManifest{}, pkgerrors.NotFound("user not found")
	}
	if err != nil {
		return AccountExportManifest{}, pkgerrors.Internal("failed to look up user").WithCause(err)
	}

	manifest := AccountExportManifest{
		Format: AccountExportFormat, UserID: user.ID, Username: user.Username,
		ExportedAt: time.Now().UTC().Truncate(time.Second), Files: []AccountExportFile{}, Repositories: []AccountExportRepository{},
	}
	gz := gzip.NewWriter(w)
	archive := tar.NewWriter(gz)
	add := func(path string, size int64, body io.Reader) error {
		header := &tar.Header{Name: path, Mode: 0o644, Size: size, ModTime: manifest.ExportedAt, Typeflag: tar.TypeReg}
		if err := archive.WriteHeader(header); err != nil {
			return pkgerrors.Internal("failed to write export archive").WithCause(err)
		}
		if _, err := io.Copy(archive, body); err != nil {
			return pkgerrors.Internal("failed to write export archive").WithCause(err)
		}
		return nil
	}

	sections := []struct {
		path  string
		query func(context.Context, int64) (json.RawMessage, error)
	}{
		{"profile.json", q.AdminExportProfile},
		{"repositories.json", q.AdminExportRepositories},
		{"issues.json", q.AdminExportIssues},
		{"comments.json", q.AdminExportComments},
		{"landing_requests.json", q.AdminExportLandingRequests},
		{"runs.json", q.AdminExportRuns},
	}
	var repos []struct {
		Name string `json:"name"`
	}
	for _, section := range sections {
		raw, err := section.query(ctx, user.ID)
		if err != nil {
			return AccountExportManifest{}, pkgerrors.Internal("failed to read " + section.path).WithCause(err)
		}
		file := AccountExportFile{Path: section.path, Bytes: int64(len(raw)), SHA256: sha256Hex(string(raw))}
		if len(raw) > 0 && raw[0] == '[' {
			var records []json.RawMessage
			if err := json.Unmarshal(raw, &records); err != nil {
				return AccountExportManifest{}, pkgerrors.Internal("failed to decode " + section.path).WithCause(err)
			}
			file.Records = len(records)
		}
		if section.path == "repositories.json" {
			if err := json.Unmarshal(raw, &repos); err != nil {
				return AccountExportManifest{}, pkgerrors.Internal("failed to decode repositories").WithCause(err)
			}
		}
		if err := add(file.Path, file.Bytes, bytes.NewReader(raw)); err != nil {
			return AccountExportManifest{}, err
		}
		manifest.Files = append(manifest.Files, file)
	}

	for _, repo := range repos {
		file, refs, err := s.addRepositoryBundle(ctx, user.Username, repo.Name, add)
		if err != nil {
			return AccountExportManifest{}, err
		}
		entry := AccountExportRepository{Name: repo.Name, Refs: refs}
		if refs > 0 {
			entry.Bundle = file.Path
			manifest.Files = append(manifest.Files, file)
		}
		manifest.Repositories = append(manifest.Repositories, entry)
	}

	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return AccountExportManifest{}, pkgerrors.Internal("failed to encode manifest").WithCause(err)
	}
	if err := add("manifest.json", int64(len(body)), bytes.NewReader(body)); err != nil {
		return AccountExportManifest{}, err
	}
	if err := archive.Close(); err != nil {
		return AccountExportManifest{}, pkgerrors.Internal("failed to finish export archive").WithCause(err)
	}
	if err := gz.Close(); err != nil {
		return AccountExportManifest{}, pkgerrors.Internal("failed to finish export archive").WithCause(err)
	}
	if err := s.insertExportAudit(ctx, q, manifest); err != nil {
		return AccountExportManifest{}, err
	}
	return manifest, nil
}

// addRepositoryBundle bundles one repository into a temporary file, since a
// tar entry needs its size up front, then archives it.
func (s *AdminUserService) addRepositoryBundle(ctx context.Context, owner, repo string, add func(string, int64, io.Reader) error) (AccountExportFile, int, error) {
	tmp, err := os.CreateTemp("", "account-export-*.bundle")
	if err != nil {
		return AccountExportFile{}, 0, pkgerrors.Internal("failed to stage git bundle").WithCause(err)
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	hash := sha256.New()
	counter := &countingWriter{w: io.MultiWriter(tmp, hash)}
	refs, err := s.export.bundle(ctx, owner, repo, counter)
	if err != nil {
		return AccountExportFile{}, 0, pkgerrors.Internal(fmt.Sprintf("failed to bundle %s/%s", owner, repo)).WithCause(err)
	}
	if refs == 0 {
		return AccountExportFile{}, 0, nil
	}
	file := AccountExportFile{Path: "repositories/" + repo + ".bundle", Bytes: counter.n, SHA256: hex.EncodeToString(hash.Sum(nil))}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return AccountExportFile{}, 0, pkgerrors.Internal("failed to read git bundle").WithCause(err)
	}
	if err := add(file.Path, file.Bytes, tmp); err != nil {
		return AccountExportFile{}, 0, err
	}
	return file, refs, nil
}

type advertisedRef struct{ oid, name string }

// bundle writes a v2 git bundle of every ref upload-pack advertises: the
// bundle header lists the refs, and the pack upload-pack sends for "want
// every tip" follows it. It returns the ref count; an empty repository
// writes nothing.
func (e *AccountExport) bundle(ctx context.Context, owner, repo string, out io.Writer) (int, error) {
	advertisement, err := e.Git.InfoRefsUploadPack(ctx, owner, repo)
	if err != nil {
		return 0, err
	}
	refs, err := parseUploadPackAdvertisement(advertisement)
	if err != nil || len(refs) == 0 {
		return 0, err
	}
	var request bytes.Buffer
	wanted := map[string]bool{}
	for _, ref := range refs {
		if !wanted[ref.oid] {
			wanted[ref.oid] = true
			writePktLine(&request, "want "+ref.oid+"\n")
		}
	}
	request.WriteString("0000")
	writePktLine(&request, "done\n")

	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := e.Git.ProxyUploadPackBody(ctx, owner, repo, &request, writer)
		writer.CloseWithError(err)
		done <- err
	}()
	fail := func(err error) (int, error) {
		reader.CloseWithError(err)
		<-done
		return 0, err
	}
	response := bufio.NewReader(reader)
	if err := skipUploadPackAcks(response); err != nil {
		return fail(err)
	}
	var header strings.Builder
	header.WriteString("# v2 git bundle\n")
	for _, ref := range refs {
		header.WriteString(ref.oid + " " + ref.name + "\n")
	}
	header.WriteString("\n")
	if _, err := io.WriteString(out, header.String()); err != nil {
		return fail(err)
	}
	if _, err := io.Copy(out, response); err != nil {
		return fail(err)
	}
	if err := <-done; err != nil {
		return 0, err
	}
	return len(refs), nil
}

// parseUploadPackAdvertisement reads the v0 ref advertisement: one pkt-line
// per ref, capabilities after a NUL on the first, peeled tags marked ^{}.
func parseUploadPackAdvertisement(raw []byte) ([]advertisedRef, error) {
	var refs []advertisedRef
	for len(raw) > 0 {
		size, err := strconv.ParseUint(string(raw[:min(4, len(raw))]), 16, 16)
		if err != nil || len(raw) < 4 {
			return nil, fmt.Errorf("malformed ref advertisement")
		}
		if size == 0 {
			break
		}
		if size < 4 || int(size) > len(raw) {
			return nil, fmt.Errorf("malformed ref advertisement")
		}
		line := string(raw[4:size])
		raw = raw[size:]
		line, _, _ = strings.Cut(strings.TrimSuffix(line, "\n"), "\x00")
		oid, name, ok := strings.Cut(line, " ")
		if !ok || len(oid) < 40 {
			return nil, fmt.Errorf("malformed ref advertisement line %q", line)
		}
		if name == "capabilities^{}" || strings.HasSuffix(name, "^{}") {
			continue
		}
		refs = append(refs, advertisedRef{oid: oid, name: name})
	}
	return refs, nil
}

// skipUploadPackAcks consumes the NAK/ACK pkt-lines before the pack.
func skipUploadPackAcks(r *bufio.Reader) error {
	for {
		prefix, err := r.Peek(4)
		if err != nil {
			return fmt.Errorf("upload-pack sent no pack: %w", err)
		}
		if string(prefix) == "PACK" {
			return nil
		}
		size, err := strconv.ParseUint(string(prefix), 16, 16)
		if err != nil {
			return fmt.Errorf("upload-pack sent a malformed response")
		}
		if _, err := r.Discard(4); err != nil {
			return err
		}
		if size <= 4 {
			continue
		}
		payload := make([]byte, size-4)
		if _, err := io.ReadFull(r, payload); err != nil {
			return err
		}
		if msg, ok := strings.CutPrefix(string(payload), "ERR "); ok {
			return fmt.Errorf("upload-pack: %s", strings.TrimSpace(msg))
		}
	}
}

func writePktLine(b *bytes.Buffer, line string) {
	fmt.Fprintf(b, "%04x%s", len(line)+4, line)
}

// insertExportAudit records who exported which account; an export without
// its audit record is a failed export.
func (s *AdminUserService) insertExportAudit(ctx context.Context, q *db.Queries, manifest AccountExportManifest) error {
	actor, _ := AdminAuditActorFromContext(ctx)
	metadata, err := json.Marshal(map[string]any{
		"operator":     actor.Username,
		"files":        len(manifest.Files),
		"repositories": len(manifest.Repositories),
	})
	if err != nil {
		return pkgerrors.Internal("failed to encode export audit").WithCause(err)
	}
	params := db.InsertAuditLogParams{
		EventType:  "admin.user.export",
		ActorName:  actor.Username,
		TargetType: "user",
		TargetID:   pgtype.Int8{Int64: manifest.UserID, Valid: true},
		TargetName: manifest.Username,
		Action:     "export",
		Metadata:   metadata,
		IpAddress:  actor.IPAddress,
	}
	if actor.UserID != 0 {
		params.ActorID = pgtype.Int8{Int64: actor.UserID, Valid: true}
	}
	if err := q.InsertAuditLog(ctx, params); err != nil {
		return pkgerrors.Internal("failed to audit export").WithCause(err)
	}
	return nil
}
