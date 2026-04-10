# Design: Slack Adapter — Telegram Parity Update (v2)

**Date:** 2026-04-10  
**Scope:** `slack-adapter/src/`  
**Reference adapters:** `OpenACP/src/plugins/telegram/` and `discord-adapter/src/`

---

## Background

A thorough comparison of the Telegram adapter, Discord adapter, `IChannelAdapter` interface (`core/channel.ts`), and `SessionBridge` (`core/sessions/session-bridge.ts`) against the Slack adapter revealed **12 gaps** — critical bugs, missing interface methods, and missing features. This spec documents all gaps, their root causes, and the exact changes required.

---

## Gap Analysis

### 1. [CRITICAL BUG] `handleText` Calls `tracker.finalize()` Prematurely

**File:** `src/adapter.ts` — `handleText()`

**Root cause:**  
`handleText` is called for every streaming text chunk. The current code calls `tracker.finalize()` on each chunk — `finalize()` marks the turn as complete and edits the "Processing..." message to "Done". But text arrives while the agent is still streaming. The session is NOT done when the first `text` event arrives.

**Telegram & Discord equivalent:**  
Both call `tracker.onTextStart()` which *seals* the tool card (stops tool updates) and dismisses the thinking indicator — but does NOT mark the turn as complete.

```typescript
// Telegram's handleText:
if (!this.draftManager.hasDraft(sessionId)) {
  const tracker = this.getOrCreateTracker(sessionId, threadId, mode);
  await tracker.onTextStart();   // ← seals tool card, NOT finalize
}

// Discord's handleText:
if (!this.draftManager.hasDraft(sessionId)) {
  const tracker = this.getOrCreateTracker(sessionId, thread, mode);
  await tracker.onTextStart();   // ← same pattern
}
```

**Fix:** Add `onTextStart()` to `SlackActivityTracker`. Call it in `handleText` only when the text buffer is fresh (no previous text in the buffer for this turn), mirroring Telegram/Discord's draft check.

---

### 2. [CRITICAL BUG] No Per-Session Dispatch Queue Serialization

**File:** `src/adapter.ts` — `sendMessage()`

**Root cause:**  
`SessionBridge` calls `adapter.sendMessage().catch()` — fire-and-forget. Multiple events (`tool_call`, `tool_update`, `text`) can arrive in rapid succession and be processed concurrently. Without serialization, a fast handler (`tool_update`) can overtake a slower one (`tool_call`), producing out-of-order state.

**Telegram equivalent:**

```typescript
// Telegram serializes per session:
const prev = this._dispatchQueues.get(sessionId) ?? Promise.resolve();
const next = prev.then(async () => {
  this._sessionThreadIds.set(sessionId, threadId);
  try { await super.sendMessage(sessionId, content); }
  finally { this._sessionThreadIds.delete(sessionId); }
}).catch((err) => log.warn({ err, sessionId }, "Dispatch queue error"));
this._dispatchQueues.set(sessionId, next);
await next;
```

**Fix:** Add `_dispatchQueues = new Map<string, Promise<void>>()` and wrap dispatch in the same per-session chain. Slack doesn't need the thread ID storage pattern (Telegram needs it because thread ID is retrieved from queue context; Slack stores it in `sessions` Map which is always available).

---

### 3. [FEATURE] `SlackActivityTracker.onTextStart()` Missing

**File:** `src/activity-tracker.ts`

**Root cause:**  
No equivalent of Telegram/Discord's `onTextStart()`. Without it, `handleText` falls back to `finalize()` (Bug #1) or does nothing.

**What `onTextStart()` must do:**
1. Seal the thought buffer (no more thoughts accepted)
2. Finalize the `toolCardState` (freeze tool card, stop accepting updates)
3. Update the main message to a neutral "responding" state (`isComplete: false`)

```typescript
async onTextStart(): Promise<void> {
  if (!this.turn) return;
  this.thoughtBuffer.seal();
  if (this.toolCardState) {
    this.toolCardState.finalize();  // freeze, don't destroy
    this.toolCardState = null;      // new tool calls after text → fresh card
  }
  await this.updateMainMessage(false);
}
```

---

### 4. [MISSING] `stripTTSBlock` Not Implemented as Adapter Method

**File:** `src/adapter.ts`

**Root cause:**  
`IChannelAdapter` declares `stripTTSBlock?(sessionId: string): Promise<void>`. This is called by `SessionBridge` when the speech plugin emits a `tts_strip` event:

```typescript
// session-bridge.ts line 401-403:
case "tts_strip":
  this.adapter.stripTTSBlock?.(this.session.id);
  break;
```

Slack handles TTS stripping inline in `handleAttachment` (when audio upload arrives), but does NOT implement `stripTTSBlock()` as an adapter method. If the `tts_strip` event fires before or independently of the attachment, the `[TTS]...[/TTS]` block is never removed from the text buffer.

