-- Disposable minimal live PostgreSQL fixture.
-- CREATE definitions copied from the product baseline; only queried additions included.

CREATE TABLE public.users (
    id bigint NOT NULL,
    username character varying(255) NOT NULL,
    lower_username character varying(255) NOT NULL,
    email character varying(255),
    lower_email character varying(255),
    display_name character varying(255) DEFAULT ''::character varying NOT NULL,
    bio text DEFAULT ''::text NOT NULL,
    search_vector tsvector,
    avatar_url character varying(2048) DEFAULT ''::character varying NOT NULL,
    wallet_address character varying(42),
    user_type character varying(32) DEFAULT 'user'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    prohibit_login boolean DEFAULT false NOT NULL,
    email_notifications_enabled boolean DEFAULT true NOT NULL,
    last_login_at timestamptz,
    deleted_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    is_synthetic boolean DEFAULT false NOT NULL,
    CONSTRAINT ck_users_canonical_owner_namespace CHECK ((((lower_username)::text = lower((username)::text)) AND ((username)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text))),
    CONSTRAINT users_user_type_check CHECK (((user_type)::text = ANY ((ARRAY['user'::character varying, 'bot'::character varying, 'service'::character varying])::text[])))
);

CREATE TABLE public.repositories (
    id bigint NOT NULL,
    user_id bigint,
    org_id bigint,
    name character varying(255) NOT NULL,
    lower_name character varying(255) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    default_bookmark character varying(255) DEFAULT 'main'::character varying NOT NULL,
    topics text[] DEFAULT '{}'::text[] NOT NULL,
    search_vector tsvector,
    next_issue_number bigint DEFAULT 1 NOT NULL,
    next_landing_number bigint DEFAULT 1 NOT NULL,
    is_fork boolean DEFAULT false NOT NULL,
    fork_id bigint,
    is_template boolean DEFAULT false NOT NULL,
    template_id bigint,
    is_archived boolean DEFAULT false NOT NULL,
    archived_at timestamptz,
    is_mirror boolean DEFAULT false NOT NULL,
    mirror_destination text DEFAULT ''::text NOT NULL,
    mirror_status character varying(16) DEFAULT 'unconfigured'::character varying NOT NULL,
    last_mirror_at timestamptz,
    last_mirror_error text,
    last_mirror_github_head character varying(64),
    mirror_behind_refs integer DEFAULT 0 NOT NULL,
    mirror_failed_refs integer DEFAULT 0 NOT NULL,
    workspace_idle_timeout_secs integer DEFAULT 1800 NOT NULL,
    workspace_persistence character varying(16) DEFAULT 'persistent'::character varying NOT NULL,
    workspace_dependencies text[] DEFAULT '{}'::text[] NOT NULL,
    clone_depth integer DEFAULT 0 NOT NULL,
    landing_queue_mode character varying(16) DEFAULT 'serialized'::character varying NOT NULL,
    landing_queue_required_checks text[] DEFAULT '{}'::text[] NOT NULL,
    num_stars bigint DEFAULT 0 NOT NULL,
    num_forks bigint DEFAULT 0 NOT NULL,
    num_watches bigint DEFAULT 0 NOT NULL,
    num_issues bigint DEFAULT 0 NOT NULL,
    num_closed_issues bigint DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT ck_repositories_canonical_storage_identity CHECK ((((lower_name)::text = lower((name)::text)) AND (length((name)::text) <= 100) AND ((name)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text) AND (lower((name)::text) !~ '\.(git|wiki|docs)$'::text) AND (lower((name)::text) <> ALL (ARRAY['agent'::text, 'bookmarks'::text, 'changes'::text, 'commits'::text, 'contributors'::text, 'issues'::text, 'labels'::text, 'landings'::text, 'milestones'::text, 'operations'::text, 'pulls'::text, 'settings'::text, 'stargazers'::text, 'watchers'::text, 'workflows'::text])))),
    CONSTRAINT repositories_check CHECK ((num_nonnulls(user_id, org_id) = 1)),
    CONSTRAINT repositories_clone_depth_check CHECK ((clone_depth >= '-1'::integer)),
    CONSTRAINT repositories_landing_queue_mode_check CHECK (((landing_queue_mode)::text = ANY ((ARRAY['serialized'::character varying, 'parallel'::character varying])::text[]))),
    CONSTRAINT repositories_mirror_behind_refs_check CHECK ((mirror_behind_refs >= 0)),
    CONSTRAINT repositories_mirror_failed_refs_check CHECK ((mirror_failed_refs >= 0)),
    CONSTRAINT repositories_mirror_status_check CHECK (((mirror_status)::text = ANY ((ARRAY['synced'::character varying, 'behind'::character varying, 'failed'::character varying, 'unconfigured'::character varying])::text[]))),
    CONSTRAINT repositories_workspace_idle_timeout_secs_check CHECK ((workspace_idle_timeout_secs > 0)),
    CONSTRAINT repositories_workspace_persistence_check CHECK (((workspace_persistence)::text = ANY ((ARRAY['persistent'::character varying, 'ephemeral'::character varying])::text[])))
);

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    repository_id bigint NOT NULL,
    user_id bigint NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    is_fork boolean DEFAULT false NOT NULL,
    parent_workspace_id uuid,
    target_bookmark text DEFAULT 'main'::text NOT NULL,
    source_snapshot_id uuid,
    kind text DEFAULT 'container'::text NOT NULL,
    environment_source text DEFAULT '.smithers/environment.nix'::text NOT NULL,
    environment_revision text DEFAULT ''::text NOT NULL,
    environment_closure_hash text DEFAULT ''::text NOT NULL,
    agent_session_id uuid,
    head_push_token_id bigint,
    environment_image text DEFAULT ''::text NOT NULL,
    desktop_session_id text DEFAULT ''::text NOT NULL,
    desktop_session_token_hash text DEFAULT ''::text NOT NULL,
    desktop_session_expires_at timestamptz,
    vm_id text DEFAULT ''::text NOT NULL,
    provisioning_generation integer DEFAULT 0 NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    failure_code text,
    failure_message text,
    provisioning_stage text DEFAULT ''::text NOT NULL,
    last_activity_at timestamptz DEFAULT now() NOT NULL,
    idle_timeout_secs integer DEFAULT 1800 NOT NULL,
    suspended_at timestamptz,
    started_at timestamptz,
    resumed_at timestamptz,
    head_change_id text DEFAULT ''::text NOT NULL,
    head_commit_id text DEFAULT ''::text NOT NULL,
    ahead integer DEFAULT 0 NOT NULL,
    behind integer DEFAULT 0 NOT NULL,
    last_accessed_at timestamptz,
    deleted_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT workspaces_ahead_check CHECK ((ahead >= 0)),
    CONSTRAINT workspaces_behind_check CHECK ((behind >= 0)),
    CONSTRAINT workspaces_failure_detail_check CHECK (((((status)::text = 'failed'::text) AND (failure_code IS NOT NULL) AND (btrim(failure_code) <> ''::text) AND (failure_message IS NOT NULL) AND (btrim(failure_message) <> ''::text)) OR (((status)::text <> 'failed'::text) AND (failure_code IS NULL) AND (failure_message IS NULL)))),
    CONSTRAINT workspaces_kind_check CHECK ((kind = ANY (ARRAY['container'::text, 'vm'::text, 'desktop'::text, 'agent'::text]))),
    CONSTRAINT workspaces_provisioning_generation_check CHECK ((provisioning_generation >= 0)),
    CONSTRAINT workspaces_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'starting'::character varying, 'running'::character varying, 'suspended'::character varying, 'stopped'::character varying, 'failed'::character varying])::text[])))
);

