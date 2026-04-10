# Slack Adapter — Telegram Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 critical bugs, 2 bugs, and 8 missing features in the Slack adapter to reach parity with Telegram/Discord reference implementations.

**Architecture:** All changes are confined to `src/activity-tracker.ts` and `src/adapter.ts`. No new files needed. Skill commands tracking (`_pendingSkillCommands`, `_skillCommandsTs`) lives inline in `adapter.ts` without a separate manager.

**Tech Stack:** TypeScript, `@openacp/plugin-sdk`, `@slack/bolt`, `@slack/web-api`

**Spec:** `../specs/2026-04-10-slack-telegram-parity-design.md`

---

## File Map

| File | Changes |
|------|---------|
| `src/activity-tracker.ts` | Add `onTextStart()` method + `textStarted` flag |
| `src/adapter.ts` | Fix `handleText`, add `_dispatchQueues`, implement 5 missing methods, fix `handleError`, fix `handleUsage`, fix `getOrCreateTracker`, expand `CoreKernel`, fix session Map cleanup, persist `channelId` + self-heal on resume |

---

## Task 1: Expand `CoreKernel` Interface + Add `AgentCommand` Import

**Files:**
- Modify: `src/adapter.ts:1-50`

This is the foundation — typed access to `lifecycleManager`, `session.workingDirectory`, and `session.name` is required by Tasks 6, 8, and 9.

- [ ] **Step 1: Add `AgentCommand` to SDK imports**

In `src/adapter.ts`, find the import block at lines 9–23 (the `import type { ... } from "@openacp/plugin-sdk"` block) and add `AgentCommand` to it:

```typescript
import type {
  MessagingAdapterConfig,
  OutgoingMessage,
  PermissionRequest,
  NotificationMessage,
  Attachment,
  AdapterCapabilities,
  FileServiceInterface,
  DisplayVerbosity,
  IRenderer,
  OutputMode,
  ToolCallMeta,
  ToolUpdateMeta,
  ViewerLinks,
  AgentCommand,
  TunnelServiceInterface,
} from "@openacp/plugin-sdk";
```

- [ ] **Step 2: Expand the `CoreKernel` interface**

Replace the current `CoreKernel` interface (lines 39–50 of `src/adapter.ts`) with:

```typescript
/** Minimal interface for the core kernel, accessed via ctx.kernel */
interface CoreKernel {
  configManager: { get(): { security: { allowedUserIds: string[] } } };
  lifecycleManager?: {
    serviceRegistry?: { get(name: string): unknown };
  };
  sessionManager: {
    getSession(id: string): {
      id: string;
      name?: string;
      threadId?: string;
      workingDirectory?: string;
      permissionGate: { requestId: string; resolve(optionId: string): void };
    } | undefined;
    getSessionByThread(platform: string, threadId: string): { id: string } | undefined;
    getSessionRecord(id: string): { platform?: Record<string, unknown> } | undefined;
    patchRecord(id: string, patch: Record<string, unknown>): Promise<void>;
  };
  fileService: FileServiceInterface;
  handleMessage(msg: { channelId: string; threadId: string; userId: string; text: string; attachments?: Attachment[] }): Promise<void>;
  handleNewSession(platform: string, userId?: string, text?: string, opts?: { createThread: boolean }): Promise<{ id: string; threadId?: string }>;
}
```

- [ ] **Step 3: Build to verify no TypeScript errors**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds (or only pre-existing errors, none new).

- [ ] **Step 4: Commit**

```bash
git add src/adapter.ts
git commit -m "feat(slack): expand CoreKernel interface with lifecycleManager and session fields"
```

---

## Task 2: Add `onTextStart()` to `SlackActivityTracker`

**Files:**
- Modify: `src/activity-tracker.ts`

`onTextStart()` seals the tool card (freezes it, stops updates) and dismisses any in-progress state — without marking the turn as complete. Required by Task 3 which fixes `handleText`.

- [ ] **Step 1: Add `textStarted` flag to `SlackActivityTracker`**

