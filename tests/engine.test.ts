import { test, expect } from 'claude-code/testing'

const LUNGO_BANALE = 'mostrami il contenuto del file settings.json per favore'
const LUNGO_COMPLESSO = 'riprogetta il modulo di sincronizzazione tra i due server evitando race condition'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Sotto il plugin: il classificatore risponde `reply`, turn.step registra
// l'effort con cui la richiesta arriva al motore.
function bottom(on: any, reply: string | null, seen: unknown[], calls = { n: 0 }, status: unknown[] = []) {
  // Gli hook sui nomi di `$` rispondono { value } (o { deny }).
  on('model.complete', async () => (calls.n++, {
    value: reply === null ? { isAnswered: false, reason: 'aborted', usage: USAGE } : { isAnswered: true, text: reply, usage: USAGE },
  }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async (_$: any, e: any) => (status.push(e.text), { value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* ($: any, e: any) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

async function step($: any, turnId: string, index: number, effort = 'high') {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5[1m]', effort, messageCount: 1 })
  for await (const _ of stream) void _
}

test('prompt banale: il turno scende a low per tutto il tool loop', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await step($, 't1', 1)
  expect(seen).toEqual(['low', 'low'])
})

test('prompt semplice: medium', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'Semplice.', seen)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  expect(seen).toEqual(['medium'])
})

test('prompt complesso: resta high', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'complesso', seen)
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0)
  expect(seen).toEqual(['high'])
})

test('il turno dopo riparte da high', { options: { minChars: 40 } }, async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  // Tra 20 e 40 caratteri: né classificato né ereditato.
  await $.prompt.submit({ text: 'va bene, adesso procedi pure' })
  await step($, 't2', 0)
  expect(seen).toEqual(['low', 'high'])
})

test('timeout o risposta ambigua: turno invariato', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, null, seen)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  expect(seen).toEqual(['high'])
})

// Il tipo `veloce` ha `model: haiku` nella sua definizione.
function spawnBottom(on: any, reply: string | null, calls = { n: 0 }, seen: unknown[] = []) {
  bottom(on, reply, seen, calls)
  on('agent.spawn', async ($: any, e: any) => ({
    model: e.model ?? (e.subagentType === 'veloce' ? 'claude-haiku-4-5-20251001' : e.parentModel),
    agentId: 'a1',
  }))
}

async function spawn($: any, on: any, reply: string | null, extra: Record<string, unknown> = {}) {
  spawnBottom(on, reply)
  return spawnCall($, extra)
}

function spawnCall($: any, extra: Record<string, unknown> = {}) {
  return $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Trova in quali file viene definita la funzione parseConfig e riporta i percorsi.',
    description: 'Trova parseConfig',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5[1m]',
    background: false,
    fork: false,
    ...extra,
  })
}

test('subagent banale senza modello: va su haiku', async ($, on) => {
  expect((await spawn($, on, 'banale')).model).toEqual('haiku')
})

test('subagent semplice senza modello: va su sonnet', async ($, on) => {
  expect((await spawn($, on, 'semplice')).model).toEqual('sonnet')
})

test('subagent difficile: resta sul modello del padre, effort invariato di default', async ($, on) => {
  const seen: unknown[] = []
  spawnBottom(on, 'difficile', { n: 0 }, seen)
  const { agentId, model } = await spawnCall($)
  expect(model).toEqual('claude-opus-5-5[1m]')
  for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5[1m]', effort: 'high', messageCount: 1, agentId })) void _
  expect(seen).toEqual(['high'])
})

test('subagent difficile con subagentRaiseTo xhigh: sale a xhigh', { options: { subagentRaiseTo: 'xhigh' } }, async ($, on) => {
  const seen: unknown[] = []
  spawnBottom(on, 'difficile', { n: 0 }, seen)
  const { agentId } = await spawnCall($)
  for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5[1m]', effort: 'high', messageCount: 1, agentId })) void _
  expect(seen).toEqual(['xhigh'])
})

test('subagentRaiseTo non tocca il turno principale', { options: { raiseTo: 'max' } }, async ($, on) => {
  const seen: unknown[] = []
  spawnBottom(on, 'difficile', { n: 0 }, seen)
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0)
  const { agentId } = await spawnCall($)
  for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5[1m]', effort: 'high', messageCount: 1, agentId })) void _
  expect(seen).toEqual(['max', 'high'])
})

test('subagent complesso: eredita il modello del padre', async ($, on) => {
  expect((await spawn($, on, 'complesso')).model).toEqual('claude-opus-5-5[1m]')
})

