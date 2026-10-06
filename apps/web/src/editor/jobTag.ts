import { Extension } from '@tiptap/core'

/**
 * Blocks written by an AI job carry the job's id (the `job` attribute), so
 * the Jobs list can remove or redo that result later. It isn't shown, and it
 * doesn't spread when a block is split or copied.
 */
export const JobTag = Extension.create({
  name: 'jobTag',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'horizontalRule'],
        attributes: {
          job: { default: null, rendered: false, keepOnSplit: false },
        },
      },
    ]
  },
})
