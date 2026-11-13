import { beforeEach, expect, test } from 'vitest'
import { appendToDraft, clearDraft, loadDraftAttachments, loadDraftMessage, saveDraftAttachments, saveDraftMessage } from './sessionDrafts'

const ref = { hash: 'h1', mimeType: 'image/png', name: 'a.png', size: 1 }

beforeEach(() => localStorage.clear())

test('message round-trips and an empty message clears it', () => {
  saveDraftMessage('s1', 'hello')
  expect(loadDraftMessage('s1')).toBe('hello')
  saveDraftMessage('s1', '')
  expect(loadDraftMessage('s1')).toBeNull()
})

test('keeps the storage keys the composer has always used', () => {
  saveDraftMessage('s1', 'hello')
  saveDraftAttachments('s1', [ref])
  expect(localStorage.getItem('verun:draft-msg:s1')).toBe('hello')
  expect(localStorage.getItem('verun:draft-att:s1')).not.toBeNull()
})

test('attachments round-trip, and none clears them', () => {
  saveDraftAttachments('s1', [ref])
  expect(loadDraftAttachments('s1')).toEqual([ref])
  saveDraftAttachments('s1', [])
  expect(loadDraftAttachments('s1')).toEqual([])
  expect(localStorage.getItem('verun:draft-att:s1')).toBeNull()
})

test('corrupt attachment data reads as none', () => {
  localStorage.setItem('verun:draft-att:s1', '{not json')
  expect(loadDraftAttachments('s1')).toEqual([])
})

test('clearDraft removes message and attachments for that session only', () => {
  saveDraftMessage('s1', 'a')
  saveDraftAttachments('s1', [ref])
  saveDraftMessage('s2', 'b')
  clearDraft('s1')
  expect(loadDraftMessage('s1')).toBeNull()
  expect(loadDraftAttachments('s1')).toEqual([])
  expect(loadDraftMessage('s2')).toBe('b')
})

test('appendToDraft appends a take to the existing draft with spacing', () => {
  saveDraftMessage('s1', 'hello')
  appendToDraft('s1', ' world ')
  expect(loadDraftMessage('s1')).toBe('hello world')
})

test('appendToDraft on no draft saves the take', () => {
  appendToDraft('s2', 'hi')
  expect(loadDraftMessage('s2')).toBe('hi')
})
