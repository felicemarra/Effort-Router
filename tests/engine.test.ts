import { test, expect } from 'claude-code/testing'

const LUNGO_BANALE = 'mostrami il contenuto del file settings.json per favore'
const LUNGO_COMPLESSO = 'riprogetta il modulo di sincronizzazione tra i due server evitando race condition'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Sotto il plugin: il classificatore risponde `reply`, turn.step registra
// l'effort con cui la richiesta arriva al motore.
function bottom(on: any, reply: string | null, seen: unknown[], calls = { n: 0 }) {
  // Gli hook sui nomi di `$` rispondono { value } (o { deny }).
  on('model.complete', async () => (calls.n++, {
    value: reply === null ? { isAnswered: false, reason: 'aborted', usage: USAGE } : { isAnswered: true, text: reply, usage: USAGE },
  }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
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

test('il turno dopo riparte da high', async ($, on) => {
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

test('prompt oltre maxChars: nessuna classificazione', async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'banale', seen, calls)
  await $.prompt.submit({ text: 'mostrami il file '.repeat(200) })
  await step($, 't1', 0)
  expect(calls.n).toEqual(0)
  expect(seen).toEqual(['high'])
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

test('tool loop lungo: dal passo 8 torna all effort della sessione', async ($, on) => {
  const seen: unknown[] = []
  bottom(on, 'banale', seen)
  await $.prompt.submit({ text: LUNGO_BANALE })
  for (let i = 0; i < 10; i++) await step($, 't1', i)
  expect(seen).toEqual(['low', 'low', 'low', 'low', 'low', 'low', 'low', 'low', 'high', 'high'])
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

test('cache invalidata dal cambio di effort: niente più abbassamento né classificazione', async ($, on) => {
  const seen: unknown[] = []
  const calls = { n: 0 }
  bottom(on, 'banale', seen, calls)
  memoryStore(on, {
    stats: { cache: { same: { n: 20, read: 950, total: 1000 }, changed: { n: 20, read: 100, total: 1000 } } },
  })
  await $.prompt.submit({ text: LUNGO_BANALE })
  await step($, 't1', 0)
  expect(seen).toEqual(['high'])
  expect(calls.n).toEqual(0)
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

test('misura della cache: le richieste con effort cambiato e invariato finiscono in secchi diversi', async ($, on) => {
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