test('subagent con modello esplicito: non si tocca', async ($, on) => {
  expect((await spawn($, on, 'banale', { model: 'sonnet' })).model).toEqual('sonnet')
})

test('fork: non si tocca', async ($, on) => {
  expect((await spawn($, on, 'banale', { fork: true, subagentType: 'fork' })).model).toEqual('claude-opus-5-5[1m]')
})

test('prompt corto: nessuna classificazione, turno invariato', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  await $.prompt.submit({ text: 'sì procedi' })
  await step($, 't1', 0)
  expect(seen).toEqual(['high'])
})

test('effort della sessione già low: il turno dopo non chiama Haiku', async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'banale', seen, calls)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0, 'low')
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't2', 0, 'low')
  expect(calls.n).toEqual(1)
  expect(seen).toEqual(['low', 'low'])
})

test('prompt oltre maxChars: classificato, ma non scende', async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'banale', seen, calls)
  await $.prompt.submit({ text: 'mostrami il file '.repeat(200) })
  await step($, 't1', 0)
  expect(calls.n).toEqual(1)
  expect(seen).toEqual(['high'])
})

test('prompt oltre maxChars difficile: sale a xhigh', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'difficile', seen)
  await $.prompt.submit({ text: 'analizza questo log di deadlock '.repeat(100) })
  await step($, 't1', 0)
  expect(seen).toEqual(['xhigh'])
})

test('prompt oltre maxChars con raiseTo off: nessuna classificazione', { options: { raiseTo: 'off' } }, async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'difficile', seen, calls)
  await $.prompt.submit({ text: 'mostrami il file '.repeat(200) })
  await step($, 't1', 0)
  expect(calls.n).toEqual(0)
  expect(seen).toEqual(['high'])
})

test('prompt difficile: xhigh per tutto il tool loop, anche lungo', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'difficile', seen)
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  for (let i = 0; i < 10; i++) await step($, 't1', i)
  expect(seen).toEqual(Array(10).fill('xhigh'))
  // Il seguito brevissimo resta difficile.
  await $.prompt.submit({ text: 'procedi' })
  await step($, 't2', 0)
  expect(seen.at(-1)).toEqual('xhigh')
})

test('prompt difficile con raiseTo max: max', { options: { raiseTo: 'max' } }, async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'difficile', seen)
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0)
  expect(seen).toEqual(['max'])
})

test('prompt difficile con raiseTo off: resta high', { options: { raiseTo: 'off' } }, async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'difficile', seen)
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0)
  expect(seen).toEqual(['high'])
})

test('prompt difficile con effort della sessione medium: non alza', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'difficile', seen)
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0, 'medium')
  expect(seen).toEqual(['medium'])
})

test('padre su haiku: il subagent non viene classificato', async ($, on) => {
  const calls = { n: 0 }
  spawnBottom(on, 'banale', calls)
  await spawnCall($, { parentModel: 'claude-haiku-4-5-20251001' })
  expect(calls.n).toEqual(0)
})

test('tipo di subagent già su haiku: classificato una volta sola', async ($, on) => {
  const calls = { n: 0 }
  spawnBottom(on, 'complesso', calls)
  expect((await spawnCall($, { subagentType: 'veloce' })).model).toEqual('claude-haiku-4-5-20251001')
  expect((await spawnCall($, { subagentType: 'veloce' })).model).toEqual('claude-haiku-4-5-20251001')
  expect(calls.n).toEqual(1)
  await spawnCall($, { subagentType: 'general-purpose' })
  expect(calls.n).toEqual(2)
})

test('il turno parte prima che Haiku risponda: il primo step aspetta la label', async ($, on) => {
  const seen: unknown[] = []
  const order: string[] = []
  let answer!: () => void
  const answered = new Promise<void>(resolve => (answer = resolve))
  on('model.complete', async () => {
    await answered
    order.push('label')
    return { value: { isAnswered: true, text: 'banale', usage: USAGE } }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('turn.step', async function* ($: any, e: any) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  // Come il motore: il turno parte dentro next(e), prima che l'hook ritorni.
  const test$ = $
  on('prompt.submit', async (_: any, e: any) => {
    order.push('turno')
    const stepping = step(test$, 't1', 0)
    answer()
    await stepping
    return { text: e.text }
  })
  await $.prompt.submit({ text: LUNGO_BANALE })
  expect(order).toEqual(['turno', 'label'])
  expect(seen).toEqual(['low'])
})

// Un $.store in memoria sotto il plugin.
function memoryStore(on: any, initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial))
  on('store.get', async ($: any, e: any) => ({ value: data.get(e.key) }))
  on('store.set', async ($: any, e: any) => (data.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('command.register', async ($: any, e: any) => ({ value: { command: e.name } }))
  return data
}

test('seguito brevissimo dopo un turno banale: eredita, ma una volta sola', async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'banale', seen, calls)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await $.prompt.submit({ text: 'sì grazie' })
  await step($, 't2', 0)
  await $.prompt.submit({ text: 'ok' })
  await step($, 't3', 0)
  expect(seen).toEqual(['low', 'low', 'high'])
  expect(calls.n).toEqual(1)
})

test('seguito brevissimo dopo un turno complesso: resta high', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'complesso', seen)
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0)
  await $.prompt.submit({ text: 'sì' })
  await step($, 't2', 0)
  expect(seen).toEqual(['high', 'high'])
})

