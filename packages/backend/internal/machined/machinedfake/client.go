package machinedfake

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// Client scripts the host boundary for consumer tests. Configure before use;
// callbacks own their synchronization. Missing operations fail closed rather
// than silently reporting a successful save, reconciliation or revocation.
// Production composition must never use this fake as a fallback.
type Client struct {
	OnReadFile      func(ctx context.Context, branch, path, at string) (machined.File, error)
	OnWriteFiles    func(ctx context.Context, branch string, actor []byte, changes []machined.FileChange) (machined.WriteResult, error)
	OnCapture       func(ctx context.Context, branch string) (machined.CaptureResult, error)
	OnWakeReconcile func(ctx context.Context, branch, head string) (machined.ReconcileResult, error)
	OnRebase        func(ctx context.Context, branch string, actor []byte, onto string) (machined.RewriteResult, error)
	OnReturnToItem  func(ctx context.Context, branch string, actor []byte) (machined.RewriteResult, error)
	OnOpenDocument  func(ctx context.Context, branch, path string, actor []byte) (machined.DocumentStream, error)
	OnSetRoster     func(ctx context.Context, branch string, members []machined.SessionUser) error
	OnAck           func(ctx context.Context, branch string, ack machined.Acknowledgement) error
	OnSessions      func(string) machined.SessionRPC
	OnEvents        func(string) machined.EventStream
}

var _ machined.Client = (*Client)(nil)

func (c *Client) ReadFile(ctx context.Context, branch, path, at string) (machined.File, error) {
	if err := ctx.Err(); err != nil {
		return machined.File{}, err
	}
	if c == nil || c.OnReadFile == nil {
		return machined.File{}, machined.ErrNotReady
	}
	return c.OnReadFile(ctx, branch, path, at)
}

func (c *Client) WriteFiles(ctx context.Context, branch string, actor []byte, changes []machined.FileChange) (machined.WriteResult, error) {
	if err := ctx.Err(); err != nil {
		return machined.WriteResult{}, err
	}
	if c == nil || c.OnWriteFiles == nil {
		return machined.WriteResult{}, machined.ErrNotReady
	}
	return c.OnWriteFiles(ctx, branch, actor, changes)
}

func (c *Client) Capture(ctx context.Context, branch string) (machined.CaptureResult, error) {
	if err := ctx.Err(); err != nil {
		return machined.CaptureResult{}, err
	}
	if c == nil || c.OnCapture == nil {
		return machined.CaptureResult{}, machined.ErrNotReady
	}
	return c.OnCapture(ctx, branch)
}

func (c *Client) WakeReconcile(ctx context.Context, branch, head string) (machined.ReconcileResult, error) {
	if err := ctx.Err(); err != nil {
		return machined.ReconcileResult{}, err
	}
	if c == nil || c.OnWakeReconcile == nil {
		return machined.ReconcileResult{}, machined.ErrNotReady
	}
	return c.OnWakeReconcile(ctx, branch, head)
}

func (c *Client) Rebase(ctx context.Context, branch string, actor []byte, onto string) (machined.RewriteResult, error) {
	if err := ctx.Err(); err != nil {
		return machined.RewriteResult{}, err
	}
	if c == nil || c.OnRebase == nil {
		return machined.RewriteResult{}, machined.ErrNotReady
	}
	return c.OnRebase(ctx, branch, actor, onto)
}

func (c *Client) ReturnToItem(ctx context.Context, branch string, actor []byte) (machined.RewriteResult, error) {
	if err := ctx.Err(); err != nil {
		return machined.RewriteResult{}, err
	}
	if c == nil || c.OnReturnToItem == nil {
		return machined.RewriteResult{}, machined.ErrNotReady
	}
	return c.OnReturnToItem(ctx, branch, actor)
}

func (c *Client) OpenDocument(ctx context.Context, branch, path string, actor []byte) (machined.DocumentStream, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c == nil || c.OnOpenDocument == nil {
		return nil, machined.ErrNotReady
	}
	return c.OnOpenDocument(ctx, branch, path, actor)
}

func (c *Client) SetRoster(ctx context.Context, branch string, members []machined.SessionUser) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if c == nil || c.OnSetRoster == nil {
		return machined.ErrNotReady
	}
	return c.OnSetRoster(ctx, branch, members)
}

func (c *Client) Ack(ctx context.Context, branch string, ack machined.Acknowledgement) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if c == nil || c.OnAck == nil {
		return machined.ErrNotReady
	}
	return c.OnAck(ctx, branch, ack)
}

func (c *Client) Sessions(branch string) machined.SessionRPC {
	if c != nil && c.OnSessions != nil {
		if rpc := c.OnSessions(branch); rpc != nil {
			return rpc
		}
	}
	return unavailable{}
}
func (c *Client) Events(branch string) machined.EventStream {
	if c != nil && c.OnEvents != nil {
		if stream := c.OnEvents(branch); stream != nil {
			return stream
		}
	}
	return unavailable{}
}

type unavailable struct{}

func (unavailable) CallSession(ctx context.Context, _ machined.SessionCall) (machined.SessionResult, error) {
	if err := ctx.Err(); err != nil {
		return machined.SessionResult{}, err
	}
	return machined.SessionResult{}, machined.ErrNotReady
}
func (unavailable) Receive(ctx context.Context) (machined.Event, error) {
	if err := ctx.Err(); err != nil {
		return machined.Event{}, err
	}
	return machined.Event{}, machined.ErrNotReady
}
func (unavailable) Close() error { return nil }
