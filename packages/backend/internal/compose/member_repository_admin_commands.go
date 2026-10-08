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
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
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
	if len(parts) < 5 || (len(parts) > 6 && (!strings.HasPrefix(command, "webhooks.") || len(parts) > 9)) {
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
	var id, delivery int64
	var selector string
	if len(parts) >= 6 && (strings.HasPrefix(command, "webhooks.") || strings.HasPrefix(command, "labels.") || strings.HasPrefix(command, "deploy-keys.")) {
		id, err = strconv.ParseInt(parts[5], 10, 64)
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid resource id"))
			return
		}
	}
	if len(parts) == 6 && strings.HasPrefix(command, "protected-bookmarks.") {
		selector, err = url.PathUnescape(parts[5])
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid bookmark pattern"))
			return
		}
	}
	if len(parts) == 6 && strings.HasPrefix(command, "variables.") {
		// Match chi's retained variable selector: RawPath is already selected
		// when nonempty; otherwise the route receives the decoded Path.
		selector = parts[5]
		if r.URL.RawPath == "" {
			selector, err = url.PathUnescape(selector)
		}
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid variable name"))
			return
		}
		selector = strings.TrimSpace(selector)
	}
	if command == "webhooks.redeliver" && len(parts) == 9 {
		delivery, err = strconv.ParseInt(parts[7], 10, 64)
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid delivery id"))
			return
		}
	}
	var input any = struct{}{}
	if command == "webhooks.create" || command == "webhooks.update" || command == "repo.topics.update" || command == "labels.create" || command == "labels.update" || command == "protected-bookmarks.upsert" || command == "variables.set" || command == "deploy-keys.create" {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, middleware.MaxRequestBodySize))
		if err != nil {
			refuse(pkgerrors.BadRequest("invalid configuration body"))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		decoder := json.NewDecoder(bytes.NewReader(raw))
		if !strings.HasPrefix(command, "webhooks.") && command != "deploy-keys.create" && command != "repo.topics.update" {
			decoder.DisallowUnknownFields()
		}
		switch command {
		case "webhooks.create":
			var value services.CreateWebhookInput
			err = decoder.Decode(&value)
			input = value
		case "webhooks.update":
			var value services.UpdateWebhookInput
			err = decoder.Decode(&value)
			input = value
		case "repo.topics.update":
			var value services.ReplaceRepoTopicsInput
			err = decoder.Decode(&value)
			input = value
		case "deploy-keys.create":
			var value services.CreateDeployKeyRequest
			err = decoder.Decode(&value)
			input = value
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
			input, selector = value, value.Pattern
		case "variables.set":
			var value services.SetVariableInput
			err = decoder.Decode(&value)
			input, selector = value, value.Name
		default:
			err = pkgerrors.BadRequest("invalid configuration command")
		}
		if err != nil || decoder.Decode(new(any)) != io.EOF {
			refuse(pkgerrors.BadRequest("invalid configuration body"))
			return
		}
	}
	if strings.HasPrefix(command, "variables.") {
		value, _ := input.(services.SetVariableInput)
		if err := routes.ValidateVariableCommandInput(command, selector, value.Value); err != nil {
			refuse(err)
			return
		}
	}
	if command == "egress.read" {
		subject = services.InstallRepositoryEgressSubject(repository.ID)
	} else if strings.HasPrefix(command, "webhooks.") {
		subject, err = services.InstallWebhookSubject(repository.ID, command, id, delivery, input)
	} else if command == "repo.topics.update" {
		value, _ := input.(services.ReplaceRepoTopicsInput)
		subject, err = services.InstallRepoTopicsSubject(repository.ID, value)
	} else if strings.HasPrefix(command, "deploy-keys.") {
		subject, err = services.InstallDeployKeySubject(repository.ID, command, id, input)
	} else if strings.HasPrefix(command, "labels.") {
		subject, err = services.InstallLabelMutationSubject(repository.ID, command, id, input)
	} else if strings.HasPrefix(command, "variables.") {
		subject, err = services.InstallVariableSubject(repository.ID, command, selector, input)
	} else {
		subject, err = services.InstallProtectedBookmarkSubject(repository.ID, command, selector, input)
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
