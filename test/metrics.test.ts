/**
 * The two numbers must stay distinguishable: a request that appends a big tool
 * result has a LOW ratio (its new content is billed fresh) and a ~100 % retention
 * (the previous prompt was reused whole). A request that rewrites the prefix has
 * a low retention. If these collapse into one number the popup lies in exactly
 * the case people watch it for — a long tool loop.
 */
import { describe, expect, test } from "bun:test";
import { computeMetrics, diagnose, fmtPercent, fmtTokens } from "../metrics.ts";

const req = (input: number, cacheRead: number, cacheWrite = 0, output = 0) => ({
  type: "assistant",
  tokens: { input, cacheRead, output, cache: { read: cacheRead, write: cacheWrite } },
});
const user = () => ({ type: "user", tokens: undefined });

describe("ratio vs retention", () => {
  test("a big appended tool result lowers the ratio but not the retention", () => {
    const m = computeMetrics([user(), req(1000, 0), req(18_000, 1000), req(200, 19_000)]);
    const [first, second, third] = m.list as any[];

    expect(first.ratio).toBe(0); // nothing to reuse on the first request
    expect(second.ratio).toBeLessThan(0.1); // 1k of 19k: looks terrible
    expect(second.retention).toBe(1); // …yet the whole previous prompt was reused
    expect(third.retention).toBeCloseTo(19_000 / 19_000, 5);
    expect(m.meanRetention).toBeCloseTo((1 + 1) / 2, 5);
  });

  test("a turn opening that re-expresses the transcript has low retention", () => {
    // turn 1 runs a loop, ending with a 90k prompt; turn 2 opens at 20k
    const m = computeMetrics([
      user(),
      req(10_000, 0),
      req(5_000, 10_000),
      req(60_000, 15_000), // payload 75k
      user(),
      req(10_000, 10_000), // payload 20k, only 10k of the 75k reused
    ]);
    const opening = m.list.at(-1)!;
    expect(opening.opensTurn).toBe(true);
    expect(opening.retention).toBeCloseTo(10_000 / 75_000, 4);
    expect(opening.retention).toBeLessThan(0.5);
    expect(m.rewritten.count).toBe(1);
    expect(m.rewritten.fresh).toBe(10_000);
  });

  test("cache writes are carried through per request and in the totals", () => {
    const m = computeMetrics([user(), req(1000, 0, 4000), req(500, 1000, 0)]);
    expect(m.list[0]!.cacheWrite).toBe(4000);
    expect(m.list[1]!.cacheWrite).toBe(0);
    expect(m.totals.cacheWrite).toBe(4000);
    expect(m.totals.input).toBe(1500);
    expect(m.totals.cacheRead).toBe(1000);
  });

  test("messages without tokens are skipped and do not shift the indexes", () => {
    const m = computeMetrics([user(), req(10, 0), { type: "assistant", tokens: { input: 0, cacheRead: 0, output: 0 } }, req(5, 10)]);
    expect(m.list.length).toBe(2);
    expect(m.list.map((r) => r.index)).toEqual([1, 2]);
  });
});

describe("diagnosis", () => {
  test("a stable prefix is reported as stable, not as a lost cache", () => {
    const m = computeMetrics([user(), req(1000, 0), req(50_000, 1000), req(500, 51_000)]);
    const text = diagnose(m).join("\n");
    expect(text).toContain("prefix is stable");
    expect(text).toContain("Inside tool loops");
  });

  test("a rewritten prefix names the requests and the cost", () => {
    const m = computeMetrics([user(), req(10_000, 0), req(60_000, 10_000), user(), req(9_000, 9_000)]);
    const text = diagnose(m).join("\n");
    expect(text).toContain("rewritten on 1 of");
    expect(text).toContain("Turn openings");
    expect(text).toContain("Lowest retention");
  });
});

describe("formatting", () => {
  test("tokens and percents", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(2_500_000)).toBe("2.50M");
    expect(fmtPercent(0.999)).toBe("99.9%");
  });
});
