import { Component, createMemo, onCleanup, JSX } from 'solid-js'

interface Props {
  data: Uint8Array
  mimeType: string
  class?: string
  alt?: string
  onClick?: JSX.EventHandlerUnion<HTMLImageElement, MouseEvent>
}

export const BlobImage: Component<Props> = (props) => {
  const url = createMemo(() => {
    const blob = new Blob([props.data], { type: props.mimeType })
    const u = URL.createObjectURL(blob)
    onCleanup(() => URL.revokeObjectURL(u))
    return u
  })
  return <img src={url()} alt={props.alt ?? ''} class={props.class} onClick={props.onClick} />
}
