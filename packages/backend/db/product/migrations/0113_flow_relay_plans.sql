-- Plans the browser workflow relay saved from its own Plan answers, by caller
-- and box: the only plans a relayed Run or plan approval may act on, and the
-- flow each plans (#3450).
CREATE TABLE public.flow_relay_plans (
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    workspace_id text NOT NULL,
    plan_id text NOT NULL,
    flow_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, workspace_id, plan_id)
);

CREATE INDEX flow_relay_plans_created_at_idx ON public.flow_relay_plans (created_at);
