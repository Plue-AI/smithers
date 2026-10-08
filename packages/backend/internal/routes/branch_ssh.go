package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	gateway "github.com/smithersai/smithers/packages/backend/ssh"
)

// SSHLine reads connection metadata only; authentication and person admission
// remain at the gateway. The catalog and app use this same door.
func (h *BranchHandler) SSHLine(q *db.Queries, fallbackOrigin string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		metadata, composed := h.Reads.(interface {
			PresenceBranch(context.Context, string, int64, int64) (db.Workspace, error)
		})
		repo, member, err := h.authorize(r, "ssh", composed && q != nil)
		if err != nil {
			writeBranchError(w, r, err)
			return
		}
		login := r.URL.Query().Get("branch")
		// Validate before querying, including main and grant usernames.
		if _, err = gateway.ResolveBranchName(login, []string{login}); err != nil {
			writeBranchError(w, r, pkgerrors.BadRequest("Invalid branch"))
			return
		}
		names := []string{}
		// A TODO's branch is named smithers/<slug> while its machine keeps the
		// stack's bookmark, so the resolved branch is read by machine id.
		machines := map[string]string{}
		for page := 1; ; page++ {
			rows, total, e := h.Reads.ListBranches(r.Context(), repo, member, page, 100)
			if e != nil {
				writeBranchError(w, r, e)
				return
			}
			for _, row := range rows {
				// As at the gateway, the stack's own bookmark is no login.
				if row.Name == services.MythicalBookmark {
					continue
				}
				names = append(names, row.Name)
				machines[row.Name] = row.Machine.ID
			}
			if int64(page*100) >= total || len(rows) == 0 {
				break
			}
		}
		name, err := gateway.ResolveBranchName(login, names)
		if err != nil {
			writeBranchError(w, r, pkgerrors.BadRequest(err.Error()))
			return
		}
		branch := name
		if id := machines[name]; id != "" {
			branch = id
		}
		if _, err = metadata.PresenceBranch(r.Context(), branch, repo, member); err != nil {
			writeBranchError(w, r, err)
			return
		}
		origin := fallbackOrigin
		setting, err := q.GetInstallSetting(r.Context(), "public_origins")
		if err == nil {
			var origins []string
			if json.Unmarshal(setting.Value, &origins) != nil {
				writeBranchError(w, r, pkgerrors.Internal("Invalid address"))
				return
			}
			origin = ""
			if len(origins) > 0 {
				origin = origins[0]
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			writeBranchError(w, r, err)
			return
		}
		host := "localhost"
		if origin != "" {
			address, e := url.Parse(origin)
			if e != nil || address.Hostname() == "" || address.User != nil ||
				(address.Scheme != "http" && address.Scheme != "https") ||
				strings.ContainsAny(address.Hostname(), " \t\r\n@'\";`$\\") {
				writeBranchError(w, r, pkgerrors.Internal("Invalid address"))
				return
			}
			host = address.Hostname()
		}
		// The CLI consumes structured fields and never interpolates this display line.
		pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"branch": name, "host": host, "port": 2222, "value": "ssh -p 2222 " + login + "@" + host})
	}
}
