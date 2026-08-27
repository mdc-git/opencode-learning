import { Plugin } from '@opencode-ai/plugin'
import { loadConfig } from './config.ts'
import { LearningSetup } from './setup.ts'
import type { OpenCodeContext } from './types.ts'

export { normalizeTelemetryState } from './telemetry.ts'

export default Plugin.define({
  id: 'learning.skills',
  async setup(ctx: OpenCodeContext): Promise<(() => Promise<void>) | undefined> {
    const config = loadConfig(ctx.options as unknown)
    if (!config.enabled) {
      return
    }

    return new LearningSetup(ctx, config).setup()
  }
})
