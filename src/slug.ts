// src/slug.ts
import { customAlphabet } from "nanoid";

const nanoidAlpha = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 4);

/**
 * Convert a human-readable session name to a valid Slack channel name.
 * Rules: lowercase, ≤80 chars, only [a-z0-9-], unique suffix appended.
 */
export function toSlug(name: string, prefix = "openacp"): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);

  const suffix = nanoidAlpha();
  return `${prefix}-${base}-${suffix}`.replace(/-+/g, "-");
}
