package routes

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type WorkflowCacheRouteService interface {
	Restore(ctx context.Context, run db.WorkflowRun, key, cacheVersion string) (services.WorkflowCacheRestoreResult, error)
	BeginSave(ctx context.Context, run db.WorkflowRun, key, cacheVersion string, objectSizeBytes int64) (services.WorkflowCacheSaveReservation, error)
	FinalizeSave(ctx context.Context, run db.WorkflowRun, cacheID, objectSizeBytes int64) (db.WorkflowCache, error)
	AbortSave(ctx context.Context, run db.WorkflowRun, cacheID int64) error
	List(ctx context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) ([]db.WorkflowCache, error)
	Clear(ctx context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) (services.WorkflowCacheClearResult, error)
	Stats(ctx context.Context, repositoryID int64) (services.WorkflowCacheStats, error)
}

type WorkflowCacheHandler struct {
	Service WorkflowCacheRouteService
}

type workflowCacheLookupRequest struct {
	Key          string `json:"key"`
	CacheVersion string `json:"cache_version"`
}

type workflowCacheBeginSaveRequest struct {
	Key             string `json:"key"`
	CacheVersion    string `json:"cache_version"`
	ObjectSizeBytes int64  `json:"object_size_bytes"`
}

type workflowCacheFinalizeRequest struct {
	ObjectSizeBytes int64 `json:"object_size_bytes"`
}

