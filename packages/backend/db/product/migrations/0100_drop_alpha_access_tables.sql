-- Signup is public (#2145): the closed-alpha whitelist and waitlist no longer
-- admit or queue anyone, and no code reads or writes them.
DROP TABLE IF EXISTS alpha_waitlist_entries;
DROP TABLE IF EXISTS alpha_whitelist_entries;