test('tool loop lungo: dal passo 6 torna all effort della sessione', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  await $.prompt.submit({ text: LUNGO_BANALE })
  for (let i = 0; i < 8; i++) await step($, 't1', i)
  expect(seen).toEqual(['low', 'low', 'low', 'low', 'low', 'low', 'high', 'high'])
  // Un turno rialzato non lascia la label in eredità.
  await $.prompt.submit({ text: 'sì' })
  await step($, 't2', 0)
  expect(seen.at(-1)).toEqual('high')
})

test('subagent semplice: gira a medium per tutta la corsa', async ($, on) => {
  const seen: unknown[] = []
  spawnBottom(on, 'semplice', { n: 0 }, seen)
  const { agentId } = await spawnCall($)
  for (const index of [0, 1]) {
    for await (const _ of $.turn.step({ turnId: 's1', index, model: 'claude-opus-5-5[1m]', effort: 'high', messageCount: 1, agentId })) void _
  }
  expect(seen).toEqual(['medium', 'medium'])
})

const NOW = Date.UTC(2026, 10, 19, 12)
const BUSTING = { same: { n: 20, read: 950, total: 1000 }, changed: { n: 20, read: 100, total: 1000 } }

test('cache invalidata dal cambio di effort: niente più abbassamento né classificazione', async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'banale', seen, calls)
  on('clock.now', async () => ({ value: NOW }))
  memoryStore(on, { cacheDays: { '2026-11-10': BUSTING } })
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  expect(seen).toEqual(['high'])
  expect(calls.n).toEqual(0)
})

test('cache invalidata oltre la finestra o solo nei totali: la protezione non scatta', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  on('clock.now', async () => ({ value: NOW }))
  // 2026-11-05 è il quindicesimo giorno prima: fuori dai 14.
  memoryStore(on, { stats: { cache: BUSTING }, cacheDays: { '2026-11-05': BUSTING } })
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  expect(seen).toEqual(['low'])
})

test('misure della cache salvate per giorno, le vecchie escono; reset le azzera', async ($, on) => {
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'complesso', usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  on('clock.now', async () => ({ value: NOW }))
  on('turn.step', async function* ($: any, e: any) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    }
  })
  const data = memoryStore(on, { cacheDays: { '2026-11-05': BUSTING, '2026-11-19': BUSTING } })
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0)
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't2', 0) // high dopo high: invariato
  await complete($, 't2')
  const days = data.get('cacheDays') as any
  expect(Object.keys(days)).toEqual(['2026-11-19'])
  expect(days['2026-11-19'].same).toEqual({ n: 21, read: 1850, total: 2000 })
  const { text } = await $.command.run({ command: 'effort-router' })
  expect(text).toContain('Verdetto, sugli ultimi 14 giorni (21 richieste con effort invariato · 20 cambiato)')
  await $.command.run({ command: 'effort-router', args: 'reset' })
  expect(data.get('cacheDays')).toEqual({})
})

test('subagent con modello esplicito e sessione a low: Haiku non viene chiamato', async ($, on) => {
  const calls = { n: 0 }
  spawnBottom(on, 'banale', calls)
  const data = memoryStore(on)
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  await step($, 't1', 0, 'low')
  await spawnCall($, { model: 'sonnet' })
  expect(calls.n).toEqual(0)
  // Con la sessione a high l'effort del subagent si può abbassare: si classifica.
  await step($, 't2', 0, 'high')
  await spawnCall($, { model: 'sonnet' })
  expect(calls.n).toEqual(1)
  await complete($, 't2')
  expect((data.get('stats') as any).subagents.skipped).toEqual(1)
})

