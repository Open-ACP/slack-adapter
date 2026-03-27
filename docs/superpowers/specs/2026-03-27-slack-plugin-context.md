# Slack Plugin — Context Document

## What This Repo Is

This is the `@openacp/adapter-slack` plugin — a Slack messaging platform adapter extracted from the [OpenACP](https://github.com/Open-ACP/OpenACP) core project.

## Background

OpenACP is a bridge that connects AI coding agents to messaging platforms. Slack was originally built-in alongside Telegram and Discord. This plugin extracts the Slack adapter so core only ships Telegram as built-in, and Slack becomes an installable plugin via the `AdapterFactory` pattern.

## Plugin Architecture

The plugin exports an `adapterFactory` object conforming to:

```typescript
// From @openacp/cli plugin-manager.ts
interface AdapterFactory {
  name: string
  createAdapter(core: OpenACPCore, config: ChannelConfig): ChannelAdapter
}
```

Core loads plugins via `loadAdapterFactory()` in `plugin-manager.ts`. When a user's config has `"adapter": "@openacp/adapter-slack"` in a channel, core dynamically loads this plugin and calls `createAdapter()`.

## Source Origin

All source files were extracted from `OpenACP/src/adapters/slack/`. The following import transformations were applied:

| Original import | Plugin import |
|---|---|
| `from "../../core/index.js"` | `from "@openacp/cli"` |
| `from "../../core/types.js"` | `from "@openacp/cli"` |
| `from "../../core/log.js"` | `from "@openacp/cli"` |
| `from "../../core/file-service.js"` | `from "@openacp/cli"` |
| `from "../../core/config.js"` (re-export) | Defined locally in `src/types.ts` |

## Key Types from @openacp/cli

The plugin depends on these types/classes from `@openacp/cli` (peer dependency):

- `ChannelAdapter` — abstract base class the adapter extends
- `OpenACPCore` — core instance passed to adapter constructor
- `ChannelConfig` — base channel config type
- `OutgoingMessage` — message types (text, thought, tool_call, etc.)
- `PermissionRequest` — approval workflow requests
- `NotificationMessage` — notification payload
- `Attachment` — file attachment type
- `FileService` — file handling service
- `createChildLogger` — pino child logger factory
- `AdapterFactory` — plugin registration interface

## Module Map

| Module | Responsibility | Core Imports |
|--------|---------------|-------------|
| `index.ts` | adapterFactory export | `AdapterFactory` |
| `types.ts` | Zod config schema, session/file types | `zod` only |
| `adapter.ts` | SlackAdapter class | `ChannelAdapter`, `OpenACPCore`, `OutgoingMessage`, `PermissionRequest`, `NotificationMessage`, `Attachment`, `FileService`, `createChildLogger` |
| `event-router.ts` | Routes Slack messages to sessions | `createChildLogger` |
| `formatter.ts` | Slack mrkdwn formatting | `OutgoingMessage`, `PermissionRequest` |
| `text-buffer.ts` | Batches outgoing text | `createChildLogger` |
| `channel-manager.ts` | Creates/archives Slack channels | None |
| `permission-handler.ts` | Allow/Deny buttons | None |
| `send-queue.ts` | Rate-limited Slack API queue | None |
| `slug.ts` | Channel name slug generator | None |
| `utils.ts` | Audio detection, text splitting | None |

## Config Schema

```typescript
SlackChannelConfig {
  enabled: boolean          // default false
  adapter?: string          // "@openacp/adapter-slack"
  botToken?: string         // xoxb-...
  appToken?: string         // xapp-... (Socket Mode)
  signingSecret?: string
  notificationChannelId?: string
  allowedUserIds: string[]  // default []
  channelPrefix: string     // default "openacp"
  autoCreateSession: boolean // default true
  startupChannelId?: string // saved by adapter for session reuse
}
```

## Related Repos

- **OpenACP core:** `../OpenACP` — the main project (removes Slack, adds migration message)
- **plugin-registry:** `../plugin-registry` — plugin manifest goes here after npm publish
