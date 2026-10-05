-- T-STK-09: fixes_issue is an accepted TODO fact (spec §3, §10.2.1b), never
-- inferred from an issue link. Existing rows keep false: no backfill.
ALTER TABLE mythical_items ADD COLUMN fixes_issue boolean NOT NULL DEFAULT false;