**Fix:** Add `stripTTSBlock(sessionId: string)` method that calls `textBuffer.stripTtsBlock()`.

---

### 5. [MISSING] `sendSkillCommands` Not Implemented

**File:** `src/adapter.ts`

**Root cause:**  
`IChannelAdapter` declares `sendSkillCommands?(sessionId, commands): Promise<void>`. Called by `SessionBridge` when the agent emits a `commands_update` event:

```typescript
// session-bridge.ts:
case "commands_update":
  this.adapter.sendSkillCommands?.(this.session.id, event.commands);
  break;
```

Slack adapter has no implementation — skill command cards never appear for Slack sessions.

**Fix:** Implement `sendSkillCommands(sessionId, commands)` to post a formatted list of available commands to the session channel. Post as a new message or edit previous one (track by storing `ts` per session).

---

### 6. [MISSING] `cleanupSkillCommands` Not Implemented

**File:** `src/adapter.ts`

**Root cause:**  
`IChannelAdapter` declares `cleanupSkillCommands?(sessionId): Promise<void>`. Called by `SessionBridge` on `session_end` and `error` events:

```typescript
// session-bridge.ts:
case "session_end":
  this.session.finish(event.reason);
  this.adapter.cleanupSkillCommands?.(this.session.id);  // ← called here
  ...
case "error":
  this.session.fail(event.message);
  this.adapter.cleanupSkillCommands?.(this.session.id);  // ← and here
  ...
```

Without this, skill command messages left in the channel after session end are never updated or cleaned up.

**Fix:** Implement `cleanupSkillCommands(sessionId)` to edit the skill commands message to show "Session ended", or delete/update it.

---

### 7. [MISSING] `cleanupSessionState` Not Implemented

**File:** `src/adapter.ts`

**Root cause:**  
`IChannelAdapter` declares `cleanupSessionState?(sessionId): Promise<void>`. Called when switching agents — clears adapter-side per-session state so the new agent starts fresh.

Telegram implements this to: finalize draft, cleanup draft manager, destroy activity tracker.

Slack has no implementation — switching agents leaves the activity tracker in stale state.

**Fix:** Implement `cleanupSessionState(sessionId)` to:
1. Destroy activity tracker
2. Flush and destroy text buffer  
3. Remove from all session maps

---

### 8. [MISSING] `flushPendingSkillCommands` Not Implemented

**File:** `src/adapter.ts`

**Root cause:**  
`IChannelAdapter` declares `flushPendingSkillCommands?(sessionId): Promise<void>`. Called after a session's threadId becomes available (via `SESSION_THREAD_READY` event) to flush commands that arrived before the channel was ready.

Telegram queues skill commands in `_pendingSkillCommands` and flushes them in `flushPendingSkillCommands`. Slack has no pending queue or flush mechanism.

