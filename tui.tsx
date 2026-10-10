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
  bar,
  computeMetrics,
  diagnose,
  fmtPercent,
  fmtTokens,
  tone,
  type AnyRec,
  type ReqMetrics,
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
        ctx.ui.dialog.set({ size: "xlarge", centered: true });
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

    function stateOf(m: SessionMetrics): { label: string; kind: "ok" | "warn" | "err" | "muted" } {
      if (m.list.length < 2) return { label: "cold", kind: "muted" };
      if (m.meanRetention >= 0.9) return { label: "stable", kind: "ok" };
      if (m.meanRetention >= 0.5) return { label: "watch", kind: "warn" };
      return { label: "rewritten", kind: "err" };
    }

    /** group requests into turns: a new turn starts when opensTurn is true (after the first) */
    function groupTurns(list: ReqMetrics[]): ReqMetrics[][] {
      const turns: ReqMetrics[][] = [];
      for (const r of list) {
        const last = turns[turns.length - 1];
        if (!last || r.opensTurn) turns.push([r]);
        else last.push(r);
      }
      return turns;
    }

    function turnAgg(rows: ReqMetrics[]): { ratio: number; retention: number; fresh: number; read: number; write: number; output: number } {
      const fresh = rows.reduce((a, r) => a + r.input, 0);
      const read = rows.reduce((a, r) => a + r.cacheRead, 0);
      const write = rows.reduce((a, r) => a + r.cacheWrite, 0);
      const output = rows.reduce((a, r) => a + r.output, 0);
      const total = fresh + read;
      const after = rows.slice(1);
      return {
        ratio: total > 0 ? read / total : 0,
        retention: after.length ? after.reduce((a, r) => a + r.retention, 0) / after.length : 0,
        fresh, read, write, output,
      };
    }

    /** one request line: fresh / write / read / out + bars for BOTH ratio and retention */
    function row(m: ReqMetrics) {
      const mark = m.opensTurn ? ">" : "·";
      const colors = { ok: ink(ctx.theme, "ok"), warn: ink(ctx.theme, "warn"), err: ink(ctx.theme, "err") } as const;
      return (
        <text fg={colors[tone(m.retention)]}>
          {`  ${mark} ${String(m.index).padStart(3)} ${fmtTokens(m.input).padStart(6)} ${fmtTokens(m.cacheWrite).padStart(6)} ${fmtTokens(m.cacheRead).padStart(6)} ${fmtTokens(m.output).padStart(6)} ${fmtPercent(m.ratio).padStart(6)} ${bar(m.ratio, 1, 10)} ${fmtPercent(m.retention).padStart(6)} ${bar(m.retention, 1, 10)}`}
        </text>
      );
    }

    /** per-turn aggregate on the SAME columns as row(), so every number lines up */
    function turnHeader(rows: ReqMetrics[], n: number) {
      const agg = turnAgg(rows);
      const ret = rows.length > 1 ? fmtPercent(agg.retention).padStart(6) : "—".padStart(6);
      const retBar = rows.length > 1 ? bar(agg.retention, 1, 10) : " ".repeat(10);
      return (
        <text fg={ink(ctx.theme, "muted")}>
          {`  = ${`T${n}`.padStart(3)} ${fmtTokens(agg.fresh).padStart(6)} ${fmtTokens(agg.write).padStart(6)} ${fmtTokens(agg.read).padStart(6)} ${fmtTokens(agg.output).padStart(6)} ${fmtPercent(agg.ratio).padStart(6)} ${bar(agg.ratio, 1, 10)} ${ret} ${retBar} · ${rows.length} req`}
        </text>
      );
    }

    const MAX_ROWS = 30;
    const short = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    /** column header built with the same widths as row(), so labels sit over their columns */
    const HEAD =
      `    ${"#".padStart(3)} ${"fresh".padStart(6)} ${"write".padStart(6)} ` +
      `${"read".padStart(6)} ${"out".padStart(6)} ${"ratio".padStart(6)} ${" ".repeat(10)} ${"reten".padStart(6)}`;

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

      const { list, totals, overallRatio, meanRetention, saved, rewritten } = metrics;
      const model = modelOf(sessionID);
      const lines = diagnose(metrics);
      const state = stateOf(metrics);
      const turns = groupTurns(list);
      // single short diag line, never a paragraph
      const diagHead = short(lines[0] ?? "", 140);
      const worst = rewritten.worst[0];
      const shownTurns = turns.slice(-12);
      const hiddenReqs = list.length - shownTurns.reduce((a, t) => a + t.length, 0);

      log(
        `stats ${sessionID}: ${list.length} requests, ratio=${fmtPercent(overallRatio)}, retention=${fmtPercent(meanRetention)}`,
      );

      ctx.ui.dialog.show(() => (
        <Dialog
          title={`cache · ${list.length} req · ${fmtPercent(overallRatio)} · ${fmtPercent(meanRetention)} · ${state.label}`}
          footer="esc close · ↑/↓ scroll"
        >
          <box flexDirection="column">
            {model && <text fg={ink(ctx.theme, "muted")}>{`  ${model.providerID}/${model.id}`}</text>}
            <text fg={ink(ctx.theme, "info")}><b>Global</b></text>
            <text fg={ink(ctx.theme, tone(overallRatio))}>{`  ratio  ${bar(overallRatio, 1, 20)} ${fmtPercent(overallRatio)}`}</text>
            <text fg={ink(ctx.theme, tone(meanRetention))}>{`  reten  ${bar(meanRetention, 1, 20)} ${fmtPercent(meanRetention)}`}</text>
            <text fg={ink(ctx.theme, "text")}>{`  in ${fmtTokens(totals.input)} · wr ${fmtTokens(totals.cacheWrite)} · rd ${fmtTokens(totals.cacheRead)} · out ${fmtTokens(totals.output)} · sv ~${fmtTokens(saved)}`}</text>
            <text fg={ink(ctx.theme, state.kind)}>{`  ${state.label} — ${diagHead}`}</text>
            {worst && (
              <text fg={ink(ctx.theme, "muted")}>{`  worst #${worst.index} ${fmtPercent(worst.retention)} ret · ${fmtPercent(worst.ratio)} ratio`}</text>
            )}
            <text fg={ink(ctx.theme, "info")}><b>Turns · requests</b></text>
            <text fg={ink(ctx.theme, "muted")}>{HEAD}</text>
            {hiddenReqs > 0 && (
              <text fg={ink(ctx.theme, "muted")}>{`  … ${hiddenReqs} older hidden`}</text>
            )}
            <For each={shownTurns}>
              {(rows, ti) => (
                <box flexDirection="column">
                  <Show when={shownTurns.length > 1 || turns.length > 1}>
                    {turnHeader(rows, turns.length - shownTurns.length + ti() + 1)}
                  </Show>
                  <For each={rows.slice(-MAX_ROWS)}>{(m) => row(m)}</For>
                </box>
              )}
            </For>
          </box>
        </Dialog>
      ));
    }

    async function showExplain(sessionID?: string) {
      const metrics = sessionID ? await getSessionMetrics(sessionID) : null;
      const ctxLine = metrics && metrics.list.length > 1
        ? `  this session: ratio ${fmtPercent(metrics.overallRatio)} · retain ${fmtPercent(metrics.meanRetention)} over ${metrics.list.length} req`
        : `  open a session and run /cache to see your numbers here`;
      ctx.ui.dialog.show(() => (
        <Dialog title="cache · ratio vs retention" footer="esc close · /cache for numbers">
          <box flexDirection="column">
            <text fg={ink(ctx.theme, "info")}><b>ratio = this prompt from cache</b></text>
            <text fg={ink(ctx.theme, "muted")}>{"  cacheRead / (cacheRead + fresh)"}</text>
            <text fg={ink(ctx.theme, "muted")}>{"  drops whenever new content arrives (big tool result) — normal"}</text>
            <text> </text>
            <text fg={ink(ctx.theme, "info")}><b>retention = prev prompt reused</b></text>
            <text fg={ink(ctx.theme, "muted")}>{"  cacheRead / previous prompt"}</text>
            <text fg={ink(ctx.theme, "muted")}>{"  100% = only appended · collapse = prefix rewritten, paid again"}</text>
            <text> </text>
            <text fg={ink(ctx.theme, "text")}>{ctxLine}</text>
            <text fg={ink(ctx.theme, "muted")}>{"  low ratio + high retention = healthy tool loop, not a broken cache"}</text>
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

    // Sidebar: one metric per line, fixed columns.
    //   cache · stable
    //   session · 35 req
    //     ratio ██████░░░░  55.0%
    //     reten ██████████  99.9%
    //   last #35
    //     ratio ██████████  98.4%
    //     reten ██████████  99.9%
    const pct = (r: number): string => `${(r * 100).toFixed(1).padStart(5)}%`;
    const BAR_W = 10;
    function Widget(props: { sessionID: string }) {
      const [data, setData] = createSignal<SessionMetrics | null>(null);
      const [failed, setFailed] = createSignal(false);

      const refresh = async () => {
        try {
          const metrics = await getSessionMetrics(props.sessionID);
          setFailed(false);
          setData(metrics && metrics.list.length > 0 ? metrics : null);
        } catch {
          setFailed(true);
          setData(null);
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
        <box flexDirection="column">
          <Show
            when={data()}
            fallback={
              <text fg={ink(ctx.theme, "muted")}>{failed() ? "cache · ?" : "cache · no data"}</text>
            }
          >
            {(m: any) => {
              const mm = m() as SessionMetrics;
              const last = mm.list[mm.list.length - 1]!;
              const st = stateOf(mm);
              return (
                <box flexDirection="column">
                  <text fg={ink(ctx.theme, st.kind)}>{`cache · ${st.label}`}</text>
                  <text fg={ink(ctx.theme, "muted")}>{`session · ${mm.list.length} req`}</text>
                  <text fg={ink(ctx.theme, tone(mm.overallRatio))}>{`  ratio ${bar(mm.overallRatio, 1, BAR_W)} ${pct(mm.overallRatio)}`}</text>
                  <text fg={ink(ctx.theme, tone(mm.meanRetention))}>{`  reten ${bar(mm.meanRetention, 1, BAR_W)} ${pct(mm.meanRetention)}`}</text>
                  <text fg={ink(ctx.theme, "muted")}>{`last #${last.index}`}</text>
                  <text fg={ink(ctx.theme, tone(last.ratio))}>{`  ratio ${bar(last.ratio, 1, BAR_W)} ${pct(last.ratio)}`}</text>
                  <text fg={ink(ctx.theme, tone(last.retention))}>{`  reten ${bar(last.retention, 1, BAR_W)} ${pct(last.retention)}`}</text>
                </box>
              );
            }}
          </Show>
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
            {
              id: "cache-monitor.explain",
              title: "Cache Monitor: ratio vs retention, what's the difference?",
              group: "cache-monitor",
              palette: true,
              slash: { name: "cache-why", aliases: ["cache-explain", "cache-help"] },
              run: () => void showExplain(currentSession()),
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
