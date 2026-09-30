package routes

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type OrgRouteService interface {
	GetOrg(ctx context.Context, viewer *db.User, orgName string) (db.Organization, error)
	CreateOrg(ctx context.Context, actor *db.User, req services.CreateOrgRequest) (db.Organization, error)
	UpdateOrg(ctx context.Context, actor *db.User, orgName string, req services.UpdateOrgRequest) (db.Organization, error)
	AddOrgMember(ctx context.Context, actor *db.User, orgName string, targetUserID int64, role string) error
	RemoveOrgMember(ctx context.Context, actor *db.User, orgName, username string) error
	ListOrgRepos(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Repository, int64, error)
	ListOrgMembers(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.ListOrgMembersRow, int64, error)
	ListOrgTeams(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Team, int64, error)
	CreateTeam(ctx context.Context, actor *db.User, orgName string, req services.CreateTeamRequest) (db.Team, error)
	GetTeam(ctx context.Context, viewer *db.User, orgName, teamName string) (db.Team, error)
	UpdateTeam(ctx context.Context, actor *db.User, orgName, teamName string, req services.UpdateTeamRequest) (db.Team, error)
	DeleteTeam(ctx context.Context, actor *db.User, orgName, teamName string) error
	ListTeamMembers(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.User, int64, error)
	AddTeamMember(ctx context.Context, actor *db.User, orgName, teamName, username string) error
	RemoveTeamMember(ctx context.Context, actor *db.User, orgName, teamName, username string) error
	ListTeamRepos(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.Repository, int64, error)
	AddTeamRepo(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error
	RemoveTeamRepo(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error
}

type OrgHandler struct {
	Service      OrgRouteService
	AuditService *services.AuditService
	// SSHHost is used to build the clone_url on mapped repository responses
	// (see mapRepoResponse in repos.go).
	SSHHost string
}

type OrgMemberResponse struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
	Role        string `json:"role"`
}

type TeamMemberResponse struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
}

type AddOrgMemberRequest struct {
	UserID int64  `json:"user_id"`
	Role   string `json:"role"`
}

func mapOrgMembersResponse(rows []db.ListOrgMembersRow) []OrgMemberResponse {
	members := make([]OrgMemberResponse, 0, len(rows))
	for _, row := range rows {
		members = append(members, OrgMemberResponse{
			ID:          row.ID,
			Username:    row.Username,
			DisplayName: row.DisplayName,
			AvatarURL:   row.AvatarUrl,
			Role:        row.Role,
		})
	}
	return members
}

func mapTeamMembersResponse(users []db.User) []TeamMemberResponse {
	members := make([]TeamMemberResponse, 0, len(users))
	for _, user := range users {
		members = append(members, TeamMemberResponse{
			ID:          user.ID,
			Username:    user.Username,
			DisplayName: user.DisplayName,
			AvatarURL:   user.AvatarUrl,
		})
	}
	return members
}

func routeParam(r *http.Request, key, message string) (string, error) {
	value := strings.TrimSpace(chi.URLParam(r, key))
	if value == "" {
		return "", errors.BadRequest(message)
	}
	return value, nil
}

func requireRouteUser(r *http.Request) (*db.User, error) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		return nil, errors.Unauthorized("authentication required")
	}
	return user, nil
}

func (h *OrgHandler) GetOrg(w http.ResponseWriter, r *http.Request) {
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	org, err := h.Service.GetOrg(r.Context(), middleware.UserFromContext(r.Context()), orgName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, org)
}

func (h *OrgHandler) PostOrg(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req services.CreateOrgRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	org, err := h.Service.CreateOrg(r.Context(), user, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "org.create",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "organization",
			TargetID:   &org.ID,
			TargetName: org.Name,
			Action:     "create",
			IPAddress:  r.RemoteAddr,
		})
	}

	errors.WriteJSON(w, http.StatusCreated, org)
}

func (h *OrgHandler) PatchOrg(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req services.UpdateOrgRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	org, err := h.Service.UpdateOrg(r.Context(), user, orgName, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, org)
}

