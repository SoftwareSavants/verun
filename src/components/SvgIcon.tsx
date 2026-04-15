import clsx from 'clsx'

export default function SvgIcon(props: { svg: string; size?: number; class?: string }) {
  return (
    <span
      class={clsx('inline-flex items-center justify-center shrink-0', props.class)}
      innerHTML={props.svg.replace('<svg ', `<svg width="${props.size ?? 12}" height="${props.size ?? 12}" `)}
    />
  )
}