test('statistiche salvate a fine turno e mostrate da /effort-router', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  const data = memoryStore(on)
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const saved = data.get('stats') as any
  expect(saved.turns).toEqual(1)
  expect(saved.lowered).toEqual(1)
  expect(saved.classifier.calls).toEqual(1)
  const { text } = await $.command.run({ command: 'effort-router' })
  expect(text).toContain('abbassati 1 (100%)')
  expect(text).toContain('alzati 0')
  await $.command.run({ command: 'effort-router', args: 'reset' })
  expect((data.get('stats') as any).turns).toEqual(0)
})

test('tipi di subagent su haiku ricordati tra le sessioni', async ($, on) => {
  const calls = { n: 0 }
  spawnBottom(on, 'complesso', calls)
  memoryStore(on, { fastTypes: ['veloce'] })
  await spawnCall($, { subagentType: 'veloce' })
  expect(calls.n).toEqual(0)
})

// minChars 40: MEDIO (28 caratteri) non viene classificato e il turno resta high.
test('misura della cache: le richieste con effort cambiato e invariato finiscono in secchi diversi', { options: { minChars: 40 } }, async ($, on) => {
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'banale', usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  // Ogni richiesta legge 900 token dalla cache su 1000.
  on('turn.step', async function* ($: any, e: any) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    }
  })
  const data = memoryStore(on)
  const MEDIO = 'va bene, adesso procedi pure'
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0) // low: prima richiesta, non contata
  await step($, 't1', 1) // low, step interno: non contato
  await $.prompt.submit({ text: MEDIO })
  await step($, 't2', 0) // high dopo low: cambiato
  await $.prompt.submit({ text: MEDIO })
  await step($, 't3', 0) // high dopo high: invariato
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
  const { cache } = data.get('stats') as any
  expect(cache.changed).toEqual({ n: 1, read: 900, total: 1000 })
  expect(cache.same).toEqual({ n: 1, read: 900, total: 1000 })
})

test('due sessioni che salvano: gli incrementi si sommano, non si sovrascrivono', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  // Un'altra sessione ha già salvato 5 turni.
  const data = memoryStore(on, { stats: { since: 1, turns: 5, lowered: 2 } })
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  // Nel frattempo l'altra sessione arriva a 7.
  data.set('stats', { ...(data.get('stats') as any), turns: 7, lowered: 3 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const saved = data.get('stats') as any
  expect(saved.turns).toEqual(8)
  expect(saved.lowered).toEqual(4)
  expect(saved.since).toEqual(1)
})

test('statistiche: rialzi per label, classificazioni senza label, label dei subagent', async ($, on) => {
  const seen: unknown[] = []
  let reply = 'semplice'
  on('model.complete', async () => ({ value: { isAnswered: true, text: reply, usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* ($: any, e: any) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('agent.spawn', async ($: any, e: any) => ({ model: e.model ?? e.parentModel, agentId: 'a1' }))
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  const data = memoryStore(on)
  await $.prompt.submit({ text: LUNGO_BANALE })
  for (let i = 0; i < 9; i++) await step($, 't1', i)
  reply = 'boh'
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't2', 0)
  reply = 'difficile'
  await spawnCall($)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  const saved = data.get('stats') as any
  expect(saved.escalatedBy).toEqual({ banale: 0, semplice: 1 })
  expect(saved.classifier.calls).toEqual(3)
  expect(saved.classifier.failed).toEqual(1)
  expect(saved.subagents.labels.difficile).toEqual(1)
})

test('status line: nome della cartella di lavoro prima dell\'effort', async ($, on) => {
  const seen: unknown[] = []
  const status: unknown[] = []
  bottom(on, 'banale', seen, { n: 0 }, status)
  on('session.cwd', async () => ({ value: 'C:\\Sviluppo\\MultigraphClaude' }))
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  expect(status).toEqual(['MultigraphClaude · effort low · banale · abbassato'])
})

test('ultrathink: difficile senza chiamare Haiku, anche se cortissimo', async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'banale', seen, calls)
  await $.prompt.submit({ text: 'ultrathink' })
  await step($, 't1', 0)
  await $.prompt.submit({ text: 'sistema il parser, think hard' })
  await step($, 't2', 0)
  expect(calls.n).toEqual(0)
  expect(seen).toEqual(['xhigh', 'xhigh'])
})

test('ultrathink con raiseTo off o sessione medium: non alza, ma non abbassa mai', { options: { raiseTo: 'off' } }, async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'banale', seen, calls)
  await $.prompt.submit({ text: 'ultrathink: mostrami il file settings.json' })
  await step($, 't1', 0)
  await $.prompt.submit({ text: 'ultrathink: mostrami il file settings.json' })
  await step($, 't2', 0, 'medium')
  expect(calls.n).toEqual(0)
  expect(seen).toEqual(['high', 'medium'])
})

