import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@solidjs/testing-library'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue(null) }))

type Listener = (e: { payload: unknown }) => void
const listeners = new Map<string, Listener[]>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, cb: Listener) => {
    const arr = listeners.get(name) || []
    arr.push(cb)
    listeners.set(name, arr)
    return Promise.resolve(() => {
      const current = listeners.get(name) || []
      listeners.set(name, current.filter((x) => x !== cb))
    })
  }),
}))

const scaffoldMock = vi.fn<(...a: unknown[]) => Promise<string>>()
const killMock = vi.fn<(...a: unknown[]) => Promise<void>>()
const listSubdirsMock = vi.fn<(p: string) => Promise<string[]>>()
const defaultBootstrapDirMock = vi.fn<() => Promise<string>>()
const inputMock = vi.fn<(...a: unknown[]) => Promise<void>>()
const resizeMock = vi.fn<(...a: unknown[]) => Promise<void>>()
vi.mock('../lib/ipc', () => ({
  scaffoldBetterTStack: (...a: unknown[]) => scaffoldMock(...a),
  killBtsScaffold: (...a: unknown[]) => killMock(...a),
  listSubdirs: (p: string) => listSubdirsMock(p),
  defaultBootstrapDir: () => defaultBootstrapDirMock(),
  btsScaffoldInput: (...a: unknown[]) => inputMock(...a),
  btsScaffoldResize: (...a: unknown[]) => resizeMock(...a),
}))

// xterm.js requires a real DOM with layout - jsdom can't render it. Stub the
// log pane to a placeholder so the dialog flow tests run without WebGL.
vi.mock('./BtsLogPane', () => ({
  BtsLogPane: (p: { projectName: string; scaffoldId: string; errorText: string | null; onCancel: () => void }) => (
    <div data-testid="bts-log">
      <span>Bootstrapping {p.projectName}</span>
      <span>{p.scaffoldId}</span>
      <button onClick={p.onCancel}>Cancel</button>
    </div>
  ),
}))

import { BtsBuilderDialog } from './BtsBuilderDialog'

