-- Aplikuje se jen když je k dispozici TimescaleDB.
SELECT create_hypertable('odds_snapshots', 'ts', chunk_time_interval => interval '1 day', if_not_exists => true, migrate_data => true);
SELECT create_hypertable('arb_ticks', 'ts', chunk_time_interval => interval '1 day', if_not_exists => true, migrate_data => true);

ALTER TABLE odds_snapshots SET (timescaledb.compress, timescaledb.compress_segmentby = 'bookmaker, event_id');
SELECT add_compression_policy('odds_snapshots', interval '3 days', if_not_exists => true);
SELECT add_retention_policy('odds_snapshots', interval '90 days', if_not_exists => true);
