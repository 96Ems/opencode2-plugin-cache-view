/**
 * verify-real — run the plugin's own metrics module over real sessions, exactly
 * the way the popup does, but headless (so the numbers can be checked without a TUI).
 *
 *   bun tools/verify-real.ts <sessionID> [sessionID…]
 *
 * Reads OpenCode's database read-only and prints what the popup would show,
 * so the numbers can be checked (or quoted) without a TUI.
 */
import { Database } from "bun:sqlite";
import { computeMetrics, diagnose, fmtPercent, fmtTokens } from "../metrics.ts";

const db = new Database(`${process.env.HOME}/.local/share/opencode/opencode.db`, { readonly: true });

for (const sessionID of process.argv.slice(2)) {
  const rows = db
    .query("select type, data from session_message where session_id = ? order by seq")
    .all(sessionID) as { type: string; data: string }[];

  // the same shape the TUI hands the module: one object per message with `tokens`
  const messages = rows.map((r) => {
    let d: any = {};
    try {
      d = JSON.parse(r.data);
    } catch {}
    return { type: r.type, tokens: d.tokens };
  });

  const m = computeMetrics(messages);
  console.log(`\n=== ${sessionID} — ${m.list.length} requests ===`);
  console.log(
    `ratio ${fmtPercent(m.overallRatio)} · retention ${fmtPercent(m.meanRetention)} · fresh ${fmtTokens(m.totals.input)} · write ${fmtTokens(m.totals.cacheWrite)} · read ${fmtTokens(m.totals.cacheRead)}`,
  );
  console.log("diagnosis:");
  for (const line of diagnose(m)) console.log(`  ${line}`);
  console.log("first rows:");
  for (const r of [...m.list.slice(0, 3), ...m.list.filter((x) => x.retention < 0.5).slice(0, 2)]) {
    console.log(
      `  #${String(r.index).padStart(3)} ${(r.opensTurn ? "turn open" : "loop").padEnd(9)} fresh ${fmtTokens(r.input).padStart(7)} write ${fmtTokens(r.cacheWrite).padStart(7)} read ${fmtTokens(r.cacheRead).padStart(7)} ratio ${fmtPercent(r.ratio).padStart(6)} retention ${fmtPercent(r.retention).padStart(6)}`,
    );
  }
}
