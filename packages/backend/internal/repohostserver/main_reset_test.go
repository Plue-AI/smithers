package repohostserver

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

func TestMainResetBindingOnlyAdmitsExactSyncWrite(t *testing.T) {
	old, newTip := strings.Repeat("1", 40), strings.Repeat("2", 40)
	binding, _ := json.Marshal(repohost.MainResetBinding{ID: "attention-one", Old: old, New: newTip})
	for _, name := range []string{"valid", "ordinary sync", "person", "run", "missing locked verifier", "wrong old", "wrong new", "other ref", "multiple refs", "deletion", "malformed", "hosted"} {
		t.Run(name, func(t *testing.T) {
			s := newTestServerWithMock(t, &mockFFI{})
			s.config.InstallMainMirror = true
			r := httptest.NewRequest("POST", "/repos/owner/app/git/receive-pack", nil)
			r.Header.Set(repohost.MainResetHeader, string(binding))
			r.Header.Set(repohost.PusherCredentialHeader, "sync")
			r.Header.Set(repohost.StartedHeader, "1")
			commands := []repohost.ReceivePackCommand{{RefName: "refs/heads/main", OldOID: old, NewOID: newTip}}
			switch name {
			case "ordinary sync":
				r.Header.Del(repohost.MainResetHeader)
			case "person", "run":
				r.Header.Set(repohost.PusherCredentialHeader, name)
			case "missing locked verifier":
				r.Header.Del(repohost.StartedHeader)
			case "wrong old":
				commands[0].OldOID = strings.Repeat("3", 40)
			case "wrong new":
				commands[0].NewOID = strings.Repeat("3", 40)
			case "other ref":
				commands[0].RefName = "refs/heads/topic"
			case "multiple refs":
				commands = append(commands, commands[0])
			case "deletion":
				commands[0].NewOID = strings.Repeat("0", 40)
			case "malformed":
				r.Header.Set(repohost.MainResetHeader, "{")
			case "hosted":
				s.config.InstallMainMirror = false
			}
			result, err := s.mainResetBinding(r, commands)
			if name == "valid" {
				require.NoError(t, err)
				require.NotNil(t, result)
			} else if name == "ordinary sync" {
				require.NoError(t, err)
				require.Nil(t, result)
			} else {
				require.Error(t, err)
				require.Nil(t, result)
			}
		})
	}
}