// Sotto il plugin: ogni tool risponde `answer` (un errore, un rifiuto, un risultato).
function toolBottom(on: any, answer: Record<string, unknown>) {
  on('tool.call', async () => answer)
}

async function bash($: any, agentId?: string) {
  return $.tool.call({ tool: 'Bash', command: 'npm test', ...(agentId ? { agentId } : {}) })
}

test('tool fallito in un turno abbassato: lo step dopo torna all effort della sessione', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  toolBottom(on, { result: 'exit 1', text: 'exit 1', isError: true })
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await bash($)
  await step($, 't1', 1)
  await step($, 't1', 2)
  expect(seen).toEqual(['low', 'high', 'high'])
  // Il turno dopo riparte pulito: abbassato di nuovo, nessun errore pendente.
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't2', 0)
  await step($, 't2', 1)
  expect(seen.slice(3)).toEqual(['low', 'low'])
})

test('tool rifiutato o riuscito: il turno resta abbassato', async ($, on) => {
  const seen: unknown[] = []
  let answer: Record<string, unknown> = { deny: "l'utente ha rifiutato" }
  bottom(on, 'banale', seen)
  on('tool.call', async () => answer)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await bash($)
  await step($, 't1', 1)
  answer = { result: 'ok', text: 'ok' }
  await bash($)
  await step($, 't1', 2)
  expect(seen).toEqual(['low', 'low', 'low'])
})

test('tool fallito in un subagent: il turno principale resta abbassato', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  toolBottom(on, { result: 'exit 1', text: 'exit 1', isError: true })
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await bash($, 'a1')
  await step($, 't1', 1)
  expect(seen).toEqual(['low', 'low'])
})

test('escalateOnError false: un tool fallito non rialza', { options: { escalateOnError: false } }, async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  toolBottom(on, { result: 'exit 1', text: 'exit 1', isError: true })
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await bash($)
  await step($, 't1', 1)
  expect(seen).toEqual(['low', 'low'])
})

test('statistiche: rialzi per errore di un tool e prompt ultrathink', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  toolBottom(on, { result: 'exit 1', text: 'exit 1', isError: true })
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  const data = memoryStore(on)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await bash($)
  await step($, 't1', 1)
  await $.prompt.submit({ text: 'ultrathink' })
  await step($, 't2', 0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  const saved = data.get('stats') as any
  expect(saved.escalated).toEqual(1)
  expect(saved.escalatedOnError).toEqual(1)
  expect(saved.escalatedBy.banale).toEqual(1)
  expect(saved.deepThinking).toEqual(1)
  expect(saved.labels.difficile).toEqual(1)
})

test('il classificatore riceve la label del turno prima', async ($, on) => {
  const prompts: string[] = []
  on('model.complete', async ($: any, e: any) => (prompts.push(e.prompt), { value: { isAnswered: true, text: 'difficile', usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0)
  await $.prompt.submit({ text: 'adesso fai lo stesso anche per gli altri due moduli' })
  await step($, 't2', 0)
  expect(prompts[0]).not.toContain('<turno-precedente>')
  expect(prompts[1]).toContain('<turno-precedente>difficile</turno-precedente>')
})

test('statistiche salvate anche per versione; /effort-router tutto mostra il totale', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  // Il totale delle versioni prima.
  const data = memoryStore(on, { stats: { since: 1, turns: 100, lowered: 40 } })
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((data.get('stats') as any).turns).toEqual(101)
  expect((data.get('stats@0.7.3') as any).turns).toEqual(1)
  const { text } = await $.command.run({ command: 'effort-router' })
  expect(text).toContain('statistiche della versione 0.7.3')
  expect(text).toContain('Turni principali: 1 ')
  expect(text).toContain('101 turni · abbassati 41')
  const all = await $.command.run({ command: 'effort-router', args: 'tutto' })
  expect(all.text).toContain('statistiche di tutte le versioni')
  expect(all.text).toContain('Turni principali: 101 ')
  await $.command.run({ command: 'effort-router', args: 'reset' })
  expect((data.get('stats') as any).turns).toEqual(0)
  expect((data.get('stats@0.7.3') as any).turns).toEqual(0)
})

test('il log "attivo" compare una volta, anche quando parte session.start', async ($, on) => {
  const logs: string[] = []
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'complesso', usage: USAGE } }))
  on('ui.log', async ($: any, e: any) => (logs.push(e.text), { value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('session.start', async ($: any, e: any) => ({ cwd: e.cwd }))
  memoryStore(on)
  await $.session.start({ cwd: '/progetto', surface: null, isInteractive: true })
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  expect(logs.filter(l => l.includes('0.7.3 attivo')).length).toEqual(1)
})

// Esperimento: 'h2' cade nel 10% di holdout, 't1'…'t5' no (vedi policy.unit.ts).
test('holdout: un turno banale resta all effort della sessione', async ($, on) => {
  const seen: unknown[] = []
  const status: unknown[] = []
  bottom(on, 'banale', seen, { n: 0 }, status)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 'h2', 0)
  await step($, 'h2', 1)
  expect(seen).toEqual(['high', 'high'])
  expect(status).toEqual(['effort high · banale · holdout'])
})

