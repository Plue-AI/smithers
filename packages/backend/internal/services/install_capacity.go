package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

type InstallCapacityQueries interface {
	GetInstallCapacity(context.Context) (db.GetInstallCapacityRow, error)
	SetInstallCapacity(context.Context, db.SetInstallCapacityParams) (int64, error)
}

// The install projection and CLI consume the same data. No visual component lives here.
type HostStatus struct {
	Profile  microsandbox.HostProfile `json:"profile"`
	Limits   microsandbox.Sizing      `json:"limits"`
	Machines MachineCapacity          `json:"machines"`
}
type MachineCapacity struct {
	InUse    int `json:"in_use"`
	Capacity int `json:"capacity"`
}

type InstallCapacityService struct {
	Queries InstallCapacityQueries
	Profile microsandbox.HostProfile
	InUse   func() int
	// Parallel writes stay dark until install authority and catalog policy are composed.
	AuthorizeParallel func(context.Context) error
}

func (s *InstallCapacityService) Read(ctx context.Context) (HostStatus, error) {
	status := HostStatus{Profile: s.Profile, Limits: microsandbox.ComputeSizing(s.Profile)}
	capacity, err := s.Capacity(ctx)
	if err != nil {
		return HostStatus{}, err
	}
	status.Machines.Capacity = capacity
	if s.InUse != nil {
		status.Machines.InUse = s.InUse()
	}
	return status, nil
}

func (s *InstallCapacityService) ValidateStart(ctx context.Context) error {
	row, err := s.Queries.GetInstallCapacity(ctx)
	if err != nil {
		return err
	}
	if err = microsandbox.ComputeSizing(s.Profile).ValidateStart(row.OwnerID > 0); err != nil {
		return err
	}
	_, err = s.Read(ctx)
	return err
}

func (s *InstallCapacityService) Set(ctx context.Context, actor int64, value int) error {
	row, err := s.Queries.GetInstallCapacity(ctx)
	if err != nil {
		return err
	}
	permission := &microsandbox.CapacityError{Code: "install_owner_required", Class: "permission", Message: "only the owner may set capacity"}
	if actor <= 0 || row.OwnerID != actor {
		return permission
	}
	maximum := microsandbox.ComputeSizing(s.Profile).Capacity
	if _, err = microsandbox.Clamp(value, maximum); err != nil {
		return err
	}
	if value > maximum {
		return &microsandbox.CapacityError{Code: "capacity_above_host", Class: "user", Message: fmt.Sprintf("capacity cannot exceed %d", maximum)}
	}
	raw := strconv.AppendInt(nil, int64(value), 10)
	rows, err := s.Queries.SetInstallCapacity(ctx, db.SetInstallCapacityParams{Value: raw, ActorID: actor})
	if err != nil {
		return err
	}
	if rows != 1 {
		return permission
	}
	return nil
}

// Capacity excludes the usage projection and clamps every read against this startup's profile.
func (s *InstallCapacityService) Capacity(ctx context.Context) (int, error) {
	row, err := s.Queries.GetInstallCapacity(ctx)
	if err != nil {
		return 0, err
	}
	formula := microsandbox.ComputeSizing(s.Profile).Capacity
	if len(row.Capacity) == 0 {
		return formula, nil
	}
	var owner int
	if err = json.Unmarshal(row.Capacity, &owner); err != nil {
		return 0, fmt.Errorf("read saved capacity: %w", err)
	}
	return microsandbox.Clamp(owner, formula)
}

// InstallParallelQueries uses install_settings; no stack-local setter remains.
type InstallParallelQueries interface {
	GetInstallParallel(context.Context) (json.RawMessage, error)
	SetInstallParallel(context.Context, db.SetInstallParallelParams) (int64, error)
}

type InstallParallel struct {
	Requested int `json:"requested"`
	Effective int `json:"effective"`
}

// Parallel leaves the saved request intact when host capacity falls, including to zero.
// An absent value alone uses the capacity-derived default; corrupt saved values refuse.
func (s *InstallCapacityService) Parallel(ctx context.Context) (InstallParallel, error) {
	if s == nil || s.Queries == nil {
		return InstallParallel{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install settings unavailable")
	}
	q, ok := s.Queries.(InstallParallelQueries)
	if !ok {
		return InstallParallel{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install parallel settings unavailable")
	}
	capacity, err := s.Capacity(ctx)
	if err != nil {
		return InstallParallel{}, err
	}
	raw, err := q.GetInstallParallel(ctx)
	if err != nil {
		return InstallParallel{}, err
	}
	requested := max(1, capacity-1)
	if len(raw) != 0 {
		var saved *int
		if err = json.Unmarshal(raw, &saved); err != nil {
			return InstallParallel{}, fmt.Errorf("read saved parallel: %w", err)
		}
		if saved == nil {
			return InstallParallel{}, pkgerrors.BadRequest("saved parallel must be an integer")
		}
		requested = *saved
		if requested < 1 || requested > 8 {
			return InstallParallel{}, pkgerrors.BadRequest("saved parallel must be between 1 and 8")
		}
	}
	return InstallParallel{Requested: requested, Effective: min(requested, capacity)}, nil
}

// SetParallel is the owner-session install write, never an agent or setup write.
// The policy callback must perform the shared Authorize/catalog decision; there is
// no default allow. The SQL owner fence also protects a change during authorization.
func (s *InstallCapacityService) SetParallel(ctx context.Context, value int) error {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil || info.SessionHash == "" || info.IsTokenAuth || info.IsAgent() {
		return pkgerrors.Forbidden("install owner session required")
	}
	if s == nil || s.Queries == nil || s.AuthorizeParallel == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install parallel authority unavailable")
	}
	if err := s.AuthorizeParallel(ctx); err != nil {
		return err
	}
	row, err := s.Queries.GetInstallCapacity(ctx)
	if err != nil {
		return err
	}
	if row.OwnerID <= 0 || row.OwnerID != info.User.ID {
		return pkgerrors.Forbidden("install owner session required")
	}
	if value < 1 || value > 8 {
		return pkgerrors.BadRequest("parallel must be between 1 and 8")
	}
	q, ok := s.Queries.(InstallParallelQueries)
	if !ok {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install parallel settings unavailable")
	}
	rows, err := q.SetInstallParallel(ctx, db.SetInstallParallelParams{Value: strconv.AppendInt(nil, int64(value), 10), ActorID: info.User.ID})
	if err != nil {
		return err
	}
	if rows != 1 {
		return pkgerrors.Forbidden("install owner session required")
	}
	return nil
}
