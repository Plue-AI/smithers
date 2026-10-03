package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type InstallStepState string

const (
	InstallPending InstallStepState = "pending"
	InstallRunning InstallStepState = "running"
	InstallReady   InstallStepState = "ready"
	InstallFailed  InstallStepState = "failed"
)

// InstallReadinessError retains the failure's class and actionable recipe fix.
type InstallReadinessError struct {
	Code    string `json:"code"`
	Class   string `json:"class"`
	Message string `json:"message"`
	Fix     string `json:"fix,omitempty"`
	cause   error
}

func (e *InstallReadinessError) Error() string { return e.Message }
func (e *InstallReadinessError) Unwrap() error { return e.cause }

type InstallReadinessStep struct {
	State InstallStepState       `json:"state"`
	Pct   int                    `json:"pct"`
	Error *InstallReadinessError `json:"error,omitempty"`
}

// Revision, LayerKey and Attempt are persisted receipts/fences. The install
// projection owner exposes Source and Machine alongside its other settings.
type InstallReadiness struct {
	Source   InstallReadinessStep `json:"source"`
	Machine  InstallReadinessStep `json:"machine"`
	Revision string               `json:"revision"`
	LayerKey string               `json:"layer_key"`
	Attempt  uint64               `json:"attempt"`
}

// Update must serialize mutations and persist the resulting readiness.
// Returning an error leaves the previous receipt unchanged. The install owner
// supplies this persistence when its settings and projection contracts land.
type InstallReadinessPersistence interface {
	Update(context.Context, string, func(InstallReadiness) (InstallReadiness, error)) (InstallReadiness, error)
}

// A successful resolver returns only verified required layers. Layer{} is
// valid for a base-only recipe, which needs no toolchain/dependency build.
type InstallMachineLayerBuilder interface {
	ResolveWorkspaceLayer(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error)
}

// InstallMachineReadyService is the readiness computation invoked by the setup
// runner. It does not launch background jobs, own install settings, or serve HTTP.
type InstallMachineReadyService struct {
	Sources     workspaceapi.SourceFiles
	Layers      InstallMachineLayerBuilder
	Persistence InstallReadinessPersistence
}

var ErrInstallReadinessSuperseded = errors.New("install readiness attempt superseded")

// Prepare resolves main once and passes that immutable revision to the layer
// builder. Source's ready receipt commits before any slow machine work starts.
func (s *InstallMachineReadyService) Prepare(ctx context.Context, repository string) (InstallReadiness, error) {
	if strings.TrimSpace(repository) == "" || s.Sources == nil || s.Layers == nil || s.Persistence == nil {
		return InstallReadiness{}, &InstallReadinessError{Code: "install_readiness_unavailable", Class: "infra", Message: "Source and machine readiness are not configured"}
	}
	state, err := s.Persistence.Update(ctx, repository, func(current InstallReadiness) (InstallReadiness, error) {
		current.Attempt++
		if current.Source.State != InstallReady {
			current.Source = InstallReadinessStep{State: InstallRunning}
		}
		// Revision alone cannot certify the current detector and manifest recipe.
		current.Machine = InstallReadinessStep{State: InstallPending}
		current.LayerKey = ""
		return current, nil
	})
	if err != nil {
		return state, err
	}
	attempt := state.Attempt
	update := func(writeCtx context.Context, mutate func(*InstallReadiness)) (InstallReadiness, error) {
		return s.Persistence.Update(writeCtx, repository, func(current InstallReadiness) (InstallReadiness, error) {
			if current.Attempt != attempt {
				return current, ErrInstallReadinessSuperseded
			}
			mutate(&current)
			return current, nil
		})
	}
	fail := func(cause error, code string, source bool) (InstallReadiness, error) {
		failure := installReadinessFailure(code, cause)
		// Cancellation still needs a durable failure receipt. It cannot be
		// recorded through the cancelled execution context.
		writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		failed, saveErr := update(writeCtx, func(current *InstallReadiness) {
			if source {
				current.Source = InstallReadinessStep{State: InstallFailed, Error: failure}
				current.Machine = InstallReadinessStep{State: InstallPending}
				current.Revision = ""
				current.LayerKey = ""
			} else {
				current.Machine = InstallReadinessStep{State: InstallFailed, Error: failure}
				current.LayerKey = ""
			}
		})
		if saveErr != nil {
			return failed, saveErr
		}
		return failed, failure
	}
	revision, err := s.Sources.ResolveSourceRevision(ctx, repository, "main")
	if err != nil {
		return fail(err, "source_main_unavailable", true)
	}
	if !installMainCommit(revision) {
		return fail(fmt.Errorf("main resolved to %q, not a commit id", revision), "source_main_invalid", true)
	}
	state, err = update(ctx, func(current *InstallReadiness) {
		current.Revision = revision
		current.Source = InstallReadinessStep{State: InstallReady, Pct: 100}
		current.Machine = InstallReadinessStep{State: InstallRunning}
		current.LayerKey = ""
	})
	if err != nil {
		return state, err
	}
	layer, err := s.Layers.ResolveWorkspaceLayer(ctx, workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: repository, Revision: revision}})
	if err != nil {
		return fail(err, "machine_build_failed", false)
	}
	if err := ctx.Err(); err != nil {
		return fail(err, "machine_build_failed", false)
	}
	return update(ctx, func(current *InstallReadiness) {
		current.Machine = InstallReadinessStep{State: InstallReady, Pct: 100}
		current.LayerKey = layer.Key
	})
}

func installMainCommit(revision string) bool {
	if len(revision) != 40 {
		return false
	}
	for _, ch := range revision {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f') {
			return false
		}
	}
	return true
}

func installReadinessFailure(code string, cause error) *InstallReadinessError {
	var recipe *microsandbox.RecipeError
	if errors.As(cause, &recipe) {
		return &InstallReadinessError{Code: recipe.Code, Class: recipe.Class, Message: recipe.Message, Fix: recipe.Fix, cause: cause}
	}
	class := "infra"
	if errors.Is(cause, context.Canceled) {
		class = "user"
		code = "install_readiness_cancelled"
	}
	return &InstallReadinessError{Code: code, Class: class, Message: cause.Error(), cause: cause}
}
