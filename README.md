# effort-router

Plugin di function hooks per Claude Code: **abbassa il reasoning effort sui turni semplici e lo alza oltre il default su quelli difficili**; ogni turno riparte dal default della sessione (`high`). Non cambia mai il modello del turno principale: il modello si cambia solo sui subagent. Misura da sé se cambiare effort costa prompt cache e, se sì, smette di farlo (vedi *Cache*).

## Come funziona

1. `prompt.submit`: Haiku classifica il prompt (`banale` / `semplice` / `complesso` / `difficile`), con un timeout di 1,5 s. La classificazione corre **in parallelo** alla partenza del turno: la sua latenza si sovrappone alla preparazione della richiesta invece di sommarsi.
2. `turn.step`: al primo step del turno aspetta la label (se non è già arrivata), applica l'effort e lo mantiene per il tool loop. Un turno abbassato torna all'effort della sessione per il resto del turno quando il compito si rivela meno semplice del previsto:
   - arriva allo step 6 (`escalateAfter`);
   - un tool del turno principale restituisce un errore (comando con exit ≠ 0, Edit rifiutato, test rosso): dallo step dopo (`escalateOnError`). Un rifiuto dell'utente a un permesso non conta, né l'errore di un subagent.

   Un turno alzato resta alzato.

**Contesto**: insieme al prompt Haiku riceve la label del turno principale prima (se c'è), solo per capire le richieste che vi rimandano (`fai lo stesso anche per gli altri file`).

**`ultrathink`**: un prompt che contiene `ultrathink`, `megathink`, `think hard`, `think harder`, `think really hard` (e simili) vale `difficile` senza chiamare Haiku, a qualunque lunghezza: non viene mai abbassato e sale a `raiseTo` se la sessione è a `high` o sopra.

**Seguiti brevissimi** (fino a 20 caratteri: `sì`, `ok procedi`, `grazie`): dopo un turno `banale`, `semplice` o `difficile` ne ereditano la label senza chiamare Haiku. Vale per un turno solo, mai dopo un turno `complesso` o rialzato. Si disattiva con `inheritShort`.

| Classificazione | Effort del turno |
|---|---|
| banale | `low` |
| semplice | `medium` |
| complesso, nessuna risposta, timeout | invariato (default `high`) |
| difficile | `xhigh` (opzione `raiseTo`: `xhigh`, `max` o `off`) |

`difficile` vuol dire ragionamento profondo evidente: architettura, bug elusivi o intermittenti, concorrenza, algoritmi non banali, sicurezza critica, problemi che i tentativi precedenti non hanno risolto. Nel dubbio il classificatore risponde `complesso`, che lascia l'effort com'è. L'effort sale solo se quello della sessione è `high` o sopra: se imposti a mano `/effort low` o `medium`, il plugin non lo alza mai. `low` è il gradino più basso: sotto non si scende.

**Subagent** (`agent.spawn`): un subagent parte con un contesto vuoto, quindi non c'è cache da perdere.
- `banale` e nessun modello indicato → parte su Haiku;
- `semplice` e nessun modello indicato → parte su Sonnet (opzione `sonnetForSimple`), solo se il padre è sopra Sonnet (Opus, Fable);
- `difficile` → resta sul suo modello e sul suo effort; con l'opzione `subagentRaiseTo` (`xhigh` o `max`, default `off`) sale a quell'effort. Di default non sale perché i prompt dei subagent li scrive il modello principale, lunghi e tecnici: il classificatore li diceva difficili nel 18% dei casi, contro il 3,5% dei prompt dell'utente;
- `banale` o `semplice` → gira a effort `low` / `medium` per tutta la corsa (anche con un `model` esplicito, se quel modello ha l'effort).

I fork non vengono mai toccati (ereditano contesto e cache del padre). Al classificatore arrivano al massimo i primi 4000 caratteri del compito. Si disattiva con l'opzione `routeSubagents`.

Haiku viene chiamato solo quando la risposta può cambiare qualcosa. Non vengono classificati:
- i prompt sotto i 12 caratteri (`sì`, `procedi`, …), che spesso proseguono un task complesso;
- i prompt sopra i 2000 caratteri (spec, log, codice incollato) quando `raiseTo` è `off`; altrimenti Haiku ne legge i primi 4000 caratteri e conta solo `difficile`, perché un prompt lungo non viene mai abbassato;
- i comandi slash;
- i messaggi consegnati dentro un turno già in corso;
- i prompt quando l'effort della sessione all'ultimo turno era già `low` (nessuna label potrebbe cambiarlo);
- i subagent che girano già su Haiku: per modello esplicito, perché il padre è su Haiku, o perché il loro tipo ci finisce da solo (es. un agente con `model: haiku` nella definizione). Quest'ultimo il plugin lo impara alla prima occorrenza e lo ricorda tra le sessioni; se la definizione cambia, se ne accorge e lo dimentica.


## Esperimento: abbassare peggiora le risposte?

Un 10% dei turni da abbassare (`banale` o `semplice`, opzione `holdout`, da 0 a 50) resta all'effort della sessione: la status line dice `· holdout`. La scelta dipende dall'id del turno, quindi è casuale ma ripetibile. Per ogni label, `/effort-router` confronta i due gruppi:
- step medi e token di output medi per turno;
- **allungati**: turni arrivati a `escalateAfter` step o a un tool fallito (per gli abbassati sono i rialzi, per l'holdout quelli che lo sarebbero stati);
- **interrotti**: turni fermati dall'utente;
- **corretti**: turni seguiti da un prompt che corregge la risposta (`no`, `non funziona`, `hai sbagliato`, `riprova`, `doesn't work`, `still failing`…). È un'euristica: conta le correzioni esplicite, non quelle implicite.

Se gli abbassati si allungano, vengono interrotti o corretti molto più spesso dell'holdout, abbassare costa qualità: è il dato per decidere se cambiare la mappa label → effort.

## Cache e statistiche

Per ogni richiesta del turno principale fatta entro 4 minuti dalla precedente e con lo stesso modello, il plugin registra quanta parte dell'input ha servito la prompt cache, separando le richieste con l'**effort cambiato** da quelle con l'**effort invariato**. Con almeno 10 campioni per tipo:
- se la quota servita dalla cache cala di oltre 30 punti quando l'effort cambia, cambiare effort invalida la cache: con `cacheGuard` attivo (default) il plugin smette di cambiare l'effort del turno principale (né abbassarlo né alzarlo), e smette anche di classificarne i prompt. L'effort dei subagent resta gestito: lo fissano all'avvio e non lo cambiano mai.
- altrimenti continua come prima.

`/effort-router` mostra le statistiche della versione installata, con in coda una riga sul totale di tutte le versioni; `/effort-router tutto` mostra il dettaglio del totale. Per ognuna: turni abbassati e alzati, label (e quante `difficile` vengono da `ultrathink`), rialzi a metà turno per label (banale / semplice) e quanti per l'errore di un tool, costo del classificatore con le classificazioni senza label (timeout, errore, risposta non valida) e l'attesa media, subagent e le loro label, le due quote di cache e il verdetto. `/effort-router reset` azzera statistiche (della versione e totali) e tipi di subagent ricordati (per esempio per rimisurare dopo un aggiornamento di Claude Code). I dati stanno nello store del plugin (`~/.claude/plugins/store/effort-router_*.json`): `stats` per il totale, `stats@<versione>` per ogni versione (la versione va tenuta allineata in `plugin.json` e in `VERSION` di `hooks/policy.ts`: un test lo controlla). Sono cumulativi tra tutte le sessioni: ogni sessione salva solo i propri incrementi, sommandoli al file riletto in quel momento, quindi più sessioni aperte in parallelo non si cancellano a vicenda. Se lo store non è disponibile il plugin funziona lo stesso, senza memoria.

Il prompt viene inviato solo ad Anthropic (Haiku), con le credenziali di Claude Code; nessun servizio di terzi.

## Installazione

Il sorgente sta qui ed è collegato con una junction:

```
~/.claude/skills/effort-router  ->  C:\Skills\effort-router
```

In `~/.claude/settings.json` deve esserci:

```json
"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }
```

Plugin id: `effort-router@skills-dir`. Le opzioni (`raiseTo`, `subagentRaiseTo`, `timeoutMs`, `minChars`, `maxChars`, `escalateAfter`, `escalateOnError`, `holdout`, `inheritShort`, `cacheGuard`, `routeSubagents`, `sonnetForSimple`, `logDecisions`) si cambiano dal menu config oppure in `pluginConfigs["effort-router@skills-dir"].options`.

## Verificare

In una sessione headless `claude -p "/effort-router"` non esegue i comandi registrati dai plugin (il testo arriva al modello): per provarlo senza interfaccia usa `--input-format stream-json`.

La status line mostra il nome della cartella di lavoro seguito dall'effort, per esempio `Desktop · effort low · banale · abbassato` o `Desktop · effort xhigh · difficile · alzato` (poi `· rialzato` se il turno si allunga, `· cache guard` se la protezione è scattata). Il log di debug (`claude --debug`) contiene le righe `[effort-router]`.

## Test

```
npm test                  # logica pura (node --test)
claude plugin test .      # hook sul motore reale
claude plugin validate .
```

I tipi dell'API si rigenerano con `/plugin-types .claude/types` dopo un aggiornamento di Claude Code.

## Disattivare

Rimuovi la junction `~/.claude/skills/effort-router`, oppure imposta `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` a `0`.
