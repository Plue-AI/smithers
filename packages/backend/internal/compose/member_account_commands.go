package compose

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func admitInstallAccountMutation(w http.ResponseWriter, r *http.Request, q *db.Queries, command string, next http.Handler) {
	refuse := func(failure error) {
		if _, err := services.Authorize(r.Context(), q, command); err != nil {
			failure = err
		}
		writeConfirmationDispatchError(w, failure)
	}
	var input any = struct{}{}
	var resource int64
	if command == "account.connection.delete" {
		parts := strings.Split(strings.Trim(r.URL.EscapedPath(), "/"), "/")
		var err error
		resource, err = strconv.ParseInt(parts[len(parts)-1], 10, 64)
		if err != nil || resource <= 0 {
			refuse(pkgerrors.BadRequest("invalid account id"))
			return
		}
	} else {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, middleware.MaxRequestBodySize))
		if err != nil {
			if middleware.IsMaxBytesError(err) {
				refuse(pkgerrors.RequestEntityTooLarge("request body too large"))
			} else {
				refuse(pkgerrors.BadRequest("invalid account body"))
			}
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		decoder := json.NewDecoder(bytes.NewReader(raw))
		// Match the retained handlers: unknown fields are ignored, and cannot
		// affect the authenticated account or the typed mutation binding.
		switch command {
		case "account.profile.update":
			var value services.UpdateUserRequest
			err = decoder.Decode(&value)
			input = value
		case "account.notifications.update":
			var value services.UpdateNotificationPreferencesRequest
			err = decoder.Decode(&value)
			input = value
		default:
			err = pkgerrors.BadRequest("invalid account command")
		}
		if err != nil || decoder.Decode(new(any)) != io.EOF {
			refuse(pkgerrors.BadRequest("invalid account body"))
			return
		}
	}
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || info.User == nil {
		refuse(pkgerrors.Unauthorized("authentication required"))
		return
	}
	repository, err := services.InstallRepositoryID(r.Context(), q)
	if err != nil {
		refuse(err)
		return
	}
	subject, err := services.InstallAccountMutationSubject(repository, info.User.ID, command, resource, input)
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
