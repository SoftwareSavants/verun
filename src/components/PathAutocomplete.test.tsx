import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'

const listSubdirsMock = vi.fn<(p: string) => Promise<string[]>>()
const createSubdirMock = vi.fn<(parent: string, name: string) => Promise<string>>()
vi.mock('../lib/ipc', () => ({
  listSubdirs: (p: string) => listSubdirsMock(p),
  createSubdir: (parent: string, name: string) => createSubdirMock(parent, name),
}))

import { PathAutocomplete } from './PathAutocomplete'

describe('PathAutocomplete', () => {
  beforeEach(() => {
    cleanup()
    listSubdirsMock.mockReset()
    createSubdirMock.mockReset()
  })

  it('does not show dropdown before the input is focused', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop', 'Documents', 'Downloads'])
    const { queryByText } = render(() => (
      <PathAutocomplete value="~/" onChange={() => {}} />
    ))
    await waitFor(() => expect(listSubdirsMock).toHaveBeenCalled())
    expect(queryByText('Desktop')).toBeNull()
  })

  it('lists visible subdirs after focus', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop', 'Documents', 'Downloads'])
    const [v, setV] = createSignal('~/')
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value={v()} onChange={setV} />
    ))
    fireEvent.focus(getByRole('textbox'))
    expect(await findByText('Desktop')).toBeTruthy()
    expect(await findByText('Documents')).toBeTruthy()
    expect(await findByText('Downloads')).toBeTruthy()
  })

  it('filters suggestions by last path segment prefix', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop', 'Documents', 'Downloads'])
    const [v, setV] = createSignal('~/Doc')
    const { findByText, queryByText, getByRole } = render(() => (
      <PathAutocomplete value={v()} onChange={setV} />
    ))
    fireEvent.focus(getByRole('textbox'))
    expect(await findByText('Documents')).toBeTruthy()
    await waitFor(() => expect(queryByText('Desktop')).toBeNull())
  })

  it('Tab completes to the highlighted suggestion', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop', 'Documents'])
    const onChange = vi.fn()
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value="~/Desk" onChange={onChange} />
    ))
    const input = getByRole('textbox') as HTMLInputElement
    fireEvent.focus(input)
    await findByText('Desktop')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(onChange).toHaveBeenCalledWith('~/Desktop/')
  })

  it('Enter completes to the highlighted suggestion', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop'])
    const onChange = vi.fn()
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value="~/" onChange={onChange} />
    ))
    const input = getByRole('textbox') as HTMLInputElement
    fireEvent.focus(input)
    await findByText('Desktop')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('~/Desktop/')
  })

  it('ArrowDown moves highlight; Enter uses new highlight', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop', 'Documents', 'Downloads'])
    const onChange = vi.fn()
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value="~/" onChange={onChange} />
    ))
    const input = getByRole('textbox') as HTMLInputElement
    fireEvent.focus(input)
    await findByText('Downloads')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('~/Documents/')
  })

  it('Escape closes the suggestions dropdown', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop'])
    const { findByText, queryByText, getByRole } = render(() => (
      <PathAutocomplete value="~/" onChange={() => {}} />
    ))
    const input = getByRole('textbox') as HTMLInputElement
    fireEvent.focus(input)
    await findByText('Desktop')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(queryByText('Desktop')).toBeNull())
  })

  it('shows a Create row when no entry matches the typed prefix', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop', 'Documents'])
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value="~/myproj" onChange={() => {}} />
    ))
    fireEvent.focus(getByRole('textbox'))
    expect(await findByText(/Create.*myproj/)).toBeTruthy()
  })

  it('does not show Create row when prefix exactly matches existing dir', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop'])
    const { findByText, queryByText, getByRole } = render(() => (
      <PathAutocomplete value="~/Desktop" onChange={() => {}} />
    ))
    fireEvent.focus(getByRole('textbox'))
    await findByText('Desktop')
    expect(queryByText(/Create.*Desktop/)).toBeNull()
  })

  it('does not show Create row when prefix is empty', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop'])
    const { findByText, queryByText, getByRole } = render(() => (
      <PathAutocomplete value="~/" onChange={() => {}} />
    ))
    fireEvent.focus(getByRole('textbox'))
    await findByText('Desktop')
    expect(queryByText(/^Create /)).toBeNull()
  })

  it('Tab applies the Create row when it is the only suggestion', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop'])
    createSubdirMock.mockResolvedValue('/Users/me/myproj')
    const onChange = vi.fn()
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value="~/myproj" onChange={onChange} />
    ))
    const input = getByRole('textbox') as HTMLInputElement
    fireEvent.focus(input)
    await findByText(/Create.*myproj/)
    fireEvent.keyDown(input, { key: 'Tab' })
    await waitFor(() => expect(createSubdirMock).toHaveBeenCalledWith('~', 'myproj'))
  })

  it('Enter applies the Create row when arrowed onto it', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop', 'Documents'])
    createSubdirMock.mockResolvedValue('/Users/me/desk')
    const onChange = vi.fn()
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value="~/desk" onChange={onChange} />
    ))
    const input = getByRole('textbox') as HTMLInputElement
    fireEvent.focus(input)
    await findByText('Desktop')
    await findByText(/Create.*desk/)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createSubdirMock).toHaveBeenCalledWith('~', 'desk'))
  })

  it('clicking the Create row creates the dir and applies the path', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop'])
    createSubdirMock.mockResolvedValue('/Users/me/myproj')
    const onChange = vi.fn()
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value="~/myproj" onChange={onChange} />
    ))
    fireEvent.focus(getByRole('textbox'))
    const createRow = await findByText(/Create.*myproj/)
    const li = createRow.closest('li')!
    fireEvent.click(li)
    await waitFor(() => expect(createSubdirMock).toHaveBeenCalledWith('~', 'myproj'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('~/myproj/'))
  })

  it('clicking a suggestion applies it', async () => {
    listSubdirsMock.mockResolvedValue(['Desktop'])
    const onChange = vi.fn()
    const { findByText, getByRole } = render(() => (
      <PathAutocomplete value="~/" onChange={onChange} />
    ))
    fireEvent.focus(getByRole('textbox'))
    const suggestion = await findByText('Desktop')
    fireEvent.click(suggestion)
    expect(onChange).toHaveBeenCalledWith('~/Desktop/')
  })
})
