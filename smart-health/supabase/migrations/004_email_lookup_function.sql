-- Function to look up a user's ID by their email address.
-- This is needed because the client cannot query auth.users directly.
-- Returns the user UUID or NULL if not found.
CREATE OR REPLACE FUNCTION get_user_id_by_email(email_input TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  user_id UUID;
BEGIN
  SELECT id INTO user_id
  FROM auth.users
  WHERE email = lower(email_input)
  LIMIT 1;

  RETURN user_id;
END;
$$;
