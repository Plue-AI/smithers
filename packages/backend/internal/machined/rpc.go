package machined

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// Current returns only the latest authenticated transport, including during
// wake admission. Consumers must still use RequireReady before ordinary work.
func (r *Registry) Current(branch string) (*Link, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b := r.branches[branch]
	if b == nil || b.link == nil || b.connection != b.link.Connection {
		return nil, ErrNotReady
	}
	return b.link, nil
}

// call checks both correlation and result method; a valid but wrong response is
// a protocol failure, never a success of another operation.
func (l *Link) call(ctx context.Context, branch string, method wire.Method, args ...[]byte) (map[byte][]byte, error) {
	f, err := l.Request(ctx, branch, method, args...)
	if err != nil {
		return nil, err
	}
	fields, err := wire.Fields("response", f.Payload[1:])
	if err != nil {
		return nil, err
	}
	result := fields[2]
	if result[0] == 255 {
		values, err := wire.Fields("error", result[1:])
		if err != nil {
			return nil, err
		}
		codes := []string{"", "malformed", "unsupported", "not_ready", "stale", "not_found", "invalid_path", "not_regular", "too_large", "busy", "moved_off", "unauthorized", "internal"}
		detail := ""
		if v := values[2]; len(v) > 0 {
			detail = string(v[2:])
		}
		return values, &SessionError{Code: codes[values[1][0]], Detail: detail}
	}
	if result[0] != byte(method) {
		_ = l.Close()
		return nil, wire.BadValue
	}
	return wire.Fields(fmt.Sprintf("result%d", method), result[1:])
}
func oid(value string) ([]byte, error) {
	bytes, err := hex.DecodeString(value)
	if err != nil || len(bytes) != 20 {
		return nil, wire.BadValue
	}
	return bytes, nil
}
func principal(actor []byte) []byte { return wire.Union(1, wire.Field(1, wire.Bytes(actor))) }
func (r *Registry) ReadFile(ctx context.Context, branch, path, at string) (File, error) {
	l, err := r.Current(branch)
	if err != nil {
		return File{}, err
	}
	args := [][]byte{wire.Field(1, wire.String(path))}
	if at != "" {
		bytes, err := oid(at)
		if err != nil {
			return File{}, err
		}
		args = append(args, wire.Field(2, bytes))
	}
	fields, err := l.call(ctx, branch, wire.ReadFile, args...)
	if err != nil {
		return File{}, err
	}
	return File{Content: append([]byte(nil), fields[1][4:]...), Digest: hex.EncodeToString(fields[2]), Mode: binary.BigEndian.Uint32(fields[3])}, nil
}
func (r *Registry) WriteFiles(ctx context.Context, branch string, actor []byte, changes []FileChange) (WriteResult, error) {
	var result WriteResult
	l, err := r.Current(branch)
	if err != nil {
		return result, err
	}
	if err := l.RequireReady(branch); err != nil {
		return result, err
	}
	if len(actor) == 0 || len(actor) > 1024 {
		return result, ErrUnauthorized
	}
	if len(changes) == 0 || len(changes) > 256 {
		return result, wire.BadValue
	}
	// Validate the complete request before dispatching its first write. The
	// wire exposes ordered writes, so malformed later arguments must not leave
	// an earlier file applied merely because decoding was interleaved with RPC.
	requests := make([][][]byte, len(changes))
	for index, change := range changes {
		base := wire.Union(2)
		if change.BaseDigest != nil {
			digest, err := hex.DecodeString(*change.BaseDigest)
			if err != nil || len(digest) != 32 {
				return result, wire.BadValue
			}
			base = wire.Union(1, wire.Field(1, digest))
		}
		requests[index] = [][]byte{wire.Field(1, wire.String(change.Path)), wire.Field(2, base), wire.Field(3, wire.Bytes(change.Content)), wire.Field(4, principal(actor))}
		if _, err := wire.RequestFrame(1, wire.WriteFile, requests[index]...); err != nil {
			return result, err
		}
	}
	for index, change := range changes {
		fields, err := l.call(ctx, branch, wire.WriteFile, requests[index]...)
		if err != nil {
			if refusal, ok := err.(*SessionError); ok && refusal.Code == "stale" {
				stale := &StaleFile{Path: change.Path}
				if bytes := fields[3]; bytes != nil {
					digest := hex.EncodeToString(bytes)
					stale.CurrentDigest = &digest
				}
				result.Stale = stale
				return result, nil
			}
			return result, err
		}
		result.Applied = append(result.Applied, AppliedFile{change.Path, hex.EncodeToString(fields[1])})
		if bytes := fields[2]; bytes != nil {
			raced, err := wire.Fields("raced", bytes)
			if err != nil {
				return result, err
			}
			result.Raced = append(result.Raced, RacedFile{string(raced[1][2:]), hex.EncodeToString(raced[2])})
		}
	}
	return result, nil
}
func (r *Registry) Capture(ctx context.Context, branch string) (CaptureResult, error) {
	l, err := r.Current(branch)
	if err != nil {
		return CaptureResult{}, err
	}
	fields, err := l.call(ctx, branch, wire.Capture)
	if err != nil {
		return CaptureResult{}, err
	}
	return CaptureResult{hex.EncodeToString(fields[1]), hex.EncodeToString(fields[2]), binary.BigEndian.Uint16(fields[3])}, nil
}
func (r *Registry) WakeReconcile(ctx context.Context, branch, head string) (ReconcileResult, error) {
	l, err := r.Current(branch)
	if err != nil {
		return ReconcileResult{}, err
	}
	bytes, err := oid(head)
	if err != nil {
		return ReconcileResult{}, err
	}
	fields, err := l.call(ctx, branch, wire.WakeReconcile, wire.Field(1, bytes))
	if err != nil {
		return ReconcileResult{}, err
	}
	value := fields[1]
	switch value[0] {
	case 1:
		return ReconcileResult{Outcome: ReconcileUnchanged, Head: head}, nil
	case 2:
		f, err := wire.Fields("moved", value[1:])
		if err != nil {
			return ReconcileResult{}, err
		}
		return ReconcileResult{Outcome: ReconcileMoved, Head: hex.EncodeToString(f[1])}, nil
	case 3:
		f, err := wire.Fields("conflict", value[1:])
		if err != nil {
			return ReconcileResult{}, err
		}
		result := ReconcileResult{Outcome: ReconcileConflict}
		list := f[1][2:]
		for len(list) > 0 {
			n := int(binary.BigEndian.Uint16(list))
			result.Paths = append(result.Paths, string(list[2:2+n]))
			list = list[2+n:]
		}
		return result, nil
	default:
		return ReconcileResult{}, wire.BadValue
	}
}
func (r *Registry) SetRoster(ctx context.Context, branch string, members []SessionUser) error {
	l, err := r.Current(branch)
	if err != nil {
		return err
	}
	if len(members) > 65535 {
		return wire.BadValue
	}
	list := wire.U16(uint16(len(members)))
	for _, member := range members {
		if !validUser(member) {
			return ErrUnauthorized
		}
		list = append(list, wire.Struct(wire.Field(1, wire.String(member.Login)), wire.Field(2, wire.U32(member.UID)))...)
	}
	_, err = l.call(ctx, branch, wire.SetRoster, wire.Field(1, list))
	return err
}
func (r *Registry) Rebase(ctx context.Context, branch string, actor []byte, onto string) (RewriteResult, error) {
	if len(actor) == 0 || len(actor) > 1024 {
		return RewriteResult{}, ErrUnauthorized
	}
	bytes, err := oid(onto)
	if err != nil {
		return RewriteResult{}, err
	}
	return r.rewrite(ctx, branch, wire.Rebase, wire.Field(1, bytes), wire.Field(2, principal(actor)))
}
func (r *Registry) ReturnToItem(ctx context.Context, branch string, actor []byte) (RewriteResult, error) {
	if len(actor) == 0 || len(actor) > 1024 {
		return RewriteResult{}, ErrUnauthorized
	}
	return r.rewrite(ctx, branch, wire.ReturnToItem, wire.Field(1, principal(actor)))
}
func (r *Registry) rewrite(ctx context.Context, branch string, method wire.Method, args ...[]byte) (RewriteResult, error) {
	l, err := r.Current(branch)
	if err != nil {
		return RewriteResult{}, err
	}
	fields, err := l.call(ctx, branch, method, args...)
	if err != nil {
		return RewriteResult{}, err
	}
	return RewriteResult{Head: hex.EncodeToString(fields[1])}, nil
}
func (r *Registry) Events(branch string) EventStream {
	l, err := r.Current(branch)
	if err != nil {
		return unavailableEvents{err}
	}
	return l
}

