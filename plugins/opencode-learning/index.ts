import { Plugin } from '@opencode-ai/plugin'
import { loadConfig } from './config.ts'
import type { OpenCodeContext } from './sdk.ts'
import { LearningSetup } from './setup.ts'

export { normalizeTelemetryState } from './telemetry-state.ts'

export default Plugin.define({
  id: 'github.learning_skills',
  async setup(ctx: OpenCodeContext): Promise<(() => Promise<void>) | undefined> {
    const config = loadConfig(ctx.options)
    if (!config.enabled) {
      return
    }

    return new LearningSetup(ctx, config).setup()
  }
})
