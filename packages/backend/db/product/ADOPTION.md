# Adopting an existing Plue database

`adopt.py` checks an existing database against a fresh product baseline and
each later public migration. It records the baseline and exactly those later
versions whose objects are already present. The target's product objects are
never changed by adoption; `migrate apply` runs the remaining versions in
order. Plue's private overlay manifest pins the definitions of private
triggers, constraints, and legacy columns attached to product tables.

Migrations with no added or changed schema objects, including data-only updates
and removal-only migrations, stay pending because a schema dump cannot prove
they ran. They must be safe to rerun when `migrate apply` follows adoption.

1. Complete and verify a database backup.
2. Create an **empty scratch database on the same PostgreSQL major version** as
   the target. The tool installs the checked-in baseline there.
3. Run the read-only plan. It exits `2` and prints a JSON drift list when
   adoption is blocked.

   ```sh
   python3 packages/backend/db/product/adopt.py \
     --baseline-url "$EMPTY_SCRATCH_DATABASE_URL" \
     --target-url "$TARGET_DATABASE_URL" \
     --overlays "$PLUE_ROOT/db/private/adoption-overlays.json" > adoption-plan.json
   ```

4. After the plan has zero drift, use a **new** empty scratch database and
   repeat with `--apply` and the same overlay manifest. Then run
   `smithers-backend migrate apply` followed by Plue's private migrations.
   Product checksums and versions are recorded in
   `public.smithers_product_migrations`.

The target must be kept free of unrelated DDL between a zero-drift plan and
apply. `--apply` repeats the comparison and refuses partially present public
migrations. The adoption command does not mutate Plue's Atlas ledger or delete
historical tables or data. Use a new empty scratch database for each invocation.
