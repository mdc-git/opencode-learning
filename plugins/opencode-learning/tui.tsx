import { Plugin } from '@opencode-ai/plugin/tui'

export default Plugin.define({
  id: 'github.learning_skills_tui',
  setup(context) {
    return context.data.on('session.synthetic', (event) => {
      if (
        event.data.metadata?.source !== 'opencode-learning' ||
        event.data.metadata.type !== 'proposal-staged'
      ) {
        return
      }

      context.ui.toast.show({
        title: 'Learning proposal',
        message: event.data.text,
        variant: 'success',
        duration: 6000
      })
    })
  }
})