In `src/activity-tracker.ts`, find the private field declarations (around line 41–53) and add `textStarted`:

```typescript
  private toolStateMap = new ToolStateMap();
  private specBuilder: DisplaySpecBuilder;
  private toolCardState: ToolCardState | null = null;
  private thoughtBuffer = new ThoughtBuffer();
  private renderer = new SlackToolCardRenderer();
  private turn: TurnState | null = null;
  private textStarted = false;           // ← add this
  private lastSnapshot: ToolCardSnapshot = {
    specs: [],
    totalVisible: 0,
    completedVisible: 0,
    allComplete: false,
  };
  private thoughtMessageTs?: string;
```

- [ ] **Step 2: Reset `textStarted` in `onNewPrompt()`**

In `onNewPrompt()` (around line 69), add `this.textStarted = false;` in the "Reset state" block:

```typescript
    // Reset state
    this.toolStateMap.clear();
    this.thoughtBuffer.reset();
    this.textStarted = false;           // ← add this
    if (this.toolCardState) {
      this.toolCardState.destroy();
      this.toolCardState = null;
    }
    this.thoughtMessageTs = undefined;
```

- [ ] **Step 3: Add `onTextStart()` method**

Add the following method after `onToolUpdate()` (around line 209, before `onPlan()`):

```typescript
  /**
   * Called on the first text chunk of a turn.
   *
   * Seals the thought buffer and freezes the tool card — no more updates accepted.
   * Does NOT mark the turn as complete (that's finalize()'s job). Idempotent: safe
   * to call multiple times per turn.
   */
  async onTextStart(): Promise<void> {
    if (!this.turn || this.textStarted) return;
    this.textStarted = true;
    this.thoughtBuffer.seal();
    if (this.toolCardState) {
      // Freeze the tool card — don't destroy it, keep it visible
      this.toolCardState.finalize();
      // Null out so any tool calls arriving after text start get a fresh card
      this.toolCardState = null;
    }
    await this.updateMainMessage(false);
  }
```

- [ ] **Step 4: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/activity-tracker.ts
git commit -m "feat(slack): add onTextStart() to SlackActivityTracker"
```

---

## Task 3: Fix `handleText` (Critical Bug #1) + Add Dispatch Queue (Critical Bug #2)

**Files:**
- Modify: `src/adapter.ts`

**Bug #1**: `handleText` currently calls `tracker.finalize()` on every text chunk, marking the turn "Done" prematurely. Fix: call `tracker.onTextStart()` instead (seals without completing).

**Bug #2**: `SessionBridge` fires `sendMessage()` fire-and-forget. Without a per-session queue, concurrent events can arrive out of order. Fix: wrap dispatch in a per-session promise chain.

- [ ] **Step 1: Add `_dispatchQueues` field**

In `src/adapter.ts`, find the private field declarations (around lines 69–77) and add:

```typescript
  private sessions = new Map<string, SlackSessionMeta>();
  private textBuffers = new Map<string, SlackTextBuffer>();
  private outputModeResolver = new OutputModeResolver();
  private modalHandler = new SlackModalHandler();
  private sessionTrackers = new Map<string, SlackActivityTracker>();
  private _dispatchQueues = new Map<string, Promise<void>>();   // ← add this
  private adapterDefaultOutputMode: OutputMode | undefined;
  private botUserId = "";
  private slackConfig: SlackChannelConfig;
  private fileService!: FileServiceInterface;
```

- [ ] **Step 2: Wrap `sendMessage()` in per-session queue**

Replace the current `sendMessage()` (lines 630–636):

```typescript
  // Before:
  async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      this.log.warn({ sessionId }, "No Slack channel for session, skipping message");
      return;
    }
    await super.sendMessage(sessionId, content);
  }
