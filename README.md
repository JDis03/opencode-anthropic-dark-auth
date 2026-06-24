# opencode-anthropic-dark-auth

OpenCode plugin that uses your Claude Code credentials — no separate login needed.

## Prerequisites

- Claude Code installed and authenticated (run `claude` at least once)
- OpenCode installed

Linux is the primary platform. macOS and Windows should work but are less tested.

## How it works

Reads OAuth tokens from `~/.claude/.credentials.json`, handles the full request lifecycle with proper transforms and retry logic. Syncs credentials to OpenCode's `auth.json` as fallback. Refreshes tokens automatically when near expiry.

## Installation

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-anthropic-dark-auth@latest"]
}
```

The `@latest` tag ensures OpenCode always pulls the newest version on startup.

## Usage

Just run OpenCode. The plugin handles auth automatically — it reads your Claude Code credentials and refreshes them in the background.

## Credential sources

The plugin checks these in order:

1. `~/.claude/.credentials.json` (Claude Code)
2. `~/.local/share/opencode/auth.json` (OpenCode fallback)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Credentials not found" | Run `claude` to authenticate with Claude Code first |
| "Token expired and refresh failed" | Re-authenticate `fixed`|
| Not working | Ensure `~/.claude/.credentials.json` exists |

Debug logs: `~/.local/share/opencode/dark-auth.log`

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Clean
npm run clean
```

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT © Dark
