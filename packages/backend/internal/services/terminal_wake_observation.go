package services

import (
	"context"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// One process clock pairs admission and the actual durable awake write. A
// recovered request has no local admission span and cannot acquire a timing.
var terminalWakeEpoch = time.Now()
var terminalWakeBoot = uuid.NewString()

type terminalWakeKey struct{}
type terminalWakeObservation struct {
	RequestID, Branch, BootID, AcceptedNS, AwakeWrittenNS, Kind, WorkingHead string
	Failed                                                                   bool
}
type terminalWakeSpan struct {
	mu                 sync.Mutex
	observation        terminalWakeObservation
	boots              int
	invalid, completed bool
	emit               func(terminalWakeObservation)
}

func terminalWakeNS() string {
	return strconv.FormatInt(time.Since(terminalWakeEpoch).Nanoseconds(), 10)
}

func beginTerminalWakeObservation(ctx context.Context, request, branch string) (context.Context, *terminalWakeSpan) {
	span := &terminalWakeSpan{observation: terminalWakeObservation{RequestID: request, Branch: branch, BootID: terminalWakeBoot, AcceptedNS: terminalWakeNS()}, emit: logTerminalWakeObservation}
	ctx = context.WithValue(ctx, terminalWakeKey{}, span)
	return workspaceapi.WithWakeObserver(ctx, span.boot), span
}

func (span *terminalWakeSpan) boot(kind string, failed bool) {
	span.mu.Lock()
	defer span.mu.Unlock()
	span.boots++
	span.observation.Kind = kind
	span.invalid = span.invalid || failed || (kind != "warm" && kind != "cold")
}

// Called only after UpdateWorkspaceStatus has committed running, the value
// the branch projection exposes as awake. Guest inspection cannot move this
// endpoint, and is never replaced by the database's remembered head.
func (s *WorkspaceService) recordTerminalAwake(ctx context.Context, row db.Workspace, member int64) {
	span, _ := ctx.Value(terminalWakeKey{}).(*terminalWakeSpan)
	if span == nil {
		return
	}
	stamp := terminalWakeNS()
	operation, err := s.workspaceRuntimeContext(ctx, row, member, workspaceLifecycleOperation(row, "inspect"))
	var head string
	if err == nil {
		head, err = workspaceapi.ResolveSourceRevision(operation, s.runtime, row.ID)
	}
	span.mu.Lock()
	defer span.mu.Unlock()
	span.invalid = span.invalid || err != nil || span.observation.AwakeWrittenNS != ""
	span.observation.AwakeWrittenNS = stamp
	span.observation.WorkingHead = head
}

func (span *terminalWakeSpan) complete(success bool) {
	span.mu.Lock()
	if span.completed {
		span.mu.Unlock()
		return
	}
	span.completed = true
	span.observation.Failed = !success || span.invalid || span.boots != 1 || span.observation.AwakeWrittenNS == "" || span.observation.WorkingHead == ""
	observation, emit := span.observation, span.emit
	span.mu.Unlock()
	emit(observation)
}

func logTerminalWakeObservation(observation terminalWakeObservation) {
	slog.Info("machine wake observation", "requestId", observation.RequestID, "branch", observation.Branch,
		"bootId", observation.BootID, "acceptedNs", observation.AcceptedNS, "awakeWrittenNs", observation.AwakeWrittenNS,
		"kind", observation.Kind, "workingHead", observation.WorkingHead, "failed", observation.Failed)
}
