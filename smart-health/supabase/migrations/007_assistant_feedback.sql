-- 007_assistant_feedback.sql
--
-- Stores 👍/👎 ratings on Smart Health AI assistant responses.
--
-- The mobile app inserts a row when the user taps Helpful / Not helpful on
-- a chat bubble. Used for thesis evaluation (agreement rate analytics) and
-- to identify weak responses for prompt-tuning.
--
-- Privacy: questions and answers are stored as text (not hashed) so we can
-- review them. Only the user themselves and (later) the project admins can
-- read the rows. RLS enforces this.

CREATE TABLE IF NOT EXISTS assistant_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    -- The interaction being rated
    rating          SMALLINT NOT NULL CHECK (rating IN (-1, 1)), -- -1 = thumbs-down, 1 = thumbs-up
    question        TEXT NOT NULL,
    answer          TEXT NOT NULL,
    comment         TEXT,                    -- optional free-text from the user

    -- Response metadata for analysis
    model           TEXT,                    -- which LLM produced the answer
    severity        TEXT,                    -- rules-engine severity (NORMAL/CRITICAL/etc.)
    emergency       BOOLEAN DEFAULT FALSE,
    emergency_reason TEXT,
    red_flag_categories TEXT[] DEFAULT '{}'::TEXT[],
    latency_ms      INT,
    from_cache      BOOLEAN DEFAULT FALSE,
    sources         TEXT[] DEFAULT '{}'::TEXT[],

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assistant_feedback_user
    ON assistant_feedback(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_feedback_rating
    ON assistant_feedback(rating, created_at DESC);

-- RLS: users insert + read their own feedback only
ALTER TABLE assistant_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own feedback"
    ON assistant_feedback FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can read own feedback"
    ON assistant_feedback FOR SELECT
    USING (auth.uid() = user_id);

-- Comments for the analytics queries you'll write later
COMMENT ON TABLE assistant_feedback IS 'User ratings on assistant responses (👍/👎). Used for thesis evaluation and prompt tuning.';
COMMENT ON COLUMN assistant_feedback.rating IS '1 = helpful (thumbs-up), -1 = not helpful (thumbs-down).';
COMMENT ON COLUMN assistant_feedback.sources IS 'Array of corpus source filenames the answer cited.';
