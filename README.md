# @openacp/slack-adapter

Slack messaging platform adapter plugin for [OpenACP](https://github.com/Open-ACP/OpenACP).

## Installation

```bash
openacp plugin install @openacp/slack-adapter
```

## Configuration

Add to your `~/.openacp/config.json`:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "adapter": "@openacp/slack-adapter",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "signingSecret": "...",
      "channelPrefix": "openacp",
      "notificationChannelId": "C...",
      "allowedUserIds": [],
      "autoCreateSession": true,
      "outputMode": "medium"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `botToken` | Bot User OAuth Token (`xoxb-…`) |
| `appToken` | App-Level Token (`xapp-…`) for Socket Mode |
| `signingSecret` | Signing Secret from Basic Information |
| `channelPrefix` | Prefix for session channel names. Default: `openacp` |
| `notificationChannelId` | Optional. Channel ID for system notifications |
| `allowedUserIds` | Optional. Restrict access to specific Slack user IDs |
| `autoCreateSession` | Create a startup session on boot. Default: `true` |
| `outputMode` | Default verbosity: `"low"`, `"medium"`, or `"high"`. Default: `"medium"` |

### Output Mode

The adapter renders agent activity in real time using Slack threads:

- **Low** 🔇 — minimal indicator only (`🔧 Processing...` → `✅ Done`)
- **Medium** 📊 — tool names + running count in the main message; tool cards in thread
- **High** 🔍 — full detail: tool input/output, diffs, viewer links, thinking in thread

Change the mode on the fly with `/outputmode low|medium|high`, or open an interactive modal with `/outputmode`. Requires the slash command to be registered in the Slack app settings — see the [setup guide](https://docs.openacp.dev/platform-setup/slack).

## Development

```bash
npm install
npm run build
npm test

# Install locally for testing
openacp plugin install /path/to/slack-plugin
```

## License

MIT
