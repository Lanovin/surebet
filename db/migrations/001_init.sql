-- Kanonické entity -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sports (
  id   text PRIMARY KEY,
  name text NOT NULL
);
INSERT INTO sports (id, name) VALUES
  ('football', 'Fotbal'), ('tennis', 'Tenis'), ('basketball', 'Basketbal'), ('hockey', 'Hokej')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS competitions (
  id       bigserial PRIMARY KEY,
  sport    text NOT NULL REFERENCES sports(id),
  name     text NOT NULL,
  country  text,
  norm_key text NOT NULL,
  UNIQUE (sport, norm_key)
);

CREATE TABLE IF NOT EXISTS participants (
  id         bigserial PRIMARY KEY,
  sport      text NOT NULL REFERENCES sports(id),
  name       text NOT NULL,
  norm_key   text NOT NULL,
  kind       text NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'player', 'pair')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport, norm_key)
);

-- Alias = surové jméno u konkrétní sázkovky -> kanonický účastník. Ruční potvrzení z dashboardu
-- se ukládá se source='manual'.
CREATE TABLE IF NOT EXISTS participant_aliases (
  bookmaker      text NOT NULL,
  sport          text NOT NULL,
  raw_name       text NOT NULL,
  participant_id bigint NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  source         text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual', 'seed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bookmaker, sport, raw_name)
);

CREATE TABLE IF NOT EXISTS events (
  id             bigserial PRIMARY KEY,
  sport          text NOT NULL REFERENCES sports(id),
  competition_id bigint REFERENCES competitions(id),
  home_id        bigint NOT NULL REFERENCES participants(id),
  away_id        bigint NOT NULL REFERENCES participants(id),
  start_time     timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'scheduled',
  is_sim         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_sport_start ON events (sport, start_time);

CREATE TABLE IF NOT EXISTS event_links (
  bookmaker       text NOT NULL,
  source_event_id text NOT NULL,
  event_id        bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  swapped         boolean NOT NULL DEFAULT false,
  confidence      real,
  method          text NOT NULL DEFAULT 'auto' CHECK (method IN ('auto', 'alias', 'manual', 'created')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bookmaker, source_event_id)
);
CREATE INDEX IF NOT EXISTS event_links_event ON event_links (event_id);

CREATE TABLE IF NOT EXISTS market_types (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  selections text[] NOT NULL
);

CREATE TABLE IF NOT EXISTS unmatched_events (
  id                 bigserial PRIMARY KEY,
  bookmaker          text NOT NULL,
  source_event_id    text NOT NULL,
  sport              text NOT NULL,
  competition        text,
  raw_home           text NOT NULL,
  raw_away           text NOT NULL,
  start_time         timestamptz NOT NULL,
  candidate_event_id bigint REFERENCES events(id) ON DELETE SET NULL,
  candidate_label    text,
  candidate_start    timestamptz,
  score              real,
  swapped            boolean NOT NULL DEFAULT false,
  reasons            jsonb,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  UNIQUE (bookmaker, source_event_id)
);
CREATE INDEX IF NOT EXISTS unmatched_pending ON unmatched_events (status, start_time);

-- Časové řady ------------------------------------------------------------------------------------
-- Jen změny (nový kurz / změna stavu open/suspended).
CREATE TABLE IF NOT EXISTS odds_snapshots (
  ts        timestamptz NOT NULL,
  bookmaker text NOT NULL,
  event_id  bigint NOT NULL,
  market    text NOT NULL,
  selection text NOT NULL,
  odds      numeric(9, 3),
  status    text NOT NULL CHECK (status IN ('open', 'suspended', 'removed')),
  mode      text NOT NULL
);
CREATE INDEX IF NOT EXISTS odds_snapshots_event ON odds_snapshots (event_id, market, ts DESC);

CREATE TABLE IF NOT EXISTS arbs (
  id                  uuid PRIMARY KEY,
  mode                text NOT NULL,
  sport               text NOT NULL,
  competition         text,
  event_id            bigint,
  event_name          text,
  market_key          text NOT NULL,
  market_type         text NOT NULL,
  market_scope        text,
  line                numeric,
  legs                jsonb NOT NULL,
  margin_at_detection double precision NOT NULL,
  max_margin          double precision NOT NULL,
  last_margin         double precision,
  first_seen          timestamptz NOT NULL,
  last_seen           timestamptz NOT NULL,
  duration_ms         integer,
  end_reason          text,
  end_bookmaker       text,
  censored            boolean,
  -- herní stav při detekci
  game_state          jsonb,
  score               text,
  period              smallint,
  minute              smallint,
  -- PAUSED
  pause_type          text,
  pause_elapsed_s     integer,
  pause_expected_s    integer,
  -- PREMATCH
  time_to_start_s     integer,
  -- vklady a segmentace
  bankroll            numeric,
  stakes              jsonb,
  expected_profit     numeric,
  bookmaker_pair      text,
  bookmakers          text[],
  hour_of_day         smallint,
  day_of_week         smallint,
  prediction          jsonb,
  is_sim              boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arbs_open ON arbs (first_seen) WHERE end_reason IS NULL;
CREATE INDEX IF NOT EXISTS arbs_segment ON arbs (mode, sport, market_type, bookmaker_pair);
CREATE INDEX IF NOT EXISTS arbs_first_seen ON arbs (first_seen DESC);

CREATE TABLE IF NOT EXISTS arb_ticks (
  ts     timestamptz NOT NULL,
  arb_id uuid NOT NULL,
  margin double precision NOT NULL,
  odds   jsonb
);
CREATE INDEX IF NOT EXISTS arb_ticks_arb ON arb_ticks (arb_id, ts);

CREATE TABLE IF NOT EXISTS user_actions (
  id            bigserial PRIMARY KEY,
  arb_id        uuid REFERENCES arbs(id) ON DELETE SET NULL,
  ts            timestamptz NOT NULL DEFAULT now(),
  action        text NOT NULL CHECK (action IN ('placed', 'missed', 'rejected', 'odds_changed')),
  bookmaker     text,
  stake         numeric,
  actual_odds   numeric,
  reaction_ms   integer,
  arb_age_ms    integer,
  margin_at_click double precision,
  note          text,
  details       jsonb
);
CREATE INDEX IF NOT EXISTS user_actions_arb ON user_actions (arb_id);
CREATE INDEX IF NOT EXISTS user_actions_ts ON user_actions (ts DESC);

CREATE TABLE IF NOT EXISTS adapter_health (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  bookmaker     text NOT NULL,
  scope         text,
  event         text NOT NULL CHECK (event IN ('state_change', 'strategy_switch', 'probe', 'diagnostic')),
  strategy      text,
  level         smallint,
  state         text,
  prev_state    text,
  prev_strategy text,
  reason        text,
  details       jsonb
);
CREATE INDEX IF NOT EXISTS adapter_health_bk ON adapter_health (bookmaker, ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Fáze 2: exportované modely přežití (koeficienty / lookup) pro skórování v TS.
CREATE TABLE IF NOT EXISTS survival_models (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL,
  n_train    integer,
  c_index    double precision,
  payload    jsonb NOT NULL,
  active     boolean NOT NULL DEFAULT false
);
