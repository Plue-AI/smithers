package ssh

import (
	"context"
	"io"
	"net"
	"sync"

	gliderssh "github.com/gliderlabs/ssh"
	gossh "golang.org/x/crypto/ssh"
)

// WorkspaceTCPBridge connects only to guest loopback through the authenticated
// machine transport. It must never dial the host network. Legacy workspace
// bridges without this capability continue to refuse local forwarding.
type WorkspaceTCPBridge interface {
	ConnectTCP(context.Context, WorkspaceAccess, uint16) (WorkspaceTCPConnection, error)
}

// WorkspaceTCPConnection preserves EOF independently in each direction.
type WorkspaceTCPConnection interface {
	net.Conn
	CloseWrite() error
}

// gliderlabs accepts agent forwarding unconditionally, before its session
// callback. Filter the channel request stream while retaining its session
// implementation for Git, SFTP, PTYs, signals and exit status.
type filteredSessionChannel struct{ gossh.NewChannel }

func (c filteredSessionChannel) Accept() (gossh.Channel, <-chan *gossh.Request, error) {
	channel, requests, err := c.NewChannel.Accept()
	if err != nil {
		return nil, nil, err
	}
	filtered := make(chan *gossh.Request)
	done := make(chan struct{})
	wrapped := &filteredChannel{Channel: channel, done: done}
	go func() {
		defer close(filtered)
		for request := range requests {
			if request.Type == "auth-agent-req@openssh.com" || request.Type == "x11-req" {
				_ = request.Reply(false, nil)
				continue
			}
			select {
			case filtered <- request:
			case <-done:
				return
			}
		}
	}()
	return wrapped, filtered, nil
}

type filteredChannel struct {
	gossh.Channel
	done chan struct{}
	// Close may be called by both gliderlabs and the bridge.
	once sync.Once
}

func (c *filteredChannel) Close() error {
	c.once.Do(func() { close(c.done) })
	return c.Channel.Close()
}

func (s *Server) filteredSessionHandler(srv *gliderssh.Server, conn *gossh.ServerConn, channel gossh.NewChannel, ctx gliderssh.Context) {
	gliderssh.DefaultSessionHandler(srv, conn, filteredSessionChannel{channel}, ctx)
}

type directTCPIPData struct {
	Destination string
	Port        uint32
	Origin      string
	OriginPort  uint32
}

// Revocation cancels both pumps, including a pending guest connection and an
// SSH read still waiting for input after the guest has sent EOF.
type forwardCancel struct{ cancel context.CancelFunc }

func (c *forwardCancel) Close() error {
	c.cancel()
	return nil
}

func (s *Server) directTCPIPHandler(_ *gliderssh.Server, _ *gossh.ServerConn, channel gossh.NewChannel, ctx gliderssh.Context) {
	var data directTCPIPData
	if err := gossh.Unmarshal(channel.ExtraData(), &data); err != nil ||
		(data.Destination != "localhost" && data.Destination != "127.0.0.1" && data.Destination != "::1") ||
		data.Port == 0 || data.Port > 65535 {
		_ = channel.Reject(gossh.Prohibited, "guest loopback port required")
		return
	}
	access, ok := ctx.Value(workspaceAccessKey).(WorkspaceAccess)
	bridge, supported := s.WorkspaceBridge.(WorkspaceTCPBridge)
	if !ok || !supported || access.SandboxID == "" || ctx.Value(workspaceErrorKey) != nil {
		_ = channel.Reject(gossh.Prohibited, "workspace forwarding unavailable")
		return
	}
	if s.BranchLogins {
		principal, ok := ctx.Value(principalKey).(sshPrincipal)
		if !ok || principal.IsDeployKey || s.BranchResolver == nil {
			_ = channel.Reject(gossh.Prohibited, "workspace access denied")
			return
		}
		current, err := s.BranchResolver.ResolveBranch(ctx, principal.UserID, ctx.User())
		if err != nil || current != access {
			_ = channel.Reject(gossh.Prohibited, "workspace access denied")
			return
		}
	}
	if err := s.validateWorkspace(ctx, access, remoteAddrIP(ctx.RemoteAddr())); err != nil {
		_ = channel.Reject(gossh.Prohibited, "workspace access denied")
		return
	}
	if !s.acquireSessionSlot(ctx.SessionID()) {
		_ = channel.Reject(gossh.ResourceShortage, "too many channels")
		return
	}
	defer s.releaseSessionSlot(ctx.SessionID())
	forwardCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	remove := liveSessions.addChannel(&forwardCancel{cancel}, contextPrincipal(ctx))
	defer remove()
	guest, err := bridge.ConnectTCP(forwardCtx, access, uint16(data.Port))
	if err != nil {
		_ = channel.Reject(gossh.ConnectionFailed, "guest connection unavailable")
		return
	}
	defer guest.Close()
	stopGuest := context.AfterFunc(forwardCtx, func() { _ = guest.Close() })
	defer stopGuest()
	if forwardCtx.Err() != nil {
		_ = channel.Reject(gossh.Prohibited, "workspace access revoked")
		return
	}
	stream, requests, err := channel.Accept()
	if err != nil {
		return
	}
	defer stream.Close()
	go gossh.DiscardRequests(requests)
	stopStream := context.AfterFunc(forwardCtx, func() { _ = stream.Close() })
	defer stopStream()
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		_, copyErr := io.Copy(guest, stream)
		if copyErr != nil {
			cancel()
			return
		}
		if err := guest.CloseWrite(); err != nil {
			cancel()
		}
	}()
	if _, err := io.Copy(stream, guest); err != nil {
		cancel()
	} else if err := stream.CloseWrite(); err != nil {
		cancel()
	}
	// A clean EOF ends only this direction. The client may still send input.
	<-inputDone
}
