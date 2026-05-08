import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, waitFor, fireEvent } from '@solidjs/testing-library'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue(null) }))

const ghStatusMock = vi.fn()
const listUserGithubReposMock = vi.fn()
const cloneGithubRepoAndAddMock = vi.fn()
vi.mock('../lib/ipc', () => ({
  ghStatus: () => ghStatusMock(),
  listUserGithubRepos: () => listUserGithubReposMock(),
  cloneGithubRepoAndAdd: (args: unknown) => cloneGithubRepoAndAddMock(args),
}))

import { CloneRepoDialog } from './CloneRepoDialog'

describe('CloneRepoDialog', () => {
  beforeEach(() => {
    cleanup()
    ghStatusMock.mockReset()
    listUserGithubReposMock.mockReset()
    cloneGithubRepoAndAddMock.mockReset()
  })

  it('shows install instructions when gh is not installed', async () => {
    ghStatusMock.mockResolvedValue({ installed: false, authenticated: false, account: null })
    const { findByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    expect(await findByText(/isn't installed or isn't on your PATH/)).toBeTruthy()
    expect(await findByText(/brew install gh\s+gh auth login/)).toBeTruthy()
  })

  it('shows auth instructions when gh is installed but unauthenticated', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: false, account: null })
    const { findByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    expect(await findByText('The GitHub CLI is installed but not signed in.')).toBeTruthy()
  })

  it('lists repos and filters them by query', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/cool-app', description: 'app', url: 'https://github.com/alice/cool-app', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 12 },
      { nameWithOwner: 'alice/dotfiles', description: null, url: 'https://github.com/alice/dotfiles', sshUrl: 's', isPrivate: true, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    const { findByText, findByPlaceholderText, queryByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)

    expect(await findByText('alice/cool-app')).toBeTruthy()
    expect(await findByText('alice/dotfiles')).toBeTruthy()
    expect(await findByText('@alice')).toBeTruthy()

    const filter = await findByPlaceholderText('Search repos, paste a Git URL, or owner/repo...') as HTMLInputElement
    fireEvent.input(filter, { target: { value: 'cool' } })
    await waitFor(() => {
      expect(queryByText('alice/dotfiles')).toBeNull()
    })
    expect(await findByText('alice/cool-app')).toBeTruthy()
  })
})
