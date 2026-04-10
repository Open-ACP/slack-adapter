# Design: Slack Adapter — Telegram Parity Update

**Date:** 2026-04-10  
**Scope:** `slack-adapter/src/`  
**Goal:** Align Slack adapter logic with Telegram adapter to fix critical bugs and add missing features.

---

## Background

A thorough comparison of the Telegram adapter (`OpenACP/src/plugins/telegram/`) and the Slack adapter (`slack-adapter/src/`) revealed several critical bugs and missing features. The Slack adapter was built earlier and has diverged from the patterns that Telegram established. This spec documents all gaps and the plan to address them in priority order.

---

## Gap Analysis

### 1. [CRITICAL BUG] `handleText` Calls `tracker.finalize()` Prematurely

**File:** `src/adapter.ts` — `handleText()`

**Problem:** `handleText` is called for every streaming text chunk. The current code calls `tracker.finalize()` on each chunk:

```typescript
// Current (wrong):
const tracker = this.sessionTrackers.get(sessionId);
if (tracker) await tracker.finalize();
```

`finalize()` marks the turn as complete and edits the "Processing..." message to "Done". But text arrives in streaming chunks — the session is NOT done yet when the first `text` event arrives. This causes the "Done" indicator to appear while the agent is still responding.

**Telegram equivalent:** Telegram calls `tracker.onTextStart()` which *seals* the tool card (stops tool updates from flowing) and dismisses the thinking indicator — but does NOT mark the turn as complete.

**Fix:** Add `onTextStart()` to `SlackActivityTracker`. Call it in `handleText` instead of `finalize()`.

---

### 2. [CRITICAL BUG] No Per-Session Dispatch Queue Serialization

**File:** `src/adapter.ts` — `sendMessage()`

**Problem:** `sendMessage` calls `super.sendMessage()` directly without serialization:

```typescript
// Current (wrong):
async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
  if (!this.sessions.has(sessionId)) { ... return; }
  await super.sendMessage(sessionId, content);
}
```

`SessionBridge` fires `sendMessage()` as fire-and-forget for each event. Multiple events (`tool_call`, `tool_update`, `text`) can arrive in rapid succession and be processed concurrently. Without serialization, a fast handler (`tool_update`) can overtake a slower one (`tool_call`), producing out-of-order state.

**Telegram equivalent:** Wraps each `sendMessage` in a per-session promise chain (`_dispatchQueues`):

```typescript
const prev = this._dispatchQueues.get(sessionId) ?? Promise.resolve();
const next = prev.then(async () => { await super.sendMessage(sessionId, content); });
this._dispatchQueues.set(sessionId, next);
await next;
```

**Fix:** Add `_dispatchQueues = new Map<string, Promise<void>>()` and wrap dispatch in the same pattern.

---

### 3. [FEATURE] `SlackActivityTracker.onTextStart()` Missing

**File:** `src/activity-tracker.ts`

**Problem:** No equivalent of Telegram's `onTextStart()`. This method is needed to:
1. Seal the thought buffer (no more thoughts accepted)
2. Finalize the `toolCardState` (freeze tool card display)
3. Update the main message to a neutral "responding" state (not "Done")

Without this, text chunks arrive and either:
- `finalize()` is called (current bug — marks "Done" too early), or
- Nothing is called (tool card keeps showing stale "Processing..." state)

**Fix:** Add `onTextStart()` to `SlackActivityTracker`:

```typescript
async onTextStart(): Promise<void> {
  if (!this.turn) return;
  this.thoughtBuffer.seal();
  if (this.toolCardState) {
    this.toolCardState.finalize(); // freeze tool card
    this.toolCardState = null;
  }
  // Update main message: still "Processing..." but tool phase is done
  await this.updateMainMessage(false);
}
```

---

### 4. [FEATURE] `sessionContext` and `tunnelService` Not Passed to ActivityTracker

**File:** `src/adapter.ts` — `getOrCreateTracker()`

**Problem:** Telegram passes `sessionContext` (session id + workingDirectory) and `tunnelService` to `ActivityTracker`, enabling tunnel viewer links in high output mode. Slack's `getOrCreateTracker` passes neither.

**Fix:** In `getOrCreateTracker`, retrieve tunnel service and session context from `core`:

```typescript
const tunnelService = (this.core as any).lifecycleManager?.serviceRegistry?.get("tunnel");
const session = this.core.sessionManager.getSession(sessionId);
const sessionContext = session ? { id: sessionId, workingDirectory: session.workingDirectory } : undefined;
```

Pass both to `SlackActivityTrackerConfig`.

---

### 5. [FEATURE] `sendSkillCommands()` Not Implemented

**File:** `src/adapter.ts`