func (h *OrgHandler) GetOrgRepos(w http.ResponseWriter, r *http.Request) {
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	repos, total, err := h.Service.ListOrgRepos(r.Context(), middleware.UserFromContext(r.Context()), orgName, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(repos), total)
	resp := make([]RepoResponse, 0, len(repos))
	for _, repo := range repos {
		resp = append(resp, mapRepoResponse(orgName, repo, h.SSHHost))
	}
	errors.WriteJSON(w, http.StatusOK, resp)
}

func (h *OrgHandler) GetOrgMembers(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	members, total, err := h.Service.ListOrgMembers(r.Context(), user, orgName, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(members), total)
	errors.WriteJSON(w, http.StatusOK, mapOrgMembersResponse(members))
}

func (h *OrgHandler) PostOrgMember(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req AddOrgMemberRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if err := h.Service.AddOrgMember(r.Context(), user, orgName, req.UserID, req.Role); err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "org.member_add",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "org_member",
			TargetID:   &req.UserID,
			TargetName: fmt.Sprintf("%s/user_%d", orgName, req.UserID),
			Action:     "add",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"role": req.Role},
		})
	}

	w.WriteHeader(http.StatusCreated)
}

func (h *OrgHandler) GetOrgTeams(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	teams, total, err := h.Service.ListOrgTeams(r.Context(), user, orgName, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(teams), total)
	errors.WriteJSON(w, http.StatusOK, teams)
}

func (h *OrgHandler) PostOrgTeam(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req services.CreateTeamRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	team, err := h.Service.CreateTeam(r.Context(), user, orgName, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, team)
}

func (h *OrgHandler) GetOrgTeam(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	team, err := h.Service.GetTeam(r.Context(), user, orgName, teamName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, team)
}

func (h *OrgHandler) PatchOrgTeam(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req services.UpdateTeamRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	team, err := h.Service.UpdateTeam(r.Context(), user, orgName, teamName, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, team)
}

func (h *OrgHandler) DeleteOrgTeam(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.DeleteTeam(r.Context(), user, orgName, teamName); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *OrgHandler) DeleteOrgMember(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	username, err := routeParam(r, "username", "username is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.RemoveOrgMember(r.Context(), user, orgName, username); err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "org.member_remove",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "org_member",
			TargetName: fmt.Sprintf("%s/%s", orgName, username),
			Action:     "remove",
			IPAddress:  r.RemoteAddr,
		})
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *OrgHandler) GetOrgTeamMembers(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	members, total, err := h.Service.ListTeamMembers(r.Context(), user, orgName, teamName, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(members), total)
	errors.WriteJSON(w, http.StatusOK, mapTeamMembersResponse(members))
}

func (h *OrgHandler) PutOrgTeamMember(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	username, err := routeParam(r, "username", "username is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.AddTeamMember(r.Context(), user, orgName, teamName, username); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *OrgHandler) DeleteOrgTeamMember(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	username, err := routeParam(r, "username", "username is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.RemoveTeamMember(r.Context(), user, orgName, teamName, username); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *OrgHandler) GetOrgTeamRepos(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	repos, total, err := h.Service.ListTeamRepos(r.Context(), user, orgName, teamName, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(repos), total)
	resp := make([]RepoResponse, 0, len(repos))
	for _, repo := range repos {
		resp = append(resp, mapRepoResponse(orgName, repo, h.SSHHost))
	}
	errors.WriteJSON(w, http.StatusOK, resp)
}

func (h *OrgHandler) PutOrgTeamRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, err := routeParam(r, "owner", "owner is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	repoName, err := routeParam(r, "repo", "repository name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.AddTeamRepo(r.Context(), user, orgName, teamName, owner, repoName); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *OrgHandler) DeleteOrgTeamRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	teamName, err := routeParam(r, "team", "team name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, err := routeParam(r, "owner", "owner is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	repoName, err := routeParam(r, "repo", "repository name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.RemoveTeamRepo(r.Context(), user, orgName, teamName, owner, repoName); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
