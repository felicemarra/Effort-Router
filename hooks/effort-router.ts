/**
 * effort-router — abbassa l'effort dei turni chiaramente semplici.
 *
 * prompt.submit: Haiku classifica il prompt (banale / semplice / complesso) in
 * parallelo alla partenza del turno, così la sua latenza si sovrappone al
 * lavoro del motore invece di sommarsi. Un seguito brevissimo (`sì`, `ok`)
 * eredita la label del turno prima senza chiamare Haiku.
 * turn.step: al primo step del turno aspetta la classificazione, applica
 * l'effort deciso e lo mantiene per il tool loop; se il loop si allunga lo
 * riporta all'effort della sessione. Il turno dopo riparte dall'effort della
 * sessione. Non alza mai oltre quello e non cambia mai il modello.
 * agent.spawn: un subagent banale va su Haiku, uno semplice gira a effort
 * medium per tutta la sua corsa.
 *
 * Misura: per ogni richiesta del turno principale registra quanta parte
 * dell'input ha servito la prompt cache, con l'effort invariato e cambiato.
 * Se cambiare effort risulta invalidare la cache, smette di abbassarlo sul
 * turno principale (cacheGuard). `/effort-router` mostra le statistiche.
 *
 * Haiku viene chiamato solo quando la risposta può cambiare qualcosa.
 * Fail-open: errore, timeout o risposta non valida lasciano il turno com'è.
 * Richiede CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 e Claude Code >= 2.1.280.
 */
import type { EngineInterface, Register } from 'claude-code'
import {
  addUsage,
  CACHE_GAP_MS,
  cacheVerdict,
  canLower,
  canRouteSubagent,
  classifyPrompt,
  clip,
  decideEffort,
  decideSubagentEffort,
  decideSubagentModel,
  formatStats,
  inheritedLabel,
  isFastModel,
  mergeStats,
  newStats,
  parseLabel,
  readStats,
  shouldClassify,
  shouldEscalate,
  subagentWorthClassifying,
  SYSTEM,
} from './policy.ts'
import type { Effort, Label, Stats } from './policy.ts'

const COMMAND = 'effort-router'
// Quanti subagent ricordare per applicarne l'effort: i più vecchi escono.
const MAX_TRACKED_AGENTS = 200

// Lo stato che gli helper qui sotto condividono con gli hook: uno per caricamento.
type State = {
  // Le statistiche all'ultima lettura dello store, e gli incrementi di questa
  // sessione da allora: si sommano solo al salvataggio.
  saved: Stats | null
  delta: Stats
  statsDirty: boolean
  fastTypes: Set<string> | null
  commandReady: boolean
  guardAnnounced: boolean
}

// Statistiche e memoria sono un di più: un loro errore non tocca mai la
// decisione sull'effort, quindi ogni accesso a $.store e $.clock è fail-open.
async function clockNow($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

async function load($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch (error) {
    $.ui.log(`[effort-router] store.get ${key} fallito: ${String(error)}`)
    return undefined
  }
}

async function save($: EngineInterface, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    // Resta in memoria per questa sessione.
  }
}

// Le statistiche complessive: quelle salvate (lette alla prima occorrenza)
// più gli incrementi di questa sessione.
async function getStats($: EngineInterface, st: State): Promise<Stats> {
  st.saved ??= readStats(await load($, 'stats'), await clockNow($))
  return mergeStats(st.saved, st.delta)
}

// Rilegge lo store e ci somma gli incrementi: le altre sessioni non si perdono.
async function saveStats($: EngineInterface, st: State): Promise<void> {
  if (!st.statsDirty) return
  st.statsDirty = false
  const merged = mergeStats(readStats(await load($, 'stats'), await clockNow($)), st.delta)
  st.delta = newStats(0)
  st.saved = merged
  await save($, 'stats', merged)
}

// Tipi di subagent che girano già su Haiku per definizione (es. un agente
// `model: haiku`): per loro la classificazione non cambierebbe nulla.
async function getFastTypes($: EngineInterface, st: State): Promise<Set<string>> {
  if (!st.fastTypes) {
    const raw = await load($, 'fastTypes')
    st.fastTypes = new Set(Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [])
  }
  return st.fastTypes
}

// Aggiunge o toglie un tipo sulla lista riletta dallo store, come per le statistiche.
async function setFastType($: EngineInterface, st: State, type: string, isFast: boolean): Promise<void> {
  st.fastTypes = null
  const fast = await getFastTypes($, st)
  if (isFast) fast.add(type)
  else fast.delete(type)
  await save($, 'fastTypes', [...fast])
}

// Se la protezione della cache è scattata; lo dice una volta.
async function guarded($: EngineInterface, st: State, cacheGuard: boolean): Promise<boolean> {
  if (!cacheGuard || cacheVerdict(await getStats($, st)) !== 'busting') return false
  if (!st.guardAnnounced) {
    st.guardAnnounced = true
    $.ui.log("[effort-router] cambiare effort invalida la prompt cache: sul turno principale l'effort non viene più abbassato (/effort-router)")
  }
  return true
}

