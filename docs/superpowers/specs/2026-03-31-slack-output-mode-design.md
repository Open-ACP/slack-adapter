# Slack Output Mode & Thread-Based Rendering Design

**Date:** 2026-03-31
**Branch:** `develop`
**Status:** Planned
**Depends on:** `output-mode-design.md` (core spec, 2026-03-30)

## Overview

Implements the OutputMode system (low/medium/high) for the Slack adapter with a **thread-based rendering model** and **Slack modals** for configuration. Reuses core adapter-primitives (`ToolStateMap`, `DisplaySpecBuilder`, `OutputModeResolver`, `ToolCardState`, `ThoughtBuffer`) — no logic duplication.

**Key Slack-specific decisions:**
- One thread per prompt turn (main message = summary, thread = tool details)
- Final text response + permissions posted in channel (not thread)
- `/outputmode` opens a Slack modal with radio buttons + scope selector

## Thread Model

### Per-Turn Flow

```
Channel:
  [User message]
  [Bot main message] "🔧 Processing..."           ← created on prompt start, edited on progress
    └── Thread replies:                            ← tool cards, thinking (per output mode)
        📖 Read src/auth.ts (lines 1-50)
        ✏️ Edit src/auth.ts (+5/-2)  [View Diff]
        🔧 Bash: npm test  [View Output]
  [Bot main message edited] "✅ Done — 3 tools"   ← summary when complete
  [Bot text reply] "I've fixed the auth bug..."    ← final text, directly in channel
  [Permission request]                             ← directly in channel if needed
```

### Rules

- **Main message**: Created when prompt starts. Edited continuously with tool progress. Finalized to summary when turn completes.
- **Thread replies**: Tool cards and thinking posted as replies to main message. Aggregated via `ToolCardState` debounce (500ms).
- **Final text response**: Posted directly in channel (not in thread) so user reads it without clicking into thread.
- **Permission requests**: Posted directly in channel with action buttons. Require immediate user attention.
- **Multiple turns**: Each turn creates a new main message = new thread. Previous turns remain as-is.
- **User replies in thread**: Ignored — only channel messages route to session.

### Main Message Format

**In progress:**
```
┌─────────────────────────────────────┐
│ 🔧 Processing...                    │
│ ✅ Read src/auth.ts                  │
│ 🔄 Edit src/auth.ts                 │
│ 2/5 tools                           │
└─────────────────────────────────────┘
```

**Completed (medium/high):**
```
┌─────────────────────────────────────┐
│ ✅ Done                              │
│ 📖 ×2  ✏️ ×1  🔧 ×1                │
│ 📊 12.5k tokens · $0.03             │
└─────────────────────────────────────┘
```

**Completed (low):**
```
┌─────────────────────────────────────┐
│ ✅ Done                              │
└─────────────────────────────────────┘
```

## Output Modes

Uses core `DisplaySpecBuilder` and `OutputModeResolver` directly. Display matrix identical to Telegram/core spec:

### Per-Mode Display Matrix

| Element | 🔇 Low | 📊 Medium | 🔍 High |
|---------|--------|-----------|---------|
| Tool title/icon | Yes | Yes | Yes |
| Tool description | No | Yes | Yes |
| Command (e.g. terminal cmd) | No | Yes | Yes |
| Output summary | No | Yes | Yes |
| Inline output content | No | No | Yes (if short) |
| View Output link (long output) | No | Yes | Yes |
| Diff stats (+X/-Y) | No | Yes | Yes |
| Thinking content | No | No | Yes |
| Noise tools | Hidden | Hidden | Shown |
| View File / View Diff buttons | Yes | Yes | Yes |
| Thinking indicator | Yes | Yes | Yes |
| Usage stats | No | Yes | Yes |

### Slack-Specific Rendering Locations

| Element | Low | Medium | High |
|---------|-----|--------|------|
| Main message | Summary only | Tool count + usage | Tool count + usage |
| Thread: tool cards | Not posted | Title + description | Title + description + output |
| Thread: thinking | Not posted | Not posted | Full thinking content |
| Final text | Channel | Channel | Channel |
| Permission | Channel | Channel | Channel |