test('holdout 0: nessun turno lasciato com era', { options: { holdout: 0 } }, async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 'h2', 0)
  expect(seen).toEqual(['low'])
})

test('holdout anche su un turno ereditato: resta all effort della sessione', { options: { saveEveryMs: 0 } }, async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  const status: unknown[] = []
  bottom(on, 'banale', seen, calls, status)
  const data = memoryStore(on)
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await complete($, 't1')
  await $.prompt.submit({ text: 'sì grazie' })
  await step($, 'h2', 0)
  await step($, 'h2', 1)
  await complete($, 'h2')
  expect(seen).toEqual(['low', 'high', 'high'])
  expect(calls.n).toEqual(1)
  expect(status).toEqual(['effort low · banale · abbassato', 'effort high · banale · holdout'])
  // Contato tra gli ereditati anche se resta all'effort della sessione.
  const saved = data.get('stats') as any
  expect(saved.inherited).toEqual(1)
  expect(saved.lowered).toEqual(1)
})

// Come bottom, con usage per gli step, tool che falliscono e lo store.
function experimentBottom(on: any, reply: string) {
  on('model.complete', async () => ({ value: { isAnswered: true, text: reply, usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* ($: any, e: any) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    }
  })
  on('tool.call', async () => ({ result: 'exit 1', text: 'exit 1', isError: true }))
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  return memoryStore(on)
}

async function complete($: any, turnId: string, isAborted = false) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted, turnId, reason: isAborted ? 'aborted' : 'answer' })
}

test('esperimento: step, token, allungati, interrotti e corretti per gruppo', { options: { saveEveryMs: 0 } }, async ($, on) => {
  const data = experimentBottom(on, 'banale')
  // Abbassato: un tool fallisce, il turno si allunga; poi l'utente corregge.
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await bash($)
  await step($, 't1', 1)
  await complete($, 't1')
  // Holdout: stesso errore (contato, effort invariato), turno interrotto.
  await $.prompt.submit({ text: 'no, non funziona: ' + LUNGO_BANALE })
  await step($, 'h2', 0)
  await bash($)
  await step($, 'h2', 1)
  await complete($, 'h2', true)
  // Il prompt dopo il turno holdout non è una correzione.
  await $.prompt.submit({ text: 'ok, adesso passa al file successivo per favore' })
  await step($, 't2', 0)
  await complete($, 't2')
  const { banale } = (data.get('stats@0.7.3') as any).experiment
  expect(banale.lowered).toEqual({ turns: 2, steps: 3, output: 300, stretched: 1, aborted: 0, corrected: 1, reworked: 0 })
  expect(banale.holdout).toEqual({ turns: 1, steps: 2, output: 200, stretched: 1, aborted: 1, corrected: 0, reworked: 0 })
})

test('esperimento: turni complessi e difficili restano fuori', async ($, on) => {
  const data = experimentBottom(on, 'complesso')
  await $.prompt.submit({ text: LUNGO_COMPLESSO })
  await step($, 't1', 0)
  await $.prompt.submit({ text: 'no, non funziona ancora' })
  await step($, 't2', 0)
  await complete($, 't2')
  const { experiment } = data.get('stats') as any
  expect(experiment.banale.lowered.turns + experiment.banale.holdout.turns + experiment.semplice.lowered.turns + experiment.semplice.holdout.turns).toEqual(0)
  expect(experiment.banale.lowered.corrected).toEqual(0)
})

