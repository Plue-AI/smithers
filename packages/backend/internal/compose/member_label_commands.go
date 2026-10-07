package compose

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func admitInstallLabelMutation(w http.ResponseWriter, r *http.Request, q *db.Queries, command string, next http.Handler) {
	subject := services.InstallSubject{}
	refuse := func(failure error) {
		// Invalid input never gets a bound decision or reaches the handler.
		// Credential and role refusals retain priority over input diagnostics.
		if _, err := services.Authorize(r.Context(), q, command, subject); err != nil {
			failure = err
		}
		writeConfirmationDispatchError(w, failure)
	}
	if q == nil {
		refuse(pkgerrors.New(pkgerrors.CodeServiceUnavailable, "label store unavailable"))
		return
	}
	parts := strings.Split(strings.Trim(r.URL.EscapedPath(), "/"), "/")
	if len(parts) < 5 || len(parts) > 6 {
		refuse(pkgerrors.BadRequest("invalid label request"))
		return
	}
	owner, err := url.PathUnescape(parts[2])
	if err != nil {
		refuse(pkgerrors.BadRequest("invalid repository"))
		return
	}
	name, err := url.PathUnescape(parts[3])
	if err != nil {
		refuse(pkgerrors.BadRequest("invalid repository"))
		return
	}
	repository, err := q.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(owner), LowerName: strings.ToLower(name)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			refuse(pkgerrors.NotFound("repository not found"))
		} else {
			refuse(pkgerrors.Internal("load label repository").WithCause(err))
		}
		return
	}
	subject.RepositoryID = repository.ID
	var id int64
	if len(parts) == 6 {
		id, err = strconv.ParseInt(parts[5], 10, 64)
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid label id"))
			return
		}
	}
	var input any = struct{}{}
	if command != "labels.delete" {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid label body"))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		switch command {
		case "labels.create":
			var value services.CreateLabelInput
			err = decoder.Decode(&value)
			input = value
		case "labels.update":
			var value services.UpdateLabelInput
			err = decoder.Decode(&value)
			input = value
		default:
			err = pkgerrors.BadRequest("invalid label command")
		}
		if err != nil || decoder.Decode(new(any)) != io.EOF {
			refuse(pkgerrors.BadRequest("invalid label body"))
			return
		}
	}
	subject, err = services.InstallLabelMutationSubject(repository.ID, command, id, input)
	if err != nil {
		refuse(err)
		return
	}
	decision, err := services.Authorize(r.Context(), q, command, subject)
	if err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
}
