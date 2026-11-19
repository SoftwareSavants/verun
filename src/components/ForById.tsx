import { For, createMemo, type Accessor, type JSX } from 'solid-js'

/**
 * `<For>` for rows rebuilt as new objects on every change (a task's status, its
 * last activity): keyed by `id`, each child given its current row. `<For>` keys
 * by object, so it would replace every row's element on each rebuild, and a
 * click pressed on one element and released on its replacement does nothing.
 */
export function ForById<T extends { id: string }>(props: { each: readonly T[]; children: (item: Accessor<T>) => JSX.Element }) {
  const byId = createMemo(() => new Map(props.each.map(r => [r.id, r])))
  const ids = createMemo(() => props.each.map(r => r.id))
  return (
    <For each={ids()}>{id => {
      // A row that leaves is unmounted; until then it keeps its last value.
      const current = createMemo<T>(prev => byId().get(id) ?? prev, byId().get(id)!)
      return props.children(current)
    }}</For>
  )
}
