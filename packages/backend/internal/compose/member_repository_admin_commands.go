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

func admitInstallRepositoryAdmin(w http.ResponseWriter, r *http.Request, q *db.Queries, command string, next http.Handler) {
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
		refuse(pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository configuration store unavailable"))
		return
	}
	parts := strings.Split(strings.Trim(r.URL.EscapedPath(), "/"), "/")
	if len(parts) < 5 || len(parts) > 6 {
		refuse(pkgerrors.BadRequest("invalid repository configuration request"))
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
			refuse(pkgerrors.Internal("load configuration repository").WithCause(err))
		}
		return
	}
	subject.RepositoryID = repository.ID
	var id int64
	var pattern string
	if len(parts) == 6 && strings.HasPrefix(command, "labels.") {
		id, err = strconv.ParseInt(parts[5], 10, 64)
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid label id"))
			return
		}
	}
	if len(parts) == 6 && strings.HasPrefix(command, "protected-bookmarks.") {
		pattern, err = url.PathUnescape(parts[5])
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid bookmark pattern"))
			return
		}
	}
	var input any = struct{}{}
	if command == "labels.create" || command == "labels.update" || command == "protected-bookmarks.upsert" {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid configuration body"))
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
		case "protected-bookmarks.upsert":
			var value services.UpsertProtectedBookmarkInput
			err = decoder.Decode(&value)
			input, pattern = value, value.Pattern
		default:
			err = pkgerrors.BadRequest("invalid configuration command")
		}
		if err != nil || decoder.Decode(new(any)) != io.EOF {
			refuse(pkgerrors.BadRequest("invalid configuration body"))
			return
		}
	}
	if strings.HasPrefix(command, "labels.") {
		subject, err = services.InstallLabelMutationSubject(repository.ID, command, id, input)
	} else {
		subject, err = services.InstallProtectedBookmarkSubject(repository.ID, command, pattern, input)
	}
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
