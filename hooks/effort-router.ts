/**
 * effort-router — abbassa l'effort dei turni semplici, lo alza su quelli difficili.
 *
 * prompt.submit: Haiku classifica il prompt (banale / semplice / complesso / difficile) in
 * parallelo alla partenza del turno, così la sua latenza si sovrappone al
 * lavoro del motore invece di sommarsi. Un seguito brevissimo (`sì`, `ok`)
 * eredita la label del turno prima senza chiamare Haiku; un prompt con
 * `ultrathink` (o `think hard`…) vale difficile senza chiamarlo.
 * turn.step: al primo step del turno aspetta la classificazione (al più
 * `labelWaitMs`, se impostato e la cache lo permette: oltre, la label vale
 * dallo step dopo), applica l'effort deciso e lo mantiene per il tool loop;
 * se il loop si allunga, o un tool restituisce un errore (tool.call), lo
 * riporta all'effort della sessione. Il turno dopo riparte dall'effort della
 * sessione. Un turno difficile sale a `raiseTo` (default xhigh). Non cambia
 * mai il modello.
 * agent.spawn: un subagent banale va su Haiku, uno semplice su Sonnet a
 * effort medium (con criteri di classificazione propri), uno difficile resta
 * sul suo modello a effort `subagentRaiseTo` (default: nessun rialzo). Un
 * subagent abbassato torna all'effort di partenza come un turno principale.
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
  adaptiveTimeout,
  addUsage,
  addWait,
  asksDeepThinking,
  CACHE_GAP_MS,
  cacheVerdict,
  canChange,
  canRouteSubagent,
  classifyPrompt,
  clip,
  clipEnds,
  day,
  decideEffort,
  decideSubagentEffort,
  decideSubagentModel,
  DEFAULT_ESCALATE_AFTER,
  DEFAULT_SUBAGENT_RAISE,
  escalatedLabel,
  folderName,
  formatStats,
  inheritedLabel,
  isFastModel,
  isLowered,
  judgePrompt,
  longPromptLabel,
  mergeCacheDays,
  MID_SUBAGENT_MODEL,
  mergeStats,
  newCache,
  newStats,
  parseHoldout,
  parseLabel,
  parseRaise,
  pickArm,
  readCacheDays,
  readStats,
  shouldClassify,
  shouldEscalate,
  SUBAGENT_SYSTEM,
  subagentCanChange,
  subagentWorthClassifying,
  sumCacheDays,
  SYSTEM,
  turnFraction,
  VERSION,
  versionStatsKey,
} from './policy.ts'
import type { Arm, Cache, CacheDays, Effort, Label, RoutedModel, Stats, TestedLabel } from './policy.ts'

const COMMAND = 'effort-router'
// Quanti subagent ricordare per applicarne l'effort: i più vecchi escono.
const MAX_TRACKED_AGENTS = 200

// Ricorda un subagent in corsa; oltre MAX_TRACKED_AGENTS esce il più vecchio.
function remember<T>(map: Map<string, T>, agentId: string, value: T): void {
  map.set(agentId, value)
  if (map.size > MAX_TRACKED_AGENTS) map.delete(map.keys().next().value!)
}

// Lo stato che gli helper qui sotto condividono con gli hook: uno per caricamento.
type State = {
  // Le statistiche all'ultima lettura dello store (il totale e quelle di
  // questa versione), e gli incrementi di questa sessione da allora: si
  // sommano a entrambe solo al salvataggio.
  saved: Stats | null
  savedVersion: Stats | null
  delta: Stats
  // Le misure della cache per giorno, salvate e di questa sessione, per il verdetto.
  cacheDays: CacheDays | null
  cacheDelta: CacheDays
  statsDirty: boolean
  fastTypes: Set<string> | null
  started: boolean
  guardAnnounced: boolean
  // L'ultimo salvataggio delle statistiche (null = mai in questa sessione).
  lastSavedAt: number | null
}

// Aspetta `ms`; se l'orologio non risponde non finisce mai, e chi lo mette in
// gara con la label aspetta la label (il comportamento di sempre).
async function sleepFor($: EngineInterface, ms: number): Promise<void> {
  try {
    await $.clock.sleep(ms)
  } catch {
    await new Promise<never>(() => {})
  }
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

// Le misure della cache degli ultimi CACHE_WINDOW_DAYS giorni, salvate più quelle di questa sessione.
async function getRecentCache($: EngineInterface, st: State): Promise<Cache> {
  st.cacheDays ??= readCacheDays(await load($, 'cacheDays'))
  return sumCacheDays(mergeCacheDays(st.cacheDays, st.cacheDelta, await clockNow($)))
}

// Rilegge lo store e ci somma gli incrementi: le altre sessioni non si perdono.
async function saveStats($: EngineInterface, st: State): Promise<void> {
  if (!st.statsDirty) return
  st.statsDirty = false
  const now = await clockNow($)
  st.lastSavedAt = now
  if (Object.keys(st.cacheDelta).length) {
    const days = mergeCacheDays(readCacheDays(await load($, 'cacheDays')), st.cacheDelta, now)
    st.cacheDelta = {}
    st.cacheDays = days
    await save($, 'cacheDays', days)
  }
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
  if (!cacheGuard || cacheVerdict({ cache: await getRecentCache($, st) }) !== 'busting') return false
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
// `previous`: la label del turno prima, contesto per i rimandi; `system`: i
// criteri (dei prompt dell'utente o dei compiti dei subagent).
async function classify($: EngineInterface, st: State, text: string, timeoutMs: number, previous: Label | null = null, system = SYSTEM): Promise<{ label: Label | null; said: string }> {
  const s = st.delta
  const startedAt = await clockNow($)
  let result: { label: Label | null; said: string }
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system,
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
  const ms = Math.max(0, (await clockNow($)) - startedAt)
  s.classifier.calls++
  s.classifier.ms += ms
  addWait(s.classifier.durations, ms)
  if (!result.label) s.classifier.failed++
  st.statsDirty = true
  return result
}

// Il turno principale in corso (o l'ultimo): resta fino al primo step del
// turno dopo, perché il prompt seguente dice se la risposta andava corretta.
type Turn = {
  id: string
  label: Label | null
  // L'effort applicato, o null per lasciare quello della sessione.
  applied: Effort | null
  // Se `applied` è sotto l'effort della sessione (sopra = turno difficile).
  lowered: boolean
  // Un tool del turno ha restituito un errore dall'ultimo step.
  toolFailed: boolean
  // Il gruppo dell'esperimento (banale o semplice da abbassare).
  experiment: { label: TestedLabel; arm: Arm; stretched: boolean; judged: boolean } | null
  // La label non ancora arrivata al primo step (`labelWaitMs`): vale dallo step in cui arriva.
  late: { label: Promise<Label | null>; inherited: boolean } | null
}

// Un subagent in corsa: la label che ne decide l'effort e il suo gruppo dell'esperimento.
type Agent = {
  label: Label | null
  experiment: { model: RoutedModel; arm: Arm } | null
  stretched: boolean
  toolFailed: boolean
  // Riportato all'effort di partenza: il compito non era semplice.
  escalated: boolean
}

const LATE = Symbol('late')

// Il timeout del classificatore: adattivo quando ci sono abbastanza misure.
async function classifierTimeout($: EngineInterface, st: State, adaptive: boolean, configured: number): Promise<number> {
  return adaptive ? adaptiveTimeout((await getStats($, st)).classifier.durations, configured) : configured
}

// Salva se è passato `everyMs` dall'ultimo salvataggio di questa sessione (0 = sempre).
async function maybeSave($: EngineInterface, st: State, everyMs: number): Promise<void> {
  const now = await clockNow($)
  if (everyMs === 0 || st.lastSavedAt === null || now - st.lastSavedAt >= everyMs) await saveStats($, st)
}

type DecideConfig = { raiseTo: Effort | null; holdout: number; log: boolean }

// L'effort del turno dalla sua label: al primo step o, con la label in
// ritardo (`late`), allo step in cui arriva. Restituisce la label da
// ricordare per il turno dopo.
async function decide($: EngineInterface, st: State, cfg: DecideConfig, t: Turn, label: Label | null, inherited: boolean, effort: unknown, guard: boolean, late: boolean): Promise<{ label: Label | null; inherited: boolean }> {
  const s = st.delta
  t.label = label
  t.applied = guard ? null : decideEffort(label, effort, cfg.raiseTo)
  t.lowered = isLowered(t.applied, effort)
  // Un turno da abbassare su `holdout` resta all'effort della sessione. Uno
  // con la label in ritardo resta fuori: il suo primo step non è stato toccato.
  const tested = !late && t.applied && t.lowered ? escalatedLabel(label) : null
  t.experiment = tested ? { label: tested, arm: pickArm(cfg.holdout, turnFraction(t.id)), stretched: false, judged: false } : null
  if (t.experiment) s.experiment[t.experiment.label][t.experiment.arm].turns++
  if (t.experiment?.arm === 'holdout') {
    t.applied = null
    t.lowered = false
  }
  if (label) s.labels[label]++
  if (t.applied && t.lowered) s.lowered++
  if (t.applied && !t.lowered) s.raised++
  // Anche un turno ereditato finito in holdout ha ereditato la label.
  if ((t.applied || t.experiment) && inherited) s.inherited++
  if (late) s.lateLabel++
  st.statsDirty = true
  if (cfg.log) {
    const now = t.applied ?? effort ?? 'default'
    const change = t.applied ? (t.lowered ? ' · abbassato' : ' · alzato') : t.experiment ? ' · holdout' : ''
    $.ui.status(`${await folderPrefix($)}effort ${now}${label ? ` · ${label}` : ''}${change}${guard ? ' · cache guard' : ''}`)
    if (t.applied) $.ui.log(`[effort-router] turno → effort ${t.applied} (${label}${inherited ? ', ereditata' : ''}${late ? ', dopo il primo step' : ''})`)
    else if (t.experiment) $.ui.log(`[effort-router] turno ${label} lasciato all'effort della sessione (holdout)`)
  }
  return { label, inherited }
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
  // Il timeout scende al p95 delle chiamate misurate (mai sopra `timeoutMs`).
  const adaptive = typeof options.adaptiveTimeout === 'boolean' ? options.adaptiveTimeout : true
  // Quanto il primo step aspetta al massimo la label (0 = finché arriva):
  // oltre, parte all'effort della sessione e la label vale dallo step dopo.
  // Solo con la cache verificata (cambiare effort a metà turno non la invalida).
  const labelWaitMs = typeof options.labelWaitMs === 'number' ? Math.max(0, options.labelWaitMs) : 0
  // Ogni quanto salvare le statistiche a fine turno (0 = a ogni turno); sempre a fine sessione.
  const saveEveryMs = typeof options.saveEveryMs === 'number' ? Math.max(0, options.saveEveryMs) : 60_000
  // La percentuale di turni da abbassare lasciati all'effort della sessione, per confronto.
  const holdout = parseHoldout(options.holdout)
  // L'effort dei compiti difficili (xhigh, max) o null per non alzare mai.
  const raiseTo = parseRaise(options.raiseTo)
  // Lo stesso per i subagent: di default non si alza.
  const subagentRaiseTo = parseRaise(options.subagentRaiseTo, DEFAULT_SUBAGENT_RAISE)
  const decideConfig: DecideConfig = { raiseTo, holdout, log }

  const st: State = { saved: null, savedVersion: null, delta: newStats(0), cacheDays: null, cacheDelta: {}, statsDirty: false, fastTypes: null, started: false, guardAnnounced: false, lastSavedAt: null }
  const announce = log ? `[effort-router] ${VERSION} attivo: abbassa l'effort sui turni semplici${raiseTo ? `, lo alza a ${raiseTo} su quelli difficili` : ''}` : null
  // Una sola classificazione in attesa: i turni principali sono sequenziali.
  let pending: Promise<Label | null> | null = null
  let pendingInherited = false
  // Se `pending` è una chiamata a Haiku (non una label ereditata o da ultrathink).
  let pendingClassified = false
  // La label del turno principale precedente, per i seguiti brevissimi.
  let last: { label: Label | null; inherited: boolean } = { label: null, inherited: false }
  let turn: Turn | null = null
  // L'effort della sessione all'ultimo turno (prima della riscrittura): se è già
  // low, il turno dopo non vale una chiamata a Haiku.
  let sessionEffort: unknown
  // L'effort dell'ultima richiesta del turno principale e quando è finita.
  let lastSent: { effort: unknown; model: string; at: number } | null = null
  const agents = new Map<string, Agent>()

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
      st.cacheDays = {}
      st.cacheDelta = {}
      await save($, 'cacheDays', {})
      return { text: 'effort-router: statistiche e tipi di subagent azzerati.' }
    }
    const fastTypes = [...(await getFastTypes($, st))]
    const total = await getStats($, st)
    const recent = await getRecentCache($, st)
    const timeout = await classifierTimeout($, st, adaptive, timeoutMs)
    const note = `\nTimeout del classificatore: ${timeout} ms${timeout !== timeoutMs ? ` (adattivo; configurato ${timeoutMs} ms)` : ''}`
    if (arg === 'tutto') return { text: formatStats(total, fastTypes, cacheGuard, null, null, recent) + note }
    return { text: formatStats(await getStats($, st, true), fastTypes, cacheGuard, VERSION, total, recent) + note }
  })

  on('prompt.submit', async ($, e, next) => {
    await start($, st, announce)
    // Consegnato dentro un turno già in corso: non apre un turno suo.
    if (e.turnId) return next(e)
    // Il prompt dopo un turno dell'esperimento: corregge la risposta? Un
    // comando slash rimanda il giudizio, uno che azzera la conversazione lo chiude.
    const exp = turn?.experiment
    if (exp && !exp.judged) {
      const verdict = judgePrompt(e.text)
      if (verdict !== 'wait') exp.judged = true
      if (verdict === 'corrected') {
        st.delta.experiment[exp.label][exp.arm].corrected++
        st.statsDirty = true
      }
    }
    pending = null
    pendingInherited = false
    pendingClassified = false
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
    // Un prompt lungo non si abbassa, ma può essere difficile: se ne
    // classificano inizio e fine solo se c'è un effort a cui alzarlo.
    const long = !shouldClassify(e.text, 0, maxChars)
    if (!shouldClassify(e.text, minChars) || (long && !raiseTo) || !canChange(sessionEffort, raiseTo)) return next(e)

    const classifying = classify($, st, long ? clipEnds(e.text) : e.text, await classifierTimeout($, st, adaptive, timeoutMs), last.label).then(({ label, said }) => {
      const kept = long ? longPromptLabel(label) : label
      if (log) $.ui.log(`[effort-router] prompt: ${said}${kept !== label ? ` (prompt lungo: ${kept})` : ''}`)
      return kept
    })
    pending = classifying
    pendingClassified = true
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
  // scelto il modello; entrambi partono con l'effort più basso, e tornano a
  // quello di partenza se il loop si allunga o un tool fallisce.
  on('agent.spawn', async ($, e, next) => {
    const fast = await getFastTypes($, st)
    const knownFast = canRouteSubagent(e) && fast.has(e.subagentType)
    let label: Label | null = null
    let model: string | null = null
    let tested: { model: RoutedModel; arm: Arm } | null = null
    const worth = routeSubagents && subagentWorthClassifying(e, knownFast)
    // Modello scelto nella chiamata ed effort che nessuna label sposterebbe: Haiku non serve.
    if (worth && !subagentCanChange(e, sessionEffort, subagentRaiseTo)) {
      st.delta.subagents.skipped++
      st.statsDirty = true
      if (log) $.ui.log(`[effort-router] subagent ${e.subagentType} (${e.description}): non classificato, nessuna label cambierebbe modello o effort`)
    } else if (worth) {
      const classified = await classify($, st, clip(`${e.description}\n\n${e.prompt}`), await classifierTimeout($, st, adaptive, timeoutMs), null, SUBAGENT_SYSTEM)
      label = classified.label
      const target = decideSubagentModel(label, e, sonnetForSimple) as RoutedModel | null
      // Un subagent da spostare su `holdout` resta sul modello e sull'effort che avrebbe.
      tested = target ? { model: target, arm: pickArm(holdout, turnFraction(e.tool_use_id ?? `${e.description}\n${e.prompt}`)) } : null
      model = tested?.arm === 'lowered' ? tested.model : null
      const s = st.delta
      s.subagents.classified++
      if (label) s.subagents.labels[label]++
      if (model === MID_SUBAGENT_MODEL) s.subagents.toSonnet++
      else if (model) s.subagents.toHaiku++
      st.statsDirty = true
      if (log) $.ui.log(`[effort-router] subagent ${e.subagentType} (${e.description}): ${classified.said}${model ? ` → ${model}` : tested ? ` (holdout: niente ${tested.model})` : ''}`)
    }
    const result = await next(model ? { ...e, model } : e)

    const effortLabel = label && label !== 'complesso' && tested?.arm !== 'holdout' ? label : null
    if (result.agentId && (effortLabel || tested)) {
      remember(agents, result.agentId, { label: effortLabel, experiment: tested, stretched: false, toolFailed: false, escalated: false })
      if (tested) st.delta.subagentExperiment[tested.model][tested.arm].agents++
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
    const s = st.delta
    if (e.agentId) {
      const a = agents.get(e.agentId)
      if (!a) return yield* next(e)
      let effort = a.escalated ? null : decideSubagentEffort(a.label, e.effort, subagentRaiseTo)
      const lowered = isLowered(effort, e.effort)
      if (effort && e.index === 0) {
        if (lowered) s.subagents.lowered++
        else s.subagents.raised++
      }
      // Il loop si allunga o un tool fallisce: il compito non era semplice.
      const stretched = shouldEscalate(e.index, escalateAfter, true, a.toolFailed)
      if (stretched && a.experiment && !a.stretched) {
        a.stretched = true
        s.subagentExperiment[a.experiment.model][a.experiment.arm].stretched++
      }
      if (stretched && lowered) {
        a.escalated = true
        effort = null
        s.subagents.escalated++
        if (log) $.ui.log(`[effort-router] subagent ${e.agentId}: ${a.toolFailed ? 'errore di un tool' : 'loop lungo'} (step ${e.index}) → effort di partenza`)
      }
      if (stretched) a.toolFailed = false
      st.statsDirty = true
      const result = yield* next(effort ? { ...e, effort } : e)
      if (a.experiment) {
        const arm = s.subagentExperiment[a.experiment.model][a.experiment.arm]
        arm.steps++
        arm.output += result.usage?.output_tokens ?? 0
      }
      return result
    }

    if (!(turn && e.index > 0 && e.turnId === turn.id)) {
      // Primo step del turno.
      sessionEffort = e.effort
      const waiting = pending
      const inherited = pendingInherited
      const classified = waiting !== null && pendingClassified
      pending = null
      pendingInherited = false
      pendingClassified = false
      const guard = await guarded($, st, cacheGuard)
      let label: Label | null = null
      let late: Promise<Label | null> | null = null
      if (waiting) {
        const waitStart = classified ? await clockNow($) : 0
        // Con `labelWaitMs` e la cache verificata il primo step non aspetta oltre.
        const budget = classified && !guard && labelWaitMs > 0 && cacheVerdict({ cache: await getRecentCache($, st) }) === 'ok' ? labelWaitMs : 0
        const got = budget ? await Promise.race([waiting, sleepFor($, budget).then(() => LATE)]) : await waiting
        if (got === LATE) late = waiting
        else label = got
        if (classified) addWait(s.firstStepWait, Math.max(0, (await clockNow($)) - waitStart))
      }
      turn = { id: e.turnId, label: null, applied: null, lowered: false, toolFailed: false, experiment: null, late: late ? { label: late, inherited } : null }
      s.turns++
      if (guard) s.guarded++
      if (late) {
        last = { label: null, inherited: false }
        if (log) $.ui.log(`[effort-router] label in ritardo: primo step all'effort della sessione`)
      } else last = await decide($, st, decideConfig, turn, label, inherited, e.effort, guard, false)
    } else if (turn.late) {
      // La label arrivata dopo il primo step vale da qui; se non c'è ancora, si riprova allo step dopo.
      const got = await Promise.race([turn.late.label, Promise.resolve(LATE)])
      if (got !== LATE) {
        const { inherited } = turn.late
        turn.late = null
        last = await decide($, st, decideConfig, turn, got, inherited, e.effort, false, true)
      }
    } else if (shouldEscalate(e.index, escalateAfter, turn.lowered, turn.toolFailed)) {
      // Il tool loop si allunga o un tool fallisce: il compito non era
      // semplice, né da ereditare.
      const onError = turn.toolFailed
      turn.applied = null
      turn.lowered = false
      turn.toolFailed = false
      last = { label: null, inherited: false }
      s.escalated++
      if (onError) s.escalatedOnError++
      if (turn.experiment && !turn.experiment.stretched) {
        turn.experiment.stretched = true
        s.experiment[turn.experiment.label][turn.experiment.arm].stretched++
      }
      const by = escalatedLabel(turn.label)
      if (by) s.escalatedBy[by]++
      if (log) {
        $.ui.status(`${await folderPrefix($)}effort ${e.effort ?? 'default'}${turn.label ? ` · ${turn.label}` : ''} · rialzato`)
        $.ui.log(`[effort-router] ${onError ? 'errore di un tool' : 'turno lungo'} (step ${e.index}) → effort della sessione`)
      }
    } else if (turn.experiment?.arm === 'holdout' && !turn.experiment.stretched && shouldEscalate(e.index, escalateAfter, true, turn.toolFailed)) {
      // Un turno holdout che, abbassato, sarebbe stato rialzato qui.
      turn.experiment.stretched = true
      turn.toolFailed = false
      s.experiment[turn.experiment.label].holdout.stretched++
    }
    st.statsDirty = true

    const t = turn
    const sent = t.applied ?? e.effort
    const startedAt = await clockNow($)
    const result = yield* next(t.applied ? { ...e, effort: t.applied } : e)
    if (t.experiment) {
      const arm = s.experiment[t.experiment.label][t.experiment.arm]
      arm.steps++
      arm.output += result.usage?.output_tokens ?? 0
    }

    // Cache: si confrontano le richieste con cui la cache dovrebbe essere viva
    // (entro CACHE_GAP_MS dalla precedente, stesso modello), al primo step o a
    // un cambio di effort.
    if (lastSent && result.usage && e.model === lastSent.model && startedAt - lastSent.at < CACHE_GAP_MS) {
      const changed = sent !== lastSent.effort
      if (changed || e.index === 0) {
        addUsage(changed ? s.cache.changed : s.cache.same, result.usage)
        const today = (st.cacheDelta[day(startedAt)] ??= newCache())
        addUsage(changed ? today.changed : today.same, result.usage)
      }
    }
    lastSent = { effort: sent, model: e.model, at: await clockNow($) }
    return result
  })

  // Un tool che restituisce un errore (comando fallito, Edit rifiutato, test
  // rosso) rialza allo step dopo il turno abbassato o il subagent abbassato
  // che l'ha chiamato (in un turno holdout lo segna soltanto). Un rifiuto
  // dell'utente (`deny`) no: non dice nulla sulla difficoltà.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!escalateOnError || !result.isError) return result
    if (e.agentId) {
      const a = agents.get(e.agentId)
      if (a) a.toolFailed = true
    } else if (turn && (turn.lowered || turn.experiment?.arm === 'holdout')) turn.toolFailed = true
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.isAborted && turn?.experiment && e.turnId === turn.id) {
      st.delta.experiment[turn.experiment.label][turn.experiment.arm].aborted++
      st.statsDirty = true
    }
    const a = e.agentId ? agents.get(e.agentId) : undefined
    if (a?.experiment && e.isAborted) {
      st.delta.subagentExperiment[a.experiment.model][a.experiment.arm].aborted++
      st.statsDirty = true
    }
    if (!e.agentId) await maybeSave($, st, saveEveryMs)
    return result
  })

  on('session.end', async ($, e, next) => {
    await saveStats($, st)
    return next(e)
  })
}
