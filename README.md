# opencode-anthropic-dark-auth

OpenCode 2 plugin for Anthropic OAuth with Claude Code credential import and multi-account rotation.

## Prerequisites

- Claude Code installed and authenticated (run `claude` at least once)
- OpenCode installed

Linux is the primary platform. macOS and Windows should work but are less tested.

## How it works

OpenCode 2 uses native `http.request`, `http.response` and `retry` hooks scoped to the Anthropic provider. At startup, if the plugin account store is empty, it imports from Claude Code or (as a fallback) the legacy OpenCode `auth.json`. Every five minutes it checks the active account for token expiry and, for accounts imported from Claude Code, silent token rotation. Older accounts are eligible for this sync only when a stored token matches Claude Code's. It never adds another account during sync. Because Claude Code's credentials file has no stable account identity, switching to a different Claude Code login after import cannot be distinguished from token rotation for an already marked account; verify the active account if you switch logins. The V2 implementation does **not** write to `auth.json`.

**V2 connection limitation:** importing tokens into the plugin's account store does not create an OpenCode 2 integration connection. The V2 plugin API has no public "connect with existing OAuth credentials" method. If Anthropic is not active in OpenCode, the HTTP hooks will not run; establish an Anthropic connection through the registered **Login with Claude Pro/Max (Dark Auth)** OAuth method in OpenCode 2. Merely installing the plugin or importing Claude Code credentials does not guarantee an active provider.

## Installation

Until the V2 package is published, build it locally (`npm install && npm run build`) and create `.opencode/plugins/dark-auth.js` in the project where you run OpenCode:

```js
export { default } from "/absolute/path/to/opencode-anthropic-dark-auth/dist/v2.js";
```

Local plugins in `.opencode/plugins/` load automatically; no global config change is needed. If you use a project-local `opencode.json`, leave package plugins empty rather than installing an unpublished version:

```json
{
  "plugins": []
}
```

Restart OpenCode after adding the local plugin. Once published, the V2 `plugins` field can instead reference `opencode-anthropic-dark-auth` (do not use the V1 `plugin` field). The package root exports the V2 implementation (`dist/v2.js`). `opencode-anthropic-dark-auth/legacy` exports the original V1 implementation (`dist/index.js`) for consumers that still run V1; it is not automatically loaded in V2. This repository change alone does not publish an npm release.

## Usage

Connect Anthropic using the V2 OAuth method, then select an Anthropic model. The plugin will use its local account store for bearer tokens and retry/rotation. Imported credentials alone cannot activate the integration (see limitation above).

## Credential sources

The plugin checks these in order:

1. `~/.claude/.credentials.json` (Claude Code)
2. `~/.local/share/opencode/auth.json` (legacy OpenCode fallback, read-only in V2)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Credentials not found" | Run `claude` to authenticate with Claude Code first |
| "Token expired and refresh failed" | Run `claude` to re-authenticate with Claude Code, then restart OpenCode |
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
