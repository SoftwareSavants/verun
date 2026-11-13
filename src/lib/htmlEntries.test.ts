import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

// macOS inline predictive text opens an NSCorrectionPanel that runs a nested
// event loop on the app's main thread: clicks and keys (Send, Enter) are held
// until it closes. `writingsuggestions` inherits, so the root turns it off for
// every input in the window.
describe.each(['index.html', 'uilab.html'])('%s', file => {
  test('turns off inline writing suggestions for the whole page', () => {
    const html = readFileSync(resolve(__dirname, '../..', file), 'utf8')
    expect(html).toMatch(/<html[^>]*\swritingsuggestions="false"/)
  })
})
