# cache-monitor

OpenCode plugin to track and display prompt cache behaviour — per request and per
session. `/cache` opens the popup; the sidebar shows the live line.

## Two numbers, not one

The popup reports **ratio** and **retention** side by side, because a single
"cache hit ratio" cannot tell these two situations apart:

| | what it means | a long tool loop | a rewritten prefix |
|---|---|---|---|
| **ratio** = `cacheRead / (cacheRead + fresh)` | the share of *this* prompt served from cache | drops (a big tool result is new content, billed fresh) | drops |
| **retention** = `cacheRead / previous prompt` | the share of the *previous* prompt still reused | stays at ~100 % | collapses |

- **Retention ~100 %** means the payload only appended: nothing was invalidated,
  and a low ratio on that line is just new information arriving. This is the
  normal, healthy shape of a tool loop.
- **Retention collapsing** is the real invalidation: bytes that were already sent
  have changed, so everything after the change is paid again. It happens when a
  conversation turn opens (the transcript is re-expressed for the new turn) and
  whenever history inside the context is rewritten mid-loop.

Per request the table shows the fresh input, the **cache write** and the **cache
read** separately, so you can see which side is being billed:

```
     #  where        fresh   write    read   ratio  retention
     1  turn open    11.6k       0     512    4.2% ░░░░░░░░░░   0.0%
     2  loop         10.4k       0    12.7k   55.0% ██████████  99.9%
    35  turn open    10.6k       0    10.2k   49.2% █░░░░░░░░░  10.9%
```

Line 2 is the case a ratio-only display gets wrong: 55 % looks like a broken
cache, while the retention of 99.9 % says the previous prompt was reused whole —
the 10.4k fresh tokens are the tool result that just arrived.

## Features

- **Per-request** cache write / read / ratio / retention with bars
- **Session totals**: fresh input, cache write, cache read, output, saved
- **Diagnosis** that separates new content from a rewritten prefix, and names the
  requests that rewrote it with what they cost
- **Sidebar widget**: `cache · 96.9% ratio · 99.9% retention · last 98.4%`

## Install

Copy the plugin files to your OpenCode plugins directory:

```bash
# Linux/macOS
cp -r . ~/.config/opencode/plugins/cache-monitor/

# Windows
xcopy /E /I /Y . %USERPROFILE%\.config\opencode\plugins\cache-monitor\
```

Then use `/cache` (aliases `/cache-monitor`, `/cm`) or the command palette.
Restart the TUI after an update: the hot reload only re-evaluates the entry file.

## Files

- `metrics.ts` — the pure logic (ratios, retention, diagnosis). Covered by `bun test`.
- `tui.tsx` — the popup and the sidebar widget; renders what `metrics.ts` computes.
- `index.ts` — server-side stub (debug logging only).
- `test/metrics.test.ts` — `bun test`.

## Debug

Set `CACHE_MONITOR_DEBUG=1` to log to `~/.local/share/opencode/cache-monitor/`.

## License

MIT
