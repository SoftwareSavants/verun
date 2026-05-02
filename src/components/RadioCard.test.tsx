import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RadioCard } from './RadioCard'

describe('RadioCard', () => {
  afterEach(cleanup)

  it('renders title, description, and options', () => {
    const { getByText, getByLabelText } = render(() => (
      <RadioCard
        title="Read tools"
        description="Where Claude can read files."
        value="repo"
        options={[
          { value: 'repo', label: 'Anywhere in the repo' },
          { value: 'any',  label: 'Anywhere on disk' },
          { value: 'ask',  label: 'Always ask' },
        ]}
        onChange={() => {}}
      />
    ))
    expect(getByText('Read tools')).toBeTruthy()
    expect(getByText('Where Claude can read files.')).toBeTruthy()
    const repoRadio = getByLabelText('Anywhere in the repo') as HTMLInputElement
    expect(repoRadio.checked).toBe(true)
  })

  it('calls onChange when an option is selected', () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(() => (
      <RadioCard
        title="x"
        value="a"
        options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]}
        onChange={onChange}
      />
    ))
    fireEvent.click(getByLabelText('B'))
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