```

With:

```typescript
  async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      this.log.warn({ sessionId }, "No Slack channel for session, skipping message");
      return;
    }
    // Serialize per session — SessionBridge fires sendMessage() fire-and-forget so
    // concurrent events (tool_call, tool_update, text) can race without this queue.
    const prev = this._dispatchQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => super.sendMessage(sessionId, content))
      .catch((err) => { this.log.warn({ err, sessionId }, "Dispatch queue error"); });
    this._dispatchQueues.set(sessionId, next);
    await next;
  }
```

- [ ] **Step 3: Fix `handleText` to call `onTextStart()` instead of `finalize()`**

Replace the current `handleText()` (lines 640–651):

```typescript
  // Before:
  protected async handleText(sessionId: string, content: OutgoingMessage): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;

    // Finalize activity tracker (marks turn as done, updates main message)
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) await tracker.finalize();

    // Post text in channel via text buffer (existing behavior)
    const buf = this.getTextBuffer(sessionId, meta.channelId);
    buf.append(content.text ?? "");
  }
```

With:

```typescript
  protected async handleText(sessionId: string, content: OutgoingMessage): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;

    // Seal tool card on first text chunk without marking the turn complete.
    // finalize() is called later in handleSessionEnd when the turn truly ends.
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) await tracker.onTextStart();

    const buf = this.getTextBuffer(sessionId, meta.channelId);
    buf.append(content.text ?? "");
  }
```

- [ ] **Step 4: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/adapter.ts
git commit -m "fix(slack): fix handleText premature finalize and add per-session dispatch queue"
```

---

## Task 4: Implement `stripTTSBlock()` Adapter Method

**Files:**
- Modify: `src/adapter.ts`

`IChannelAdapter` declares `stripTTSBlock?(sessionId: string): Promise<void>`. `SessionBridge` calls it on `tts_strip` events — which may fire independently of `handleAttachment`. Without this, [TTS] blocks linger in text if synthesis races ahead.

- [ ] **Step 1: Add `stripTTSBlock()` after `sendNotification()`**

In `src/adapter.ts`, add the following method after `sendNotification()` (after line 870, before the closing `}`):

```typescript
  /**
   * Remove [TTS]...[/TTS] blocks from the text buffer for a session.
   * Called by SessionBridge on tts_strip events — fires independently of the
   * attachment upload, so this handles the case where tts_strip arrives before
   * or separately from handleAttachment.
   */
  async stripTTSBlock(sessionId: string): Promise<void> {
    const buf = this.textBuffers.get(sessionId);
    if (buf) await buf.stripTtsBlock();
  }
```

- [ ] **Step 2: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/adapter.ts
git commit -m "feat(slack): implement stripTTSBlock adapter method"
```

---

## Task 5: Implement `sendSkillCommands()`, `cleanupSkillCommands()`, `flushPendingSkillCommands()`

**Files:**
- Modify: `src/adapter.ts`

These three methods implement the full skill commands lifecycle. Without them, skill command cards never appear in Slack sessions and are never cleaned up on session end.

- [ ] **Step 1: Add tracking fields for skill commands**

In `src/adapter.ts`, add two new fields next to `_dispatchQueues`:

```typescript
  private _dispatchQueues = new Map<string, Promise<void>>();
  /** Message `ts` of the skill commands card per session, for in-place edits */
  private _skillCommandsTs = new Map<string, string>();
  /** Commands queued before a session channel was ready */
  private _pendingSkillCommands = new Map<string, AgentCommand[]>();
```

- [ ] **Step 2: Add private `formatSkillCommands()` helper**

Add a private helper at the end of the class (after `postFormattedMessage()`, before `sendPermissionRequest()`):

```typescript
  private formatSkillCommands(commands: AgentCommand[]): string {
    if (commands.length === 0) return "_No commands available_";
    const lines = ["*Available commands:*"];
    for (const cmd of commands) {
      const hint = (cmd as { description?: string }).description
        ? ` — ${(cmd as { description?: string }).description}`
        : "";
      lines.push(`• \`/${cmd.name}\`${hint}`);
    }
    return lines.join("\n");
  }
