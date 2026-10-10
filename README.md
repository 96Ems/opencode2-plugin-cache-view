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

Per request the table shows fresh input, **cache write**, **cache read** and
**output** with a progress bar for **both** ratio and retention, so you can see
which side is being billed. Requests are grouped by turn (`›` opens a turn,
`·` is inside a tool loop), and each turn header carries both bars too:

```
/cache           → numbers (global + last 12 turns, all with bars)
/cache-why       → what ratio vs retention means, with your session numbers

cache · 35 req · 55.0% · 99.9% · stable
Global
  ratio  ███████████░░░░░░░░░ 55.0%
  reten  ████████████████████ 99.9%
  in 12.7k · wr 0 · rd 45.2k · out 8.1k · sv ~40k
  stable — The prefix is stable …
  worst #12 10.9% ret · 49.2% ratio
Turns · requests
      #  fresh  write   read    out  ratio             reten
  =  T1  22.1k      0  23.2k    259  55.0% ██████░░░░  99.9% ██████████ · 2 req
  >   1   11.6k      0    512    900   4.2% ░░░░░░░░░░   0.0% ░░░░░░░░░░
  ·   2   10.4k      0   12.7k   1.1k 55.0% ██████░░░░  99.9% ██████████
```

Line 2 is the case a ratio-only display gets wrong: 55 % looks like a broken
cache, while the retention of 99.9 % says the previous prompt was reused whole —
the 10.4k fresh tokens are the tool result that just arrived.

## Features

- **Per-request** fresh / write / read / out + bars for both ratio and retention
- **Per-turn** headers with both bars + token totals
- **Session totals**: fresh input, cache write, cache read, output, saved
- **Diagnosis** in 1–2 lines with a state (`stable` / `watch` / `rewritten` /
  `cold`) + the worst offender, instead of a wall of text
- **`/cache-why`** explains ratio vs retention with your live session numbers
- **Sidebar widget** (one metric per line, fixed columns):
  ```
  cache · stable
  session · 35 req
    ratio ██████░░░░  55.0%
    reten ██████████  99.9%
  last #35
    ratio ██████████  98.4%
    reten ██████████  99.9%
  ```

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
