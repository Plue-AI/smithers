package services

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Sandbox environment images are the NixOS compute path for kind=vm and
// kind=desktop workspaces. nix/cloudbuild.yaml builds an image whose tag is
// the closure hash of the NixOS toplevel (nix/modules/base.nix + the
// repository's .smithers/environment.nix [+ desktop.nix]); the registrar
// (scripts/build-nix-environment.ts) records it here. Workspace creation
// resolves the newest ready image for (repository, kind), falling back to the
// platform base image (repository_id NULL), and boots it with the worker's
// PID-1 init handoff. Registering an image also bakes its golden snapshot so
// the second boot of every closure clones a disk instead of pulling.

var (
	sandboxEnvironmentClosureHashPattern = regexp.MustCompile(`^[0-9a-z]{32}$`)
	// Registry references: host[/path]:tag or @sha256:digest; no whitespace.
	sandboxEnvironmentImagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$`)
)

// SandboxEnvironmentImageQuerier is the persistence surface (generated sqlc).
type SandboxEnvironmentImageQuerier interface {
	UpsertSandboxEnvironmentImage(ctx context.Context, arg runtimeports.UpsertSandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error)
	GetLatestReadySandboxEnvironmentImage(ctx context.Context, arg runtimeports.GetLatestReadySandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error)
	ListSandboxEnvironmentImages(ctx context.Context, repositoryID pgtype.Int8) ([]runtimeports.SandboxEnvironmentImage, error)
	RetireSandboxEnvironmentImage(ctx context.Context, arg runtimeports.RetireSandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error)
}

// SandboxEnvironmentImageResponse is the API representation of one image.
type SandboxEnvironmentImageResponse struct {
	ID string `json:"id"`
	// RepositoryID is 0 for platform base images.
	RepositoryID   int64  `json:"repository_id"`
	Kind           string `json:"kind"`
	Source         string `json:"source"`
	SourceRevision string `json:"source_revision"`
	ClosureHash    string `json:"closure_hash"`
	Image          string `json:"image"`
	Status         string `json:"status"`
	// GoldenSnapshotID is the ready Microsandbox snapshot baked from this
	// image, or "" while the first bake is still running.
	GoldenSnapshotID string    `json:"golden_snapshot_id"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// RegisterSandboxEnvironmentImageInput registers a built image.
type RegisterSandboxEnvironmentImageInput struct {
	// RepositoryID 0 registers a platform base image (admin only).
	RepositoryID   int64
	Kind           string
	Source         string
	SourceRevision string
	ClosureHash    string
	Image          string
	CreatedBy      int64
}

// SandboxEnvironmentImageService registers, lists, and resolves images.
type SandboxEnvironmentImageService struct {
	q      SandboxEnvironmentImageQuerier
	golden *GoldenSnapshotService
	// bakeRequest returns the builder request for an image: the exact
	// kind=vm/desktop workspace request, repository-agnostic, booting Image.
	bakeRequest func(image runtimeports.SandboxEnvironmentImage) sandbox.CreateRequest
}

// SandboxEnvironmentImageServiceOption configures optional dependencies.
type SandboxEnvironmentImageServiceOption func(*SandboxEnvironmentImageService)

// WithSandboxEnvironmentImageGoldenSnapshots wires per-closure golden
// snapshot baking. bakeRequest is WorkspaceService.NixBakeVMRequest.
func WithSandboxEnvironmentImageGoldenSnapshots(golden *GoldenSnapshotService, bakeRequest func(runtimeports.SandboxEnvironmentImage) sandbox.CreateRequest) SandboxEnvironmentImageServiceOption {
	return func(s *SandboxEnvironmentImageService) {
		s.golden = golden
		s.bakeRequest = bakeRequest
	}
}

// NewSandboxEnvironmentImageService constructs the service.
func NewSandboxEnvironmentImageService(q SandboxEnvironmentImageQuerier, opts ...SandboxEnvironmentImageServiceOption) *SandboxEnvironmentImageService {
	s := &SandboxEnvironmentImageService{q: q}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

func repositoryIDArg(repositoryID int64) pgtype.Int8 {
	if repositoryID <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: repositoryID, Valid: true}
}

// Register validates and upserts an image, then bakes its golden snapshot in
// the background. Same closure hash for the same (repository, kind) is an
// idempotent refresh. A new platform base image atomically retires the prior
// ready base of the same kind in the upsert query.
func (s *SandboxEnvironmentImageService) Register(ctx context.Context, input RegisterSandboxEnvironmentImageInput) (SandboxEnvironmentImageResponse, error) {
	if s == nil || s.q == nil {
		return SandboxEnvironmentImageResponse{}, pkgerrors.Internal("environment image store unavailable")
	}
	kind := strings.TrimSpace(input.Kind)
	if kind != "vm" && kind != "desktop" {
		return SandboxEnvironmentImageResponse{}, pkgerrors.BadRequest("kind must be vm or desktop")
	}
	closure := strings.TrimSpace(input.ClosureHash)
	if !sandboxEnvironmentClosureHashPattern.MatchString(closure) {
		return SandboxEnvironmentImageResponse{}, pkgerrors.BadRequest("closure_hash must be the 32-character nix store hash of the NixOS toplevel")
	}
	image := strings.TrimSpace(input.Image)
	if image == "" || len(image) > 512 || !sandboxEnvironmentImagePattern.MatchString(image) {
		return SandboxEnvironmentImageResponse{}, pkgerrors.BadRequest("image must be a registry reference (host/path:tag)")
	}
	if !strings.Contains(image, ":"+closure) && !strings.Contains(image, "-"+closure) {
		return SandboxEnvironmentImageResponse{}, pkgerrors.BadRequest("image tag must carry the closure hash")
	}
	source := strings.TrimSpace(input.Source)
	if source == "" {
		source = defaultWorkspaceEnvironmentSource
	}
	if source != defaultWorkspaceEnvironmentSource {
		return SandboxEnvironmentImageResponse{}, pkgerrors.BadRequest("source must be " + defaultWorkspaceEnvironmentSource)
	}
	revision := strings.TrimSpace(input.SourceRevision)
	if len(revision) > 128 {
		return SandboxEnvironmentImageResponse{}, pkgerrors.BadRequest("source_revision is too long")
	}
	row, err := s.q.UpsertSandboxEnvironmentImage(ctx, runtimeports.UpsertSandboxEnvironmentImageParams{
		RepositoryID:   repositoryIDArg(input.RepositoryID),
		Kind:           kind,
		Source:         source,
		SourceRevision: revision,
		ClosureHash:    closure,
		Image:          image,
		CreatedBy:      repositoryIDArg(input.CreatedBy),
	})
	if err != nil {
		return SandboxEnvironmentImageResponse{}, pkgerrors.Internal("register environment image: " + err.Error())
	}
	s.ensureGoldenSnapshot(ctx, row)
	slog.Info("environment image registered", "kind", kind, "repository_id", input.RepositoryID, "closure_hash", closure, "image", image)
	return s.toResponse(ctx, row), nil
}

// ensureGoldenSnapshot starts the per-closure bake when snapshots are wired
// (and enabled: see nixGoldenSnapshotsEnabled).
func (s *SandboxEnvironmentImageService) ensureGoldenSnapshot(ctx context.Context, row runtimeports.SandboxEnvironmentImage) {
	if s.golden == nil || s.bakeRequest == nil || !nixGoldenSnapshotsEnabled {
		return
	}
	image := row
	s.golden.EnsureBake(ctx, goldenSnapshotKeyForImage(image.Kind, image.ClosureHash), func() sandbox.CreateRequest {
		return s.bakeRequest(image)
	})
}

// List returns the images registered for a repository (0 = platform base).
func (s *SandboxEnvironmentImageService) List(ctx context.Context, repositoryID int64) ([]SandboxEnvironmentImageResponse, error) {
	if s == nil || s.q == nil {
		return nil, pkgerrors.Internal("environment image store unavailable")
	}
	rows, err := s.q.ListSandboxEnvironmentImages(ctx, repositoryIDArg(repositoryID))
	if err != nil {
		return nil, pkgerrors.Internal("list environment images: " + err.Error())
	}
	out := make([]SandboxEnvironmentImageResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.toResponse(ctx, row))
	}
	return out, nil
}