```

- [ ] **Step 3: Implement `sendSkillCommands()`**

Add after `stripTTSBlock()`:

```typescript
  /**
   * Post or update the skill commands card in the session channel.
   * If the session channel is not yet ready, queues for later flush.
   */
  async sendSkillCommands(sessionId: string, commands: AgentCommand[]): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) {
      // Channel not ready yet — queue and flush in flushPendingSkillCommands()
      this._pendingSkillCommands.set(sessionId, commands);
      return;
    }

    const text = this.formatSkillCommands(commands);
    const existingTs = this._skillCommandsTs.get(sessionId);

    try {
      if (existingTs) {
        await this.queue.enqueue("chat.update", {
          channel: meta.channelId,
          ts: existingTs,
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        });
      } else {
        const result = await this.queue.enqueue<{ ts?: string }>("chat.postMessage", {
          channel: meta.channelId,
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        });
        if (result?.ts) this._skillCommandsTs.set(sessionId, result.ts);
      }
    } catch (err) {
      this.log.warn({ err, sessionId }, "Failed to post/update skill commands");
    }
  }
```

- [ ] **Step 4: Implement `cleanupSkillCommands()`**

Add after `sendSkillCommands()`:

```typescript
  /**
   * Update the skill commands card to "Session ended" and clear all tracking.
   * Called by SessionBridge on session_end and error events.
   */
  async cleanupSkillCommands(sessionId: string): Promise<void> {
    this._pendingSkillCommands.delete(sessionId);

    const ts = this._skillCommandsTs.get(sessionId);
    const meta = this.sessions.get(sessionId);
    if (ts && meta) {
      try {
        await this.queue.enqueue("chat.update", {
          channel: meta.channelId,
          ts,
          text: "_Session ended_",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "_Session ended_" } }],
        });
      } catch (err) {
        this.log.warn({ err, sessionId }, "Failed to cleanup skill commands card");
      }
    }

    this._skillCommandsTs.delete(sessionId);
  }
```

- [ ] **Step 5: Implement `flushPendingSkillCommands()`**

Add after `cleanupSkillCommands()`:

```typescript
  /**
   * Flush any skill commands that were queued before the session channel was ready.
   * Called after createSessionThread() makes the channel available.
   */
  async flushPendingSkillCommands(sessionId: string): Promise<void> {
    const commands = this._pendingSkillCommands.get(sessionId);
    if (!commands) return;
    this._pendingSkillCommands.delete(sessionId);
    await this.sendSkillCommands(sessionId, commands);
  }
```

- [ ] **Step 6: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/adapter.ts
git commit -m "feat(slack): implement sendSkillCommands, cleanupSkillCommands, flushPendingSkillCommands"
```

---

## Task 6: Implement `cleanupSessionState()`

**Files:**
- Modify: `src/adapter.ts`

Called by `SessionBridge` when switching agents. Without this, the old agent's activity tracker stays alive with stale state, holding timer references and potentially posting stale updates.

- [ ] **Step 1: Implement `cleanupSessionState()`**

Add after `flushPendingSkillCommands()`:

```typescript
  /**
   * Clean up all adapter-side state for a session.
   *
   * Called when switching agents so the new agent starts from a clean slate.
   * Destroys the activity tracker, flushes and destroys the text buffer, and
   * clears pending skill commands.
   */
  async cleanupSessionState(sessionId: string): Promise<void> {
    this._pendingSkillCommands.delete(sessionId);

    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }

    await this.flushTextBuffer(sessionId);
  }
```

