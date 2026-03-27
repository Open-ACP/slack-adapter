import { describe, it, expect, vi, afterEach } from "vitest";
import { generateSlackManifest, validateSlackBotToken } from "../setup.js";

describe("generateSlackManifest", () => {
  it("returns manifest with required bot scopes", () => {
    const manifest = generateSlackManifest();
    expect(manifest.version).toBe(2);
    const scopes = manifest.manifest.oauth_config.scopes.bot;
    const required = [
      "channels:manage", "channels:history", "channels:join", "channels:read",
      "chat:write", "chat:write.public",
      "groups:write", "groups:history", "groups:read",
      "files:read", "files:write",
    ];
    for (const s of required) expect(scopes).toContain(s);
  });

  it("includes /openacp-archive slash command", () => {
    const manifest = generateSlackManifest();
    const cmds = manifest.manifest.features.slash_commands;
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("/openacp-archive");
  });

  it("has socket_mode_enabled true", () => {
    const manifest = generateSlackManifest();
    expect(manifest.manifest.settings.socket_mode_enabled).toBe(true);
  });

  it("has interactivity enabled", () => {
    const manifest = generateSlackManifest();
    expect(manifest.manifest.settings.interactivity.is_enabled).toBe(true);
  });

  it("subscribes to message.channels, message.groups, and message.im events", () => {
    const manifest = generateSlackManifest();
    const events = manifest.manifest.settings.event_subscriptions.bot_events;
    expect(events).toContain("message.channels");
    expect(events).toContain("message.groups");
    expect(events).toContain("message.im");
  });
});

describe("validateSlackBotToken", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns ok with username on valid token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, user: "openacp-bot", user_id: "U123" }),
    }));
    const result = await validateSlackBotToken("xoxb-valid");
    expect(result).toEqual({ ok: true, botUsername: "openacp-bot" });
  });

  it("returns error when Slack responds ok: false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: "invalid_auth" }),
    }));
    const result = await validateSlackBotToken("xoxb-bad");
    expect(result).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("returns error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await validateSlackBotToken("xoxb-any");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Network error");
  });
});
