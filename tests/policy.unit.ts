import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addUsage,
  asksDeepThinking,
  cacheVerdict,
  canChange,
  canRouteSubagent,
  clip,
  decideEffort,
  decideSubagentEffort,
  decideSubagentModel,
  DEFAULT_SUBAGENT_RAISE,
  escalatedLabel,
  folderName,
  formatStats,
  inheritedLabel,
  isLowered,
  longPromptLabel,
  mergeStats,
  newStats,
  parseLabel,
  parseRaise,
  readStats,
  shouldClassify,
  shouldEscalate,
  subagentWorthClassifying,
} from '../hooks/policy.ts'

test('subagent: haiku se banale, sonnet se semplice, senza modello esplicito, non fork', () => {
  const base = { fork: false, parentModel: 'claude-opus-5-5[1m]' }
  assert.equal(decideSubagentModel('banale', base), 'haiku')
  assert.equal(decideSubagentModel('semplice', base), 'sonnet')
  assert.equal(decideSubagentModel('semplice', base, false), null)
  assert.equal(decideSubagentModel('semplice', { ...base, parentModel: 'claude-sonnet-5' }), null)
  assert.equal(decideSubagentModel('banale', { ...base, parentModel: 'claude-sonnet-5' }), 'haiku')
  assert.equal(decideSubagentModel('semplice', { ...base, parentModel: 'claude-fable-5-1' }), 'sonnet')
  assert.equal(decideSubagentModel('semplice', { ...base, model: 'opus' }), null)
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

test('banale e semplice non alzano mai', () => {
  assert.equal(decideEffort('semplice', 'low'), null)
  assert.equal(decideEffort('semplice', 'medium'), null)
  assert.equal(decideEffort('banale', 'low'), null)
})

test('difficile alza fino a raiseTo, solo da high in su', () => {
  assert.equal(decideEffort('difficile', 'high'), 'xhigh')
  assert.equal(decideEffort('difficile', undefined), 'xhigh')
  assert.equal(decideEffort('difficile', 'high', 'max'), 'max')
  assert.equal(decideEffort('difficile', 'xhigh', 'max'), 'max')
  assert.equal(decideEffort('difficile', 'xhigh'), null)
  assert.equal(decideEffort('difficile', 'max'), null) // mai verso il basso
  assert.equal(decideEffort('difficile', 'medium'), null) // scelta dell'utente
  assert.equal(decideEffort('difficile', 'low'), null)
  assert.equal(decideEffort('difficile', 'high', null), null)
  assert.equal(decideEffort('difficile', 3), null)
})

test('parseRaise', () => {
  assert.equal(parseRaise(undefined), 'xhigh')
  assert.equal(parseRaise('max'), 'max')
  assert.equal(parseRaise('xhigh'), 'xhigh')
  assert.equal(parseRaise('off'), null)
  assert.equal(parseRaise('high'), null)
  assert.equal(parseRaise('low'), null)
  assert.equal(parseRaise(5), null)
})

test('parseRaise per i subagent: senza opzione non si alza', () => {
  assert.equal(parseRaise(undefined, DEFAULT_SUBAGENT_RAISE), null)
  assert.equal(parseRaise('xhigh', DEFAULT_SUBAGENT_RAISE), 'xhigh')
  assert.equal(parseRaise('off', DEFAULT_SUBAGENT_RAISE), null)
  assert.equal(decideSubagentEffort('difficile', 'high', parseRaise(undefined, DEFAULT_SUBAGENT_RAISE)), null)
})

test('escalatedLabel: solo le label che abbassano', () => {
  assert.equal(escalatedLabel('banale'), 'banale')
  assert.equal(escalatedLabel('semplice'), 'semplice')
  assert.equal(escalatedLabel('complesso'), null)
  assert.equal(escalatedLabel('difficile'), null)
  assert.equal(escalatedLabel(null), null)
})

test('isLowered', () => {
  assert.equal(isLowered('low', 'high'), true)
  assert.equal(isLowered('medium', undefined), true)
  assert.equal(isLowered('xhigh', 'high'), false)
  assert.equal(isLowered(null, 'high'), false)
})

test('longPromptLabel: di un prompt lungo conta solo difficile', () => {
  assert.equal(longPromptLabel('difficile'), 'difficile')
  assert.equal(longPromptLabel('banale'), 'complesso')
  assert.equal(longPromptLabel('semplice'), 'complesso')
  assert.equal(longPromptLabel(null), null)
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

test('canChange: con effort già low e niente da alzare niente classificazione', () => {
  assert.equal(canChange(undefined, 'xhigh'), true)
  assert.equal(canChange('high', null), true)
  assert.equal(canChange('medium', 'xhigh'), true)
  assert.equal(canChange('low', 'xhigh'), false)
  assert.equal(canChange('max', null), true) // si può abbassare
  assert.equal(canChange(3, 'xhigh'), false)
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
  assert.equal(parseLabel('Difficile'), 'difficile')
  assert.equal(parseLabel('banale o complesso'), null) // ambigua
  assert.equal(parseLabel('fast'), null)
  assert.equal(parseLabel(''), null)
})

test('inheritedLabel: solo seguiti brevissimi, mai complesso, mai due volte', () => {
  assert.equal(inheritedLabel('procedi', { label: 'difficile', inherited: false }), 'difficile')
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
  assert.equal(shouldEscalate(8, 8, true), true)
  assert.equal(shouldEscalate(7, 8, true), false)
  assert.equal(shouldEscalate(20, 0, true), false)
  assert.equal(shouldEscalate(20, 8, false), false) // invariato o alzato
})

test('shouldEscalate: un tool fallito rialza subito, solo un turno abbassato', () => {
  assert.equal(shouldEscalate(1, 8, true, true), true)
  assert.equal(shouldEscalate(1, 0, true, true), true) // anche con escalateAfter 0
  assert.equal(shouldEscalate(1, 8, false, true), false) // invariato o alzato
  assert.equal(shouldEscalate(1, 8, true, false), false)
})

test('asksDeepThinking: ultrathink e think hard, non le frasi comuni', () => {
  assert.equal(asksDeepThinking('ultrathink'), true)
  assert.equal(asksDeepThinking('Ultrathink: sistema il parser'), true)
  assert.equal(asksDeepThinking('sistema il parser, think hard'), true)
  assert.equal(asksDeepThinking('think harder about the cache'), true)
  assert.equal(asksDeepThinking('think really hard'), true)
  assert.equal(asksDeepThinking('think super hard'), true)
  assert.equal(asksDeepThinking('megathink'), true)
  assert.equal(asksDeepThinking('I think hardware is the problem'), false)
  assert.equal(asksDeepThinking('pensaci bene'), false)
  assert.equal(asksDeepThinking('think about it'), false)
  assert.equal(asksDeepThinking('/review ultrathink'), false)
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
  assert.equal(decideSubagentEffort('difficile', 'high'), 'xhigh')
  assert.equal(decideSubagentEffort('difficile', 'high', null), null)
})

test('readStats: riempie i buchi e scarta i valori non numerici', () => {
  const stats = readStats({ turns: 5, labels: { banale: 'x' }, extra: 1 }, 0)
  assert.equal(stats.turns, 5)
  assert.equal(stats.labels.banale, 0)
  assert.equal(stats.cache.same.n, 0)
  assert.equal('extra' in stats, false)
  assert.deepEqual(readStats(null, 7), newStats(7))
})

test('readStats: uno store della 0.5 riceve i campi nuovi a zero', () => {
  const stats = readStats({ escalated: 160, classifier: { calls: 3, input: 9, output: 1 }, subagents: { raised: 4 } }, 0)
  assert.equal(stats.escalated, 160)
  assert.deepEqual(stats.escalatedBy, { banale: 0, semplice: 0 })
  assert.equal(stats.escalatedOnError, 0)
  assert.equal(stats.deepThinking, 0)
  assert.equal(stats.classifier.calls, 3)
  assert.equal(stats.classifier.failed, 0)
  assert.equal(stats.classifier.ms, 0)
  assert.equal(stats.subagents.raised, 4)
  assert.equal(stats.subagents.labels.difficile, 0)
})

test('formatStats: rialzi per label, classificatore e label dei subagent', () => {
  const stats = newStats(0)
  stats.labels.banale = 10
  stats.escalatedBy.banale = 2
  stats.escalatedOnError = 1
  stats.deepThinking = 5
  stats.classifier.calls = 4
  stats.classifier.failed = 1
  stats.classifier.ms = 2000
  stats.subagents.labels.difficile = 3
  const text = formatStats(stats, [], true)
  assert.match(text, /Rialzati a metà per label: banale 2 \(20%\) · semplice 0 \(—\) · per errore di un tool 1/)
  assert.match(text, /di cui difficili per ultrathink 5/)
  assert.match(text, /senza label 1 \(25%\) · attesa media 500 ms/)
  assert.match(text, /Label dei subagent: banale 0 · semplice 0 · complesso 0 · difficile 3/)
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
  assert.match(formatStats(stats, ['veloce'], true), /INVALIDA la cache: cambi di effort/)
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

test('folderName: ultimo segmento del percorso', () => {
  assert.equal(folderName('C:\\Users\\Marra\\Desktop'), 'Desktop')
  assert.equal(folderName('C:\\Skills\\effort-router\\'), 'effort-router')
  assert.equal(folderName('/home/u/progetto'), 'progetto')
  assert.equal(folderName('C:\\'), 'C:')
  assert.equal(folderName(''), null)
  assert.equal(folderName(undefined), null)
})