- [ ] **Step 2: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/adapter.ts
git commit -m "feat(slack): implement cleanupSessionState"
```

---

## Task 7: Pass `sessionContext` + `tunnelService` to ActivityTracker

**Files:**
- Modify: `src/adapter.ts` — `getOrCreateTracker()`

Without these, `DisplaySpecBuilder.buildToolSpec()` cannot generate viewer links even when a tunnel is active. The `SlackActivityTrackerConfig` already accepts them — they just aren't passed.

- [ ] **Step 1: Update `getOrCreateTracker()` to extract and pass both fields**

Replace the current `getOrCreateTracker()` (lines 604–619):

```typescript
  // Before:
  private getOrCreateTracker(sessionId: string, channelId: string): SlackActivityTracker {
    let tracker = this.sessionTrackers.get(sessionId);
    const mode = this.resolveOutputMode(sessionId);
    if (!tracker) {
      tracker = new SlackActivityTracker({
        channelId,
        sessionId,
        queue: this.queue,
        outputMode: mode,
      });
      this.sessionTrackers.set(sessionId, tracker);
    } else {
      tracker.setOutputMode(mode);
    }
    return tracker;
  }
```

With:

```typescript
  private getOrCreateTracker(sessionId: string, channelId: string): SlackActivityTracker {
    let tracker = this.sessionTrackers.get(sessionId);
    const mode = this.resolveOutputMode(sessionId);
    if (!tracker) {
      const tunnelService = this.core.lifecycleManager?.serviceRegistry?.get("tunnel") as TunnelServiceInterface | undefined;
      const session = this.core.sessionManager.getSession(sessionId);
      const sessionContext = session?.workingDirectory
        ? { id: sessionId, workingDirectory: session.workingDirectory }
        : undefined;
      tracker = new SlackActivityTracker({
        channelId,
        sessionId,
        queue: this.queue,
        outputMode: mode,
        tunnelService,
        sessionContext,
      });
      this.sessionTrackers.set(sessionId, tracker);
    } else {
      tracker.setOutputMode(mode);
    }
    return tracker;
  }
```

- [ ] **Step 2: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/adapter.ts
git commit -m "feat(slack): pass sessionContext and tunnelService to SlackActivityTracker"
```

---

## Task 8: Fix `handleError` (Destroy Tracker) + Fix `handleUsage` (Completion Notification)

**Files:**
- Modify: `src/adapter.ts`

**Bug**: `handleError` leaves the activity tracker running after error, holding open timer refs.
**Feature**: `handleUsage` should post an inline completion notification with channel link to `notificationChannelId`, matching Telegram/Discord behavior.

- [ ] **Step 1: Fix `handleError` to destroy the tracker**

Replace the current `handleError()` (lines 680–698):

```typescript
  // Before:
  protected async handleError(sessionId: string, content: OutgoingMessage): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    // Flush any pending text first
    await this.flushTextBuffer(sessionId);

    const blocks = this.formatter.formatOutgoing(content);
    if (blocks.length === 0) return;

    try {
      await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        text: content.text ?? content.type,
        blocks,
      });
    } catch (err) {
      this.log.error({ err, sessionId, type: content.type }, "Failed to post Slack message");
    }
  }
```

With:

```typescript
  protected async handleError(sessionId: string, content: OutgoingMessage): Promise<void> {
    // Destroy tracker on error — stops timer refs and prevents stale state
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }

    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    await this.flushTextBuffer(sessionId);

    const blocks = this.formatter.formatOutgoing(content);
    if (blocks.length === 0) return;

    try {
      await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        text: content.text ?? content.type,
        blocks,
      });
    } catch (err) {
      this.log.error({ err, sessionId, type: content.type }, "Failed to post Slack message");
    }
  }
```

- [ ] **Step 2: Fix `handleUsage` to post completion notification**

Replace the current `handleUsage()` (lines 768–778):

```typescript
  // Before:
  protected async handleUsage(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
    const m = content.metadata as any;
    await tracker.onUsage({
      tokensUsed: m?.tokensUsed ?? m?.tokens,
      contextSize: m?.contextSize,
      cost: m?.cost,
    });
  }
```

With:

```typescript
  protected async handleUsage(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
    const m = content.metadata as any;
    await tracker.onUsage({
      tokensUsed: m?.tokensUsed ?? m?.tokens,
      contextSize: m?.contextSize,
      cost: m?.cost,
    });

    // Post inline completion notification with direct channel link
    if (this.slackConfig.notificationChannelId) {
      const sess = this.core.sessionManager.getSession(sessionId);
      const name = sess?.name ?? "Session";
      await this.queue.enqueue("chat.postMessage", {
        channel: this.slackConfig.notificationChannelId,
        text: `✅ *${name}* — Task completed. <#${meta.channelId}>`,
      }).catch((err) => this.log.warn({ err, sessionId }, "Failed to post completion notification"));
    }
  }
```

- [ ] **Step 3: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/adapter.ts
git commit -m "fix(slack): destroy tracker on error, add completion notification in handleUsage"
```

---

## Task 9: Fix Session Map Cleanup (Memory Leak)

**Files:**
- Modify: `src/adapter.ts` — `deleteSessionThread()`, `cleanupSessionState()`, `handleError()`

**Bug**: `_dispatchQueues`, `_skillCommandsTs`, and `_pendingSkillCommands` are never cleaned up when a session ends. Confirmed present in Telegram too but Slack must not repeat the same bug.

- `_dispatchQueues` entries hold Promise chain references — they grow indefinitely as sessions are created and destroyed
- `_skillCommandsTs` / `_pendingSkillCommands` hold per-session state that should be wiped when the channel is torn down

- [ ] **Step 1: Clean all session Maps in `deleteSessionThread()`**

`deleteSessionThread` is the definitive teardown point for a session — the channel is gone. All per-session Map entries should be cleaned here.

Find `deleteSessionThread()` (around line 484) and add cleanup at the end of the method (after `this.textBuffers.delete(sessionId)`):

```typescript
  async deleteSessionThread(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;

    try {
      await this.permissionHandler.cleanupSession(meta.channelId);
    } catch (err) {
      this.log.warn({ err, sessionId }, "Failed to clean up permission buttons");
    }

    try {
      await this.channelManager.archiveChannel(meta.channelId);
      this.log.info({ sessionId, channelId: meta.channelId }, "Session channel archived");
    } catch (err) {
      this.log.warn({ err, sessionId }, "Failed to archive Slack channel");
    }

    this.sessions.delete(sessionId);
    const buf = this.textBuffers.get(sessionId);
    if (buf) { buf.destroy(); this.textBuffers.delete(sessionId); }

    // Clean all per-session Maps to prevent unbounded memory growth
    this._dispatchQueues.delete(sessionId);
    this._skillCommandsTs.delete(sessionId);
    this._pendingSkillCommands.delete(sessionId);
  }
```

- [ ] **Step 2: Also clean `_dispatchQueues` in `cleanupSessionState()`**

Task 6 added `cleanupSessionState()`. Update it to also delete the dispatch queue entry for this session:

```typescript
  async cleanupSessionState(sessionId: string): Promise<void> {
    this._pendingSkillCommands.delete(sessionId);
    this._dispatchQueues.delete(sessionId);   // ← add this

    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }

    await this.flushTextBuffer(sessionId);
  }
```

- [ ] **Step 3: Also clean `_dispatchQueues` in `handleError()`**

Task 8 fixed `handleError()`. Add queue cleanup there too, so error paths don't leak:

```typescript
  protected async handleError(sessionId: string, content: OutgoingMessage): Promise<void> {
    // Destroy tracker on error — stops timer refs and prevents stale state
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }
    // Drop the dispatch queue entry — no more events expected after an error
    this._dispatchQueues.delete(sessionId);

    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    await this.flushTextBuffer(sessionId);

    const blocks = this.formatter.formatOutgoing(content);
    if (blocks.length === 0) return;

    try {
      await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        text: content.text ?? content.type,
        blocks,
      });
    } catch (err) {
      this.log.error({ err, sessionId, type: content.type }, "Failed to post Slack message");
    }
  }
```

