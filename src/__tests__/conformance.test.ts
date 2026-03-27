// conformance.test.ts
// SKIPPED: runAdapterConformanceTests is not exported by @openacp/plugin-sdk.
// Follow-up: add conformance test support to plugin-sdk, then re-enable this test.
//
// Original imports:
//   import { runAdapterConformanceTests } from '../../../core/adapter-primitives/__tests__/adapter-conformance.js'
//   import { MessagingAdapter } from '../../../core/adapter-primitives/messaging-adapter.js'
//   import { BaseRenderer } from '../../../core/adapter-primitives/rendering/renderer.js'
//   import type { AdapterCapabilities } from '../../../core/channel.js'

import { describe, it } from "vitest";

describe("SlackAdapter conformance", () => {
  it.skip("conformance tests pending plugin-sdk export of runAdapterConformanceTests", () => {
    // no-op
  });
});