type unavailableEvents struct{ err error }

func (s unavailableEvents) Receive(context.Context) (Event, error) { return Event{}, s.err }
func (s unavailableEvents) Close() error                           { return nil }

// Ack is usable before ready so wake reconciliation can drain queued events.
func (r *Registry) Ack(ctx context.Context, branch string, ack Acknowledgement) error {
	l, err := r.Current(branch)
	if err != nil {
		return err
	}
	return l.Ack(ctx, branch, ack)
}
func (l *Link) Ack(ctx context.Context, branch string, ack Acknowledgement) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	l.registry.mu.Lock()
	valid := branch == l.boot.branch && l.current()
	l.registry.mu.Unlock()
	if !valid {
		return ErrUnauthorized
	}
	if ack.Seq == 0 {
		return wire.BadValue
	}
	fields := [][]byte{wire.Field(1, wire.U64(ack.Seq)), wire.Field(2, []byte{byte(ack.Outcome)})}
	for _, pair := range []struct {
		tag    byte
		values []string
	}{{3, ack.OIDs}, {5, ack.Haves}} {
		if len(pair.values) == 0 {
			continue
		}
		if len(pair.values) > 65535 {
			return wire.BadValue
		}
		list := wire.U16(uint16(len(pair.values)))
		for _, value := range pair.values {
			bytes, err := oid(value)
			if err != nil {
				return err
			}
			list = append(list, bytes...)
		}
		fields = append(fields, wire.Field(pair.tag, list))
	}
	if ack.Error != nil {
		codes := map[string]byte{"malformed": 1, "unsupported": 2, "not_ready": 3, "stale": 4, "not_found": 5, "invalid_path": 6, "not_regular": 7, "too_large": 8, "busy": 9, "moved_off": 10, "unauthorized": 11, "internal": 12}
		code, ok := codes[ack.Error.Code]
		if !ok {
			return wire.BadValue
		}
		detail := [][]byte{wire.Field(1, []byte{code})}
		if ack.Error.Detail != "" {
			detail = append(detail, wire.Field(2, wire.String(ack.Error.Detail)))
		}
		fields = append(fields, wire.Field(4, wire.Struct(detail...)))
	}
	sort.Slice(fields, func(a, b int) bool { return fields[a][0] < fields[b][0] })
	return l.sendContext(ctx, wire.Frame{Kind: wire.Events, Payload: wire.Union(3, fields...)})
}