- [ ] **Step 4: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/adapter.ts
git commit -m "fix(slack): clean _dispatchQueues and skill command Maps on session teardown"
```

---

## Final Verification

- [ ] **Step 1: Full build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: zero TypeScript errors.

- [ ] **Step 2: Verify all 12 gaps are addressed**

| # | Gap | Fixed in Task |
|---|-----|---------------|
| 1 | `handleText` calls `finalize()` prematurely | Task 3 |
| 2 | No per-session dispatch queue | Task 3 |
| 3 | `onTextStart()` missing from tracker | Task 2 |
| 4 | `stripTTSBlock()` not implemented | Task 4 |
| 5 | `sendSkillCommands()` not implemented | Task 5 |
| 6 | `cleanupSkillCommands()` not implemented | Task 5 |
| 7 | `cleanupSessionState()` not implemented | Task 6 |
| 8 | `flushPendingSkillCommands()` not implemented | Task 5 |
| 9 | `sessionContext` + `tunnelService` not passed | Task 7 |
| 10 | `handleUsage` missing completion notification | Task 8 |
| 11 | `handleError` doesn't destroy tracker | Task 8 |
| 12 | `CoreKernel` interface missing typed members | Task 1 |
| 13 | `_dispatchQueues` + skill Map entries never cleaned up (memory leak) | Task 9 |
| 14 | `channelId` not persisted → `this.sessions` empty after restart → all responses dropped | Task 10 |

---

## Task 10: Persist `channelId` + Self-Heal on Restart (Critical Bug #3)

**Files:**
- Modify: `src/adapter.ts` — `createSessionThread()`, `sendMessage()`

**Root cause:** After a process restart, `this.sessions` Map is cleared. Lazy resume re-creates the Session and re-connects the bridge — but it does NOT call `createSessionThread()` (that flag is only set for new sessions, not resumed ones). Result: `this.sessions.has(sessionId)` is always false → every `sendMessage` call hits the early-exit guard → **all responses are silently dropped**.

Telegram avoids this by reading `session.threadId` directly (a simple string), without any in-memory Map. Slack needs the Slack-specific `channelId` (`C01234...` format) which is only known at channel-creation time and currently never persisted.

**Fix:**
1. In `createSessionThread`, persist `channelId` into the session record (`platform.channelId`)
2. In `sendMessage`, if the session isn't in `this.sessions`, try to restore it from the record — self-healing

- [ ] **Step 1: Persist `channelId` in `createSessionThread()`**

Replace the current `createSessionThread()` (lines 450–456):

```typescript
  // Before:
  async createSessionThread(sessionId: string, name: string): Promise<string> {
    const meta = await this.channelManager.createChannel(sessionId, name);
    this.sessions.set(sessionId, meta);
    this.log.info({ sessionId, channelId: meta.channelId, slug: meta.channelSlug }, "Session channel created");
    return meta.channelSlug;
  }
```

With:

```typescript
  async createSessionThread(sessionId: string, name: string): Promise<string> {
    const meta = await this.channelManager.createChannel(sessionId, name);
    this.sessions.set(sessionId, meta);
    this.log.info({ sessionId, channelId: meta.channelId, slug: meta.channelSlug }, "Session channel created");
    // Persist Slack-specific channelId (C01234...) so it can be recovered after restart.
    // Core will also patchRecord with platform.threadId after this returns; it merges,
    // so the final record will have both channelId and threadId.
    await this.core.sessionManager.patchRecord(sessionId, {
      platform: { channelId: meta.channelId },
    });
    return meta.channelSlug;
  }
