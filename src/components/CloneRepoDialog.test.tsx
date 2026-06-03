import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, waitFor, fireEvent } from '@solidjs/testing-library'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue(null) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))

const ghStatusMock = vi.fn()
const listUserGithubReposMock = vi.fn()
const cloneGithubRepoAndAddMock = vi.fn()
const fetchGithubRepoMock = vi.fn()
const searchGithubReposMock = vi.fn()
vi.mock('../lib/ipc', () => ({
  ghStatus: () => ghStatusMock(),
  listUserGithubRepos: () => listUserGithubReposMock(),
  cloneGithubRepoAndAdd: (args: unknown) => cloneGithubRepoAndAddMock(args),
  fetchGithubRepo: (slug: string) => fetchGithubRepoMock(slug),
  searchGithubRepos: (q: string) => searchGithubReposMock(q),
}))

import { CloneRepoDialog } from './CloneRepoDialog'

describe('CloneRepoDialog', () => {
  beforeEach(() => {
    cleanup()
    ghStatusMock.mockReset()
    listUserGithubReposMock.mockReset()
    cloneGithubRepoAndAddMock.mockReset()
    fetchGithubRepoMock.mockReset()
    searchGithubReposMock.mockReset()
    // Default: the debounced URL/slug lookup never resolves during a single test
    // run — assertions complete before the timer fires, so we don't need real data.
    fetchGithubRepoMock.mockImplementation(() => new Promise(() => {}))
    searchGithubReposMock.mockImplementation(() => new Promise(() => {}))
  })

  it('shows install instructions when gh is not installed', async () => {
    ghStatusMock.mockResolvedValue({ installed: false, authenticated: false, offline: false, account: null })
    const { findByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    expect(await findByText(/isn't installed or isn't on your PATH/)).toBeTruthy()
    expect(await findByText(/brew install gh\s+gh auth login/)).toBeTruthy()
  })

  it('shows the offline view when gh reports no connectivity (not the login guide)', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: false, offline: true, account: null })
    const { findByText, queryByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    expect(await findByText(/No internet connection/i)).toBeTruthy()
    // Critically: the gh auth login instructions must NOT be shown — that
    // command won't fix an offline state and just confuses the user.
    expect(queryByText(/gh auth login/)).toBeNull()
  })

  it('shows auth instructions when gh is installed but unauthenticated', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: false, offline: false, account: null })
    const { findByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    expect(await findByText('The GitHub CLI is installed but not signed in.')).toBeTruthy()
  })

  it('shows the owner avatar on a repo suggestion when available', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'acme/web', description: 'app', url: 'https://github.com/acme/web', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 12, ownerAvatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4', ownerType: 'Organization' },
    ])
    const { findByText, container } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    await findByText('acme/web')
    const item = container.querySelector('button[data-repo]') as HTMLElement
    const img = item.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    // Owner avatar, upscaled via the `s` param so it stays crisp on retina.
    expect(img.src).toBe('https://avatars.githubusercontent.com/u/2?v=4&s=48')
  })

  it('falls back to an organization icon when no owner avatar is available', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/cool-app', description: 'app', url: 'https://github.com/alice/cool-app', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 12, ownerAvatarUrl: null, ownerType: null },
    ])
    const { findByText, container } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    await findByText('alice/cool-app')
    const item = container.querySelector('button[data-repo]') as HTMLElement
    expect(item.querySelector('img')).toBeNull()
    expect(item.querySelector('.lucide-building-2')).toBeTruthy()
  })

  it('lists repos and filters them by query', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/cool-app', description: 'app', url: 'https://github.com/alice/cool-app', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 12 },
      { nameWithOwner: 'alice/dotfiles', description: null, url: 'https://github.com/alice/dotfiles', sshUrl: 's', isPrivate: true, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    const { findByText, findByPlaceholderText, queryByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)

    expect(await findByText('alice/cool-app')).toBeTruthy()
    expect(await findByText('alice/dotfiles')).toBeTruthy()
    expect(await findByText('@alice')).toBeTruthy()

    const filter = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.input(filter, { target: { value: 'cool' } })
    await waitFor(() => {
      expect(queryByText('alice/dotfiles')).toBeNull()
    })
    expect(await findByText('alice/cool-app')).toBeTruthy()
  })

  it('ranks prefix matches above substring matches and matches across tokens', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      // Substring of "auth" in description only — lowest rank
      { nameWithOwner: 'alice/notes', description: 'session auth helpers', url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
      // Substring of "auth" in name — middle rank
      { nameWithOwner: 'alice/reauth-flow', description: null, url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
      // Prefix match on repo name — top rank
      { nameWithOwner: 'alice/auth-server', description: null, url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
      // Doesn't match at all
      { nameWithOwner: 'alice/unrelated', description: 'totally different', url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    const { findByText, findByPlaceholderText, queryByText, container } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    await findByText('alice/auth-server')
    const filter = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.input(filter, { target: { value: 'auth' } })
    await waitFor(() => {
      expect(queryByText('alice/unrelated')).toBeNull()
    })
    const rows = Array.from(container.querySelectorAll('button[data-repo] .truncate.text-\\[13px\\]')).map((n) => n.textContent)
    expect(rows[0]).toBe('alice/auth-server')
    expect(rows.indexOf('alice/reauth-flow')).toBeGreaterThan(rows.indexOf('alice/auth-server'))
    expect(rows.indexOf('alice/notes')).toBeGreaterThan(rows.indexOf('alice/reauth-flow'))
  })

  it('selecting a repo stamps its URL into the search input and keeps the row visible', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/cool-app', description: 'app', url: 'https://github.com/alice/cool-app', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
      { nameWithOwner: 'alice/dotfiles', description: null, url: 'https://github.com/alice/dotfiles', sshUrl: 's', isPrivate: true, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    const { findByText, findByPlaceholderText, queryByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const row = await findByText('alice/cool-app')
    fireEvent.click(row)
    const search = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    await waitFor(() => {
      expect(search.value).toBe('https://github.com/alice/cool-app')
    })
    // URL-aware filter keeps the selected row in view but hides others.
    expect(await findByText('alice/cool-app')).toBeTruthy()
    await waitFor(() => {
      expect(queryByText('alice/dotfiles')).toBeNull()
    })
  })

  it('owner-profile URL lists every repo owned by that account', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([])
    const allOwnerRepos = [
      { nameWithOwner: 'SoftwareSavants/verun', description: null, url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 42 },
      { nameWithOwner: 'SoftwareSavants/cli', description: null, url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 17 },
      { nameWithOwner: 'SoftwareSavants/docs', description: null, url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 3 },
    ]
    searchGithubReposMock.mockResolvedValue(allOwnerRepos)
    const { findByText, findByPlaceholderText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const search = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.input(search, { target: { value: 'https://github.com/SoftwareSavants' } })
    await waitFor(() => {
      expect(searchGithubReposMock).toHaveBeenCalledWith('user:SoftwareSavants')
    }, { timeout: 2000 })
    expect(await findByText('SoftwareSavants/verun')).toBeTruthy()
    expect(await findByText('SoftwareSavants/cli')).toBeTruthy()
    expect(await findByText('SoftwareSavants/docs')).toBeTruthy()
    // Profile URL shouldn't fire the exact-fetch path (no repo half).
    expect(fetchGithubRepoMock).not.toHaveBeenCalled()
  })

  it('exact-slug fetch wins: list shows only the canonical repo, not fuzzy alternates', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([])
    const exactRepo = { nameWithOwner: 'Openclaw/openclaw', description: 'game', url: 'https://github.com/Openclaw/openclaw', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 100 }
    fetchGithubRepoMock.mockResolvedValue(exactRepo)
    // The fuzzy `user:<owner>` search returns extra noise — sibling repos
    // by the same owner. None of these should leak into the list when the
    // exact fetch succeeds.
    searchGithubReposMock.mockResolvedValue([
      exactRepo,
      { nameWithOwner: 'Openclaw/levels', description: null, url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 1 },
      { nameWithOwner: 'Openclaw/tools', description: null, url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 1 },
    ])
    const { findByText, findByPlaceholderText, queryByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const search = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.input(search, { target: { value: 'https://github.com/Openclaw/openclaw' } })
    expect(await findByText('Openclaw/openclaw', {}, { timeout: 2000 })).toBeTruthy()
    await waitFor(() => {
      expect(queryByText('Openclaw/levels')).toBeNull()
      expect(queryByText('Openclaw/tools')).toBeNull()
    })
  })

  it('partial slug (owner/incomplete) still surfaces matching public repos via keyword search', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([])
    // Exact slug `Openclaw/o` doesn't exist as a repo — fetch 404s.
    fetchGithubRepoMock.mockRejectedValue(new Error('Not Found'))
    // ...but a keyword search for "Openclaw o" finds the real one.
    const realRepo = { nameWithOwner: 'Openclaw/openclaw', description: 'game', url: 'https://github.com/Openclaw/openclaw', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 100 }
    searchGithubReposMock.mockResolvedValue([realRepo])
    const { findByPlaceholderText, findByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const search = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.input(search, { target: { value: 'Openclaw/o' } })
    expect(await findByText('Openclaw/openclaw', {}, { timeout: 2000 })).toBeTruthy()
    // Sanity: search restricted to that owner via GitHub's `user:` qualifier.
    expect(searchGithubReposMock).toHaveBeenCalledWith('o user:Openclaw')
  })

  it('slug-only input (owner with empty repo half) searches all of that owner\'s repos', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([])
    fetchGithubRepoMock.mockRejectedValue(new Error('Not Found'))
    searchGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'Openclaw/openclaw', description: 'game', url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 100 },
    ])
    const { findByPlaceholderText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const search = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    // `Openclaw/` parses as a slug with an empty name half — should search
    // all of that owner's repos rather than firing a bare keyword search.
    fireEvent.input(search, { target: { value: 'Openclaw/x' } })
    await waitFor(() => {
      expect(searchGithubReposMock).toHaveBeenCalledWith('x user:Openclaw')
    }, { timeout: 2000 })
  })

  it('search is case-insensitive: UPPERCASE query still matches local repos', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'Openclaw/openclaw', description: null, url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    const { findByText, findByPlaceholderText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const search = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.input(search, { target: { value: 'OPENCLAW' } })
    expect(await findByText('Openclaw/openclaw')).toBeTruthy()
  })

  it('keeps a selected public (remote-only) repo visible in the list', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    // Local repos: just one. The repo the user "selects" is NOT in this list.
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/private-thing', description: null, url: 'https://github.com/alice/private-thing', sshUrl: 's', isPrivate: true, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    // The remote search returns a public repo that isn't in `v.repos`.
    const publicRepo = { nameWithOwner: 'public-org/library', description: 'something', url: 'https://github.com/public-org/library', sshUrl: 'git@github.com:public-org/library.git', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 1234 }
    searchGithubReposMock.mockResolvedValue([publicRepo])
    const { findByText, findByPlaceholderText, queryByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const search = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.input(search, { target: { value: 'library' } })
    // Wait for the debounced remote search to surface the public repo.
    const row = await findByText('public-org/library', {}, { timeout: 2000 })
    fireEvent.click(row)
    await waitFor(() => {
      expect(search.value).toBe('https://github.com/public-org/library')
    })
    // The selected public repo must remain visible — not be replaced by
    // an empty "No repos match" state once `remoteResults` is suppressed.
    expect(await findByText('public-org/library')).toBeTruthy()
    expect(queryByText(/No repos match/)).toBeNull()
  })

  it('clicking Clone Repo closes the dialog immediately and runs the clone in the background', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/cool-app', description: 'app', url: 'https://github.com/alice/cool-app', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    // Make the IPC call hang forever so we can observe the dialog closing
    // *before* the clone resolves — proves the call is fire-and-forget.
    let resolveClone: (p: unknown) => void = () => {}
    cloneGithubRepoAndAddMock.mockImplementation(() => new Promise(resolve => { resolveClone = resolve }))
    localStorage.setItem('verun.clone.parentDir', '/tmp')
    const onClose = vi.fn()
    const { findByText, getByText } = render(() => <CloneRepoDialog open={true} onClose={onClose} />)
    fireEvent.click(await findByText('alice/cool-app'))
    await waitFor(() => {
      expect((getByText(/Clone Repo/) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(getByText(/Clone Repo/))
    // Dialog closes synchronously — no need to await the still-pending IPC.
    expect(onClose).toHaveBeenCalled()
    expect(cloneGithubRepoAndAddMock).toHaveBeenCalled()
    // Sanity: clean up the dangling promise so vitest doesn't complain.
    resolveClone({ id: 'p1', name: 'cool-app' })
  })

  it('clicking the already-selected repo deselects it and clears the input', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/cool-app', description: 'app', url: 'https://github.com/alice/cool-app', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    const { findByText, findByPlaceholderText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const row = await findByText('alice/cool-app')
    const search = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.click(row)
    await waitFor(() => {
      expect(search.value).toBe('https://github.com/alice/cool-app')
    })
    // Re-click toggles off.
    fireEvent.click(await findByText('alice/cool-app'))
    await waitFor(() => {
      expect(search.value).toBe('')
    })
  })

  it('clicking a repo selects it without cloning; Clone button gates on repo + destination', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/cool-app', description: 'app', url: 'https://github.com/alice/cool-app', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    cloneGithubRepoAndAddMock.mockResolvedValue({ id: 'p1', name: 'cool-app', path: '/tmp/cool-app', baseBranch: 'main', autoStart: false, setupHook: '', destroyHook: '', startCommand: '', defaultAgentType: 'claude' })
    // Start with an empty destination so the Clone button is gated.
    localStorage.removeItem('verun.clone.parentDir')
    const { findByText, getByText, container } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    const row = await findByText('alice/cool-app')

    const cloneBtn = getByText(/Clone Repo/) as HTMLButtonElement
    expect(cloneBtn.disabled).toBe(true)

    fireEvent.click(row)
    // Clicking does NOT trigger clone — it just selects.
    expect(cloneGithubRepoAndAddMock).not.toHaveBeenCalled()
    // Still gated because there's no destination folder.
    expect(cloneBtn.disabled).toBe(true)

    // Provide a destination folder via PathAutocomplete's input.
    const destInput = container.querySelector('input[placeholder="~"]') as HTMLInputElement
    expect(destInput).toBeTruthy()
    fireEvent.input(destInput, { target: { value: '/tmp' } })
    await waitFor(() => {
      expect((getByText(/Clone Repo/) as HTMLButtonElement).disabled).toBe(false)
    })

    fireEvent.click(getByText(/Clone Repo/))
    await waitFor(() => {
      expect(cloneGithubRepoAndAddMock).toHaveBeenCalledWith({ nameWithOwner: 'alice/cool-app', parentDir: '/tmp' })
    })
  })

  it('multi-token query matches when every token hits somewhere', async () => {
    ghStatusMock.mockResolvedValue({ installed: true, authenticated: true, offline: false, account: 'alice' })
    listUserGithubReposMock.mockResolvedValue([
      { nameWithOwner: 'alice/cool-app', description: 'a React frontend', url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
      { nameWithOwner: 'alice/server', description: 'a node backend', url: 'u', sshUrl: 's', isPrivate: false, isFork: false, isArchived: false, updatedAt: null, starCount: 0 },
    ])
    const { findByText, findByPlaceholderText, queryByText } = render(() => <CloneRepoDialog open={true} onClose={() => {}} />)
    await findByText('alice/cool-app')
    const filter = await findByPlaceholderText(/Search your repos/) as HTMLInputElement
    fireEvent.input(filter, { target: { value: 'cool react' } })
    await waitFor(() => {
      expect(queryByText('alice/server')).toBeNull()
    })
    expect(await findByText('alice/cool-app')).toBeTruthy()
  })
})
