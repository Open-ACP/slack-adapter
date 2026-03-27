// src/setup.ts
import fs from "node:fs";
import * as path from "node:path";
import os from "node:os";
import * as clack from "@clack/prompts";
import { guardCancel, ok, fail, warn, dim, c } from "@openacp/cli";

// --- Manifest ---

export interface SlackManifest {
  version: number;
  manifest: {
    display_information: { name: string };
    features: {
      app_home: { messages_tab_enabled: boolean; messages_tab_read_only_enabled: boolean };
      bot_user: { display_name: string; always_online: boolean };
      slash_commands: Array<{ command: string; description: string; should_escape: boolean }>;
    };
    oauth_config: { scopes: { bot: string[] } };
    settings: {
      event_subscriptions: { bot_events: string[] };
      interactivity: { is_enabled: boolean };
      socket_mode_enabled: boolean;
      token_rotation_enabled: boolean;
    };
  };
}

export function generateSlackManifest(): SlackManifest {
  return {
    version: 2,
    manifest: {
      display_information: { name: "OpenACP" },
      features: {
        app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: "OpenACP", always_online: true },
        slash_commands: [
          {
            command: "/openacp-archive",
            description: "Archive current session channel and start fresh",
            should_escape: false,
          },
        ],
      },
      oauth_config: {
        scopes: {
          bot: [
            "channels:manage", "channels:history", "channels:join", "channels:read",
            "chat:write", "chat:write.public",
            "commands",
            "groups:write", "groups:history", "groups:read",
            "files:read", "files:write",
            "im:history",
          ],
        },
      },
      settings: {
        event_subscriptions: { bot_events: ["message.channels", "message.groups", "message.im"] },
        interactivity: { is_enabled: true },
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    },
  };
}

