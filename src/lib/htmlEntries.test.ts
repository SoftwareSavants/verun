import { describe, expect, test } from 'vitest'
import indexHtml from '../../index.html?raw'
import uilabHtml from '../../uilab.html?raw'

// macOS inline predictive text opens an NSCorrectionPanel that runs a nested
// event loop on the app's main thread: clicks and keys (Send, Enter) are held
// until it closes. `writingsuggestions` inherits, so the root turns it off for
// every input in the window.
describe.each([['index.html', indexHtml], ['uilab.html', uilabHtml]])('%s', (_file, html) => {
  test('turns off inline writing suggestions for the whole page', () => {
    expect(html).toMatch(/<html[^>]*\swritingsuggestions="false"/)
  })
})
