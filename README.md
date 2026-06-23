# opencode-anthropic-dark-auth

Anthropic OAuth authentication plugin for OpenCode with multi-account support and proactive token refresh.

## Features

- ✅ **Own OAuth PKCE flow** - No dependency on `claude` CLI
- ✅ **Multi-account support** - Add multiple Claude Pro/Max accounts
- ✅ **Proactive token refresh** - Refreshes tokens 1 hour before expiry
- ✅ **Rate limit handling** - Auto-switches to next available account
- ✅ **Clean error messages** - No "Retrying in 25201s" spam
- ✅ **Atomic storage** - Safe concurrent access to credentials

## Installation

```bash
npm install opencode-anthropic-dark-auth
```

Or use directly in `opencode.json`:

```json
{
  "plugin": [
    "opencode-anthropic-dark-auth@latest"
  ]
}
```

## Usage

### First Login

1. Restart OpenCode
2. Click "Login with Claude Pro/Max" for Anthropic provider
3. Authorize in browser
4. Done! Token refreshes automatically

### Multiple Accounts

Add more accounts to rotate when hitting rate limits:

1. Click "Login with Claude Pro/Max" again
2. Authorize with a different account
3. Accounts rotate automatically on rate limit

### Storage

Accounts are stored in:
- `~/.config/opencode/dark-auth-accounts.json`

## Configuration

Default configuration (can be customized):

- **Proactive refresh**: 1 hour before token expiry
- **Max retry delay**: 30 seconds
- **Credentials cache TTL**: 30 seconds

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

## License

MIT © DarkRed
