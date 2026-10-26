import { Component, For, Show, createSignal, createUniqueId, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { Plus, X } from 'lucide-solid'
import { Dialog } from './Dialog'
import { DialogFooter } from './DialogFooter'
import { Popover } from './Popover'
import { ColorPicker } from './ColorPicker'
import { Select } from './Select'
import { Toggle } from './Toggle'
import { agents } from '../store/agents'
import { addToast } from '../store/ui'
import { toastError } from '../lib/accountErrors'
import { useDismissable } from '../lib/dismissable'
import * as ipc from '../lib/ipc'
import { AGENT_DISPLAY_NAMES, type Account, type AccountEnvInput, type AgentType } from '../types'

interface Props {
  open: boolean
  agentType: AgentType
  /** The account to edit. Without one, the dialog adds an account. */
  account?: Account
  onClose: () => void
}

const DEFAULT_COLOR = '#7c3aed'
const STORED_SECRET = 'Stored - leave empty to keep'
/** What the color picker needs below its swatch, so it can be kept on screen. */
const PICKER_HEIGHT = 240

type FolderMode = 'managed' | 'existing'

/** One row of the env editor. `id` keeps the row's inputs in place while it is edited. */
interface EnvRow {
  id: number
  key: string
  value: string
  secret: boolean
}

let nextRowId = 0

const newRow = (row: Partial<EnvRow> = {}): EnvRow => ({ id: nextRowId++, key: '', value: '', secret: false, ...row })

/**
 * Adds an account or, given one, edits it: its label, color and env. The folder
 * is chosen when adding and fixed after that. The commands' own snapshots are
 * not applied to the store: every window gets `accounts-changed`.
 *
 * The form is a child of the dialog, so it starts clean each time the dialog opens.
 */
export const AccountDialog: Component<Props> = (props) => {
  return (
    <Dialog open={props.open} onClose={props.onClose} width="38rem">
      <AccountForm {...props} />
    </Dialog>
  )
}

const AccountForm: Component<Props> = (props) => {
  const agent = () => agents.find((a) => a.id === props.agentType)
  const support = () => agent()?.accountSupport ?? null
  const requiredSecret = () => support()?.requiredSecret ?? null
  const editing = () => props.account !== undefined

  const [label, setLabel] = createSignal(props.account?.label ?? '')
  const [color, setColor] = createSignal(props.account?.color ?? DEFAULT_COLOR)
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [pickerPos, setPickerPos] = createSignal({ x: 0, y: 0 })
  const [folderMode, setFolderMode] = createSignal<FolderMode>('managed')
  const [folderPath, setFolderPath] = createSignal('')
  const [requiredValue, setRequiredValue] = createSignal('')
  // The required secret has a field of its own, so it is not a row of the editor.
  const [rows, setRows] = createStore<EnvRow[]>(
    (props.account?.env ?? [])
      .filter((v) => v.key !== requiredSecret())
      .map((v) => newRow({ key: v.key, value: v.value ?? '', secret: v.secret })),
  )
  const [saving, setSaving] = createSignal(false)

  const labelId = createUniqueId()
  const folderId = createUniqueId()
  const secretId = createUniqueId()
  let labelInput!: HTMLInputElement
  let swatch!: HTMLButtonElement
  onMount(() => labelInput.focus())

  const togglePicker = () => {
    if (!pickerOpen()) {
      // Placed by the screen, not the dialog: the dialog scrolls, and would cut the picker off.
      const rect = swatch.getBoundingClientRect()
      setPickerPos({ x: rect.left, y: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - PICKER_HEIGHT)) })
    }
    setPickerOpen(!pickerOpen())
  }

  // Escape closes the dialog (a color picker or a select open in it goes first).
  useDismissable(() => true, () => props.onClose())

  /** Whether the account being edited has a secret stored under `key`. */
  const hasStoredSecret = (key: string) => props.account?.env.some((v) => v.secret && v.key === key) ?? false
  /** An empty secret field means "keep what is stored" only where something is stored under that key. */
  const keepsStored = (row: EnvRow) => row.secret && hasStoredSecret(row.key.trim())

  const showFolder = () => !editing() && support()?.existingDir === true

  const canSave = () => {
    if (saving() || label().trim() === '') return false
    if (showFolder() && folderMode() === 'existing' && folderPath().trim() === '') return false
    const required = requiredSecret()
    return !required || requiredValue() !== '' || hasStoredSecret(required)
  }

  const envInput = (): AccountEnvInput[] => {
    const input: AccountEnvInput[] = []
    const required = requiredSecret()
    if (required) {
      input.push({ key: required, value: requiredValue() === '' && hasStoredSecret(required) ? null : requiredValue(), secret: true })
    }
    for (const row of rows) {
      const key = row.key.trim()
      if (key === '' && row.value === '') continue
      input.push({ key, value: row.value === '' && keepsStored(row) ? null : row.value, secret: row.secret })
    }
    return input
  }

  const save = async () => {
    if (!canSave()) return
    const name = label().trim()
    setSaving(true)
    try {
      if (props.account) {
        await ipc.updateAccount({ id: props.account.id, label: name, color: color(), env: envInput() })
        addToast(`Saved ${name}`, 'success')
      } else {
        await ipc.createAccount({
          agentType: props.agentType,
          label: name,
          color: color(),
          existingDir: showFolder() && folderMode() === 'existing' ? folderPath().trim() : null,
          env: envInput(),
        })
        addToast(`Added ${name}`, 'success')
      }
      props.onClose()
    } catch (e) {
      toastError(e)
    } finally {
      setSaving(false)
    }
  }

  const saveOnEnter = (e: KeyboardEvent) => {
    // Enter that confirms an IME composition is not "save".
    if (e.key !== 'Enter' || e.isComposing) return
    e.preventDefault()
    void save()
  }

  return (
    <>
      <h2 class="text-base font-semibold text-text-primary mb-4">
        {editing() ? 'Edit account' : `Add ${agent()?.name ?? AGENT_DISPLAY_NAMES[props.agentType]} account`}
      </h2>

      <div class="space-y-4 mb-5">
        <div>
          <label for={labelId} class="block text-sm text-text-primary mb-1.5">Label</label>
          <div class="flex items-center gap-2">
            <div class="relative">
              <button
                ref={swatch}
                type="button"
                class="w-9 h-9 rounded-lg ring-1 ring-outline/8 hover:ring-outline/20 transition-shadow"
                style={{ background: color() }}
                title="Pick a color"
                aria-label="Pick a color"
                onClick={togglePicker}
              />
              <Popover
                open={pickerOpen()}
                onClose={() => setPickerOpen(false)}
                pos={pickerPos()}
                class="w-64 p-3 bg-surface-2 border-border-active"
              >
                <ColorPicker value={color()} onChange={setColor} />
              </Popover>
            </div>
            <input
              id={labelId}
              ref={labelInput}
              type="text"
              class="input-base"
              placeholder="Work"
              value={label()}
              onInput={(e) => setLabel(e.currentTarget.value)}
              onKeyDown={saveOnEnter}
            />
          </div>
        </div>

        <Show when={showFolder()}>
          <div>
            <label for={folderId} class="block text-sm text-text-primary mb-1.5">Folder</label>
            <Select
              id={folderId}
              label="Folder"
              value={folderMode()}
              onChange={(v) => setFolderMode(v as FolderMode)}
              options={[
                { value: 'managed', label: 'New folder managed by Verun' },
                { value: 'existing', label: 'Existing folder' },
              ]}
            />
            <Show when={folderMode() === 'existing'}>
              <input
                type="text"
                class="input-base font-mono text-[12px] mt-2"
                aria-label="Folder path"
                placeholder="/path/to/folder"
                spellcheck={false}
                autocapitalize="off"
                value={folderPath()}
                onInput={(e) => setFolderPath(e.currentTarget.value)}
                onKeyDown={saveOnEnter}
              />
            </Show>
          </div>
        </Show>

        <Show when={requiredSecret()}>
          {(key) => (
            <div>
              <label for={secretId} class="block text-sm text-text-primary mb-1.5">{key()}</label>
              <input
                id={secretId}
                type="password"
                class="input-base font-mono text-[12px]"
                autocomplete="off"
                spellcheck={false}
                placeholder={hasStoredSecret(key()) ? STORED_SECRET : ''}
                value={requiredValue()}
                onInput={(e) => setRequiredValue(e.currentTarget.value)}
                onKeyDown={saveOnEnter}
              />
            </div>
          )}
        </Show>

        <div>
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-sm text-text-primary">Environment variables</span>
            <button
              type="button"
              class="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
              onClick={() => setRows(rows.length, newRow())}
            >
              <Plus size={12} />
              Add variable
            </button>
          </div>
          <p class="text-xs text-text-dim mb-2">Set for every process this account starts. Secret values are stored in your keychain.</p>
          <div class="space-y-2">
            <For each={rows}>
              {(row) => (
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    class="input-base font-mono text-[12px] w-44 shrink-0"
                    aria-label="Variable name"
                    placeholder="NAME"
                    spellcheck={false}
                    autocapitalize="off"
                    value={row.key}
                    onInput={(e) => setRows((r) => r.id === row.id, 'key', e.currentTarget.value)}
                    onKeyDown={saveOnEnter}
                  />
                  <input
                    type={row.secret ? 'password' : 'text'}
                    class="input-base font-mono text-[12px] flex-1 min-w-0"
                    aria-label="Value"
                    placeholder={keepsStored(row) ? STORED_SECRET : 'value'}
                    autocomplete="off"
                    spellcheck={false}
                    autocapitalize="off"
                    value={row.value}
                    onInput={(e) => setRows((r) => r.id === row.id, 'value', e.currentTarget.value)}
                    onKeyDown={saveOnEnter}
                  />
                  <label class="flex items-center gap-1.5 text-xs text-text-muted shrink-0">
                    <Toggle checked={row.secret} onChange={(secret) => setRows((r) => r.id === row.id, 'secret', secret)} />
                    Secret
                  </label>
                  <button
                    type="button"
                    class="p-1 rounded-md text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors shrink-0"
                    aria-label="Remove variable"
                    title="Remove variable"
                    onClick={() => setRows((all) => all.filter((r) => r.id !== row.id))}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      <DialogFooter
        onCancel={props.onClose}
        onConfirm={() => void save()}
        confirmLabel={editing() ? 'Save' : 'Add account'}
        loadingLabel="Saving..."
        loading={saving()}
        disabled={!canSave()}
      />
    </>
  )
}