type workflowCacheResponse struct {
	ID              int64      `json:"id"`
	RepositoryID    int64      `json:"repository_id"`
	WorkflowRunID   *int64     `json:"workflow_run_id,omitempty"`
	BookmarkName    string     `json:"bookmark_name"`
	CacheKey        string     `json:"cache_key"`
	CacheVersion    string     `json:"cache_version"`
	ObjectKey       string     `json:"object_key"`
	ObjectSizeBytes int64      `json:"object_size_bytes"`
	Compression     string     `json:"compression"`
	Status          string     `json:"status"`
	HitCount        int64      `json:"hit_count"`
	LastHitAt       *time.Time `json:"last_hit_at,omitempty"`
	FinalizedAt     *time.Time `json:"finalized_at,omitempty"`
	ExpiresAt       time.Time  `json:"expires_at"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type workflowCacheRestoreResponse struct {
	Hit             bool   `json:"hit"`
	CacheID         int64  `json:"cache_id,omitempty"`
	CacheKey        string `json:"cache_key,omitempty"`
	CacheVersion    string `json:"cache_version,omitempty"`
	BookmarkName    string `json:"bookmark_name,omitempty"`
	Compression     string `json:"compression,omitempty"`
	DownloadURL     string `json:"download_url,omitempty"`
	ObjectSizeBytes int64  `json:"object_size_bytes,omitempty"`
}

type workflowCacheSaveResponse struct {
	CacheID         int64             `json:"cache_id"`
	CacheKey        string            `json:"cache_key"`
	CacheVersion    string            `json:"cache_version"`
	BookmarkName    string            `json:"bookmark_name"`
	Compression     string            `json:"compression"`
	UploadURL       string            `json:"upload_url,omitempty"`
	UploadHeaders   map[string]string `json:"upload_headers,omitempty"`
	AlreadyExists   bool              `json:"already_exists"`
	ArchiveMaxBytes int64             `json:"archive_max_bytes"`
}

func mapWorkflowCacheResponse(cache db.WorkflowCache) workflowCacheResponse {
	response := workflowCacheResponse{
		ID:              cache.ID,
		RepositoryID:    cache.RepositoryID,
		BookmarkName:    cache.BookmarkName,
		CacheKey:        cache.CacheKey,
		CacheVersion:    cache.CacheVersion,
		ObjectKey:       cache.ObjectKey,
		ObjectSizeBytes: cache.ObjectSizeBytes,
		Compression:     cache.Compression,
		Status:          cache.Status,
		HitCount:        cache.HitCount,
		ExpiresAt:       cache.ExpiresAt,
		CreatedAt:       cache.CreatedAt,
		UpdatedAt:       cache.UpdatedAt,
	}
	if cache.WorkflowRunID.Valid {
		runID := cache.WorkflowRunID.Int64
		response.WorkflowRunID = &runID
	}
	if cache.LastHitAt.Valid {
		t := cache.LastHitAt.Time
		response.LastHitAt = &t
	}
	if cache.FinalizedAt.Valid {
		t := cache.FinalizedAt.Time
		response.FinalizedAt = &t
	}
	return response
}

func (h *WorkflowCacheHandler) Restore(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow cache service unavailable"))
		return
	}
	run := middleware.WorkflowRunFromContext(r.Context())
	if run == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow run context not loaded"))
		return
	}

	var req workflowCacheLookupRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	result, err := h.Service.Restore(r.Context(), *run, req.Key, req.CacheVersion)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	response := workflowCacheRestoreResponse{Hit: result.CacheHit}
	if result.Cache != nil {
		response.CacheID = result.Cache.ID
		response.CacheKey = result.Cache.CacheKey
		response.CacheVersion = result.Cache.CacheVersion
		response.BookmarkName = result.ResolvedBookmark
		response.Compression = result.Cache.Compression
		response.DownloadURL = result.DownloadURL
		response.ObjectSizeBytes = result.Cache.ObjectSizeBytes
	}
	pkgerrors.WriteJSON(w, http.StatusOK, response)
}

func (h *WorkflowCacheHandler) BeginSave(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow cache service unavailable"))
		return
	}
	run := middleware.WorkflowRunFromContext(r.Context())
	if run == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow run context not loaded"))
		return
	}

	var req workflowCacheBeginSaveRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	reservation, err := h.Service.BeginSave(r.Context(), *run, req.Key, req.CacheVersion, req.ObjectSizeBytes)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, workflowCacheSaveResponse{
		CacheID:         reservation.Cache.ID,
		CacheKey:        reservation.Cache.CacheKey,
		CacheVersion:    reservation.Cache.CacheVersion,
		BookmarkName:    reservation.Cache.BookmarkName,
		Compression:     reservation.Cache.Compression,
		UploadURL:       reservation.UploadURL,
		UploadHeaders:   reservation.UploadHeaders,
		AlreadyExists:   reservation.AlreadyExists,
		ArchiveMaxBytes: reservation.ArchiveMaxBytes,
	})
}

func (h *WorkflowCacheHandler) FinalizeSave(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow cache service unavailable"))
		return
	}
	run := middleware.WorkflowRunFromContext(r.Context())
	if run == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow run context not loaded"))
		return
	}

	cacheID, err := parseWorkflowCacheID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req workflowCacheFinalizeRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	cache, err := h.Service.FinalizeSave(r.Context(), *run, cacheID, req.ObjectSizeBytes)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, mapWorkflowCacheResponse(cache))
}

func (h *WorkflowCacheHandler) AbortSave(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow cache service unavailable"))
		return
	}
	run := middleware.WorkflowRunFromContext(r.Context())
	if run == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow run context not loaded"))
		return
	}

	cacheID, err := parseWorkflowCacheID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	if err := h.Service.AbortSave(r.Context(), *run, cacheID); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorkflowCacheHandler) ListCaches(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow cache service unavailable"))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	cursor, perPage, err := parseOffsetPagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	rows, err := h.Service.List(r.Context(), repoCtx.Repository.ID, services.WorkflowCacheListFilter{
		Page:     cursorToPage(cursor, perPage),
		PerPage:  perPage,
		Bookmark: r.URL.Query().Get("bookmark"),
		CacheKey: r.URL.Query().Get("key"),
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	response := make([]workflowCacheResponse, len(rows))
	for i, row := range rows {
		response[i] = mapWorkflowCacheResponse(row)
	}
	pkgerrors.WriteJSON(w, http.StatusOK, response)
}

func (h *WorkflowCacheHandler) ClearCaches(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow cache service unavailable"))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	result, err := h.Service.Clear(r.Context(), repoCtx.Repository.ID, services.WorkflowCacheListFilter{
		Bookmark: r.URL.Query().Get("bookmark"),
		CacheKey: r.URL.Query().Get("key"),
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *WorkflowCacheHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow cache service unavailable"))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	stats, err := h.Service.Stats(r.Context(), repoCtx.Repository.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, stats)
}

func parseWorkflowCacheID(r *http.Request) (int64, error) {
	raw := chi.URLParam(r, "cache-id")
	cacheID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || cacheID <= 0 {
		return 0, pkgerrors.BadRequest("invalid cache id")
	}
	return cacheID, nil
}
