/**
 * metrics — the pure part: read a session's messages, produce every number the
 * popup and the sidebar render. No TUI imports in here, so `bun test` covers it.
 *
 * TWO numbers per request, because they answer different questions and reading
 * only the first one is how a healthy loop looks like a broken cache:
 *
 *   ratio       cacheRead / (cacheRead + input)
 *               the share of THIS prompt that came from cache. A request that
 *               appends a big tool result scores low here even when nothing was
 *               invalidated — the new content is billed fresh, as it must be.
 *
 *   retention   cacheRead / previous prompt size
 *               the share of the PREVIOUS prompt the provider could still serve.
 *               100% means the payload only appended. A drop means bytes that
 *               were already sent have changed, so everything after the change is
 *               paid again: that is the real invalidation, and it happens when a
 *               turn opens (the transcript is re-expressed) or when history is
 *               rewritten inside the view.
 *
 * cacheWrite is carried through too: it is what a rewritten prefix costs on the
 * way in (0 on providers that cache implicitly and only bill the read side).
 */

export type AnyRec = Record<string, any>;

export interface ReqMetrics {
  /** 1-based, as displayed */
  index: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** input + cacheRead: what the model had to read this request */
  payload: number;
  /** the previous request's payload, 0 for the first one */
  prevPayload: number;
  /** 0..1 — share of this prompt served from cache */
  ratio: number;
  /** 0..1 — share of the PREVIOUS prompt still served from cache */
  retention: number;
  /** true when the message before this request was a user message */
  opensTurn: boolean;
}

export interface SessionMetrics {
  list: ReqMetrics[];
  totals: { input: number; cacheWrite: number; cacheRead: number; output: number };
  /** over every request */
  overallRatio: number;
  /** means over the requests after the first (the first can never hit) */
  meanRatio: number;
  meanRetention: number;
  minRatio: number;
  maxRatio: number;
  /** requests that rewrote the prefix (retention < 50 %) and what they cost fresh */
  rewritten: { count: number; fresh: number; worst: ReqMetrics[] };
  /** token-equivalents saved by the cache, at the usual ~10 % price of a read */
  saved: number;
}

const ratioOf = (input: number, cacheRead: number): number => {
  const total = input + cacheRead;
  return total > 0 ? cacheRead / total : 0;
};

/** Turn the session's messages into the per-request metrics. */
export function computeMetrics(messages: AnyRec[]): SessionMetrics {
  const list: ReqMetrics[] = [];
  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let prevType = "";
  let prevPayload = 0;

  for (const m of messages) {
    const t = m?.tokens;
    if (!t || typeof t.input !== "number") {
      prevType = String(m?.type ?? m?.role ?? "");
      continue;
    }
    const input = Number(t.input ?? 0);
    const cacheRead = Number(t.cache?.read ?? 0);
    const cacheWrite = Number(t.cache?.write ?? 0);
    const output = Number(t.output ?? 0);
    if (input + cacheRead + output === 0) {
      prevType = String(m?.type ?? m?.role ?? "");
      continue;
    }

    const payload = input + cacheRead;
    list.push({
      index: list.length + 1,
      input,
      cacheWrite,
      cacheRead,
      output,
      payload,
      prevPayload,
      ratio: ratioOf(input, cacheRead),
      retention: prevPayload > 0 ? Math.min(1, cacheRead / prevPayload) : 0,
      opensTurn: prevType === "user",
    });

    totals.input += input;
    totals.cacheWrite += cacheWrite;
    totals.cacheRead += cacheRead;
    totals.output += output;
    prevPayload = payload;
    prevType = String(m?.type ?? m?.role ?? "");
  }

  const after = list.slice(1);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const rewritten = after.filter((r) => r.retention < 0.5).sort((a, b) => a.retention - b.retention);

  return {
    list,
    totals,
    overallRatio: ratioOf(totals.input, totals.cacheRead),
    meanRatio: mean(after.map((r) => r.ratio)),
    meanRetention: mean(after.map((r) => r.retention)),
    minRatio: list.length ? Math.min(...list.map((r) => r.ratio)) : 0,
    maxRatio: list.length ? Math.max(...list.map((r) => r.ratio)) : 0,
    rewritten: {
      count: rewritten.length,
      fresh: rewritten.reduce((a, r) => a + r.input, 0),
      worst: rewritten.slice(0, 5),
    },
    saved: totals.cacheRead * 0.9,
  };
}

// ---------------------------------------------------------------- formatting

export function fmtTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

export function fmtPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function bar(value: number, max: number, width = 20): string {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(frac * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function ratioBar(ratio: number): string {
  return bar(ratio, 1, 10);
}

export function tone(ratio: number): "ok" | "warn" | "err" {
  if (ratio >= 0.7) return "ok";
  if (ratio >= 0.3) return "warn";
  return "err";
}

/**
 * The lines that explain the table. A high retention with low ratios is normal
 * (new tool results); a low retention is the thing worth acting on.
 */
export function diagnose(m: SessionMetrics): string[] {
  const out: string[] = [];
  const ret = m.meanRetention;
  const rewrite = m.rewritten;

  if (m.list.length < 2) {
    out.push("One request so far — nothing to reuse yet.");
    return out;
  }

  if (ret >= 0.9) {
    out.push(
      `The prefix is stable: ${fmtPercent(ret)} of each previous prompt is reused. Low ratios below are new content (tool results), not lost cache.`,
    );
  } else {
    out.push(
      `The prefix is rewritten on ${rewrite.count} of ${m.list.length - 1} requests: retention averages ${fmtPercent(ret)}, and those rewrites cost ${fmtTokens(rewrite.fresh)} fresh tokens.`,
    );
  }

  const opens = m.list.slice(1).filter((r) => r.opensTurn);
  if (opens.length) {
    const openRet = opens.reduce((a, r) => a + r.retention, 0) / opens.length;
    out.push(
      `Turn openings: retention ${fmtPercent(openRet)} over ${opens.length} openings (${fmtTokens(opens.reduce((a, r) => a + r.input, 0))} fresh, paid once per turn to re-establish the prefix).`,
    );
  }

  const loop = m.list.slice(1).filter((r) => !r.opensTurn);
  if (loop.length) {
    out.push(
      `Inside tool loops: retention ${fmtPercent(loop.reduce((a, r) => a + r.retention, 0) / loop.length)} over ${loop.length} requests.`,
    );
  }

  if (rewrite.count) {
    out.push("Lowest retention:");
    for (const r of rewrite.worst) {
      out.push(
        `  #${r.index}${r.opensTurn ? " (opens a turn)" : ""} retention ${fmtPercent(r.retention)} · ratio ${fmtPercent(r.ratio)} · fresh ${fmtTokens(r.input)} · previous prompt ${fmtTokens(r.prevPayload)}`,
      );
    }
  }
  return out;
}
