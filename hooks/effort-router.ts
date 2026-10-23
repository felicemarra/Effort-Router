/**
 * effort-router — abbassa l'effort dei turni semplici, lo alza su quelli difficili.
 *
 * prompt.submit: Haiku classifica il prompt (banale / semplice / complesso / difficile) in
 * parallelo alla partenza del turno, così la sua latenza si sovrappone al
 * lavoro del motore invece di sommarsi. Un seguito brevissimo (`sì`, `ok`)
 * eredita la label del turno prima senza chiamare Haiku; un prompt con
 * `ultrathink` (o `think hard`…) vale difficile senza chiamarlo.
 * turn.step: al primo step del turno aspetta la classificazione, applica
 * l'effort deciso e lo mantiene per il tool loop; se il loop si allunga, o un
 * tool restituisce un errore (tool.call), lo riporta all'effort della
 * sessione. Il turno dopo riparte dall'effort della
 * sessione. Un turno difficile sale a `raiseTo` (default xhigh). Non cambia
 * mai il modello.
 * agent.spawn: un subagent banale va su Haiku, uno semplice su Sonnet a
 * effort medium, uno difficile resta sul suo modello a effort
 * `subagentRaiseTo` (default: nessun rialzo), per tutta la sua corsa.
 *
 * Misura: per ogni richiesta del turno principale registra quanta parte
 * dell'input ha servito la prompt cache, con l'effort invariato e cambiato.
 * Se cambiare effort risulta invalidare la cache, smette di cambiarlo sul
 * turno principale (cacheGuard). `/effort-router` mostra le statistiche.
 *
 * Haiku viene chiamato solo quando la risposta può cambiare qualcosa.
 * Fail-open: errore, timeout o risposta non valida lasciano il turno com'è.
 * Richiede CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 e Claude Code >= 2.1.280.
 */
import type { EngineInterface, Register } from 'claude-code'
import {
  addUsage,
  asksDeepThinking,
  CACHE_GAP_MS,
  cacheVerdict,
  canChange,
  canRouteSubagent,
  classifyPrompt,
  clip,
  decideEffort,
  decideSubagentEffort,
  decideSubagentModel,
  DEFAULT_ESCALATE_AFTER,
  DEFAULT_SUBAGENT_RAISE,
  escalatedLabel,
  folderName,
  formatStats,
  inheritedLabel,
  isCorrection,
  isFastModel,
  isLowered,
  longPromptLabel,
  MID_SUBAGENT_MODEL,
  mergeStats,
  newStats,
  parseHoldout,
  parseLabel,
  parseRaise,
  pickArm,
  readStats,
  shouldClassify,
  shouldEscalate,
  subagentWorthClassifying,
  SYSTEM,
  turnFraction,
  VERSION,
  versionStatsKey,
} from './policy.ts'
import type { Arm, Effort, Label, Stats, TestedLabel } from './policy.ts'

const COMMAND = 'effort-router'
// Quanti subagent ricordare per applicarne l'effort: i più vecchi escono.
const MAX_TRACKED_AGENTS = 200

