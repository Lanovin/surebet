// Konfigurace procesu z proměnných prostředí (s rozumnými výchozími hodnotami pro lokální běh).
export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://surebet@127.0.0.1:5432/surebet',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  GATEWAY_PORT: Number(process.env.GATEWAY_PORT ?? 3001),
  /** sim = testovací kurzy ze simulátoru, real = skutečné sázkovky, both = obojí. */
  DATA_SOURCE: (process.env.DATA_SOURCE ?? 'sim') as 'sim' | 'real' | 'both',
  /** Omezení na vybrané sázkovky (čárkami), prázdné = všechny. */
  BOOKMAKERS: (process.env.BOOKMAKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};
