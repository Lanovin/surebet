-- Další sporty (házená, volejbal, baseball, americký fotbal, MMA, box, šipky, snooker, stolní tenis).
INSERT INTO sports (id, name) VALUES
  ('handball', 'Házená'), ('volleyball', 'Volejbal'), ('baseball', 'Baseball'),
  ('american_football', 'Americký fotbal'), ('mma', 'MMA'), ('boxing', 'Box'),
  ('darts', 'Šipky'), ('snooker', 'Snooker'), ('table_tennis', 'Stolní tenis')
ON CONFLICT DO NOTHING;
