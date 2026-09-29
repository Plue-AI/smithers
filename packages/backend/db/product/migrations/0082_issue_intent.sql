-- Intent metadata an issue carries (smithers-ui-DESIGN.md §3.2): who owns
-- it, when it is due, how urgent it is (0 highest .. 3) and the issue it
-- belongs under. The parent is an issue in the same repository and the
-- parent chain never loops back to the issue itself.
ALTER TABLE public.issues
    ADD COLUMN owner_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN due_on date,
    ADD COLUMN priority smallint CONSTRAINT issues_priority_check CHECK (priority BETWEEN 0 AND 3),
    ADD COLUMN parent_id bigint REFERENCES public.issues(id) ON DELETE SET NULL;

CREATE INDEX issues_parent_id_idx ON public.issues (parent_id) WHERE parent_id IS NOT NULL;

-- Writers hold the repository row lock (UpdateIssue's repository_lock), so
-- two concurrent parent writes in one repository cannot form a cycle.
CREATE OR REPLACE FUNCTION public.guard_issue_parent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.issues p WHERE p.id = NEW.parent_id AND p.repository_id = NEW.repository_id) THEN
    RAISE EXCEPTION 'issue parent must be in the same repository'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'issues_parent_repository';
  END IF;
  IF NEW.parent_id = NEW.id OR EXISTS (
    WITH RECURSIVE chain(id) AS (
      SELECT p.parent_id FROM public.issues p WHERE p.id = NEW.parent_id AND p.parent_id IS NOT NULL
      UNION
      SELECT p.parent_id FROM public.issues p JOIN chain c ON p.id = c.id WHERE p.parent_id IS NOT NULL
    )
    SELECT 1 FROM chain WHERE chain.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'issue parent would form a cycle'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'issues_parent_cycle';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_issues_parent_guard
    BEFORE INSERT OR UPDATE OF parent_id, repository_id ON public.issues
    FOR EACH ROW EXECUTE FUNCTION public.guard_issue_parent();