// Lo stato che gli helper qui sotto condividono con gli hook: uno per caricamento.
type State = {
  // Le statistiche all'ultima lettura dello store (il totale e quelle di
  // questa versione), e gli incrementi di questa sessione da allora: si
  // sommano a entrambe solo al salvataggio.
  saved: Stats | null
  savedVersion: Stats | null
  delta: Stats
  statsDirty: boolean
  fastTypes: Set<string> | null
  started: boolean
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

// La cartella di lavoro della sessione, in testa alla status line; '' se non si sa.
async function folderPrefix($: EngineInterface): Promise<string> {
  try {
    const name = folderName(await $.session.cwd())
    return name ? `${name} · ` : ''
  } catch {
    return ''
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

const VERSION_KEY = versionStatsKey(VERSION)

// Le statistiche di tutte le versioni (o solo di questa): quelle salvate
// (lette alla prima occorrenza) più gli incrementi di questa sessione.
async function getStats($: EngineInterface, st: State, onlyVersion = false): Promise<Stats> {
  if (onlyVersion) {
    st.savedVersion ??= readStats(await load($, VERSION_KEY), await clockNow($))
    return mergeStats(st.savedVersion, st.delta)
  }
  st.saved ??= readStats(await load($, 'stats'), await clockNow($))
  return mergeStats(st.saved, st.delta)
}

// Rilegge lo store e ci somma gli incrementi: le altre sessioni non si perdono.
async function saveStats($: EngineInterface, st: State): Promise<void> {
  if (!st.statsDirty) return
  st.statsDirty = false
  const now = await clockNow($)
  const merged = mergeStats(readStats(await load($, 'stats'), now), st.delta)
  const mergedVersion = mergeStats(readStats(await load($, VERSION_KEY), now), st.delta)
  st.delta = newStats(0)
  st.saved = merged
  st.savedVersion = mergedVersion
  await save($, 'stats', merged)
  await save($, VERSION_KEY, mergedVersion)
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
    $.ui.log("[effort-router] cambiare effort invalida la prompt cache: sul turno principale l'effort non viene più cambiato (/effort-router)")
  }
  return true
}

// Alla prima occorrenza (session.start o, se il plugin arriva a sessione
// avviata, il primo prompt): registra il comando e dice che è attivo.
async function start($: EngineInterface, st: State, announce: string | null): Promise<void> {
  if (st.started) return
  st.started = true
  try {
    await $.command.register({ name: COMMAND, description: 'Statistiche di effort-router (tutto: di tutte le versioni; reset per azzerarle)', argumentHint: '[tutto|reset]', immediate: true })
  } catch {
    // Senza comando si perde solo il resoconto.
  }
  if (announce) $.ui.log(announce)
}

// Haiku classifica un testo; null su timeout, errore o risposta non valida.
// `previous`: la label del turno prima, contesto per i rimandi.
async function classify($: EngineInterface, st: State, text: string, timeoutMs: number, previous: Label | null = null): Promise<{ label: Label | null; said: string }> {
  const s = st.delta
  const startedAt = await clockNow($)
  let result: { label: Label | null; said: string }
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: classifyPrompt(text, previous),
      maxTokens: 5,
      effort: 'low',
      timeoutMs,
    })
    s.classifier.input += reply.usage.input_tokens + reply.usage.cache_read_input_tokens + reply.usage.cache_creation_input_tokens
    s.classifier.output += reply.usage.output_tokens
    if (!reply.isAnswered) result = { label: null, said: reply.reason }
    else {
      const label = parseLabel(reply.text)
      result = { label, said: label ?? `risposta non valida "${reply.text.slice(0, 20)}"` }
    }
  } catch (error) {
    result = { label: null, said: `classificazione fallita: ${String(error)}` }
  }
  s.classifier.calls++
  s.classifier.ms += Math.max(0, (await clockNow($)) - startedAt)
  if (!result.label) s.classifier.failed++
  st.statsDirty = true
  return result
}

