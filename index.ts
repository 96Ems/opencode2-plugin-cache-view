/**
 * cache-monitor — Track prompt cache hit ratios per turn and session.
 *
 * This is a minimal server-side plugin. The real work happens in the TUI
 * which reads session data directly from OpenCode's data APIs.
 *
 * The server plugin only logs debug info when CACHE_MONITOR_DEBUG=1.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type AnyRec = Record<string, any>;

const DATA_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "cache-monitor",
);

export default {
  id: "cache-monitor",

  async setup(ctx: AnyRec) {
    const debug = process.env.CACHE_MONITOR_DEBUG === "1";

    const log = async (text: string) => {
      if (!debug) return;
      const line = `${new Date().toISOString()} ${text}\n`;
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.appendFile(join(DATA_DIR, "monitor.log"), line, "utf8");
      } catch {}
      console.error(`[cache-monitor] ${text}`);
    };

    await log("loaded (TUI-only plugin, cache stats come from session data)");

    return async () => {
      await log("unloading");
    };
  },
};

export { DATA_DIR };
