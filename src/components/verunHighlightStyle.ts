import { HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// Mode-aware highlight style used by CodeEditor and CodeTextarea. Colors come
// from SYNTAX_DARK / SYNTAX_LIGHT in theme.ts and flip with [data-theme].
// Lives in its own module so lightweight consumers (e.g. the hook inputs in
// Settings) can share the palette without pulling in CodeEditor's LSP deps.
export const verunHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: 'var(--syntax-variable)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--syntax-function)' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: 'var(--syntax-number)' },
  { tag: [tags.definition(tags.name), tags.separator], color: 'var(--text-primary)' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: 'var(--syntax-type)' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: 'var(--syntax-keyword)' },
  { tag: [tags.meta, tags.comment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--syntax-function)', textDecoration: 'underline' },
  { tag: tags.heading, fontWeight: 'bold', color: 'var(--syntax-keyword)' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: 'var(--syntax-number)' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: 'var(--syntax-string)' },
  { tag: tags.invalid, color: 'var(--surface-0)', backgroundColor: 'var(--syntax-keyword)' },
  { tag: tags.propertyName, color: 'var(--syntax-variable)' },
  { tag: tags.variableName, color: 'var(--syntax-variable)' },
  { tag: tags.definition(tags.variableName), color: 'var(--syntax-function)' },
  { tag: tags.definition(tags.propertyName), color: 'var(--syntax-function)' },
  { tag: tags.definition(tags.typeName), color: 'var(--syntax-type)' },
])