describe('BtsBuilderDialog', () => {
  beforeEach(() => {
    cleanup()
    listeners.clear()
    localStorage.clear()
    scaffoldMock.mockReset()
    killMock.mockReset()
    listSubdirsMock.mockReset().mockResolvedValue([])
    defaultBootstrapDirMock.mockReset().mockResolvedValue('~')
  })

  it('renders the bootstrap heading when open', () => {
    const { getByText } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    expect(getByText(/Bootstrap a new project/i)).toBeTruthy()
  })

  it('does not render when closed', () => {
    const { queryByText } = render(() => (
      <BtsBuilderDialog open={false} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    expect(queryByText(/Bootstrap a new project/i)).toBeNull()
  })

  it('command preview updates when project name changes', () => {
    const { getByPlaceholderText, getByTestId } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    const input = getByPlaceholderText('my-new-app') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'foo' } })
    expect(getByTestId('bts-preview').textContent).toContain('foo')
  })

  it('selecting a backend card adds its flag to the preview', async () => {
    const { getByText, getByTestId } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    fireEvent.click(getByText(/^Backend$/))
    fireEvent.click(getByText('Hono'))
    await waitFor(() => expect(getByTestId('bts-preview').textContent).toMatch(/--backend hono/))
  })

  it('preview includes --git but never --yes/--yolo (CLI runs interactively for unanswered prompts)', () => {
    const { getByTestId } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    const preview = getByTestId('bts-preview').textContent ?? ''
    expect(preview).toMatch(/--git/)
    expect(preview).not.toMatch(/--yes/)
    expect(preview).not.toMatch(/--yolo/)
  })

  it('create button is disabled without project name', () => {
    const { getByRole } = render(() => (
      <BtsBuilderDialog
        open={true}
        onClose={() => {}}
        onScaffoldComplete={() => {}}
        initialParentDir="/tmp/p"
      />
    ))
    const btn = getByRole('button', { name: /Create project/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('clicking Create calls ipc.scaffoldBetterTStack with built cli args', async () => {
    scaffoldMock.mockResolvedValue('/tmp/test-parent/foo-app')
    const { getByPlaceholderText, getByRole } = render(() => (
      <BtsBuilderDialog
        open={true}
        onClose={() => {}}
        onScaffoldComplete={() => {}}
        initialParentDir="/tmp/test-parent"
      />
    ))
    fireEvent.input(getByPlaceholderText('my-new-app'), { target: { value: 'foo-app' } })
    const btn = getByRole('button', { name: /Create project/i }) as HTMLButtonElement
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(scaffoldMock).toHaveBeenCalledTimes(1))
    const [parentDir, projectName, pmRun, cliArgs, verunCfg, scaffoldId] = scaffoldMock.mock.calls[0] as [string, string, string, string[], Record<string, unknown>, string]
    expect(parentDir).toBe('/tmp/test-parent/')
    expect(projectName).toBe('foo-app')
    expect(pmRun).toBe('bunx')
    expect(cliArgs).toContain('--backend')
    expect(cliArgs).toContain('hono')
    expect(cliArgs).toContain('--git')
    expect(cliArgs).not.toContain('--yes')
    expect(cliArgs).not.toContain('--yolo')
    expect(cliArgs[0]).toBe('foo-app')
    expect(verunCfg).toMatchObject({ startCommand: 'bun dev', hooks: { setup: 'bun install' } })
    expect(typeof scaffoldId).toBe('string')
  })

  it('mounts the interactive log pane with the scaffold id after clicking Create', async () => {
    let resolveScaffold: (v: string) => void = () => {}
    scaffoldMock.mockImplementation(
      () => new Promise<string>((res) => { resolveScaffold = res }),
    )
    const { getByPlaceholderText, getByRole, findByTestId } = render(() => (
      <BtsBuilderDialog
        open={true}
        onClose={() => {}}
        onScaffoldComplete={() => {}}
        initialParentDir="/tmp/p"
      />
    ))
    fireEvent.input(getByPlaceholderText('my-new-app'), { target: { value: 'demo' } })
    const btn = getByRole('button', { name: /Create project/i })
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(scaffoldMock).toHaveBeenCalled())
    const id = scaffoldMock.mock.calls[0][5] as string
    const pane = await findByTestId('bts-log')
    expect(pane.textContent).toContain(id)
    expect(pane.textContent).toContain('demo')
    resolveScaffold('/tmp/p/demo')
  })

  it('calls onScaffoldComplete with returned path on success', async () => {
    scaffoldMock.mockResolvedValue('/tmp/p/demo')
    const onComplete = vi.fn()
    const { getByPlaceholderText, getByRole } = render(() => (
      <BtsBuilderDialog
        open={true}
        onClose={() => {}}
        onScaffoldComplete={onComplete}
        initialParentDir="/tmp/p"
      />
    ))
    fireEvent.input(getByPlaceholderText('my-new-app'), { target: { value: 'demo' } })
    const btn = getByRole('button', { name: /Create project/i })
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('/tmp/p/demo'))
  })

  it('picking a second web frontend replaces the first but keeps the native one', async () => {
    const { getByText, getByTestId } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    fireEvent.click(getByText('TanStack Router'))
    fireEvent.click(getByText('Expo + Uniwind'))
    fireEvent.click(getByText('Next.js'))
    await waitFor(() => {
      const txt = getByTestId('bts-preview').textContent || ''
      expect(txt).toMatch(/--frontend next/)
      expect(txt).toMatch(/--frontend native-uniwind/)
      expect(txt).not.toMatch(/--frontend tanstack-router/)
    })
  })

  it('picking a second native frontend replaces the first but keeps the web one', async () => {
    const { getByText, getByTestId } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    fireEvent.click(getByText('Expo + Uniwind'))
    fireEvent.click(getByText('Expo + Unistyles'))
    await waitFor(() => {
      const txt = getByTestId('bts-preview').textContent || ''
      expect(txt).toMatch(/--frontend tanstack-router/)
      expect(txt).toMatch(/--frontend native-unistyles/)
      expect(txt).not.toMatch(/--frontend native-uniwind/)
    })
  })

  it('does not show downstream-only validation reasons on initial open (e.g. "Nuxt doesn\'t support tRPC" while api is still default)', () => {
    const { queryByText } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    expect(queryByText(/Nuxt doesn't support tRPC/i)).toBeNull()
    expect(queryByText(/Svelte doesn't support tRPC/i)).toBeNull()
    expect(queryByText(/Solid doesn't support tRPC/i)).toBeNull()
    expect(queryByText(/Astro doesn't support tRPC/i)).toBeNull()
  })

  it('shows upstream validation reasons (frontend already picked, then api card visited)', async () => {
    const { getByText, findByText } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    fireEvent.click(getByText('Nuxt'))
    expect(await findByText(/tRPC doesn't support Nuxt/i)).toBeTruthy()
  })

  it('Reset restores defaults', async () => {
    const { getByText, getByTestId, getByRole } = render(() => (
      <BtsBuilderDialog open={true} onClose={() => {}} onScaffoldComplete={() => {}} />
    ))
    fireEvent.click(getByText('Express'))
    await waitFor(() => expect(getByTestId('bts-preview').textContent).toMatch(/--backend express/))
    fireEvent.click(getByRole('button', { name: /^\s*Reset\s*$/i }))
    await waitFor(() => expect(getByTestId('bts-preview').textContent).toMatch(/--backend hono/))
  })
})