### Thresholds (from core)

- Inline output (high mode): `OUTPUT_LINE_THRESHOLD = 15` lines, `OUTPUT_CHAR_THRESHOLD = 800` chars
- Both must be within threshold for inline display; otherwise use viewer link

### Cascade Resolution (from core)

```
Session override → Adapter override → Global default → "medium"
```

### Noise Rules (from core)

- `ls`, `glob`, `grep`, directory reads → noise → hidden in low/medium, shown in high

## Tool Card Rendering (Block Kit)

### Thread Reply Format

**Medium mode:**
```
context block:  ✏️ Edit  ·  src/auth.ts
section block:  Fixed validation logic in login()
context block:  +5 / -2 lines  ·  View Diff
```

**High mode adds:**
```
section block:  ```
                if (!token) throw new AuthError()
                ```
```

### Aggregation

Multiple tool updates aggregated into single thread reply via `ToolCardState`:
- Debounce: 500ms
- First flush: immediate
- Finalize: immediate flush
- Split at entry boundary if message > 3000 chars (Slack block text limit)

### Out-of-Order Handling

Core `ToolStateMap` handles out-of-order tool events:
- `merge()` for unknown ID buffers in `pendingUpdates`
- Next `upsert()` applies pending update atomically

## Modal: `/outputmode`

### Trigger

- `/outputmode` → opens modal
- `/outputmode low|medium|high` → set directly without modal (inline shortcut)

### Modal Layout

```
┌──────────────────────────────────────┐
│  ⚙️ Output Mode                      │
│                                      │
│  ○ 🔇 Low                            │
│    Summary only, no tool details     │
│                                      │
│  ● 📊 Medium                         │
│    Tool summaries + viewer links     │
│                                      │
│  ○ 🔍 High                           │
│    Full details, thinking, output    │
│                                      │
│  ─────────────────────────────       │
│  Apply to:                           │
│  [ This session ▾ ]                  │
│    • This session                    │
│    • All sessions (adapter default)  │
│                                      │
│          [ Cancel ]  [ Save ]        │
└──────────────────────────────────────┘
```

### Implementation

- Radio buttons: `radio_buttons` element with 3 options
- Each option includes description text below label
- Scope: `static_select` with 2 options
- Current selection pre-populated from `OutputModeResolver.resolve()`
- Submit: Updates config via cascade (session record or adapter config)

## Permission Requests

Posted directly in channel (not in thread):

```
section block:   🔐 Permission Request
section block:   Edit file: src/auth.ts
actions block:   [✅ Allow (primary)]  [❌ Deny (danger)]
```

- Button value: `requestId:optionId` (existing pattern preserved)
- After click: edit message to remove buttons, add result:
  ```
  context block:  🔐 Permission: Edit src/auth.ts — ✅ Allowed by @lucas
  ```
- Multiple options: render all as buttons
- Timeout (10min, from core PermissionGate): edit message to "⏰ Timed out"

## Architecture

### Data Flow

```
ACP Event → SessionBridge → adapter.sendMessage()
  → SlackActivityTracker (per session)
    → ToolStateMap (accumulate tool state)
    → DisplaySpecBuilder (mode-aware spec)
    → ToolCardState (debounce + aggregate)
    → SlackToolCardRenderer (spec → Block Kit blocks)
    → SlackSendQueue
      → Main message: chat.update (edit progress)
      → Thread reply: chat.postMessage (thread_ts)
      → Channel message: chat.postMessage (final text, permissions)
```

### Components