**Problem:** `MessagingAdapter` base class supports `sendSkillCommands(sessionId, commands)` which sends the agent's available skill commands to the channel. Telegram implements this via `SkillCommandManager`. Slack doesn't implement it at all — skill command cards never appear.

**Fix:** Implement `sendSkillCommands(sessionId: string, commands: AgentCommand[]): Promise<void>` in `SlackAdapter`:
- Format commands as a Slack Block Kit message
- Post to the session channel
- No pending queue needed (Slack channels are always ready by the time skill commands arrive)

---

### 6. [FEATURE] `handleUsage` Missing Completion Notification

**File:** `src/adapter.ts` — `handleUsage()`

**Problem:** Telegram's `handleUsage` does two things:
1. Sends usage stats as a standalone message to the session topic
2. Sends a completion notification (`✅ Task completed`) to the notification topic

Slack's `handleUsage` only appends usage to the tracker (for display in the tool card). It doesn't send any message to `notificationChannelId`.

**Fix:** After `tracker.onUsage()`, post a completion notification to `notificationChannelId` (if configured).

---

### 7. [BUG] `handleError` Doesn't Destroy Tracker

**File:** `src/adapter.ts` — `handleError()`

**Problem:** Telegram's `handleError` destroys the tracker and removes it from `sessionTrackers`. Slack's `handleError` only flushes the text buffer — the tracker keeps running with stale state.

**Fix:** Mirror Telegram:
```typescript
const tracker = this.sessionTrackers.get(sessionId);
if (tracker) {
  tracker.destroy();
  this.sessionTrackers.delete(sessionId);
}
```

---

### 8. [MINOR] `CoreKernel` Interface Missing Typed Members

**File:** `src/adapter.ts` — `CoreKernel` interface

**Problem:** Several core methods are accessed via `(this.core as any)` casts:
- `lifecycleManager?.serviceRegistry?.get(...)` — for CommandRegistry and tunnel service
- `assistantManager` — used in Telegram's `handleText` for assistant session filtering

The `CoreKernel` interface in Slack is a minimal subset. The `(this.core as any)` casts work at runtime but are fragile.

**Fix:** Add typed optional properties to `CoreKernel`:
```typescript
lifecycleManager?: {
  serviceRegistry?: {
    get(name: string): unknown;
  };
};
```

---

## Summary Table

| # | Priority | File | Change |
|---|----------|------|--------|
| 1 | Critical Bug | `adapter.ts` | Fix `handleText` — call `onTextStart()` not `finalize()` |
| 2 | Critical Bug | `adapter.ts` | Add `_dispatchQueues` serialization to `sendMessage` |
| 3 | Feature | `activity-tracker.ts` | Add `onTextStart()` method |
| 4 | Feature | `adapter.ts` | Pass `sessionContext` + `tunnelService` to tracker |
| 5 | Feature | `adapter.ts` | Implement `sendSkillCommands()` |
| 6 | Feature | `adapter.ts` | `handleUsage` → send completion notification |
| 7 | Bug | `adapter.ts` | `handleError` → destroy tracker |
| 8 | Minor | `adapter.ts` | Expand `CoreKernel` interface types |

---

## Architecture: Revised Event Flow

```
SessionBridge fires sendMessage() (fire-and-forget, concurrent)
                      ↓
         SlackAdapter._dispatchQueues[sessionId]   ← NEW: serialize
                      ↓ (serialized per session)
         super.sendMessage() → dispatchMessage()
              ↓                      ↓
         handleToolCall()        handleText()
              ↓                      ↓
      tracker.onNewPrompt()    tracker.onTextStart() ← FIXED (was finalize)
      tracker.onToolCall()     textBuffer.append()
              ↓
      handleSessionEnd()
              ↓
      tracker.finalize()  ← Only here marks "Done"
      flushTextBuffer()
```

---

## Files Changed

1. `src/activity-tracker.ts` — Add `onTextStart()` method
2. `src/adapter.ts` — All other changes (dispatch queue, handleText fix, sendSkillCommands, handleUsage notification, handleError tracker destroy, CoreKernel types, sessionContext/tunnelService passing)

No new files needed. No tests broken by these changes (existing tests mock the tracker).

---

## Out of Scope

- **ThinkingIndicator**: Telegram shows a "💭 Thinking..." message with elapsed time. Slack doesn't have a direct equivalent. Adding it would require posting then editing a message on each thought, which is expensive. Skipping for now — the tool card "Processing..." message serves the same purpose.
- **Control message**: Telegram has a pinned session control message (bypass/TTS buttons). No Slack equivalent planned.
- **handleConfigUpdate**: No visible user-facing change needed for Slack.
- **Assistant session filtering**: Telegram filters out assistant session notifications. Slack doesn't have AssistantManager, so not applicable.
