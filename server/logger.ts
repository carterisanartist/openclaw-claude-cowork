/**
 * stderr-only logger.
 *
 * Critical: an MCP server using stdio transport MUST NOT write anything to
 * stdout that isn't a valid JSON-RPC frame. All diagnostic output goes to
 * stderr, where Claude Desktop's MCP host captures it for the log viewer.
 */

type Level = "debug" | "info" | "warn" | "error";

const levelRank: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const minRank = levelRank[envLevel] ?? levelRank.info;

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (levelRank[level] < minRank) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  if (meta) Object.assign(line, meta);
  try {
    process.stderr.write(`${JSON.stringify(line)}\n`);
  } catch {
    // best-effort; never throw from the logger
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
