# cache-monitor

OpenCode plugin to track and display prompt cache hit ratios per turn and session.

## Features

- **Per-turn cache hit ratio** with visual bars
- **Session totals and averages**
- **Diagnosis of cache efficiency**
- **Sidebar widget** showing current cache stats
- `/cache` command to open the stats popup

## Installation

Copy the plugin files to your OpenCode plugins directory:

```bash
# Linux/macOS
cp -r . ~/.config/opencode/plugins/cache-monitor/

# Windows
xcopy /E /I /Y . %USERPROFILE%\.config\opencode\plugins\cache-monitor\
```

## Usage

1. Open a session in OpenCode
2. Send some messages to the model
3. Use `/cache` command or find "Cache Monitor" in the command palette
4. View cache hit ratios and efficiency diagnosis

## Cache Hit Ratio Indicators

- **≥70%** (green): Excellent caching
- **30-70%** (yellow): Moderate caching
- **<30%** (red): Poor caching

## Files

- `index.ts` — Server-side plugin (minimal, debug logging only)
- `tui.tsx` — TUI plugin with popup and sidebar widget
- `package.json` — Plugin manifest

## Debug Mode

Set `CACHE_MONITOR_DEBUG=1` to enable debug logging to `~/.local/share/opencode/cache-monitor/`.

## License

MIT
