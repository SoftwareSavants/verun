import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ChipList } from './ChipList'

describe('ChipList', () => {
  afterEach(cleanup)

  it('renders chips and removes them via the × button', () => {
    const onChange = vi.fn()
    const { getByText, getByLabelText } = render(() => (
      <ChipList values={['github.com', 'npmjs.com']} onChange={onChange} placeholder="Add domain" />
    ))
    expect(getByText('github.com')).toBeTruthy()
    fireEvent.click(getByLabelText('Remove github.com'))
    expect(onChange).toHaveBeenCalledWith(['npmjs.com'])
  })

  it('adds a value on Enter and clears the input', () => {
    const onChange = vi.fn()
    const { getByPlaceholderText } = render(() => (
      <ChipList values={[]} onChange={onChange} placeholder="Add" />
    ))
    const input = getByPlaceholderText('Add') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'x.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['x.com'])
  })

  it('rejects duplicates', () => {
    const onChange = vi.fn()
    const { getByPlaceholderText } = render(() => (
      <ChipList values={['a.com']} onChange={onChange} placeholder="Add" />
    ))
    const input = getByPlaceholderText('Add') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'a.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })
})
