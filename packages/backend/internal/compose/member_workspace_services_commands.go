package compose

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func admitInstallWorkspaceServices(w http.ResponseWriter, r *http.Request, q *db.Queries, command string, next http.Handler) {
	subject := services.InstallSubject{}
	refuse := func(failure error) {
		if _, err := services.Authorize(r.Context(), q, command, subject); err != nil {
			failure = err
		}
		writeConfirmationDispatchError(w, failure)
	}
	if q == nil {
		writeConfirmationDispatchError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace store unavailable"))
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if (command == "workspace.services.list" && len(parts) != 7) || (command != "workspace.services.list" && len(parts) != 9) || parts[4] != "workspaces" || parts[6] != "services" {
		refuse(pkgerrors.BadRequest("invalid preview"))
		return
	}
	repository, err := q.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(parts[2]), LowerName: strings.ToLower(parts[3])})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			refuse(pkgerrors.NotFound("repository not found"))
		} else {
			refuse(pkgerrors.Internal("load preview repository").WithCause(err))
		}
		return
	}
	var port uint64
	if command == "workspace.services.list" {
		subject = services.InstallWorkspaceServicesSubject(repository.ID, parts[5])
	} else {
		port, err = strconv.ParseUint(parts[7], 10, 16)
		if err != nil || port == 0 {
			refuse(pkgerrors.BadRequest("invalid preview port"))
			return
		}
		subject = services.InstallWorkspaceVisibilitySubject(repository.ID, parts[5], uint16(port))
	}
	if command == "workspace.preview.update" {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid preview body"))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var input services.WorkspaceVisibilityInput
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || input.Public == nil || decoder.Decode(new(any)) != io.EOF {
			refuse(pkgerrors.BadRequest("public boolean required"))
			return
		}
		subject = services.InstallWorkspaceVisibilityWriteSubject(repository.ID, parts[5], uint16(port), *input.Public)
	}
	decision, err := services.Authorize(r.Context(), q, command, subject)
	if err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
}
