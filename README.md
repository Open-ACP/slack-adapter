# @openacp/adapter-slack

Slack messaging platform adapter plugin for [OpenACP](https://github.com/Open-ACP/OpenACP).

## Installation

```bash
openacp plugin install @openacp/adapter-slack
```

## Configuration

Add to your `~/.openacp/config.json`:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "adapter": "@openacp/adapter-slack",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "signingSecret": "...",
      "channelPrefix": "openacp",
      "notificationChannelId": "C...",
      "allowedUserIds": [],
      "autoCreateSession": true
    }
  }
}
```

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