test('esperimento subagent: spostato su haiku contro holdout sul modello del padre', async ($, on) => {
  const seen: unknown[] = []
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'banale', usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('turn.step', async function* ($: any, e: any) {
    seen.push(`${e.agentId}:${e.effort}`)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, output_tokens: 50 } }
  })
  on('tool.call', async () => ({ result: 'exit 1', text: 'exit 1', isError: true }))
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  const data = memoryStore(on)
  on('agent.spawn', async ($: any, e: any) => ({ model: e.model ?? e.parentModel, agentId: `a-${e.tool_use_id}` }))
  // tu1 finisce fra gli spostati, h2 nell'holdout (vedi pickArm nei test di policy).
  const moved = await spawnCall($, { tool_use_id: 'tu1' })
  const held = await spawnCall($, { tool_use_id: 'h2' })
  expect(moved.model).toEqual('haiku')
  expect(held.model).toEqual('claude-opus-5-5[1m]')
  for (const agentId of ['a-tu1', 'a-h2']) {
    for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: 'm', effort: 'high', messageCount: 1, agentId })) void _
  }
  // L'holdout tiene anche l'effort che avrebbe.
  expect(seen).toEqual(['a-tu1:low', 'a-h2:high'])
  // Un tool fallito nello spostato lo segna allungato allo step dopo.
  await bash($, 'a-tu1')
  for await (const _ of $.turn.step({ turnId: 's1', index: 1, model: 'm', effort: 'high', messageCount: 1, agentId: 'a-tu1' })) void _
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 's1', reason: 'aborted', agentId: 'a-h2' })
  await complete($, 't1')
  const { subagentExperiment: x, subagents } = data.get('stats') as any
  expect(x.haiku.lowered).toEqual({ agents: 1, steps: 2, output: 100, stretched: 1, aborted: 0 })
  expect(x.haiku.holdout).toEqual({ agents: 1, steps: 1, output: 50, stretched: 0, aborted: 1 })
  expect(x.sonnet.lowered.agents + x.sonnet.holdout.agents).toEqual(0)
  expect(subagents.toHaiku).toEqual(1)
})

test('attesa del primo step: misurata sui turni classificati, non su quelli ereditati', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  const data = memoryStore(on)
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  // Ogni lettura dell'orologio avanza di 100 ms.
  let now = 0
  on('clock.now', async () => ({ value: (now += 100) }))
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await $.prompt.submit({ text: 'ok' }) // ereditata: nessuna attesa da misurare
  await step($, 't2', 0)
  await complete($, 't2')
  const { firstStepWait } = data.get('stats') as any
  expect(firstStepWait.turns).toEqual(1)
  expect(firstStepWait.ms).toEqual(100)
  expect(firstStepWait.buckets.le100).toEqual(1)
})

// Un verdetto della cache `ok` nella finestra: serve a `labelWaitMs`.
const CACHE_OK = { same: { n: 20, read: 900, total: 1000 }, changed: { n: 20, read: 880, total: 1000 } }