export async function validateSlackBotToken(
  token: string,
): Promise<{ ok: true; botUsername: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const data = (await res.json()) as { ok: boolean; user?: string; error?: string };
    if (data.ok && data.user) return { ok: true, botUsername: data.user };
    return { ok: false, error: data.error || "Invalid token" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// --- Manifest version tracking ---

const OPENACP_DIR = path.join(os.homedir(), ".openacp");
const SLACK_MANIFEST_VERSION_FILE = path.join(OPENACP_DIR, "slack-manifest-version");

function writeSlackManifestVersion(version: number): void {
  fs.mkdirSync(path.dirname(SLACK_MANIFEST_VERSION_FILE), { recursive: true });
  fs.writeFileSync(SLACK_MANIFEST_VERSION_FILE, String(version), "utf8");
}

// --- Setup wizard ---

export async function setupSlack(existing?: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Guard: already configured
  if (existing?.botToken) {
    const rerun = guardCancel(
      await clack.confirm({
        message: "Slack is already configured. Re-run setup? This will overwrite existing credentials.",
        initialValue: false,
      }),
    );
    if (!rerun) {
      clack.cancel("Keeping existing Slack config.");
      process.exit(0);
    }
  }

  // Step 1: App Manifest
  const { manifest } = generateSlackManifest();
  const manifestJson = JSON.stringify(manifest, null, 2);

  console.log("");
  console.log(`  ${c.bold}Step 1: Create your Slack app${c.reset}`);
  console.log("");
  console.log(dim("  1. Open https://api.slack.com/apps"));
  console.log(dim("  2. Click 'Create New App' → 'From a manifest'"));
  console.log(dim("  3. Select your workspace"));
  console.log(dim("  4. Paste this manifest:"));
  console.log("");
  console.log(`  ┌${"─".repeat(60)}┐`);
  manifestJson.split("\n").forEach((line) => {
    console.log(`  │ ${line.padEnd(58)} │`);
  });
  console.log(`  └${"─".repeat(60)}┘`);
  console.log("");
  console.log(dim("  5. Click Next → Create → Install to Workspace → Allow"));
  console.log(dim("  6. After install:"));
  console.log(dim("     • Bot Token:      OAuth & Permissions → Bot User OAuth Token"));
  console.log(dim("     • App Token:      Basic Information → App-Level Tokens → Generate Token"));
  console.log(dim("                       (name it anything, select 'connections:write' scope)"));
  console.log(dim("     • Signing Secret: Basic Information → App Credentials → Signing Secret"));
  console.log("");

  guardCancel(await clack.text({ message: "Press Enter when done..." }));

  // Step 2: Credentials
  let botToken = "";
  while (true) {
    botToken = (guardCancel(
      await clack.text({
        message: "Bot Token (xoxb-...):",
        validate: (val) => (val ?? "").toString().trim().length > 0 ? undefined : "Bot Token cannot be empty",
      }),
    ) as string).trim();

    const spinner = clack.spinner();
    spinner.start("Validating Bot Token...");
    const result = await validateSlackBotToken(botToken);
    spinner.stop(result.ok ? ok(`Authenticated as @${result.botUsername}`) : fail(result.error));

    if (result.ok) break;

    const action = guardCancel(
      await clack.select({
        message: "What to do?",
        options: [
          { label: "Re-enter token", value: "retry" },
          { label: "Use as-is (skip validation)", value: "skip" },
        ],
      }),
    );
    if (action === "skip") break;
  }

  const appToken = (guardCancel(
    await clack.text({
      message: "App Token (xapp-1-...):",
      validate: (val) => {
        const v = (val ?? "").toString().trim();
        if (!v) return "App Token cannot be empty";
        if (!v.startsWith("xapp-1-")) return "App Token must start with xapp-1-";
        return undefined;
      },
    }),
  ) as string).trim();

  const signingSecret = (guardCancel(
    await clack.text({
      message: "Signing Secret:",
      validate: (val) => (val ?? "").toString().trim().length > 0 ? undefined : "Signing Secret cannot be empty",
    }),
  ) as string).trim();

  console.log(warn("App Token and Signing Secret cannot be validated until the adapter starts."));

  // Step 3: Optional config
  const allowedRaw = (guardCancel(
    await clack.text({
      message: "Allowed Slack User IDs (comma-separated, or Enter to allow all):",
      placeholder: "U0123456789, U9876543210",
    }),
  ) as string).trim();
  const allowedUserIds = allowedRaw
    ? allowedRaw.split(",").map((uid) => uid.trim()).filter(Boolean)
    : [];

  const channelPrefix = (guardCancel(
    await clack.text({
      message: "Channel prefix:",
      initialValue: "openacp",
    }),
  ) as string).trim() || "openacp";

  // Step 4: Auto-create notification channel
  let notificationChannelId: string | undefined;

  const s4 = clack.spinner();
  s4.start("Creating #openacp-notifications channel...");

  try {
    const { WebClient } = await import("@slack/web-api");
    const web = new WebClient(botToken);

    try {
      const createRes = await web.conversations.create({
        name: "openacp-notifications",
        is_private: true,
      });
      notificationChannelId = (createRes.channel as { id?: string })?.id;
      s4.stop(ok(`Created #openacp-notifications (${notificationChannelId})`));
      console.log(dim("  ➜ Join the channel: open Slack → search for #openacp-notifications → Join"));
    } catch (createErr: unknown) {
      const errCode = (createErr as { data?: { error?: string } })?.data?.error;
      if (errCode === "name_taken") {
        s4.message("Channel name taken — looking up existing channel...");
        let cursor = "";
        let found = false;
        while (true) {
          const listRes = await web.conversations.list({
            types: "private_channel",
            cursor,
            limit: 200,
          });
          const channels = (listRes.channels ?? []) as Array<{ id?: string; name?: string }>;
          const match = channels.find((ch) => ch.name === "openacp-notifications");
          if (match?.id) {
            notificationChannelId = match.id;
            s4.stop(ok(`Using existing #openacp-notifications (${notificationChannelId})`));
            found = true;
            break;
          }
          cursor = (listRes.response_metadata as { next_cursor?: string })?.next_cursor ?? "";
          if (!cursor) break;
        }
        if (!found) {
          s4.stop(warn("Could not find #openacp-notifications"));
          console.log(dim("  Set notificationChannelId manually in config after joining the channel"));
        }
      } else {
        s4.stop(warn("Could not create notification channel — skipping"));
        console.log(dim("  Set notificationChannelId manually in config after joining the channel"));
      }
    }
  } catch {
    s4.stop(warn("Skipped notification channel creation"));
  }

  writeSlackManifestVersion(generateSlackManifest().version);

  console.log("");
  console.log(ok("Slack adapter configured"));
  console.log(dim("  Note: autoCreateSession is enabled by default."));
  console.log(dim("  To disable: openacp config set channels.slack.autoCreateSession false"));

  return {
    botToken,
    appToken,
    signingSecret,
    allowedUserIds,
    channelPrefix,
    autoCreateSession: true,
    ...(notificationChannelId ? { notificationChannelId } : {}),
  };
}
