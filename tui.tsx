/** @jsxImportSource @opentui/solid */
/**
 * cache-monitor TUI — Display cache hit ratios in the sidebar and popup.
 *
 * `/cache` opens the stats popup showing:
 *  - per request: fresh input, cache WRITE, cache READ, ratio, retention
 *  - session totals and averages for both numbers
 *  - a diagnosis that separates "new content arrived" from "the prefix was rewritten"
 *
 * The numbers come from the session's own messages (same source as optchat) and
 * are computed in metrics.ts, which `bun test` covers — this file only renders.
 */
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  computeMetrics,
  diagnose,
  fmtPercent,
  fmtTokens,
  ratioBar,
  tone,
  type AnyRec,
  type SessionMetrics,
} from "./metrics.ts";

const DATA_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "cache-monitor",
);

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
        return computeMetrics(messages);
      } catch (err) {
        log(`error getting metrics: ${String(err)}`);
        return null;
      }
    }

    function modelOf(sessionID: string): { providerID: string; id: string } | undefined {
      try {
        const info = ctx.data?.session?.get?.(sessionID) as AnyRec | undefined;
        if (info?.model) {
          return { providerID: String(info.model.providerID ?? ""), id: String(info.model.id ?? "") };
        }
      } catch {}
      return undefined;
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

    /** one request line: fresh / write / read / ratio / retention */
    function row(m: SessionMetrics["list"][number]) {
      const where = m.opensTurn ? "turn open" : "loop";
      const colors = { ok: ink(ctx.theme, "ok"), warn: ink(ctx.theme, "warn"), err: ink(ctx.theme, "err") } as const;
      return (
        <text fg={colors[tone(m.retention)]}>
          {`  ${String(m.index).padStart(4)}  ${where.padEnd(9)} ${fmtTokens(m.input).padStart(7)} ${fmtTokens(m.cacheWrite).padStart(7)} ${fmtTokens(m.cacheRead).padStart(7)}  ${fmtPercent(m.ratio).padStart(6)} ${ratioBar(m.retention)} ${fmtPercent(m.retention).padStart(6)}`}
        </text>
      );
    }

    async function showStats(sessionID: string) {
      const metrics = await getSessionMetrics(sessionID);

      if (!metrics || metrics.list.length === 0) {
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

      const { list, totals, overallRatio, meanRatio, meanRetention, minRatio, maxRatio, saved, rewritten } = metrics;
      const model = modelOf(sessionID);
      const lines = diagnose(metrics);

      log(
        `stats ${sessionID}: ${list.length} requests, ratio=${fmtPercent(overallRatio)}, retention=${fmtPercent(meanRetention)}`,
      );

      ctx.ui.dialog.show(() => (
        <Dialog
          title={`Cache Monitor — ${list.length} requests · ratio ${fmtPercent(overallRatio)} · retention ${fmtPercent(meanRetention)}`}
          footer="esc close · ↑/↓ scroll"
        >
          <box flexDirection="column">
            <text fg={ink(ctx.theme, "info")}><b>Summary</b></text>
            <text fg={ink(ctx.theme, "text")}>{`  Session:          ${sessionID.slice(0, 28)}`}</text>
            {model && <text fg={ink(ctx.theme, "muted")}>{`  Model:            ${model.providerID}/${model.id}`}</text>}
            <text fg={ink(ctx.theme, "text")}>{`  Requests:         ${list.length}`}</text>
            <text fg={ink(ctx.theme, tone(overallRatio))}>{`  Ratio (cached/share): ${ratioBar(overallRatio)} ${fmtPercent(overallRatio)}`}</text>
            <text fg={ink(ctx.theme, tone(meanRetention))}>{`  Retention (reused/prev): ${ratioBar(meanRetention)} ${fmtPercent(meanRetention)}`}</text>
            <text fg={ink(ctx.theme, "muted")}>{`  Ratio range:      ${fmtPercent(minRatio)} – ${fmtPercent(maxRatio)}`}</text>
            <text fg={ink(ctx.theme, "muted")}>{`  Reuse after the first request: ${fmtPercent(meanRatio)} ratio`}</text>
            <text> </text>

            <text fg={ink(ctx.theme, "info")}><b>Tokens</b></text>
            <text fg={ink(ctx.theme, "text")}>{`  Fresh input:      ${fmtTokens(totals.input).padEnd(9)} billed full price`}</text>
            <text fg={ink(ctx.theme, "muted")}>{`  Cache write:      ${fmtTokens(totals.cacheWrite).padEnd(9)} what a rewritten prefix costs on the way in`}</text>
            <text fg={ink(ctx.theme, "ok")}>{`  Cache read:       ${fmtTokens(totals.cacheRead).padEnd(9)} billed ~10%`}</text>
            <text fg={ink(ctx.theme, "text")}>{`  Output:           ${fmtTokens(totals.output)}`}</text>
            <text fg={ink(ctx.theme, "ok")}>{`  Saved ~${fmtTokens(saved)} token-equivalents`}</text>
            <text> </text>

            <text fg={ink(ctx.theme, "info")}><b>Reading the two numbers</b></text>
            <text fg={ink(ctx.theme, "muted")}>{"  ratio      cacheRead / (cacheRead + fresh) of this prompt"}</text>
            <text fg={ink(ctx.theme, "muted")}>{"             a big new tool result lowers it — that is not a lost cache"}</text>
            <text fg={ink(ctx.theme, "muted")}>{"  retention  cacheRead / previous prompt: how much of what was already"}</text>
            <text fg={ink(ctx.theme, "muted")}>{"             sent is still reused. 100% = the payload only appended."}</text>
            <text> </text>

            <text fg={ink(ctx.theme, "info")}><b>Diagnosis</b></text>
            <For each={lines}>
              {(l) => <text fg={ink(ctx.theme, l.startsWith("  #") ? "text" : "muted")}>{`  ${l}`}</text>}
            </For>
            {rewritten.count > 0 && (
              <text fg={ink(ctx.theme, "warn")}>{`  ${rewritten.count} request(s) rewrote the prefix, ${fmtTokens(rewritten.fresh)} fresh tokens.`}</text>
            )}
            <text> </text>

            <text fg={ink(ctx.theme, "info")}><b>Per request</b></text>
            <text fg={ink(ctx.theme, "muted")}>{"     #  where        fresh   write    read   ratio  retention"}</text>
            <For each={list}>{(m) => row(m)}</For>
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
      const [toneKind, setToneKind] = createSignal<"ok" | "warn" | "err" | "muted">("muted");

      const refresh = async () => {
        try {
          const metrics = await getSessionMetrics(props.sessionID);
          if (!metrics || metrics.list.length === 0) {
            setLine("cache · no data");
            setToneKind("muted");
            return;
          }
          const last = metrics.list[metrics.list.length - 1]!;
          setLine(
            `cache · ${fmtPercent(metrics.overallRatio)} ratio · ${fmtPercent(metrics.meanRetention)} retention · last ${fmtPercent(last.ratio)}`,
          );
          setToneKind(tone(metrics.meanRetention));
        } catch {
          setLine("cache · ?");
          setToneKind("muted");
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
          <text fg={ink(ctx.theme, toneKind())}>{line() ?? "cache · …"}</text>
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
              title: "Cache Monitor: cache ratio and prefix retention",
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
