import { Mark, getMarkRange } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

/**
 * A word the AI guessed when converting handwriting (its clean-up pass
 * changed it from what the reader saw): shown with a dotted underline so you
 * can check it. Tap it to accept it as right; editing it teaches the AI the
 * correction (see the server's vocabulary.ts).
 */
export const Uncertain = Mark.create({
  name: 'uncertain',
  inclusive: false,
  parseHTML() {
    return [{ tag: 'span[data-uncertain]' }]
  },
  renderHTML() {
    return ['span', { 'data-uncertain': '', class: 'uncertain-word', title: 'The AI wasn’t sure about this word – tap to mark it as right' }, 0]
  },
  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        props: {
          handleClick: (view, pos, event) => {
            if (!(event.target as HTMLElement).closest?.('.uncertain-word')) return false
            const range = getMarkRange(view.state.doc.resolve(pos), type)
            if (!range) return false
            view.dispatch(view.state.tr.removeMark(range.from, range.to, type))
            return false
          },
        },
      }),
    ]
  },
})
