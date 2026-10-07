package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestTerminalWakeObservationCompletesOnce(t *testing.T) {
	for _, tc := range []struct {
		name, kind                                string
		boots                                     int
		bootFailed, complete, awake, head, failed bool
	}{
		{"warm success", "warm", 1, false, true, true, true, false},
		{"cold is recorded as cold", "cold", 1, false, true, true, true, false},
		{"already awake is not a boot", "", 0, false, true, true, true, true},
		{"duplicate boot", "warm", 2, false, true, true, true, true},
		{"failed boot", "warm", 1, true, true, true, true, true},
		{"failed session", "warm", 1, false, false, true, true, true},
		{"missing awake write", "warm", 1, false, true, false, true, true},
		{"missing guest head", "warm", 1, false, true, true, false, true},
		{"unknown kind", "unknown", 1, false, true, true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, span := beginTerminalWakeObservation(context.Background(), "request", "branch")
			var observations []terminalWakeObservation
			span.emit = func(record terminalWakeObservation) { observations = append(observations, record) }
			for i := 0; i < tc.boots; i++ {
				workspaceapi.ObserveWake(ctx, tc.kind, tc.bootFailed)
			}
			if tc.awake {
				span.observation.AwakeWrittenNS = terminalWakeNS()
			}
			if tc.head {
				span.observation.WorkingHead = "0123456789012345678901234567890123456789"
			}
			span.complete(tc.complete)
			span.complete(true)
			require.Len(t, observations, 1)
			record := observations[0]
			require.Equal(t, tc.failed, record.Failed)
			require.Equal(t, "request", record.RequestID)
			require.Equal(t, "branch", record.Branch)
			require.Equal(t, tc.kind, record.Kind)
			require.Equal(t, terminalWakeBoot, record.BootID)
			accepted, err := strconv.ParseInt(record.AcceptedNS, 10, 64)
			require.NoError(t, err)
			require.Positive(t, accepted)
			if tc.awake {
				awake, err := strconv.ParseInt(record.AwakeWrittenNS, 10, 64)
				require.NoError(t, err)
				require.GreaterOrEqual(t, awake, accepted)
			}
		})
	}
}

type terminalWakeSource struct {
	workspaceapi.WorkspaceRuntime
	inspections *int
}

func (source terminalWakeSource) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	*source.inspections++
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}
func (terminalWakeSource) ListFiles(context.Context, string, string) ([]workspaceapi.FileEntry, error) {
	return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}}, nil
}
func (terminalWakeSource) ExecuteCommand(_ context.Context, _ string, cmd workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if strings.Join(cmd.Args, " ") == "git rev-parse --verify HEAD" {
		return workspaceapi.CommandResult{Stdout: strings.Repeat("1", 40) + "\n"}, nil
	}
	if strings.Join(cmd.Args, " ") == "git status --porcelain=v1 --untracked-files=normal" {
		return workspaceapi.CommandResult{}, nil
	}
	return workspaceapi.CommandResult{}, errors.New("unexpected source read")
}
func TestTerminalAwakeObservationRefusesMissingIdentityAndRepeatedWrite(t *testing.T) {
	inspections := 0
	service := NewWorkspaceService(nil, WithWorkspaceRuntime(terminalWakeSource{inspections: &inspections}))
	row := db.Workspace{ID: "branch", UserID: 1}
	// Ordinary non-observed lifecycle calls do no extra source reads.
	service.recordTerminalAwake(context.Background(), row, 2)
	require.Zero(t, inspections)
	for _, refuse := range []bool{false, true} {
		ctx, span := beginTerminalWakeObservation(context.Background(), "request", "branch")
		var observations []terminalWakeObservation
		span.emit = func(record terminalWakeObservation) { observations = append(observations, record) }
		workspaceapi.ObserveWake(ctx, "warm", false)
		if refuse {
			service.runtimeIdentity = func(context.Context, db.Workspace, int64) (workspaceapi.Operation, error) {
				return workspaceapi.Operation{}, errors.New("identity unavailable")
			}
		}
		service.recordTerminalAwake(ctx, row, 2)
		if !refuse {
			service.recordTerminalAwake(ctx, row, 2)
		}
		span.complete(true)
		require.Len(t, observations, 1)
		require.True(t, observations[0].Failed)
		require.NotEmpty(t, observations[0].AwakeWrittenNS)
		if refuse {
			require.Empty(t, observations[0].WorkingHead)
		} else {
			require.Equal(t, strings.Repeat("1", 40), observations[0].WorkingHead)
		}
	}
}

func TestTerminalWakeObservationStructuredLog(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	defer slog.SetDefault(previous)
	ctx, span := beginTerminalWakeObservation(context.Background(), "literal-request", "literal-branch")
	workspaceapi.ObserveWake(ctx, "warm", false)
	span.observation.AwakeWrittenNS = terminalWakeNS()
	span.observation.WorkingHead = strings.Repeat("2", 40)
	span.complete(true)
	var record map[string]any
	require.NoError(t, json.Unmarshal(output.Bytes(), &record))
	require.Equal(t, "machine wake observation", record["msg"])
	require.Equal(t, "literal-request", record["requestId"])
	require.Equal(t, "literal-branch", record["branch"])
	require.Equal(t, terminalWakeBoot, record["bootId"])
	require.Equal(t, "warm", record["kind"])
	require.Equal(t, false, record["failed"])
	require.Equal(t, strings.Repeat("2", 40), record["workingHead"])
	require.IsType(t, "", record["acceptedNs"])
	require.IsType(t, "", record["awakeWrittenNs"])
}