```

- [ ] **Step 2: Add `tryRestoreSessionFromRecord()` private helper**

Add this private method before `sendMessage()`:

```typescript
  /**
   * Attempt to restore a session's Slack channel metadata from the persisted session record.
   *
   * Called when a session is not in the in-memory `this.sessions` Map, which happens
   * after a process restart when lazy resume re-creates the session without calling
   * createSessionThread(). Without this, all agent responses are silently dropped.
   */
  private async tryRestoreSessionFromRecord(sessionId: string): Promise<void> {
    const record = this.core.sessionManager.getSessionRecord(sessionId) as any;
    const channelId = record?.platform?.channelId as string | undefined;
    // Startup reuse sessions use topicId; normal sessions use threadId
    const channelSlug = (record?.platform?.threadId ?? record?.platform?.topicId) as string | undefined;
    if (!channelId || !channelSlug) return;

    try {
      const info = await this.queue.enqueue<{ channel: { is_archived: boolean } }>(
        "conversations.info",
        { channel: channelId },
      );
      if (info?.channel?.is_archived) {
        await this.queue.enqueue("conversations.unarchive", { channel: channelId });
      }
      this.sessions.set(sessionId, { channelId, channelSlug });
      this.log.info({ sessionId, channelId, channelSlug }, "Restored session channel from record after restart");
    } catch (err) {
      this.log.warn({ err, sessionId, channelId }, "Failed to restore session channel — channel may be deleted");
    }
  }
```

- [ ] **Step 3: Call `tryRestoreSessionFromRecord()` in `sendMessage()` before the guard**

Replace the current `sendMessage()` (already updated by Task 3 to add dispatch queue):

```typescript
  async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      // On restart, this.sessions is cleared. Lazy resume does not call
      // createSessionThread(), so we self-heal by restoring from the persisted record.
      await this.tryRestoreSessionFromRecord(sessionId);

      if (!this.sessions.has(sessionId)) {
        this.log.warn({ sessionId }, "No Slack channel for session, skipping message");
        return;
      }
    }
    // Serialize per session — SessionBridge fires sendMessage() fire-and-forget so
    // concurrent events (tool_call, tool_update, text) can race without this queue.
    const prev = this._dispatchQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => super.sendMessage(sessionId, content))
      .catch((err) => { this.log.warn({ err, sessionId }, "Dispatch queue error"); });
    this._dispatchQueues.set(sessionId, next);
    await next;
  }
```

- [ ] **Step 4: Fix `_createStartupSession` reuse path to also persist `channelId`**

The startup session "reuse" path bypasses `createSessionThread` (it calls `handleNewSession` with `createThread: false`), so our Step 1 fix doesn't cover it. Fix the `patchRecord` call at line 383:

```typescript
      if (!hasSession) {
        const session = await this.core.handleNewSession("slack", undefined, undefined, { createThread: false });
        const slug = `startup-${session.id.slice(0, 8)}`;
        this.sessions.set(session.id, { channelId: reuseChannelId, channelSlug: slug });
        session.threadId = slug;
        // Persist both channelId and slug so the channel can be restored after restart.
        // topicId is used here (vs threadId) for backward compat with existing records.
        await this.core.sessionManager.patchRecord(session.id, {
          platform: { topicId: slug, channelId: reuseChannelId },
        });
        this.log.info({ sessionId: session.id, channelId: reuseChannelId }, "Reused startup channel");
      }
```

- [ ] **Step 5: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/adapter.ts
git commit -m "fix(slack): persist channelId and self-heal sessions after restart"
```

---

## Out of Scope (Verified)

These were reviewed and confirmed as intentionally not needed for Slack:

| Handler | Why out of scope |
|---------|-----------------|
| `handleConfigUpdate` | Telegram uses this to update a pinned "control message". Slack has no equivalent UI element — base class no-op is correct. |
| `handleModeChange` | Same as above — no UI to update. No adapter besides Telegram implements this. |
| `handleModelUpdate` | Same as above. No adapter implements this. |
| `archiveSessionTopic` | Slack's `deleteSessionThread` already archives the channel. The archive/resume scenario via `archiveSessionTopic` is Telegram-specific. |
| Multi-adapter `platforms` key | Core writes `platforms["slack"].threadId` automatically (core.ts:540-547). No adapter code needed. |
| Permission request bypass `_dispatchQueues` | By design — same as Telegram. Permissions use global `sendQueue` rate-limit, not per-session chains. |
| `outputMode` on `config_option_update` | Slack's outputMode is a Slack-specific UX setting controlled by `/outputmode`. Agent-side config changes don't map to it. |