async function ensureCommand($: EngineInterface, st: State): Promise<void> {
  if (st.commandReady) return
  st.commandReady = true
  try {
    await $.command.register({ name: COMMAND, description: 'Statistiche di effort-router (reset per azzerarle)', argumentHint: '[reset]', immediate: true })
  } catch {
    // Senza comando si perde solo il resoconto.
  }
}

// Haiku classifica un testo; null su timeout, errore o risposta non valida.
async function classify($: EngineInterface, st: State, text: string, timeoutMs: number): Promise<{ label: Label | null; said: string }> {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: classifyPrompt(text),
      maxTokens: 5,
      effort: 'low',
      timeoutMs,
    })
    const s = st.delta
    s.classifier.calls++
    s.classifier.input += reply.usage.input_tokens + reply.usage.cache_read_input_tokens + reply.usage.cache_creation_input_tokens
    s.classifier.output += reply.usage.output_tokens
    st.statsDirty = true
    if (!reply.isAnswered) return { label: null, said: reply.reason }
    const label = parseLabel(reply.text)
    return { label, said: label ?? `risposta non valida "${reply.text.slice(0, 20)}"` }
  } catch (error) {
    return { label: null, said: `classificazione fallita: ${String(error)}` }
  }
}

export const register: Register = (on, options) => {
  // Il turno aspetta al massimo questo: resta ben dentro il budget di un hook (10 s).
  const timeoutMs = typeof options.timeoutMs === 'number' ? Math.min(Math.max(options.timeoutMs, 100), 8000) : 1500
  const minChars = typeof options.minChars === 'number' ? options.minChars : 40
  const maxChars = typeof options.maxChars === 'number' ? options.maxChars : 2000
  const escalateAfter = typeof options.escalateAfter === 'number' ? options.escalateAfter : 8
  const inheritShort = typeof options.inheritShort === 'boolean' ? options.inheritShort : true
  const cacheGuard = typeof options.cacheGuard === 'boolean' ? options.cacheGuard : true
  const log = typeof options.logDecisions === 'boolean' ? options.logDecisions : true
  const routeSubagents = typeof options.routeSubagents === 'boolean' ? options.routeSubagents : true

  const st: State = { saved: null, delta: newStats(0), statsDirty: false, fastTypes: null, commandReady: false, guardAnnounced: false }
  // Una sola classificazione in attesa: i turni principali sono sequenziali.
  let pending: Promise<Label | null> | null = null
  let pendingInherited = false
  // La label del turno principale precedente, per i seguiti brevissimi.
  let last: { label: Label | null; inherited: boolean } = { label: null, inherited: false }
  let appliedTurnId: string | undefined
  let applied: Effort | null = null
  let turnLabel: Label | null = null
  // L'effort della sessione all'ultimo turno (prima della riscrittura): se è già
  // low, il turno dopo non vale una chiamata a Haiku.
  let sessionEffort: unknown
  // L'effort dell'ultima richiesta del turno principale e quando è finita.
  let lastSent: { effort: unknown; model: string; at: number } | null = null
  // Label dei subagent in corsa, per l'effort dei loro step.
  const agentLabels = new Map<string, Label>()

  on('session.start', async ($, e, next) => {
    await ensureCommand($, st)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if ((e.args ?? '').trim() === 'reset') {
      st.saved = newStats(await clockNow($))
      st.delta = newStats(0)
      st.statsDirty = false
      st.guardAnnounced = false
      await save($, 'stats', st.saved)
      st.fastTypes = new Set()
      await save($, 'fastTypes', [])
      return { text: 'effort-router: statistiche e tipi di subagent azzerati.' }
    }
    return { text: formatStats(await getStats($, st), [...(await getFastTypes($, st))], cacheGuard) }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!st.commandReady) {
      await ensureCommand($, st)
      if (log) $.ui.log("[effort-router] attivo: abbassa l'effort solo sui turni semplici")
    }
    // Consegnato dentro un turno già in corso: non apre un turno suo.
    if (e.turnId) return next(e)
    pending = null
    pendingInherited = false
    if (await guarded($, st, cacheGuard)) return next(e)

    const inherited = inheritShort ? inheritedLabel(e.text, last) : null
    if (inherited) {
      pending = Promise.resolve(inherited)
      pendingInherited = true
      if (log) $.ui.log(`[effort-router] prompt: ${inherited} (ereditata dal turno prima)`)
      return next(e)
    }
    if (!shouldClassify(e.text, minChars, maxChars) || !canLower(sessionEffort)) return next(e)

    const classifying = classify($, st, e.text, timeoutMs).then(({ label, said }) => {
      if (log) $.ui.log(`[effort-router] prompt: ${said}`)
      return label
    })
    pending = classifying
    // Il turno parte subito; il primo turn.step aspetta la label. L'hook resta
    // vivo finché la classificazione non finisce, così la chiamata non è
    // abbandonata con il dispatch.
    const [result] = await Promise.all([next(e), classifying])
    // Prompt scartato più in basso: nessun turno, la label non vale per il prossimo.
    if ('drop' in result && result.drop && pending === classifying) pending = null
    return result
  })

  // Subagent: nessuna cache da perdere (partono da un contesto vuoto), quindi
  // un compito banale va su Haiku se nessuno ha già scelto il modello, e uno
  // banale o semplice gira con l'effort più basso per tutta la corsa.
  on('agent.spawn', async ($, e, next) => {
    const fast = await getFastTypes($, st)
    const knownFast = canRouteSubagent(e) && fast.has(e.subagentType)
    let label: Label | null = null
    let model: string | null = null
    if (routeSubagents && subagentWorthClassifying(e, knownFast)) {
      const classified = await classify($, st, clip(`${e.description}\n\n${e.prompt}`), timeoutMs)
      label = classified.label
      model = decideSubagentModel(label, e)
      const s = st.delta
      s.subagents.classified++
      if (model) s.subagents.toHaiku++
      st.statsDirty = true
      if (log) $.ui.log(`[effort-router] subagent ${e.subagentType} (${e.description}): ${classified.said}${model ? ` → ${model}` : ''}`)
    }
    const result = await next(model ? { ...e, model } : e)

    if (label && label !== 'complesso' && result.agentId) {
      agentLabels.set(result.agentId, label)
      if (agentLabels.size > MAX_TRACKED_AGENTS) agentLabels.delete(agentLabels.keys().next().value!)
    }
    // Senza il nostro intervento il tipo è finito su Haiku: lo sceglie da sé.
    // Se un tipo noto non ci finisce più, la sua definizione è cambiata.
    if (!model && canRouteSubagent(e) && result.model) {
      const isFast = isFastModel(result.model)
      if (isFast !== fast.has(e.subagentType)) await setFastType($, st, e.subagentType, isFast)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      const effort = decideSubagentEffort(agentLabels.get(e.agentId) ?? null, e.effort)
      if (effort && e.index === 0) {
        st.delta.subagents.lowered++
        st.statsDirty = true
      }
      return yield* next(effort ? { ...e, effort } : e)
    }

    const s = st.delta
    if (!(e.index > 0 && e.turnId === appliedTurnId)) {
      // Primo step del turno.
      sessionEffort = e.effort
      const waiting = pending
      const inherited = pendingInherited
      pending = null
      pendingInherited = false
      const label = waiting ? await waiting : null
      const guard = await guarded($, st, cacheGuard)
      applied = guard ? null : decideEffort(label, e.effort)
      appliedTurnId = e.turnId
      turnLabel = label
      last = { label, inherited }

      s.turns++
      if (label) s.labels[label]++
      if (applied) s.lowered++
      if (applied && inherited) s.inherited++
      if (guard) s.guarded++
      if (log) {
        const now = applied ?? e.effort ?? 'default'
        $.ui.status(`effort ${now}${label ? ` · ${label}` : ''}${applied ? ' · abbassato' : ''}${guard ? ' · cache guard' : ''}`)
        if (applied) $.ui.log(`[effort-router] turno → effort ${applied} (${label}${inherited ? ', ereditata' : ''})`)
      }
    } else if (shouldEscalate(e.index, escalateAfter, applied)) {
      // Il tool loop si allunga: il compito non era semplice, né da ereditare.
      applied = null
      last = { label: null, inherited: false }
      s.escalated++
      if (log) {
        $.ui.status(`effort ${e.effort ?? 'default'}${turnLabel ? ` · ${turnLabel}` : ''} · rialzato`)
        $.ui.log(`[effort-router] turno lungo (step ${e.index}) → effort della sessione`)
      }
    }
    st.statsDirty = true

    const sent = applied ?? e.effort
    const startedAt = await clockNow($)
    const result = yield* next(applied ? { ...e, effort: applied } : e)

    // Cache: si confrontano le richieste con cui la cache dovrebbe essere viva
    // (entro CACHE_GAP_MS dalla precedente, stesso modello), al primo step o a
    // un cambio di effort.
    if (lastSent && result.usage && e.model === lastSent.model && startedAt - lastSent.at < CACHE_GAP_MS) {
      const changed = sent !== lastSent.effort
      if (changed || e.index === 0) addUsage(changed ? s.cache.changed : s.cache.same, result.usage)
    }
    lastSent = { effort: sent, model: e.model, at: await clockNow($) }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await saveStats($, st)
    return result
  })

  on('session.end', async ($, e, next) => {
    await saveStats($, st)
    return next(e)
  })
}
