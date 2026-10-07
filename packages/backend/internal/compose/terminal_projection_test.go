package compose

import (
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
	"testing"
)

// Real persisted session rows and the composed live socket supply card metadata.
// The fixture presence host is not a root/guest acceptance receipt.
func TestTerminalMetadataThroughComposedLiveSocket(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	_, err := f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	create := func(via string) db.WorkspaceSession {
		row, e := q.CreateWorkspaceSession(t.Context(), db.CreateWorkspaceSessionParams{WorkspaceID: f.row.ID, RepositoryID: f.row.RepositoryID, UserID: f.user.ID, Cols: 80, Rows: 24})
		require.NoError(t, e)
		_, e = q.UpdateWorkspaceSessionSSHConnectionInfo(t.Context(), db.UpdateWorkspaceSessionSSHConnectionInfoParams{ID: row.ID, SshConnectionInfo: []byte(fmt.Sprintf(`{"via":%q}`, via))})
		require.NoError(t, e)
		return row
	}
	own := create("terminal")
	_ = create("ssh")
	f.p.terminals = terminalProjection(f.pool, func(id string) routes.TerminalPresence {
		require.Equal(t, own.ID, id)
		return routes.TerminalPresence{Owner: f.user.ID}
	}, nil)
	socket := f.dial(t)
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	frame := readPresenceFrame(t, socket)
	require.Equal(t, "snap", frame.T)
	var model struct {
		Terminals []struct {
			ID     string `json:"id"`
			Frozen bool   `json:"frozen"`
			Owner  struct {
				Login string `json:"login"`
			} `json:"owner"`
		} `json:"terminals"`
	}
	require.NoError(t, json.Unmarshal(frame.Data, &model))
	require.Len(t, model.Terminals, 1)
	require.Equal(t, own.ID, model.Terminals[0].ID)
	require.Equal(t, f.user.Username, model.Terminals[0].Owner.Login)
	require.True(t, model.Terminals[0].Frozen, "a persisted request is not a ready broker")
	_, err = f.pool.Exec(t.Context(), `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	rows, err := f.p.terminals(t.Context(), f.row, nil)
	require.NoError(t, err)
	require.Empty(t, rows, "revoked members disappear from terminal metadata")
}
