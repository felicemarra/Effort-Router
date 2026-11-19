import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addUsage,
  editedFile,
  asksDeepThinking,
  isCorrection,
  judgePrompt,
  parseHoldout,
  pickArm,
  turnFraction,
  classifyPrompt,
  adaptiveTimeout,
  addWait,
  cacheVerdict,
  clipEnds,
  mergeCacheDays,
  readCacheDays,
  subagentCanChange,
  sumCacheDays,
  waitPercentile,
  wilson,
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
  VERSION,
  versionStatsKey,
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
  assert.match(text, /senza label 1 \(25%\) · durata media 500 ms/)
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

test('classifyPrompt: la label del turno prima solo se c\'è', () => {
  assert.equal(classifyPrompt('fai lo stesso'), '<richiesta>\nfai lo stesso\n</richiesta>')
  assert.equal(classifyPrompt('fai lo stesso', 'difficile'), '<turno-precedente>difficile</turno-precedente>\n<richiesta>\nfai lo stesso\n</richiesta>')
  assert.equal(classifyPrompt('fai lo stesso', null), '<richiesta>\nfai lo stesso\n</richiesta>')
})

test('VERSION coincide con plugin.json', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, manifest.version)
  assert.equal(versionStatsKey('0.7.0'), 'stats@0.7.0')
})

test('formatStats: statistiche di una versione con la riga del totale', () => {
  const version = newStats(Date.UTC(2026, 9, 24))
  version.turns = 3
  const total = newStats(Date.UTC(2026, 8, 25))
  total.turns = 3239
  total.lowered = 1105
  total.raised = 86
  const text = formatStats(version, [], true, '0.7.0', total)
  assert.match(text, /statistiche della versione 0\.7\.0 dal 2026-10-24/)
  assert.match(text, /Tutte le versioni, dal 2026-09-25: 3239 turni · abbassati 1105 · alzati 86/)
  assert.match(formatStats(total, [], true), /statistiche di tutte le versioni dal 2026-09-25/)
  assert.doesNotMatch(formatStats(total, [], true), /Tutte le versioni, dal/)
})

test('parseHoldout: percentuale fra 0 e 50, default 10', () => {
  assert.equal(parseHoldout(undefined), 10)
  assert.equal(parseHoldout('x'), 10)
  assert.equal(parseHoldout(25), 25)
  assert.equal(parseHoldout(-5), 0)
  assert.equal(parseHoldout(90), 50)
})

test('pickArm e turnFraction: deterministico, uniforme sugli UUID', () => {
  assert.equal(pickArm(10, 0.05), 'holdout')
  assert.equal(pickArm(10, 0.1), 'lowered')
  assert.equal(pickArm(0, 0), 'lowered')
  assert.equal(turnFraction('h2'), turnFraction('h2'))
  assert.equal(pickArm(10, turnFraction('h2')), 'holdout') // usato dai test sul motore
  for (const id of ['t1', 't2', 't3', 't4', 't5', 's1']) assert.equal(pickArm(10, turnFraction(id)), 'lowered', id)
  let held = 0
  for (let i = 0; i < 20000; i++) if (pickArm(10, turnFraction(crypto.randomUUID())) === 'holdout') held++
  assert.ok(held > 1800 && held < 2200, `holdout ${held} su 20000`)
})

test('isCorrection: le correzioni, non le conferme', () => {
  for (const text of ['no, non quello', 'No.', 'non funziona', 'è sbagliato il percorso', 'hai sbagliato file', 'Ancora lo stesso errore', 'riprova', 'wrong file', "that's wrong", "it doesn't work", 'still failing', 'il test non va'])
    assert.equal(isCorrection(text), true, text)
  for (const text of ['ok procedi', 'sì grazie', 'no problem, go on', 'nota bene: usa tabs', 'normalizza i nomi', 'ora aggiungi i test', '/review no', 'errori di battitura nel README: correggili? sì'])
    assert.equal(isCorrection(text), false, text)
})

