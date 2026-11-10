import { test, expect, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
import { openUrl } from '@tauri-apps/plugin-opener'
import { openWebLink } from './terminalWebLinks'

test('a URL in a terminal opens in the browser on Cmd/Ctrl-click only', () => {
  openWebLink(new MouseEvent('click'), 'https://example.com')
  expect(openUrl).not.toHaveBeenCalled()
  openWebLink(new MouseEvent('click', { metaKey: true, ctrlKey: true }), 'https://example.com')
  expect(openUrl).toHaveBeenCalledWith('https://example.com')
})