CREATE TABLE public.workspace_shares (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id bigint NOT NULL,
    grantee_user_id bigint NOT NULL,
    level character varying(8) DEFAULT 'read'::character varying NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT workspace_shares_level_check CHECK (((level)::text = ANY ((ARRAY['read'::character varying, 'write'::character varying])::text[])))
);

CREATE TABLE public.sandbox_usage_intervals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id bigint NOT NULL,
    sandbox_kind text NOT NULL,
    sandbox_id text NOT NULL,
    started_at timestamptz DEFAULT now() NOT NULL,
    ended_at timestamptz,
    CONSTRAINT sandbox_usage_intervals_order CHECK (((ended_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT sandbox_usage_intervals_sandbox_kind_check CHECK ((sandbox_kind = ANY (ARRAY['workspace'::text, 'gateway'::text, 'agent'::text])))
);

ALTER TABLE users ADD PRIMARY KEY (id);

ALTER TABLE repositories ADD PRIMARY KEY (id);

ALTER TABLE workspaces ADD PRIMARY KEY (id);

ALTER TABLE workspaces ADD FOREIGN KEY (repository_id) REFERENCES repositories(id);

ALTER TABLE workspaces ADD FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE workspaces ADD COLUMN rebuild_required_at timestamptz, ADD COLUMN client_lease_secs integer, ADD COLUMN client_lease_expires_at timestamptz, ADD COLUMN source_commit text NOT NULL DEFAULT '', ADD COLUMN vcpu_count integer, ADD COLUMN memory_mb integer, ADD COLUMN disk_mb integer;

CREATE UNIQUE INDEX sandbox_usage_open ON sandbox_usage_intervals (sandbox_kind,sandbox_id) WHERE ended_at IS NULL;

