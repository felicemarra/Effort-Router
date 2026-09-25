import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addUsage,
  cacheVerdict,
  canLower,
  canRouteSubagent,
  clip,
  decideEffort,
  decideSubagentEffort,
  decideSubagentModel,
  formatStats,
  inheritedLabel,
  mergeStats,
  newStats,
  parseLabel,
  readStats,
  shouldClassify,
  shouldEscalate,
  subagentWorthClassifying,
} from '../hooks/policy.ts'

test('subagent: haiku solo se banale, senza modello esplicito, non fork', () => {
  const base = { fork: false, parentModel: 'claude-opus-5-5[1m]' }
  assert.equal(decideSubagentModel('banale', base), 'haiku')
  assert.equal(decideSubagentModel('semplice', base), null)
  assert.equal(decideSubagentModel('complesso', base), null)
  assert.equal(decideSubagentModel(null, base), null)
  assert.equal(decideSubagentModel('banale', { ...base, model: 'opus' }), null)
  assert.equal(decideSubagentModel('banale', { ...base, fork: true }), null)
  assert.equal(decideSubagentModel('banale', { ...base, parentModel: 'claude-haiku-4-5-20251001' }), null)
})

test('abbassa solo sotto il livello corrente', () => {
  assert.equal(decideEffort('banale', 'high'), 'low')
  assert.equal(decideEffort('semplice', 'high'), 'medium')
  assert.equal(decideEffort('banale', undefined), 'low')
  assert.equal(decideEffort('semplice', 'xhigh'), 'medium')
})

test('complesso non cambia nulla', () => {
  assert.equal(decideEffort('complesso', 'high'), null)
  assert.equal(decideEffort('complesso', undefined), null)
})

test('non alza mai', () => {
  assert.equal(decideEffort('semplice', 'low'), null)
  assert.equal(decideEffort('semplice', 'medium'), null)
  assert.equal(decideEffort('banale', 'low'), null)
})

test('effort non confrontabile o nessuna label: nulla', () => {
  assert.equal(decideEffort('banale', 3), null)
  assert.equal(decideEffort('banale', 'boh'), null)
  assert.equal(decideEffort(null, 'high'), null)
})

test('prompt corti e slash command non vengono classificati', () => {
  assert.equal(shouldClassify('sì procedi', 40), false)
  assert.equal(shouldClassify('/clear e poi rileggi tutto il progetto per favore', 40), false)
  assert.equal(shouldClassify('mostrami il contenuto del file settings.json per favore', 40), true)
})

test('prompt oltre maxChars non vengono classificati', () => {
  const lungo = 'x'.repeat(2001)
  assert.equal(shouldClassify(lungo, 40, 2000), false)
  assert.equal(shouldClassify(lungo, 40), true)
})

test('canLower: con effort già low niente classificazione', () => {
  assert.equal(canLower(undefined), true)
  assert.equal(canLower('high'), true)
  assert.equal(canLower('medium'), true)
  assert.equal(canLower('low'), false)
  assert.equal(canLower(3), false)
})

test('clip taglia solo i testi lunghi', () => {
  assert.equal(clip('breve', 10), 'breve')
  assert.equal(clip('abcdefghijkl', 4), 'abcd\n[…]')
})

test('canRouteSubagent', () => {
  const base = { fork: false, parentModel: 'claude-opus-5-5[1m]' }
  assert.equal(canRouteSubagent(base), true)
  assert.equal(canRouteSubagent({ ...base, model: 'sonnet' }), false)
  assert.equal(canRouteSubagent({ ...base, fork: true }), false)
  assert.equal(canRouteSubagent({ ...base, parentModel: 'claude-haiku-4-5-20251001' }), false)
})

test('parseLabel', () => {
  assert.equal(parseLabel('banale'), 'banale')
  assert.equal(parseLabel(' Semplice.\n'), 'semplice')
  assert.equal(parseLabel('complesso'), 'complesso')
  assert.equal(parseLabel('banale o complesso'), null) // ambigua
  assert.equal(parseLabel('fast'), null)
  assert.equal(parseLabel(''), null)
})

