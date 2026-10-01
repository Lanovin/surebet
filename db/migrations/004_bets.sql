-- Přehled sázek: vyhodnocení vsazených arbů (která noha vyhrála / ruční zisk) a ruční sázky z kalkulačky.
ALTER TABLE user_actions ADD COLUMN IF NOT EXISTS result text CHECK (result IN ('won', 'void', 'manual'));
ALTER TABLE user_actions ADD COLUMN IF NOT EXISTS winning_leg smallint;
ALTER TABLE user_actions ADD COLUMN IF NOT EXISTS profit numeric;
ALTER TABLE user_actions ADD COLUMN IF NOT EXISTS settled_at timestamptz;
CREATE INDEX IF NOT EXISTS user_actions_placed ON user_actions (ts DESC) WHERE action = 'placed';