test('readStats: uno store della 0.6 riceve l\'esperimento a zero', () => {
  const stats = readStats({ turns: 9 }, 0)
  assert.deepEqual(stats.experiment.banale.holdout, { turns: 0, steps: 0, output: 0, stretched: 0, aborted: 0, corrected: 0, reworked: 0 })
})

test('formatStats: righe dell\'esperimento', () => {
  const stats = newStats(0)
  Object.assign(stats.experiment.banale.lowered, { turns: 4, steps: 10, output: 800, stretched: 1, aborted: 0, corrected: 1 })
  const text = formatStats(stats, [], true)
  assert.match(text, /banale abbassati: 4 turni · step medi 2\.5 · token out medi 200 · allungati 25% \(5–70%\) · interrotti 0% \(0–49%\) · corretti 25% \(5–70%\) · rifatti 0% \(0–49%\)/)
  assert.match(text, /semplice holdout  : 0 turni · step medi — · token out medi —/)
})

test('esperimento subagent: store vecchio a zero, righe nel resoconto', () => {
  assert.deepEqual(readStats({ turns: 9 }, 0).subagentExperiment.sonnet.holdout, { agents: 0, steps: 0, output: 0, stretched: 0, aborted: 0 })
  const stats = newStats(0)
  Object.assign(stats.subagentExperiment.haiku.lowered, { agents: 4, steps: 10, output: 800, stretched: 1, aborted: 0 })
  const text = formatStats(stats, [], true)
  assert.match(text, /haiku spostati: 4 subagent · step medi 2\.5 · token out medi 200 · allungati 25% \(5–70%\) · interrotti 0% \(0–49%\)/)
  assert.match(text, /sonnet holdout : 0 subagent · step medi —/)
})

test('cache per giorno: finestra di 14 giorni, chiavi malformate scartate, somma', () => {
  const now = Date.UTC(2026, 10, 19, 23)
  const one = { same: { n: 1, read: 9, total: 10 }, changed: { n: 0, read: 0, total: 0 } }
  const saved = readCacheDays({ '2026-11-05': one, '2026-11-06': one, 'stats': one, '2026-11-19': { same: { n: 'x' } } })
  assert.deepEqual(Object.keys(saved).sort(), ['2026-11-05', '2026-11-06', '2026-11-19'])
  const merged = mergeCacheDays(saved, { '2026-11-19': one }, now)
  assert.deepEqual(Object.keys(merged).sort(), ['2026-11-06', '2026-11-19'])
  assert.deepEqual(sumCacheDays(merged).same, { n: 2, read: 18, total: 20 })
  assert.deepEqual(readCacheDays([1]), {})
})

test('subagentCanChange: modello libero o effort che una label sposterebbe', () => {
  const spawn = { fork: false, parentModel: 'claude-opus-5-5' }
  assert.equal(subagentCanChange(spawn, 'low', null), true)
  assert.equal(subagentCanChange({ ...spawn, model: 'sonnet' }, 'high', null), true)
  assert.equal(subagentCanChange({ ...spawn, model: 'sonnet' }, 'low', null), false)
  assert.equal(subagentCanChange({ ...spawn, model: 'sonnet' }, 'low', 'xhigh'), false)
  assert.equal(subagentCanChange({ ...spawn, model: 'sonnet' }, 'high', 'xhigh'), true)
})

