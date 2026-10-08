package machined

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// These are host transport controls, not privilege-drop or freeze evidence.
// The required FaultSuite opts into the acceptance gate below; an ordinary Go
// run can verify refusals without claiming a C-DUR-04 pass or inventing a kill.
func TestRebaseFaultRootInputsValidatedBeforeUse(t *testing.T) {
	const target = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for _, cell := range []struct {
		name, onto string
		actor      []byte
	}{
		{"missing actor", target, nil},
		{"oversize actor", target, make([]byte, 1025)},
		{"traversal target", "../../root-canary", []byte("stack")},
		{"argv target", "--config=alias.rebase=!touch /root/canary", []byte("stack")},
		{"environment target", "LD_PRELOAD=/workspace/evil.so", []byte("stack")},
		{"kill selector target", "SMITHERS_MACHINED_KILL_AT=rebase-mid", []byte("stack")},
		{"short oid", strings.Repeat("a", 39), []byte("stack")},
		{"long oid", strings.Repeat("a", 42), []byte("stack")},
		{"NUL target", target + "\x00", []byte("stack")},
	} {
		t.Run(cell.name, func(t *testing.T) {
			r, _, guest := rpcFixture(t)
			result, err := r.Rebase(t.Context(), "a", cell.actor, cell.onto)
			require.Error(t, err)
			require.Zero(t, result)
			_, err = r.RebaseWithObjects(t.Context(), "a", cell.actor, cell.onto, "", func(func() error) error { t.Fatal("invalid root input entered mutation guard"); return nil })
			require.Error(t, err)
			requireGuestSilent(t, guest)
		})
	}
	t.Run("startup envelope", func(t *testing.T) {
		var registry Registry
		for _, cell := range []struct {
			branch, machine string
			boot            [16]byte
			credential      []byte
		}{
			{"", "vm", [16]byte{1}, []byte("host credential")},
			{"a", "", [16]byte{1}, []byte("host credential")},
			{"a", "vm", [16]byte{}, []byte("host credential")},
			{"a", "vm", [16]byte{1}, nil},
			{"a", "vm", [16]byte{1}, make([]byte, 1025)},
		} {
			require.ErrorIs(t, registry.BindBoot(cell.branch, cell.machine, cell.boot, cell.credential), ErrUnauthorized)
			_, err := registry.Current("a")
			require.ErrorIs(t, err, ErrNotReady)
		}
		require.NoError(t, registry.BindBoot("a", "vm", [16]byte{1}, []byte("host credential")))
		require.ErrorIs(t, registry.BindBoot("foreign", "vm", [16]byte{1}, []byte("substituted credential")), ErrUnauthorized)
	})
	for _, path := range []string{"../root-canary", "/root/canary", "a/../../canary", "a//canary", "a/./canary", "canary\x00"} {
		t.Run("writer/"+path, func(t *testing.T) {
			r, _, guest := rpcFixture(t)
			result, err := r.WriteFiles(t.Context(), "a", []byte("member"), []FileChange{{Path: path, Content: []byte("must not write")}})
			require.Error(t, err)
			require.Empty(t, result.Applied)
			requireGuestSilent(t, guest)
		})
	}
	for _, state := range []string{"unreconciled", "foreign branch", "closed boot", "missing object provider", "missing mutation guard"} {
		t.Run(state, func(t *testing.T) {
			r, link, guest := rpcFixture(t)
			branch := "a"
			switch state {
			case "unreconciled":
				r.mu.Lock()
				link.Connection.ready = false
				r.mu.Unlock()
			case "foreign branch":
				branch = "../../foreign"
			case "closed boot":
				require.NoError(t, link.Close())
			case "missing object provider":
				link.objectExporter = nil
			}
			var err error
			if state == "missing object provider" || state == "missing mutation guard" {
				var guard func(func() error) error
				if state == "missing object provider" {
					guard = func(func() error) error { t.Fatal("missing object provider entered mutation guard"); return nil }
				}
				_, err = r.RebaseWithObjects(t.Context(), branch, []byte("stack"), target, "", guard)
			} else {
				_, err = r.Rebase(t.Context(), branch, []byte("stack"), target)
			}
			require.Error(t, err)
			if state != "closed boot" {
				requireGuestSilent(t, guest)
			}
		})
	}
	t.Run("trusted transport positive control", func(t *testing.T) {
		r, _, guest := rpcFixture(t)
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			result, err := r.Rebase(ctx, "a", []byte("stack"), target)
			if err == nil && result.Head != target {
				err = wire.BadValue
			}
			done <- err
		}()
		frame, err := wire.Read(guest)
		require.NoError(t, err)
		id, method, args, err := frame.Request()
		require.NoError(t, err)
		require.Equal(t, byte(wire.Rebase), method)
		fields, err := wire.Fields("args11", args)
		require.NoError(t, err)
		bytes, err := hex.DecodeString(target)
		require.NoError(t, err)
		require.Equal(t, bytes, fields[1])
		require.Equal(t, principal([]byte("stack")), fields[2])
		require.Len(t, fields, 2)
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.Rebase), wire.Field(1, bytes))))}))
		require.NoError(t, <-done)
	})
	rebaseUnavailable(t, "root-inputs", "approved guest startup, actual UID/GID/groups, cgroup freeze, retained symlinks, substituted artifacts and root/outside canaries are not qualified")
}

// Do not dispatch a destructive test through a fixture broker and describe it
// as a real freeze/kill. Until that provider is qualified every required cell
// produces an unavailable observation, without a fabricated CRASH-POINT.
func TestRebaseCrashThroughDispatcher(t *testing.T) {
	for _, presence := range []string{"people-present", "people-absent"} {
		for _, point := range []string{"rebase-post-capture", "rebase-mid", "rebase-post-apply"} {
			t.Run(presence+"/"+point, func(t *testing.T) {
				rebaseUnavailable(t, point, "production dispatcher/daemon kill controller with real member writers and qualified broker freeze unavailable")
			})
		}
	}
}

func rebaseUnavailable(t *testing.T, point, reason string) {
	t.Helper()
	// check-run retains this diagnostic in its commit-bound log; this is not a
	// second receipt writer. Null observations cannot masquerade as zero loss.
	observation, err := json.Marshal(map[string]any{"check": "C-DUR-04", "case": t.Name(), "point": point, "status": "unavailable", "passing": false, "reason": reason, "marker_observed": false, "steps_rerun": nil, "effects_seen": nil, "writes_acknowledged": nil, "writes_found": nil, "root_execution_qualified": false})
	require.NoError(t, err)
	t.Log(string(observation))
	if os.Getenv("SMITHERS_REBASE_FAULT_REQUIRED") == "1" {
		t.Error("C-DUR-04 unavailable provider: " + reason)
	}
}