| Component | New/Rewrite | Description |
|-----------|-------------|-------------|
| `SlackActivityTracker` | **New** | Wraps core primitives (ToolStateMap, DisplaySpecBuilder, ToolCardState, ThoughtBuffer). Manages main message + thread replies per turn. |
| `SlackToolCardRenderer` | **New** | Converts `ToolCardSnapshot` → Slack Block Kit blocks. Equivalent to Telegram's `formatting.ts` renderToolCard. |
| `SlackModalHandler` | **New** | Registers Bolt view handlers, renders `/outputmode` modal, handles submit callbacks. |
| `formatter.ts` | **Rewrite** | Remove inline tool rendering. Keep `markdownToMrkdwn()`, permission block formatting, text formatting. |
| `renderer.ts` | **Rewrite** | Delegate tool/thinking/usage rendering to ActivityTracker instead of self-rendering. |
| `adapter.ts` | **Update** | Add OutputModeResolver, thread management (main message ts tracking), wire ActivityTracker. |
| `send-queue.ts` | **Update** | Add `chat.update` method rate limit tier. |
| `text-buffer.ts` | **Keep** | Still buffers streaming text, flushes to channel (not thread). |

### Turn State (in SlackActivityTracker)

```typescript
interface TurnState {
  mainMessageTs: string;        // main message timestamp (for editing)
  threadTs: string;             // same as mainMessageTs (thread parent)
  currentToolCardTs?: string;   // current aggregated tool card in thread
  toolStateMap: ToolStateMap;
  toolCardState: ToolCardState;
  thoughtBuffer: ThoughtBuffer;
  isFinalized: boolean;
}
```

### Core Primitives Used (no duplication)

- `ToolStateMap` — accumulate tool events, handle out-of-order
- `DisplaySpecBuilder` — mode-aware spec generation
- `ToolCardState` — debounce + aggregate tool updates
- `ThoughtBuffer` — thought chunk accumulation
- `OutputModeResolver` — cascade config resolution

## Edge Cases

### Thread

| Scenario | Handling |
|----------|----------|
| Main message edit fails (deleted/archived) | Log warning, post new message instead of edit |
| Thread reply fails | Retry once, skip if still fails (tool card not critical) |
| Too many thread replies (>100 tools) | Aggregate harder: 5-10 tools per message instead of 2-3 |
| User replies in thread | Ignore — only channel messages route to session |
| Session has multiple turns | Each turn = new main message + new thread |
| Rate limit (429) | SlackSendQueue handles — queue waits per tier |

### Permission

| Scenario | Handling |
|----------|----------|
| No click within 10 minutes | PermissionGate timeout (core) → edit message "⏰ Timed out" |
| Permission during tool card update | Permission in channel, no conflict with thread |
| Multiple consecutive permission requests | Each request = separate channel message |

### Modal

| Scenario | Handling |
|----------|----------|
| Submit when session already ended | Apply to adapter default, ignore session scope |
| Concurrent modal opens | Slack handles — only 1 modal active per user |
| Invalid slash command args | `/outputmode xyz` → open modal with current selection |

### Output Mode (from core)

| Scenario | Handling |
|----------|----------|
| Tunnel unavailable | Fallback inline content on high mode |
| Out-of-order tool events | ToolStateMap buffers pending, applies on upsert |
| Tool card > 3000 chars | Split at entry boundary into multiple thread replies |
| No description available | Fallback to raw content |

## Files Changed

**New:**
- `src/activity-tracker.ts` — SlackActivityTracker
- `src/tool-card-renderer.ts` — SlackToolCardRenderer (Block Kit)
- `src/modal-handler.ts` — SlackModalHandler (/outputmode modal)

**Rewrite:**
- `src/formatter.ts` — Remove tool rendering, keep text/permission formatting
- `src/renderer.ts` — Delegate to ActivityTracker

**Update:**
- `src/adapter.ts` — OutputModeResolver, thread management, ActivityTracker wiring
- `src/send-queue.ts` — Add chat.update tier
- `src/index.ts` — Register modal handler, slash command
- `src/permission-handler.ts` — Update to use Block Kit format from this spec

**Keep:**
- `src/text-buffer.ts` — Unchanged
- `src/channel-manager.ts` — Unchanged
- `src/event-router.ts` — Unchanged
- `src/slug.ts` — Unchanged
- `src/utils.ts` — Unchanged
- `src/types.ts` — Add TurnState type
