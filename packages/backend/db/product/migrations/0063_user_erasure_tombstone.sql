-- An account erasure renames the users row to a tombstone identity. The rename
-- guard protects repository storage paths, so it admits only an erased user
-- that owns no repositories.
CREATE OR REPLACE FUNCTION public.prevent_user_owner_namespace_rename()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.username IS DISTINCT FROM OLD.username
       OR NEW.lower_username IS DISTINCT FROM OLD.lower_username THEN
        IF NEW.deleted_at IS NOT NULL
           AND NOT NEW.is_active
           AND NOT EXISTS (SELECT 1 FROM public.repositories WHERE user_id = NEW.id) THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION USING
            ERRCODE = '0A000',
            MESSAGE = 'user owner namespace is immutable',
            HINT = 'Move repository storage with a durable namespace-move workflow before renaming a user.';
    END IF;
    RETURN NEW;
END;
$$;
