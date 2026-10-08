package compose

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	internalssh "github.com/smithersai/smithers/packages/backend/internal/ssh"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

type memberDaemonClient struct {
	channel *services.MemberChannel
	user    machined.SessionUser
}

func (c memberDaemonClient) OpenSession(ctx context.Context, user machined.SessionUser, kind machined.SessionKind, argv []string, size *machined.SessionSize) (uint32, error) {
	return c.channel.Open(ctx, user, kind, argv, size)
}
func (c memberDaemonClient) CloseSession(ctx context.Context, id uint32) error {
	return c.channel.CloseSession(ctx, id)
}
func (c memberDaemonClient) Stream(ctx context.Context, id uint32) (internalssh.DaemonStream, error) {
	return c.channel.Stream(ctx, id)
}
func (c memberDaemonClient) TCPConnect(ctx context.Context, port uint16) (uint32, error) {
	if port == 0 {
		return 0, machined.ErrUnauthorized
	}
	// ADR 0004's TCP primitive has no member selector and runs as agent. Use
	// the installed unprivileged loopback relay through member exec admission.
	return c.channel.Open(ctx, c.user, machined.SessionExec, []string{"/opt/smithers/bin/smithers-machined", "session-tcp", strconv.Itoa(int(port))}, nil)
}

type sshReservation struct {
	access  internalssh.WorkspaceAccess
	session services.WorkspaceSessionResponse
	channel *services.MemberChannel
	closed  bool
	once    sync.Once
}

func installDaemonBridge(pool *pgxpool.Pool, service *services.WorkspaceService, registry *machined.Registry) *internalssh.DaemonBridge {
	if pool == nil || service == nil || registry == nil {
		return nil
	}
	var mu sync.Mutex
	held := map[context.Context]*sshReservation{}
	ready := func(ctx context.Context, a internalssh.WorkspaceAccess) error {
		return service.ValidateMemberChannel(ctx, a.SandboxID, a.MemberID, a.User, a.UID)
	}
	bridge := &internalssh.DaemonBridge{Ready: ready}
	bridge.Track = func(ctx context.Context, a internalssh.WorkspaceAccess, id uint32) (func(), error) {
		if err := ready(ctx, a); err != nil {
			return nil, err
		}
		if id != 0 {
			mu.Lock()
			reservation := held[ctx]
			var channel *services.MemberChannel
			if reservation != nil {
				channel = reservation.channel
			}
			mu.Unlock()
			if reservation == nil || reservation.access != a || channel == nil || !channel.HasSession(id) {
				return nil, machined.ErrUnauthorized
			}
			return func() {}, nil
		}
		mu.Lock()
		defer mu.Unlock()
		if held[ctx] != nil {
			return nil, machined.ErrUnauthorized
		}
		row, err := db.New(pool).GetWorkspace(ctx, a.SandboxID)
		if err != nil {
			return nil, err
		}
		receipt, err := service.OpenSSHReservation(ctx, row.ID, row.RepositoryID, a.MemberID, uuid.NewString())
		if err != nil {
			return nil, err
		}
		reservation := &sshReservation{access: a, session: receipt}
		held[ctx] = reservation
		return func() {
			reservation.once.Do(func() {
				mu.Lock()
				delete(held, ctx)
				reservation.closed = true
				channel := reservation.channel
				mu.Unlock()
				if channel != nil {
					channel.Close()
				}
				closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = service.CloseMemberReservation(closeCtx, receipt.ID, row.RepositoryID, a.MemberID)
			})
		}, nil
	}
	bridge.Admit = func(ctx context.Context, a internalssh.WorkspaceAccess, request microsandbox.AdmissionRequest, stderr io.Writer) (internalssh.DaemonClient, func(), error) {
		if request.Class != "person" || request.Holder != "workspace:"+a.SandboxID || request.Actor != "person:"+strconv.FormatInt(a.MemberID, 10) {
			return nil, nil, machined.ErrUnauthorized
		}
		mu.Lock()
		reservation := held[ctx]
		mu.Unlock()
		if reservation == nil || reservation.access != a {
			return nil, nil, machined.ErrUnauthorized
		}
		var last int
		for {
			if err := ready(ctx, a); err != nil {
				return nil, nil, err
			}
			receipt, err := service.MemberReservation(ctx, reservation.session.ID, reservation.session.RepositoryID, a.MemberID, a.User, a.UID)
			if err != nil {
				return nil, nil, err
			}
			if receipt.Status == "running" {
				break
			}
			if receipt.Status != "pending" && receipt.Status != "starting" {
				return nil, nil, machined.ErrNotReady
			}
			row, err := db.New(pool).GetWorkspace(ctx, a.SandboxID)
			if err != nil {
				return nil, nil, err
			}
			if place, waiting := service.MachinePlace(row); waiting && place != last {
				if _, err = fmt.Fprintf(stderr, "waiting for a machine #%d\n", place); err != nil {
					return nil, nil, err
				}
				last = place
			}
			timer := time.NewTimer(250 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, nil, ctx.Err()
			case <-timer.C:
			}
		}
		channel, err := service.AdmitMemberChannel(ctx, reservation.session.ID, reservation.session.RepositoryID, a.MemberID, a.User, a.UID)
		if err != nil {
			return nil, nil, err
		}
		mu.Lock()
		if reservation.closed {
			mu.Unlock()
			channel.Close()
			return nil, nil, machined.ErrUnauthorized
		}
		reservation.channel = channel
		mu.Unlock()
		return memberDaemonClient{channel, machined.SessionUser{Login: a.User, UID: a.UID}}, channel.Close, nil
	}
	return bridge
}
