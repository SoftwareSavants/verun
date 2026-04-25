import type { Attachment, AttachmentRef } from '../types'
import * as ipc from './ipc'

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

/**
 * Persisted attachment shape for `Step.attachmentsJson`, NDJSON userMessage
 * lines, and any other on-disk / wire format. Just `AttachmentRef[]` round-
 * tripped through JSON.
 *
 * The OLD format embedded base64 bytes (`{name, mimeType, dataBase64}`).
 * Phase 8 migrates legacy rows to refs; this function only emits refs.
 */
export function serializeAttachments(refs: AttachmentRef[]): string {
  return JSON.stringify(refs)
}

export function deserializeAttachments(json: string): AttachmentRef[] {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) return []
  // Defend against legacy base64 rows that haven't been migrated yet — surface
  // a clear error rather than silently returning a malformed ref.
  return parsed.map(item => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Malformed attachment entry')
    }
    const r = item as Record<string, unknown>
    if (typeof r.dataBase64 === 'string' && typeof r.hash !== 'string') {
      throw new Error('Legacy base64 attachment found — needs migration')
    }
    return {
      hash: String(r.hash),
      mimeType: String(r.mimeType),
      name: String(r.name),
      size: Number(r.size ?? 0),
    }
  })
}

/**
 * Upload a batch of in-memory `Attachment`s to the blob store and return the
 * resulting refs in the same order. Caller owns the bytes until this resolves;
 * once it returns, drop them and hold only the refs.
 */
export async function uploadAttachments(atts: Attachment[]): Promise<AttachmentRef[]> {
  const out: AttachmentRef[] = []
  for (const a of atts) {
    const ref = await ipc.uploadAttachment(a.mimeType, a.data)
    out.push({ hash: ref.hash, mimeType: ref.mime, name: a.name, size: ref.size })
  }
  return out
}