// Retire marks an image unusable for new workspaces. Running workspaces are
// untouched; the next create resolves the previous ready image.
func (s *SandboxEnvironmentImageService) Retire(ctx context.Context, repositoryID int64, id string) (SandboxEnvironmentImageResponse, error) {
	if s == nil || s.q == nil {
		return SandboxEnvironmentImageResponse{}, pkgerrors.Internal("environment image store unavailable")
	}
	row, err := s.q.RetireSandboxEnvironmentImage(ctx, runtimeports.RetireSandboxEnvironmentImageParams{
		ID:           strings.TrimSpace(id),
		RepositoryID: repositoryIDArg(repositoryID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SandboxEnvironmentImageResponse{}, pkgerrors.NotFound("environment image not found")
		}
		return SandboxEnvironmentImageResponse{}, pkgerrors.Internal("retire environment image: " + err.Error())
	}
	return s.toResponse(ctx, row), nil
}

// Resolve returns the image a new workspace of kind boots: the repository's
// newest ready image, else the platform base image for the kind.
func (s *SandboxEnvironmentImageService) Resolve(ctx context.Context, repositoryID int64, kind string) (runtimeports.SandboxEnvironmentImage, error) {
	if s == nil || s.q == nil {
		return runtimeports.SandboxEnvironmentImage{}, pkgerrors.Internal("environment image store unavailable")
	}
	// RFD-004: agent workspaces are container guests; they never boot a
	// NixOS closure image.
	kind = sandboxKindForWorkspace(kind)
	if kind == "container" {
		return runtimeports.SandboxEnvironmentImage{}, pkgerrors.BadRequest("container workspaces do not use environment images")
	}
	candidates := []int64{0}
	if repositoryID > 0 {
		candidates = []int64{repositoryID, 0}
	}
	for _, candidate := range candidates {
		row, err := s.q.GetLatestReadySandboxEnvironmentImage(ctx, runtimeports.GetLatestReadySandboxEnvironmentImageParams{
			RepositoryID: repositoryIDArg(candidate),
			Kind:         kind,
		})
		if err == nil {
			return row, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return runtimeports.SandboxEnvironmentImage{}, pkgerrors.Internal("resolve environment image: " + err.Error())
		}
	}
	return runtimeports.SandboxEnvironmentImage{}, pkgerrors.EnvironmentImageUnavailable("no NixOS environment image is registered for kind " + kind + "; build one with scripts/build-nix-environment.ts")
}

// Pinned returns the ready image of kind whose NixOS toplevel is
// closureHash: the image a workspace was placed on, registered for the
// repository or as the platform base. A retired or unregistered image is
// unavailable; no other image stands in for it.
func (s *SandboxEnvironmentImageService) Pinned(ctx context.Context, repositoryID int64, kind, closureHash string) (runtimeports.SandboxEnvironmentImage, error) {
	if s == nil || s.q == nil {
		return runtimeports.SandboxEnvironmentImage{}, pkgerrors.Internal("environment image store unavailable")
	}
	kind = sandboxKindForWorkspace(kind)
	candidates := []int64{0}
	if repositoryID > 0 {
		candidates = []int64{repositoryID, 0}
	}
	for _, candidate := range candidates {
		rows, err := s.q.ListSandboxEnvironmentImages(ctx, repositoryIDArg(candidate))
		if err != nil {
			return runtimeports.SandboxEnvironmentImage{}, pkgerrors.Internal("list environment images: " + err.Error())
		}
		for _, row := range rows {
			if row.Kind == kind && row.ClosureHash == closureHash && row.Status == "ready" {
				return row, nil
			}
		}
	}
	return runtimeports.SandboxEnvironmentImage{}, pkgerrors.EnvironmentImageUnavailable("the NixOS image this workspace was placed on (closure " + closureHash + ") is no longer registered")
}

func (s *SandboxEnvironmentImageService) toResponse(ctx context.Context, row runtimeports.SandboxEnvironmentImage) SandboxEnvironmentImageResponse {
	resp := SandboxEnvironmentImageResponse{
		ID:             row.ID,
		Kind:           row.Kind,
		Source:         row.Source,
		SourceRevision: row.SourceRevision,
		ClosureHash:    row.ClosureHash,
		Image:          row.Image,
		Status:         row.Status,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}
	if row.RepositoryID.Valid {
		resp.RepositoryID = row.RepositoryID.Int64
	}
	if s.golden != nil {
		resp.GoldenSnapshotID = s.golden.CurrentFor(ctx, goldenSnapshotKeyForImage(row.Kind, row.ClosureHash))
	}
	return resp
}