**Fix:** Once `sendSkillCommands` is implemented (#5), add a `_pendingSkillCommands` map and implement `flushPendingSkillCommands` to flush after channel creation.

Note: This is lower priority than #5/#6 since Slack channels are ready synchronously when sessions are created, making pending skill commands unlikely in practice.

---

### 9. [FEATURE] `sessionContext` + `tunnelService` Not Passed to ActivityTracker

**File:** `src/adapter.ts` — `getOrCreateTracker()`

**Root cause:**  
Telegram/Discord pass `sessionContext` (id + workingDirectory) and `tunnelService` to their `ActivityTracker`. The Slack `SlackActivityTracker` accepts these via `SlackActivityTrackerConfig` but `getOrCreateTracker` never populates them.

Without `sessionContext`, `DisplaySpecBuilder.buildToolSpec()` cannot generate viewer links for tools even when a tunnel is active.

**Fix:** In `getOrCreateTracker`, extract from `core`:
```typescript
const tunnelService = (this.core as any).lifecycleManager?.serviceRegistry?.get("tunnel");
const session = this.core.sessionManager.getSession(sessionId);
const sessionContext = session?.workingDirectory
  ? { id: sessionId, workingDirectory: session.workingDirectory }
  : undefined;
```

Pass both to `SlackActivityTrackerConfig`.

---

### 10. [FEATURE] `handleUsage` Missing Completion Notification

**File:** `src/adapter.ts` — `handleUsage()`

**Root cause:**  
Both Telegram and Discord send a completion notification to the notification channel from `handleUsage`. Telegram posts an inline notification; Discord calls `notificationChannel.send()`. Slack's `handleUsage` only appends usage to the tracker — no notification is sent.

Note: `sendNotification` IS called separately by `SessionBridge` via `NotificationManager`, but that covers general notifications. The inline completion notification with a direct channel link is separate and per-platform.

**Fix:** After `tracker.onUsage()`, post a notification to `notificationChannelId`:
```typescript
if (this.slackConfig.notificationChannelId) {
  const sess = this.core.sessionManager.getSession(sessionId);
  const name = sess?.name || "Session";
  await this.queue.enqueue("chat.postMessage", {
    channel: this.slackConfig.notificationChannelId,
    text: `✅ *${name}* — Task completed. <#${meta?.channelId}>`,
  });
}
```

---

### 11. [BUG] `handleError` Doesn't Destroy Tracker

**File:** `src/adapter.ts` — `handleError()`

**Root cause:**  
Telegram and Discord both destroy the activity tracker on error:
```typescript
const tracker = this.sessionTrackers.get(sessionId);
if (tracker) {
  tracker.destroy();
  this.sessionTrackers.delete(sessionId);
}
```

Slack's `handleError` only flushes the text buffer — the tracker continues running with stale state, holding open timer references.

**Fix:** Add tracker destroy to `handleError`.

---

### 12. [MINOR] `CoreKernel` Interface Missing Typed Members

**File:** `src/adapter.ts` — `CoreKernel` interface

**Root cause:**  
Several members are accessed via `(this.core as any)` casts:
- `lifecycleManager?.serviceRegistry?.get(...)` — for CommandRegistry and tunnel service  
- `sessionManager.getSession()` — already typed, but `session.workingDirectory` is missing from the interface

**Fix:** Add typed optional members to `CoreKernel`:
```typescript
lifecycleManager?: {
  serviceRegistry?: { get(name: string): unknown };
};
```
And add `workingDirectory?: string` to the session interface returned by `getSession`.

---

## Summary Table

| # | Priority | File | Change |
|---|----------|------|--------|
| 1 | Critical Bug | `adapter.ts` | Fix `handleText` — call `onTextStart()` not `finalize()` |
| 2 | Critical Bug | `adapter.ts` | Add `_dispatchQueues` serialization to `sendMessage` |
| 3 | Feature | `activity-tracker.ts` | Add `onTextStart()` method |
| 4 | Missing | `adapter.ts` | Implement `stripTTSBlock()` adapter method |
| 5 | Missing | `adapter.ts` | Implement `sendSkillCommands()` |
| 6 | Missing | `adapter.ts` | Implement `cleanupSkillCommands()` |
| 7 | Missing | `adapter.ts` | Implement `cleanupSessionState()` |
| 8 | Missing | `adapter.ts` | Implement `flushPendingSkillCommands()` + pending queue |
| 9 | Feature | `adapter.ts` | Pass `sessionContext` + `tunnelService` to tracker |
| 10 | Feature | `adapter.ts` | `handleUsage` → send completion notification |
| 11 | Bug | `adapter.ts` | `handleError` → destroy tracker |
| 12 | Minor | `adapter.ts` | Expand `CoreKernel` interface types |

---

## Revised Architecture: Full Event Flow

```
SessionBridge fires sendMessage() (fire-and-forget, concurrent)
                      ↓
         SlackAdapter._dispatchQueues[sessionId]   ← [2] serialize
                      ↓ (serialized per session)
         super.sendMessage() → dispatchMessage()
              ┌────────────┬───────────────┬────────────┐
              ↓            ↓               ↓            ↓
       handleToolCall  handleText    handleSessionEnd  handleError
              ↓            ↓               ↓            ↓
     tracker.onNewPrompt  tracker.onTextStart()  tracker.finalize()  tracker.destroy()
     tracker.onToolCall() [3] ← FIXED [1]        flushTextBuffer()
              ↓
       buf.flush() before tool card

SessionBridge also calls adapter directly:
  commands_update → sendSkillCommands()      [5] ← MISSING
  session_end     → cleanupSkillCommands()   [6] ← MISSING
  error           → cleanupSkillCommands()   [6] ← MISSING
  tts_strip       → stripTTSBlock()          [4] ← MISSING
  agent switch    → cleanupSessionState()    [7] ← MISSING
```

---

## Files Changed

1. `src/activity-tracker.ts` — Add `onTextStart()` method (#3)
2. `src/adapter.ts` — All other changes (#1, #2, #4-#12)

No new files needed. Skill commands tracking (`_pendingSkillCommands`, message `ts` tracking) is lightweight enough to stay in `adapter.ts` without a separate manager class.

---

## Out of Scope

- **ThinkingIndicator**: Telegram shows "💭 Thinking..." with elapsed time refresh. No Slack equivalent planned — the "Processing..." tool card message serves the same purpose.
- **Control message / pinned status card**: Telegram has a pinned session control message with bypass/TTS buttons. No Slack equivalent planned.
- **handleConfigUpdate / handleModeChange / handleModelUpdate**: No visible user-facing change needed for Slack (these trigger control message updates in Telegram, but Slack has no equivalent).
- **`archiveSessionTopic`**: Telegram implements this for the archive command. Slack's `deleteSessionThread` already archives the channel. This method is optional in `IChannelAdapter` and can be deferred.
- **Assistant session filtering**: Telegram and Discord suppress notifications for assistant sessions. Slack doesn't have an AssistantManager, so not applicable.
