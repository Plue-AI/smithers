package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/db"
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