test('attesa del primo step: fasce, percentili e resoconto', () => {
  const stats = newStats(0)
  assert.equal(waitPercentile(stats.firstStepWait, 0.95), null)
  for (const ms of [0, 5, 40, 80, 120, 180, 250, 400, 900, 1400]) addWait(stats.firstStepWait, ms)
  assert.equal(waitPercentile(stats.firstStepWait, 0.5), 200)
  assert.equal(waitPercentile(stats.firstStepWait, 0.95), 1500)
  addWait(stats.firstStepWait, 9000)
  assert.equal(stats.firstStepWait.buckets.over, 1)
  assert.equal(waitPercentile(stats.firstStepWait, 1), Infinity)
  assert.match(formatStats(stats, [], true), /Attesa del primo step per la label: 11 turni · media 1125 ms · p50 ≤ 200 ms · p95 > 8000 ms/)
  assert.match(formatStats(newStats(0), [], true), /Attesa del primo step per la label: 0 turni · media — · p50 — · p95 —/)
  assert.equal(readStats({ turns: 1 }, 0).firstStepWait.buckets.le1000, 0)
})

test('wilson: intervallo al 95%, null senza campioni', () => {
  assert.equal(wilson(0, 0), null)
  const [lo, hi] = wilson(1, 4)!
  assert.ok(Math.abs(lo - 0.0456) < 0.001 && Math.abs(hi - 0.6994) < 0.001, `${lo} ${hi}`)
  const [lo2, hi2] = wilson(50, 100)!
  assert.ok(lo2 > 0.40 && hi2 < 0.60)
})

test('clipEnds: inizio e fine di un testo lungo', () => {
  assert.equal(clipEnds('abc', 2, 2), 'abc')
  assert.equal(clipEnds('0123456789', 3, 2), '012\n[…]\n89')
  const long = `${'a'.repeat(3000)}FINE`
  assert.ok(clipEnds(long).endsWith('FINE'))
  assert.ok(clipEnds(long).length < 1600)
})

test('judgePrompt: comandi slash rimandano, quelli che azzerano chiudono', () => {
  assert.equal(judgePrompt('no, non funziona'), 'corrected')
  assert.equal(judgePrompt('ora aggiungi i test'), 'clean')
  assert.equal(judgePrompt('/help'), 'wait')
  assert.equal(judgePrompt('/clear'), 'clean')
  assert.equal(judgePrompt('/new'), 'clean')
  for (const text of ['intendevo il file di test', 'volevo dire la seconda', 'I meant the other one', "that's not what I meant"])
    assert.equal(isCorrection(text), true, text)
})

test('adaptiveTimeout: configurato finché mancano misure, poi p95 con margine nei limiti', () => {
  const stats = newStats(0)
  const d = stats.classifier.durations
  for (let i = 0; i < 49; i++) addWait(d, 180)
  assert.equal(adaptiveTimeout(d, 1500), 1500)
  addWait(d, 180)
  assert.equal(adaptiveTimeout(d, 1500), 300) // p95 ≤ 200 · 1.5
  for (let i = 0; i < 100; i++) addWait(d, 450)
  assert.equal(adaptiveTimeout(d, 1500), 750)
  assert.equal(adaptiveTimeout(d, 600), 600) // mai sopra il configurato
  const slow = newStats(0).classifier.durations
  for (let i = 0; i < 60; i++) addWait(slow, 9000)
  assert.equal(adaptiveTimeout(slow, 1500), 1500)
  const fast = newStats(0).classifier.durations
  for (let i = 0; i < 60; i++) addWait(fast, 5)
  assert.equal(adaptiveTimeout(fast, 1500), 300) // mai sotto il minimo
})

test('editedFile: solo gli strumenti che modificano, percorso normalizzato', () => {
  assert.equal(editedFile({ tool: 'Edit', file_path: 'C:\\Src\\A.ts' }), 'c:/src/a.ts')
  assert.equal(editedFile({ tool: 'Write', file_path: 'c:/src/a.ts' }), 'c:/src/a.ts')
  assert.equal(editedFile({ tool: 'NotebookEdit', notebook_path: 'n.ipynb' }), 'n.ipynb')
  assert.equal(editedFile({ tool: 'Read', file_path: 'a.ts' }), null)
  assert.equal(editedFile({ tool: 'Bash', command: 'rm a.ts' }), null)
  assert.equal(editedFile({ tool: 'Edit' }), null)
})
