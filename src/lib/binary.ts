import type { Attachment } from '../types'

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

interface SerializedAttachment {
  name: string
  mimeType: string
  dataBase64: string
}

export function serializeAttachments(atts: Attachment[]): string {
  const out: SerializedAttachment[] = atts.map(a => ({
    name: a.name,
    mimeType: a.mimeType,
    dataBase64: bytesToBase64(a.data),
  }))
  return JSON.stringify(out)
}

export function deserializeAttachments(json: string): Attachment[] {
  const parsed: SerializedAttachment[] = JSON.parse(json)
  return parsed.map(a => ({
    name: a.name,
    mimeType: a.mimeType,
    data: base64ToBytes(a.dataBase64),
  }))
}