export const register: Register = (on, options) => {
  // Il turno aspetta al massimo questo: resta ben dentro il budget di un hook (10 s).
  const timeoutMs = typeof options.timeoutMs === 'number' ? Math.min(Math.max(options.timeoutMs, 100), 8000) : 1500
  const minChars = typeof options.minChars === 'number' ? options.minChars : 12
  const maxChars = typeof options.maxChars === 'number' ? options.maxChars : 2000
  const escalateAfter = typeof options.escalateAfter === 'number' ? options.escalateAfter : DEFAULT_ESCALATE_AFTER
  const escalateOnError = typeof options.escalateOnError === 'boolean' ? options.escalateOnError : true
  const inheritShort = typeof options.inheritShort === 'boolean' ? options.inheritShort : true
  const cacheGuard = typeof options.cacheGuard === 'boolean' ? options.cacheGuard : true
  const log = typeof options.logDecisions === 'boolean' ? options.logDecisions : true
  const routeSubagents = typeof options.routeSubagents === 'boolean' ? options.routeSubagents : true
  const sonnetForSimple = typeof options.sonnetForSimple === 'boolean' ? options.sonnetForSimple : true
  // La percentuale di turni da abbassare lasciati all'effort della sessione, per confronto.
  const holdout = parseHoldout(options.holdout)
  // L'effort dei compiti difficili (xhigh, max) o null per non alzare mai.
  const raiseTo = parseRaise(options.raiseTo)
  // Lo stesso per i subagent: di default non si alza.
  const subagentRaiseTo = parseRaise(options.subagentRaiseTo, DEFAULT_SUBAGENT_RAISE)

  const st: State = { saved: null, savedVersion: null, delta: newStats(0), statsDirty: false, fastTypes: null, started: false, guardAnnounced: false }
  const announce = log ? `[effort-router] ${VERSION} attivo: abbassa l'effort sui turni semplici${raiseTo ? `, lo alza a ${raiseTo} su quelli difficili` : ''}` : null
  // Una sola classificazione in attesa: i turni principali sono sequenziali.
  let pending: Promise<Label | null> | null = null
  let pendingInherited = false
  // La label del turno principale precedente, per i seguiti brevissimi.
  let last: { label: Label | null; inherited: boolean } = { label: null, inherited: false }
  let appliedTurnId: string | undefined
  let applied: Effort | null = null
  // Se `applied` è sotto l'effort della sessione (sopra = turno difficile).
  let lowered = false
  // Un tool del turno principale ha restituito un errore dall'ultimo step.
  let toolFailed = false
  let turnLabel: Label | null = null
  // Il gruppo dell'esperimento del turno principale (banale o semplice da
  // abbassare): resta fino al primo step del turno dopo, perché il prompt
  // seguente dice se la risposta andava corretta.
  let experiment: { label: TestedLabel; arm: Arm; stretched: boolean; judged: boolean } | null = null
  // L'effort della sessione all'ultimo turno (prima della riscrittura): se è già
  // low, il turno dopo non vale una chiamata a Haiku.
  let sessionEffort: unknown
  // L'effort dell'ultima richiesta del turno principale e quando è finita.
  let lastSent: { effort: unknown; model: string; at: number } | null = null
  // Label dei subagent in corsa, per l'effort dei loro step.
  const agentLabels = new Map<string, Label>()

  on('session.start', async ($, e, next) => {
    await start($, st, announce)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'reset') {
      const now = await clockNow($)
      st.saved = newStats(now)
      st.savedVersion = newStats(now)
      st.delta = newStats(0)
      st.statsDirty = false
      st.guardAnnounced = false
      await save($, 'stats', st.saved)
      await save($, VERSION_KEY, st.savedVersion)
      st.fastTypes = new Set()
      await save($, 'fastTypes', [])
      return { text: 'effort-router: statistiche e tipi di subagent azzerati.' }
    }
    const fastTypes = [...(await getFastTypes($, st))]
    const total = await getStats($, st)
    if (arg === 'tutto') return { text: formatStats(total, fastTypes, cacheGuard) }
    return { text: formatStats(await getStats($, st, true), fastTypes, cacheGuard, VERSION, total) }
  })

  on('prompt.submit', async ($, e, next) => {
    await start($, st, announce)
    // Consegnato dentro un turno già in corso: non apre un turno suo.
    if (e.turnId) return next(e)
    // Il prompt dopo un turno dell'esperimento: corregge la risposta?
    if (experiment && !experiment.judged) {
      experiment.judged = true
      if (isCorrection(e.text)) {
        st.delta.experiment[experiment.label][experiment.arm].corrected++
        st.statsDirty = true
      }
    }
    pending = null
    pendingInherited = false
    if (await guarded($, st, cacheGuard)) return next(e)

    // `ultrathink` e simili: l'utente ha già deciso, Haiku non serve.
    if (asksDeepThinking(e.text)) {
      pending = Promise.resolve<Label>('difficile')
      st.delta.deepThinking++
      st.statsDirty = true
      if (log) $.ui.log('[effort-router] prompt: difficile (ultrathink)')
      return next(e)
    }

    const inherited = inheritShort ? inheritedLabel(e.text, last) : null
    if (inherited) {
      pending = Promise.resolve(inherited)
      pendingInherited = true
      if (log) $.ui.log(`[effort-router] prompt: ${inherited} (ereditata dal turno prima)`)
      return next(e)
    }
    // Un prompt lungo non si abbassa, ma può essere difficile: si classifica
    // il suo inizio solo se c'è un effort a cui alzarlo.
    const long = !shouldClassify(e.text, 0, maxChars)
    if (!shouldClassify(e.text, minChars) || (long && !raiseTo) || !canChange(sessionEffort, raiseTo)) return next(e)

    const classifying = classify($, st, long ? clip(e.text) : e.text, timeoutMs, last.label).then(({ label, said }) => {
      const kept = long ? longPromptLabel(label) : label
      if (log) $.ui.log(`[effort-router] prompt: ${said}${kept !== label ? ` (prompt lungo: ${kept})` : ''}`)
      return kept
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
  // un compito banale va su Haiku e uno semplice su Sonnet se nessuno ha già
  // scelto il modello; entrambi girano con l'effort più basso per tutta la corsa.
  on('agent.spawn', async ($, e, next) => {
    const fast = await getFastTypes($, st)
    const knownFast = canRouteSubagent(e) && fast.has(e.subagentType)
    let label: Label | null = null
    let model: string | null = null
    if (routeSubagents && subagentWorthClassifying(e, knownFast)) {
      const classified = await classify($, st, clip(`${e.description}\n\n${e.prompt}`), timeoutMs)
      label = classified.label
      model = decideSubagentModel(label, e, sonnetForSimple)
      const s = st.delta
      s.subagents.classified++
      if (label) s.subagents.labels[label]++
      if (model === MID_SUBAGENT_MODEL) s.subagents.toSonnet++
      else if (model) s.subagents.toHaiku++
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
      const effort = decideSubagentEffort(agentLabels.get(e.agentId) ?? null, e.effort, subagentRaiseTo)
      if (effort && e.index === 0) {
        if (isLowered(effort, e.effort)) st.delta.subagents.lowered++
        else st.delta.subagents.raised++
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
      applied = guard ? null : decideEffort(label, e.effort, raiseTo)
      lowered = isLowered(applied, e.effort)
      toolFailed = false
      appliedTurnId = e.turnId
      turnLabel = label
      last = { label, inherited }
      // Un turno da abbassare su `holdout` resta all'effort della sessione.
      const tested = applied && lowered ? escalatedLabel(label) : null
      experiment = tested ? { label: tested, arm: pickArm(holdout, turnFraction(e.turnId)), stretched: false, judged: false } : null
      if (experiment) s.experiment[experiment.label][experiment.arm].turns++
      if (experiment?.arm === 'holdout') {
        applied = null
        lowered = false
      }

      s.turns++
      if (label) s.labels[label]++
      if (applied && lowered) s.lowered++
      if (applied && !lowered) s.raised++
      // Anche un turno ereditato finito in holdout ha ereditato la label.
      if ((applied || experiment) && inherited) s.inherited++
      if (guard) s.guarded++
      if (log) {
        const now = applied ?? e.effort ?? 'default'
        const change = applied ? (lowered ? ' · abbassato' : ' · alzato') : experiment ? ' · holdout' : ''
        $.ui.status(`${await folderPrefix($)}effort ${now}${label ? ` · ${label}` : ''}${change}${guard ? ' · cache guard' : ''}`)
        if (applied) $.ui.log(`[effort-router] turno → effort ${applied} (${label}${inherited ? ', ereditata' : ''})`)
        else if (experiment) $.ui.log(`[effort-router] turno ${label} lasciato all'effort della sessione (holdout)`)
      }
    } else if (shouldEscalate(e.index, escalateAfter, lowered, toolFailed)) {
      // Il tool loop si allunga o un tool fallisce: il compito non era
      // semplice, né da ereditare.
      const onError = toolFailed
      applied = null
      lowered = false
      toolFailed = false
      last = { label: null, inherited: false }
      s.escalated++
      if (onError) s.escalatedOnError++
      if (experiment && !experiment.stretched) {
        experiment.stretched = true
        s.experiment[experiment.label][experiment.arm].stretched++
      }
      const by = escalatedLabel(turnLabel)
      if (by) s.escalatedBy[by]++
      if (log) {
        $.ui.status(`${await folderPrefix($)}effort ${e.effort ?? 'default'}${turnLabel ? ` · ${turnLabel}` : ''} · rialzato`)
        $.ui.log(`[effort-router] ${onError ? 'errore di un tool' : 'turno lungo'} (step ${e.index}) → effort della sessione`)
      }
    } else if (experiment?.arm === 'holdout' && !experiment.stretched && shouldEscalate(e.index, escalateAfter, true, toolFailed)) {
      // Un turno holdout che, abbassato, sarebbe stato rialzato qui.
      experiment.stretched = true
      toolFailed = false
      s.experiment[experiment.label].holdout.stretched++
    }
    st.statsDirty = true

    const sent = applied ?? e.effort
    const startedAt = await clockNow($)
    const result = yield* next(applied ? { ...e, effort: applied } : e)
    if (experiment) {
      const arm = s.experiment[experiment.label][experiment.arm]
      arm.steps++
      arm.output += result.usage?.output_tokens ?? 0
    }

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

  // Un tool del turno principale che restituisce un errore (comando fallito,
  // Edit rifiutato, test rosso) rialza il turno abbassato allo step dopo (in
  // un turno holdout lo segna soltanto). Un rifiuto dell'utente (`deny`) no:
  // non dice nulla sulla difficoltà.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const watched = lowered || experiment?.arm === 'holdout'
    if (escalateOnError && watched && !e.agentId && result.isError) toolFailed = true
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.isAborted && experiment && e.turnId === appliedTurnId) {
      st.delta.experiment[experiment.label][experiment.arm].aborted++
      st.statsDirty = true
    }
    if (!e.agentId) await saveStats($, st)
    return result
  })

  on('session.end', async ($, e, next) => {
    await saveStats($, st)
    return next(e)
  })
}
