package machined

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

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
	content := fields[1][4:]
	digest := sha256.Sum256(content)
	if !bytes.Equal(digest[:], fields[2]) {
		_ = l.Close()
		return File{}, wire.BadValue
	}
	return File{Content: append([]byte(nil), content...), Digest: hex.EncodeToString(fields[2]), Mode: binary.BigEndian.Uint32(fields[3])}, nil
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
	if l.protocol != wire.Protocol {
		return result, refused("unsupported", fmt.Sprintf("file mutation batches require protocol %d", wire.Protocol))
	}
	// Keep receipt validation bound to what was encoded, even if the caller
	// reuses its input buffers after the peer receives the request.
	changes = append([]FileChange(nil), changes...)
	expectedDigests := make([][32]byte, len(changes))
	payload := wire.U16(uint16(len(changes)))
	paths := make(map[string]bool, len(changes))
	total := 0
	for index, change := range changes {
		if change.Path == "" || len(change.Path) > 4096 || strings.HasPrefix(change.Path, "/") || strings.ContainsRune(change.Path, 0) || !utf8.ValidString(change.Path) || paths[change.Path] {
			return result, wire.BadValue
		}
		for _, part := range strings.Split(change.Path, "/") {
			if part == "" || part == "." || part == ".." {
				return result, wire.BadValue
			}
		}
		paths[change.Path] = true
		total += len(change.Content)
		if total > 1<<20 || !utf8.Valid(change.Content) {
			return result, wire.BadValue
		}
		base := wire.Union(2)
		if change.BaseDigest != nil {
			digest, err := hex.DecodeString(*change.BaseDigest)
			if err != nil || len(digest) != 32 || hex.EncodeToString(digest) != *change.BaseDigest {
				return result, wire.BadValue
			}
			base = wire.Union(1, wire.Field(1, digest))
		}
		expectedDigests[index] = sha256.Sum256(change.Content)
		fields := [][]byte{wire.Field(1, wire.String(change.Path)), wire.Field(2, base)}
		if change.Content != nil {
			fields = append(fields, wire.Field(3, wire.Bytes(change.Content)))
		}
		payload = append(payload, wire.Struct(fields...)...)
	}
	for path := range paths {
		for at := strings.IndexByte(path, '/'); at >= 0; {
			if paths[path[:at]] {
				return result, wire.BadValue
			}
			next := strings.IndexByte(path[at+1:], '/')
			if next < 0 {
				break
			}
			at += next + 1
		}
	}
	fields, err := l.call(ctx, branch, wire.WriteFiles, wire.Field(1, payload), wire.Field(2, principal(actor)))
	if err != nil {
		return result, err
	}
	receipts, err := wire.List("mutation_result", fields[1])
	if err != nil || len(receipts) > len(changes) {
		return result, wire.BadValue
	}
	for i, raw := range receipts {
		receipt, err := wire.Fields("mutation_result", raw)
		if err != nil {
			return result, err
		}
		expected := expectedDigests[i]
		post := "absent"
		if changes[i].Content == nil {
			if !bytes.Equal(receipt[1], wire.Union(2)) {
				_ = l.Close()
				return result, wire.BadValue
			}
		} else {
			if !bytes.Equal(receipt[1], wire.Union(1, wire.Field(1, expected[:]))) {
				_ = l.Close()
				return result, wire.BadValue
			}
			post = hex.EncodeToString(expected[:])
		}
		result.Applied = append(result.Applied, AppliedFile{changes[i].Path, post})
		if raw := receipt[2]; raw != nil {
			raced, err := wire.Fields("raced", raw)
			if err != nil || string(raced[1][2:]) != changes[i].Path {
				return result, wire.BadValue
			}
			result.Raced = append(result.Raced, RacedFile{changes[i].Path, hex.EncodeToString(raced[2])})
		}
	}
	if raw := fields[2]; raw != nil {
		failure, err := wire.Fields("batch_failure", raw)
		if err != nil {
			return result, err
		}
		index := int(binary.BigEndian.Uint16(failure[1]))
		preflight := failure[2][0] == 1
		if index >= len(changes) || (preflight && len(receipts) != 0) || (!preflight && index != len(receipts)) {
			return result, wire.BadValue
		}
		e, err := wire.Fields("error", failure[3])
		if err != nil {
			return result, err
		}
		if preflight && e[1][0] == byte(wire.Stale) {
			result.Stale = &StaleFile{Path: changes[index].Path}
			if current := e[3]; current != nil {
				digest := hex.EncodeToString(current)
				result.Stale.CurrentDigest = &digest
			}
			return result, nil
		}
		codes := []string{"", "malformed", "unsupported", "not_ready", "stale", "not_found", "invalid_path", "not_regular", "too_large", "busy", "moved_off", "unauthorized", "internal"}
		detail := changes[index].Path
		if v := e[2]; len(v) > 0 {
			detail += ": " + string(v[2:])
		}
		return result, &SessionError{Code: codes[e[1][0]], Detail: detail}
	}
	if len(receipts) != len(changes) {
		return result, wire.BadValue
	}
	return result, nil
}

