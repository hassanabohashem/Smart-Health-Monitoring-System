-- Drop the broad read policy
DROP POLICY IF EXISTS "Authenticated users can read any profile" ON profiles;

-- Users can read their own full profile
DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
CREATE POLICY "Users can read own profile"
    ON profiles FOR SELECT
    USING (auth.uid() = id);

-- Users can read profiles of people they are linked with (active links only)
CREATE POLICY "Users can read linked profiles"
    ON profiles FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM caregiver_links
            WHERE caregiver_links.status = 'active'
            AND (
                (caregiver_links.caregiver_id = auth.uid() AND caregiver_links.wearer_id = profiles.id)
                OR
                (caregiver_links.wearer_id = auth.uid() AND caregiver_links.caregiver_id = profiles.id)
            )
        )
    );

-- Move the role check into the existing SQL function (bypasses RLS)
CREATE OR REPLACE FUNCTION get_user_id_by_email(email_input TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  user_id UUID;
  user_role TEXT;
BEGIN
  SELECT id INTO user_id
  FROM auth.users
  WHERE email = lower(email_input)
  LIMIT 1;

  IF user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Also check the role
  SELECT role INTO user_role
  FROM profiles
  WHERE id = user_id;

  IF user_role != 'caregiver' THEN
    RAISE EXCEPTION 'NOT_CAREGIVER';
  END IF;

  RETURN user_id;
END;
$$;