test('labelWaitMs con la cache verificata: primo step senza attesa, label dallo step dopo', { options: { labelWaitMs: 50 } }, async ($, on) => {
  const seen: unknown[] = []
  let called!: () => void
  const classifying = new Promise<void>(resolve => (called = resolve))
  on('model.complete', async () => {
    called()
    await new Promise(resolve => setTimeout(resolve, 40))
    return { value: { isAnswered: true, text: 'banale', usage: USAGE } }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* ($: any, e: any) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  on('clock.now', async () => ({ value: NOW }))
  on('clock.sleep', async () => ({ value: undefined })) // il budget scade subito
  const data = memoryStore(on, { cacheDays: { '2026-11-19': CACHE_OK } })
  // Il prompt.submit resta vivo finché Haiku risponde: il turno parte prima.
  const submitted = $.prompt.submit({ text: LUNGO_BANALE })
  await classifying
  await step($, 't1', 0)
  await submitted
  await step($, 't1', 1)
  await complete($, 't1')
  expect(seen).toEqual(['high', 'low'])
  const stats = data.get('stats') as any
  expect(stats.lateLabel).toEqual(1)
  expect(stats.lowered).toEqual(1)
  // Fuori dall'esperimento: il primo step non è stato abbassato.
  expect(stats.experiment.banale.lowered.turns + stats.experiment.banale.holdout.turns).toEqual(0)
})

test('labelWaitMs senza cache verificata: il primo step aspetta la label', { options: { labelWaitMs: 50 } }, async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  on('clock.sleep', async () => ({ value: undefined }))
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  expect(seen).toEqual(['low'])
})

test('subagent abbassato: un tool fallito lo riporta all effort di partenza', async ($, on) => {
  const seen: unknown[] = []
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'semplice', usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('turn.step', async function* ($: any, e: any) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', async () => ({ result: 'exit 1', text: 'exit 1', isError: true }))
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  on('agent.spawn', async ($: any, e: any) => ({ model: e.model ?? e.parentModel, agentId: 'a1' }))
  const data = memoryStore(on)
  // Modello esplicito: resta su sonnet, ma l'effort scende a medium.
  await spawnCall($, { model: 'sonnet' })
  for (const index of [0, 1, 2]) {
    if (index === 1) await bash($, 'a1')
    for await (const _ of $.turn.step({ turnId: 's1', index, model: 'sonnet', effort: 'high', messageCount: 1, agentId: 'a1' })) void _
  }
  expect(seen).toEqual(['medium', 'high', 'high'])
  await complete($, 't1')
  expect((data.get('stats') as any).subagents.escalated).toEqual(1)
})

test('classificatore: criteri dei subagent per gli spawn, inizio e fine dei prompt lunghi', { options: { raiseTo: 'xhigh' } }, async ($, on) => {
  const calls: any[] = []
  on('model.complete', async ($: any, e: any) => (calls.push(e), { value: { isAnswered: true, text: 'complesso', usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('agent.spawn', async ($: any, e: any) => ({ model: e.model ?? e.parentModel, agentId: 'a1' }))
  await $.prompt.submit({ text: `${'log '.repeat(1000)}\nperché fallisce?` })
  await step($, 't1', 0)
  await spawnCall($)
  expect(calls[0].prompt).toContain('perché fallisce?')
  expect(calls[0].prompt.length < 1700).toEqual(true)
  expect(calls[0].system).toContain("un assistente di programmazione.")
  expect(calls[1].system).toContain('sotto-agente')
})

test('giudizio del turno: un comando slash lo rimanda, /clear lo chiude', { options: { saveEveryMs: 0 } }, async ($, on) => {
  const data = experimentBottom(on, 'banale')
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await $.prompt.submit({ text: '/help' })
  await $.prompt.submit({ text: 'no, non funziona' })
  await step($, 't2', 0)
  await complete($, 't2')
  expect((data.get('stats') as any).experiment.banale.lowered.corrected).toEqual(1)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't3', 0)
  await $.prompt.submit({ text: '/clear' })
  await $.prompt.submit({ text: 'no, non funziona' })
  await step($, 't4', 0)
  await complete($, 't4')
  expect((data.get('stats') as any).experiment.banale.lowered.corrected).toEqual(1)
})

test('timeout adattivo: con abbastanza misure scende al p95 con margine', async ($, on) => {
  const timeouts: unknown[] = []
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('model.complete', async ($: any, e: any) => (timeouts.push(e.timeoutMs), { value: { isAnswered: true, text: 'banale', usage: USAGE } }))
  const buckets: Record<string, number> = { le500: 60 }
  memoryStore(on, { stats: { classifier: { calls: 60, durations: { turns: 60, ms: 24000, buckets } } } })
  await $.prompt.submit({ text: LUNGO_BANALE })
  expect(timeouts).toEqual([750])
  const { text } = await $.command.run({ command: 'effort-router' })
  expect(text).toContain('Timeout del classificatore: 750 ms (adattivo; configurato 1500 ms)')
})

test('salvataggio: al più uno ogni saveEveryMs, il primo subito', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  on('clock.now', async () => ({ value: NOW }))
  const data = memoryStore(on)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await complete($, 't1')
  expect((data.get('stats') as any).turns).toEqual(1)
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't2', 0)
  await complete($, 't2')
  expect((data.get('stats') as any).turns).toEqual(1)
  // Il resoconto conta anche quello che non è ancora salvato.
  const { text } = await $.command.run({ command: 'effort-router' })
  expect(text).toContain('Turni principali: 2')
})

test('esperimento: un turno il cui turno dopo rimodifica gli stessi file è rifatto', { options: { saveEveryMs: 0 } }, async ($, on) => {
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'banale', usage: USAGE } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }))
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  const data = memoryStore(on)
  const edit = (file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
  // t1 modifica a.ts; t2 lo rimodifica (scritto diverso): t1 rifatto, una volta sola.
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  await edit('C:\\src\\a.ts')
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't2', 0)
  await edit('c:/src/A.ts')
  await edit('c:/src/a.ts')
  // t3 modifica un altro file: t2 non è rifatto.
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't3', 0)
  await edit('c:/src/b.ts')
  // t4 rimodifica a.ts, ma t3 non l'aveva toccato e t2 non è più il turno prima.
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't4', 0)
  await edit('c:/src/a.ts')
  await complete($, 't4')
  const { banale } = (data.get('stats') as any).experiment
  expect(banale.lowered.turns).toEqual(4)
  expect(banale.lowered.reworked).toEqual(1)
})