// IdleSafety is fresh authenticated evidence, never a cached empty inventory.
// Older daemons omit the optional observations and cannot authorize release.
func (r *Registry) IdleSafety(ctx context.Context, branch string) (burstsIdle, documentsFlushed bool, err error) {
	l, err := r.Current(branch)
	if err != nil {
		return false, false, err
	}
	fields, err := l.call(ctx, branch, wire.Status)
	if err != nil {
		return false, false, err
	}
	if fields[1][0] != 3 || len(fields[7]) != 1 || len(fields[8]) != 1 {
		return false, false, ErrNotReady
	}
	return fields[7][0] == 1, fields[8][0] == 1, nil
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
	result := CaptureResult{hex.EncodeToString(fields[1]), hex.EncodeToString(fields[2]), binary.BigEndian.Uint16(fields[3])}
	// The native RPC snapshots and queues delivery under the mutation lock.
	// Sleep needs its durable host acknowledgement AND all earlier events
	// drained. Poll outside that lock, keeping the original authenticated link:
	// a replacement boot cannot certify this capture's completion.
	drain, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		status, err := l.call(drain, branch, wire.Status)
		if err != nil {
			return CaptureResult{}, err
		}
		if status[1][0] != 3 { // ready, reconciled and roster installed
			return CaptureResult{}, ErrNotReady
		}
		if binary.BigEndian.Uint32(status[4]) == 0 {
			// New writes observed while the capture drained are not part of
			// its acknowledged head. Retain the live machine and retry capture.
			if status[7] != nil && status[7][0] != 1 || status[8] != nil && status[8][0] != 1 {
				return CaptureResult{}, ErrNotReady
			}
			if hex.EncodeToString(status[5]) != result.Head {
				return CaptureResult{}, fmt.Errorf("capture head was not acknowledged")
			}
			return result, nil
		}
		select {
		case <-drain.Done():
			return CaptureResult{}, drain.Err()
		case <-tick.C:
		}
	}
}
func (r *Registry) WakeReconcile(ctx context.Context, branch, head string) (ReconcileResult, error) {
	l, err := r.Current(branch)
	if err != nil {
		return ReconcileResult{}, err
	}
	return l.wakeReconcile(ctx, branch, head)
}
func (l *Link) wakeReconcile(ctx context.Context, branch, head string) (ReconcileResult, error) {
	bytes, err := oid(head)
	if err != nil {
		return ReconcileResult{}, err
	}
	var fields map[byte][]byte
	err = l.withWake(ctx, branch, head, func(ctx context.Context) error {
		var callErr error
		fields, callErr = l.call(ctx, branch, wire.WakeReconcile, wire.Field(1, bytes))
		return callErr
	})
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

// RebaseWithObjects imports the host-admitted target on this authenticated
// connection before invoking the daemon's single mutation-lock rewrite path.
func (r *Registry) RebaseWithObjects(ctx context.Context, branch string, actor []byte, onto string, guard func(func() error) error) (RewriteResult, error) {
	if _, err := oid(onto); err != nil || len(actor) == 0 || len(actor) > 1024 {
		return RewriteResult{}, ErrUnauthorized
	}
	l, err := r.Current(branch)
	if err != nil {
		return RewriteResult{}, err
	}
	if err := l.RequireReady(branch); err != nil {
		return RewriteResult{}, err
	}
	if guard == nil {
		return RewriteResult{}, ErrNotReady
	}
	if err := l.sendWakeObjects(ctx, branch, onto); err != nil {
		return RewriteResult{}, err
	}
	// This link was already reconciled before the object-only import. The
	// acknowledged transfer adds the target; it does not change the working
	// copy or require another wake. Restore admission before the rewrite RPC.
	if err := l.Reconciled(); err != nil {
		return RewriteResult{}, err
	}
	var result RewriteResult
	err = guard(func() error {
		var callErr error
		target, _ := oid(onto)
		result, callErr = l.rewrite(ctx, branch, wire.Rebase, wire.Field(1, target), wire.Field(2, principal(actor)))
		return callErr
	})
	return result, err
}

// InspectConflict reads native unresolved paths for one retained change/target
// under the daemon's mutation lock and broker freeze. Older peers refuse it.
func (r *Registry) InspectConflict(ctx context.Context, branch, change, onto string) ([]string, error) {
	retained, err := oid(change)
	if err != nil {
		return nil, err
	}
	target, err := oid(onto)
	if err != nil {
		return nil, err
	}
	link, err := r.Current(branch)
	if err != nil {
		return nil, err
	}
	if err := link.RequireReady(branch); err != nil {
		return nil, err
	}
	fields, err := link.call(ctx, branch, wire.InspectConflict, wire.Field(1, retained), wire.Field(2, target))
	if err != nil {
		return nil, err
	}
	paths, found := fields[1]
	if !found {
		return nil, ErrNotReady
	}
	return decodeNativePaths(paths), nil
}
func decodeNativePaths(list []byte) []string {
	paths := []string{}
	for list = list[2:]; len(list) > 0; {
		n := int(binary.BigEndian.Uint16(list))
		paths = append(paths, string(list[2:2+n]))
		list = list[2+n:]
	}
	return paths
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
	return l.rewrite(ctx, branch, method, args...)
}
func (l *Link) rewrite(ctx context.Context, branch string, method wire.Method, args ...[]byte) (RewriteResult, error) {
	fields, err := l.call(ctx, branch, method, args...)
	if err != nil {
		return RewriteResult{}, err
	}
	result := RewriteResult{Head: hex.EncodeToString(fields[1])}
	if list, found := fields[2]; found {
		result.Inspected = true
		result.Paths = decodeNativePaths(list)
	}
	return result, nil
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
