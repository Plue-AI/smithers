-- A run's projections as its lane's coding host last answered them (spec
-- §7.2 run:<id>, §11.6): kept while the lane runs, so the run stays readable
-- once the lane stops. A merged TODO's lane is stopped, and a read never
-- wakes a sleeping branch. One row per Projection.Snapshot selector
-- (run-summary, run-events, run-tree, transcript, approvals); answer is the
-- host's answer verbatim (json keeps its text).
CREATE TABLE public.run_journals (
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    run_id text NOT NULL,
    selector text NOT NULL,
    repository_id bigint NOT NULL REFERENCES public.repositories(id) ON DELETE CASCADE,
    answer json NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (workspace_id, run_id, selector)
);
