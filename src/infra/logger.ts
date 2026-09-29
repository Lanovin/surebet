type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(name: string): Logger;
}

export function createLogger(name: string): Logger {
  const write = (level: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < MIN) return;
    const ts = new Date().toISOString().slice(11, 23);
    const extra = data && Object.keys(data).length ? ' ' + safeJson(data) : '';
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${name}] ${msg}${extra}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (sub) => createLogger(`${name}:${sub}`),
  };
}

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_k, v) => (v instanceof Error ? { message: v.message, name: v.name } : v));
  } catch {
    return '[unserializable]';
  }
}
