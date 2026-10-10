package routes

import (
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// InstallAckDelayHandler uses the owner-person-session admission of install
// settings, then binds the diagnostic to a branch in this install's repository.
type InstallAckDelayHandler struct {
	Pool     *pgxpool.Pool
	Queries  *db.Queries
	Registry *machined.Registry
}

func (h *InstallAckDelayHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	branch := r.URL.Query().Get("branch")
	reference := r.URL.Query().Get("actor_reference")
	var actorBytes []byte
	if reference != "" {
		var err error
		actorBytes, err = hex.DecodeString(reference)
		if r.Method != http.MethodGet || err != nil || len(actorBytes) != 16 || hex.EncodeToString(actorBytes) != reference {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("actor reference invalid"))
			return
		}
	}
	delay := 0
	id, boot := "", ""
	if r.Method == http.MethodPost {
		var body struct {
			Branch  string `json:"branch"`
			DelayMS *int   `json:"delay_ms"`
			ID      string `json:"id"`
			Boot    string `json:"boot"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 4097))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil || body.DelayMS == nil || decoder.Decode(new(any)) != io.EOF {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("branch and delay_ms required"))
			return
		}
		branch, delay, id, boot = body.Branch, *body.DelayMS, body.ID, body.Boot
		if delay != 0 && delay != 10000 {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("delay_ms must be 0 or 10000"))
			return
		}
		if delay == 0 && (id == "" || boot == "") || delay == 10000 && (id != "" || boot != "") {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("restoration requires id and boot; arming forbids them"))
			return
		}
	}
	if branch == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("branch required"))
		return
	}
	repository, err := services.InstallRepositoryID(r.Context(), h.Queries)
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("install repository unavailable"))
		return
	}
	row, err := h.Queries.GetWorkspace(r.Context(), branch)
	if err != nil || row.RepositoryID != repository {
		pkgerrors.WriteError(w, pkgerrors.NotFound("branch not found"))
		return
	}
	if h.Registry == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "machine connection unavailable"))
		return
	}
	var receipt machined.AckDelayReceipt
	if r.Method == http.MethodPost {
		receipt, err = h.Registry.AckDelay(branch, delay, id, boot)
	} else {
		receipt, err = h.Registry.ReadAckDelay(branch)
	}
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Conflict("ready machine connection required"))
		return
	}
	var actor *machined.ActorIdentity
	if reference != "" {
		if h.Pool == nil {
			pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "actor reference lookup unavailable"))
			return
		}
		tx, err := h.Pool.Begin(r.Context())
		if err != nil {
			pkgerrors.WriteError(w, pkgerrors.Internal("actor lookup failed").WithCause(err))
			return
		}
		defer tx.Rollback(r.Context())
		identity, err := machined.ResolveActorInTx(r.Context(), tx, branch, row.VmID, actorBytes)
		if err != nil {
			pkgerrors.WriteError(w, pkgerrors.NotFound("actor reference not found"))
			return
		}
		actor = &identity
	}
	pkgerrors.WriteJSON(w, http.StatusOK, struct {
		machined.AckDelayReceipt
		Actor *machined.ActorIdentity `json:"actor,omitempty"`
	}{receipt, actor})
}
