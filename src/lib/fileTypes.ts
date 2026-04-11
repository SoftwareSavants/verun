export type PreviewType = 'code' | 'markdown' | 'svg' | 'image' | 'video' | 'audio'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'ogv'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'])
const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown'])
const SVG_EXTS = new Set(['svg'])

export function getPreviewType(filePath: string): PreviewType {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (SVG_EXTS.has(ext)) return 'svg'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return 'code'
}

export function isMediaType(type: PreviewType): boolean {
  return type === 'image' || type === 'video' || type === 'audio'
}