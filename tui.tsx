/** @jsxImportSource @opentui/solid */
/**
 * cache-monitor TUI — Display cache hit ratios in the sidebar and popup.
 *
 * `/cache` opens the stats popup showing:
 *  - Per-turn cache hit ratio with visual bars
 *  - Session totals and averages
 *  - Diagnosis of cache efficiency
 *
 * Data comes from OpenCode's session message API (same source as optchat).
 */
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { join } from "node:path";
import { homedir } from "node:os";

type AnyRec = Record<string, any>;

const DATA_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "cache-monitor",
);

interface TurnMetrics {
  turn: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  hitRatio: number;
  contextSize: number;
}

interface SessionMetrics {
  sessionID: string;
  turns: TurnMetrics[];
  totals: { input: number; cacheRead: number; cacheWrite: number; output: number };
  overallHitRatio: number;
  model?: { providerID: string; id: string };
}

function computeHitRatio(input: number, cacheRead: number): number {
  const total = input + cacheRead;
  return total > 0 ? cacheRead / total : 0;
}

function extractMetrics(messages: AnyRec[]): SessionMetrics {
  const turns: TurnMetrics[] = [];
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let turnNum = 0;

  for (const m of messages) {
    const t = m.tokens;
    if (!t || typeof t.input !== "number") continue;

    turnNum++;
    const input = t.input ?? 0;
    const cacheRead = t.cache?.read ?? 0;
    const cacheWrite = t.cache?.write ?? 0;
    const output = t.output ?? 0;

    const turn: TurnMetrics = {
      turn: turnNum,
      input,
      cacheRead,
      cacheWrite,
      output,
      hitRatio: computeHitRatio(input, cacheRead),
      contextSize: input + cacheRead,
    };

    turns.push(turn);
    totals.input += input;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.output += output;
  }

  return {
    sessionID: "",
    turns,
    totals,
    overallHitRatio: computeHitRatio(totals.input, totals.cacheRead),
  };
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

function fmtPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function bar(value: number, max: number, width = 20): string {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(frac * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function ratioBar(ratio: number): string {
  return bar(ratio, 1, 10);
}

function ratioColor(ratio: number): "ok" | "warn" | "err" {
  if (ratio >= 0.7) return "ok";
  if (ratio >= 0.3) return "warn";
  return "err";
}

function pick(theme: AnyRec | undefined, path: string, fallback = "#cccccc"): any {
  let node: any = theme;
  for (const key of path.split(".")) {
    if (node && typeof node === "object" && key in node) node = node[key];
    else return fallback;
  }
  if (node && typeof node === "object") return node.base ?? node.default ?? fallback;
  return node ?? fallback;
}

const ink = (theme: AnyRec | undefined, kind: "ok" | "warn" | "err" | "info" | "muted" | "text"): any => {
  switch (kind) {
    case "ok": return pick(theme, "text.feedback.success");
    case "warn": return pick(theme, "text.feedback.warning");
    case "err": return pick(theme, "text.feedback.error");
    case "info": return pick(theme, "text.feedback.info");
    case "muted": return pick(theme, "text.subdued", pick(theme, "text.muted"));
    default: return pick(theme, "text.base", pick(theme, "text.default"));
  }
};

export default Plugin.define({
  id: "cache-monitor.cli",

  setup(ctx: AnyRec) {
    const log = (text: string) => {
      if (process.env.CACHE_MONITOR_DEBUG !== "1") return;
      void import("node:fs/promises")
        .then(({ appendFile, mkdir }) =>
          mkdir(DATA_DIR, { recursive: true }).then(() =>
            appendFile(join(DATA_DIR, "tui.log"), `${new Date().toISOString()} ${text}\n`, "utf8")
          )
        )
        .catch(() => {});
    };

    const routeNow = (): AnyRec | undefined => {
      try {
        return ctx.ui?.router?.current?.() as AnyRec | undefined;
      } catch {
        return undefined;
      }
    };

    const currentSession = (): string | undefined => {
      const route = routeNow();
      return route?.type === "session" ? (route.sessionID as string) : undefined;
    };

    async function getSessionMetrics(sessionID: string): Promise<SessionMetrics | null> {
      try {
        const messages: AnyRec[] = ctx.data?.session?.message?.list?.(sessionID) ?? [];
        if (!messages.length) return null;
        
        const metrics = extractMetrics(messages);
        metrics.sessionID = sessionID;
        
        // Get model info
        const info = ctx.data?.session?.get?.(sessionID) as AnyRec | undefined;
        if (info?.model) {
          metrics.model = {
            providerID: String(info.model.providerID ?? ""),
            id: String(info.model.id ?? ""),
          };
        }
        
        return metrics;
      } catch (err) {
        log(`error getting metrics: ${String(err)}`);
        return null;
      }
    }

    function Dialog(props: { title: string; children: any; footer?: string }) {
      let off: (() => void) | undefined;
      onMount(() => {
        ctx.ui.dialog.set({ size: "xlarge" });
        off = ctx.keymap.layer(() => ({
          mode: "modal",
          commands: [
            { id: "cache.popup.close", title: "Close", bind: "escape", run: () => ctx.ui.dialog.clear() },
          ],
        }));
      });
      onCleanup(() => off?.());
      return (
        <box paddingLeft={2} paddingRight={2} flexDirection="column" height="100%">
          <text fg={ink(ctx.theme, "ok")}><b>{props.title}</b></text>
          <scrollbox scrollY flexGrow={1} gap={0}>{props.children}</scrollbox>
          <text fg={ink(ctx.theme, "muted")}>{props.footer ?? "esc close"}</text>
        </box>
      );
    }

    async function showStats(sessionID: string) {
      const metrics = await getSessionMetrics(sessionID);

      if (!metrics || metrics.turns.length === 0) {
        ctx.ui.dialog.show(() => (
          <Dialog title="Cache Monitor — No Data">
            <box flexDirection="column">
              <text fg={ink(ctx.theme, "warn")}>No cache metrics recorded for this session yet.</text>
              <text fg={ink(ctx.theme, "muted")}> </text>
              <text fg={ink(ctx.theme, "muted")}>Cache metrics are captured after each model response.</text>
              <text fg={ink(ctx.theme, "muted")}>Send a message and check back!</text>
            </box>
          </Dialog>
        ));
        return;
      }

      const { turns, totals, overallHitRatio, model } = metrics;

      // Stats excluding first turn (always 0% cache)
      const effectiveTurns = turns.slice(1);
      const effectiveAvg = effectiveTurns.length > 0
        ? effectiveTurns.reduce((a, t) => a + t.hitRatio, 0) / effectiveTurns.length
        : 0;
      const minRatio = turns.length > 0 ? Math.min(...turns.map((t) => t.hitRatio)) : 0;
      const maxRatio = turns.length > 0 ? Math.max(...turns.map((t) => t.hitRatio)) : 0;

      // Savings estimate (cache costs ~10% of fresh input)
      const savedTokenEquivalent = totals.cacheRead * 0.9;

      log(`stats ${sessionID}: ${turns.length} turns, overall=${fmtPercent(overallHitRatio)}, effective=${fmtPercent(effectiveAvg)}`);

      ctx.ui.dialog.show(() => (
        <Dialog
          title={`Cache Monitor — ${turns.length} turns · ${fmtPercent(overallHitRatio)} overall`}
          footer="esc close · ↑/↓ scroll"
        >
          <box flexDirection="column">
            <text fg={ink(ctx.theme, "info")}><b>Summary</b></text>
            <text fg={ink(ctx.theme, "text")}>{`  Session:        ${sessionID.slice(0, 24)}`}</text>
            {model && <text fg={ink(ctx.theme, "muted")}>{`  Model:          ${model.providerID}/${model.id}`}</text>}
            <text fg={ink(ctx.theme, "text")}>{`  Turns:          ${turns.length}`}</text>
            <text fg={ink(ctx.theme, ratioColor(overallHitRatio))}>{`  Overall ratio:  ${ratioBar(overallHitRatio)} ${fmtPercent(overallHitRatio)}`}</text>
            <text fg={ink(ctx.theme, ratioColor(effectiveAvg))}>{`  Avg (turn 2+):  ${ratioBar(effectiveAvg)} ${fmtPercent(effectiveAvg)}`}</text>
            <text fg={ink(ctx.theme, "muted")}>{`  Range:          ${fmtPercent(minRatio)} - ${fmtPercent(maxRatio)}`}</text>
            <text> </text>

            <text fg={ink(ctx.theme, "info")}><b>Token Totals</b></text>
            <text fg={ink(ctx.theme, "text")}>{`  Fresh input:    ${fmtTokens(totals.input).padEnd(10)} (billed full price)`}</text>
            <text fg={ink(ctx.theme, "ok")}>{`  Cache read:     ${fmtTokens(totals.cacheRead).padEnd(10)} (billed ~10%)`}</text>
            <text fg={ink(ctx.theme, "muted")}>{`  Cache write:    ${fmtTokens(totals.cacheWrite).padEnd(10)} (one-time cost)`}</text>
            <text fg={ink(ctx.theme, "text")}>{`  Output:         ${fmtTokens(totals.output)}`}</text>
            <text fg={ink(ctx.theme, "ok")}>{`  Saved ~         ${fmtTokens(savedTokenEquivalent)} token-equivalents`}</text>
            <text> </text>

            <text fg={ink(ctx.theme, "info")}><b>Per-Turn Cache Hit Ratio</b></text>
            <text fg={ink(ctx.theme, "muted")}>{"  Turn  Input      Cache      Ratio"}</text>
            <For each={turns}>
              {(turn) => (
                <text fg={ink(ctx.theme, turn.turn === 1 ? "muted" : ratioColor(turn.hitRatio))}>
                  {`  ${String(turn.turn).padStart(4)}  ${fmtTokens(turn.input).padEnd(10)} ${fmtTokens(turn.cacheRead).padEnd(10)} ${ratioBar(turn.hitRatio)} ${fmtPercent(turn.hitRatio)}${turn.turn === 1 ? " (first turn)" : ""}`}
                </text>
              )}
            </For>
            <text> </text>

            <text fg={ink(ctx.theme, "info")}><b>Diagnosis</b></text>
            {effectiveAvg >= 0.7 ? (
              <text fg={ink(ctx.theme, "ok")}>✓ Excellent caching! The provider reuses most of your prompt prefix.</text>
            ) : effectiveAvg >= 0.3 ? (
              <text fg={ink(ctx.theme, "warn")}>⚠ Moderate caching. Something may be invalidating the prompt prefix.</text>
            ) : (
              <text fg={ink(ctx.theme, "err")}>✗ Poor caching! The prompt prefix changes every turn.</text>
            )}
            {effectiveAvg < 0.5 && (
              <>
                <text fg={ink(ctx.theme, "muted")}> </text>
                <text fg={ink(ctx.theme, "muted")}>Common causes of poor caching:</text>
                <text fg={ink(ctx.theme, "muted")}>• optchat rewrites history as a compressed view</text>
                <text fg={ink(ctx.theme, "muted")}>• System prompt changes between turns</text>
                <text fg={ink(ctx.theme, "muted")}>• Model/provider doesn't support prompt caching</text>
              </>
            )}
          </box>
        </Dialog>
      ));
    }

    async function showMenu() {
      const sessionID = currentSession();
      if (sessionID) {
        return showStats(sessionID);
      }
      ctx.ui.toast.show({
        title: "Cache Monitor",
        message: "Open a session first",
        variant: "warning",
      });
    }

    // Widget for sidebar
    function Widget(props: { sessionID: string }) {
      const [line, setLine] = createSignal<string | undefined>();
      const [tone, setTone] = createSignal<"ok" | "warn" | "err" | "muted">("muted");

      const refresh = async () => {
        try {
          const metrics = await getSessionMetrics(props.sessionID);
          if (!metrics || metrics.turns.length === 0) {
            setLine("cache · no data");
            setTone("muted");
            return;
          }

          const { overallHitRatio, turns } = metrics;
          const lastTurn = turns[turns.length - 1];
          const lastRatio = lastTurn?.hitRatio ?? 0;

          setLine(`cache · ${fmtPercent(overallHitRatio)} overall · ${fmtPercent(lastRatio)} last`);
          setTone(ratioColor(overallHitRatio));
        } catch {
          setLine("cache · ?");
          setTone("muted");
        }
      };

      void refresh();
      const timer = setInterval(() => void refresh(), 10_000);
      let unlisten: (() => void) | undefined;
      try {
        unlisten = ctx.data?.on?.("session.idle", () => void refresh());
      } catch {
        unlisten = undefined;
      }
      onCleanup(() => {
        clearInterval(timer);
        unlisten?.();
      });

      return (
        <box flexDirection="row" gap={1}>
          <text fg={ink(ctx.theme, tone())}>{line() ?? "cache · …"}</text>
        </box>
      );
    }

    // Register commands
    ctx.ui.slot({
      append: "app",
      render() {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "cache-monitor.menu",
              title: "Cache Monitor: view cache hit ratios",
              group: "cache-monitor",
              palette: true,
              suggested: true,
              slash: { name: "cache", aliases: ["cache-monitor", "cm"] },
              run: () => void showMenu(),
            },
          ],
        }));
        return null;
      },
    });

    // Sidebar widget
    try {
      ctx.ui.slot({
        append: "sidebar.content",
        render: (input: AnyRec) => (
          <Show when={input?.sessionID}>
            {(id: any) => <Widget sessionID={id()} />}
          </Show>
        ),
      });
    } catch (err) {
      log(`sidebar slot refused: ${String(err)}`);
    }

    log("loaded");
  },
});
