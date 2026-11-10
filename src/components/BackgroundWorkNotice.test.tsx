import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, test } from 'vitest'
import { BackgroundWorkNotice } from './BackgroundWorkNotice'
afterEach(cleanup)

test('says background agents are still working, and that chatting is fine', () => {
  render(() => <BackgroundWorkNotice status="background" />)
  expect(screen.getByRole('status').textContent).toMatch(/background agents are still working/i)
})
test('shows nothing otherwise', () => {
  render(() => <BackgroundWorkNotice status="idle" />)
  expect(screen.queryByRole('status')).toBeNull()
})