test('inheritedLabel: solo seguiti brevissimi, mai complesso, mai due volte', () => {
  const banale = { label: 'banale' as const, inherited: false }
  assert.equal(inheritedLabel('sì', banale), 'banale')
  assert.equal(inheritedLabel('ok procedi', { label: 'semplice', inherited: false }), 'semplice')
  assert.equal(inheritedLabel('sì', { label: 'complesso', inherited: false }), null)
  assert.equal(inheritedLabel('sì', { label: 'banale', inherited: true }), null)
  assert.equal(inheritedLabel('sì', { label: null, inherited: false }), null)
  assert.equal(inheritedLabel('ok ora riscrivi tutto il modulo', banale), null)
  assert.equal(inheritedLabel('/clear', banale), null)
  assert.equal(inheritedLabel('   ', banale), null)
})

test('shouldEscalate', () => {
  assert.equal(shouldEscalate(8, 8, 'low'), true)
  assert.equal(shouldEscalate(7, 8, 'low'), false)
  assert.equal(shouldEscalate(20, 0, 'low'), false)
  assert.equal(shouldEscalate(20, 8, null), false)
})

test('subagentWorthClassifying', () => {
  const base = { fork: false, parentModel: 'claude-opus-5-5[1m]' }
  assert.equal(subagentWorthClassifying(base, false), true)
  assert.equal(subagentWorthClassifying({ ...base, model: 'sonnet' }, false), true) // per l'effort
  assert.equal(subagentWorthClassifying({ ...base, model: 'haiku' }, false), false)
  assert.equal(subagentWorthClassifying({ ...base, fork: true }, false), false)
  assert.equal(subagentWorthClassifying({ ...base, parentModel: 'claude-haiku-4-5' }, false), false)
  assert.equal(subagentWorthClassifying(base, true), false)
})

test('decideSubagentEffort: un modello senza effort non si tocca', () => {
  assert.equal(decideSubagentEffort('semplice', 'high'), 'medium')
  assert.equal(decideSubagentEffort('banale', 'high'), 'low')
  assert.equal(decideSubagentEffort('semplice', undefined), null)
  assert.equal(decideSubagentEffort('complesso', 'high'), null)
})

test('readStats: riempie i buchi e scarta i valori non numerici', () => {
  const stats = readStats({ turns: 5, labels: { banale: 'x' }, extra: 1 }, 0)
  assert.equal(stats.turns, 5)
  assert.equal(stats.labels.banale, 0)
  assert.equal(stats.cache.same.n, 0)
  assert.equal('extra' in stats, false)
  assert.deepEqual(readStats(null, 7), newStats(7))
})

test('cacheVerdict', () => {
  const stats = newStats(0)
  assert.equal(cacheVerdict(stats), 'unknown')
  for (let i = 0; i < 10; i++) {
    addUsage(stats.cache.same, { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 950, cache_creation_input_tokens: 0 })
    addUsage(stats.cache.changed, { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 })
  }
  assert.equal(cacheVerdict(stats), 'ok')
  for (let i = 0; i < 30; i++) {
    addUsage(stats.cache.changed, { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 950 })
  }
  assert.equal(cacheVerdict(stats), 'busting')
  assert.match(formatStats(stats, ['veloce'], true), /INVALIDA la cache: abbassamento/)
})

test('mergeStats: somma gli incrementi e tiene la data più vecchia', () => {
  const saved = readStats({ since: 100, turns: 3, cache: { same: { n: 2, read: 10, total: 20 } } }, 0)
  const delta = newStats(0)
  delta.turns = 2
  delta.cache.same.n = 1
  delta.labels.banale = 1
  const merged = mergeStats(saved, delta)
  assert.equal(merged.turns, 5)
  assert.equal(merged.cache.same.n, 3)
  assert.equal(merged.cache.same.read, 10)
  assert.equal(merged.labels.banale, 1)
  assert.equal(merged.since, 100)
  assert.equal(mergeStats(newStats(0), newStats(50)).since, 50)
  assert.equal(saved.turns, 3) // non muta gli argomenti
})
