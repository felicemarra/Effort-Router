# effort-router

Plugin di function hooks per Claude Code: **abbassa il reasoning effort sui turni chiaramente semplici** e al turno successivo riparte dal default della sessione (`high`). Non alza mai l'effort oltre quello della sessione e non cambia mai il modello del turno principale. Misura da sé se cambiare effort costa prompt cache e, se sì, smette di farlo (vedi *Cache*).

## Come funziona

1. `prompt.submit`: Haiku classifica il prompt (`banale` / `semplice` / `complesso`), con un timeout di 1,5 s. La classificazione corre **in parallelo** alla partenza del turno: la sua latenza si sovrappone alla preparazione della richiesta invece di sommarsi.
2. `turn.step`: al primo step del turno aspetta la label (se non è già arrivata), applica l'effort e lo mantiene per il tool loop. Se il loop arriva allo step 8 (`escalateAfter`) il compito non era semplice: l'effort torna a quello della sessione per il resto del turno.

**Seguiti brevissimi** (fino a 20 caratteri: `sì`, `ok procedi`, `grazie`): dopo un turno `banale` o `semplice` ne ereditano la label senza chiamare Haiku. Vale per un turno solo, mai dopo un turno `complesso` o rialzato. Si disattiva con `inheritShort`.

| Classificazione | Effort del turno |
|---|---|
| banale | `low` |
| semplice | `medium` |
| complesso, nessuna risposta, timeout | invariato (default `high`) |

**Subagent** (`agent.spawn`): un subagent parte con un contesto vuoto, quindi non c'è cache da perdere.
- `banale` e nessun modello indicato → parte su Haiku;
- `banale` o `semplice` → gira a effort `low` / `medium` per tutta la corsa (anche con un `model` esplicito, se quel modello ha l'effort).

I fork non vengono mai toccati (ereditano contesto e cache del padre). Al classificatore arrivano al massimo i primi 4000 caratteri del compito. Si disattiva con l'opzione `routeSubagents`.

Haiku viene chiamato solo quando la risposta può cambiare qualcosa. Non vengono classificati:
- i prompt sotto i 40 caratteri (`sì`, `procedi`, …), che spesso proseguono un task complesso;
- i prompt sopra i 2000 caratteri (spec, log, codice incollato), che non sono quasi mai banali;
- i comandi slash;
- i messaggi consegnati dentro un turno già in corso;
- i prompt quando l'effort della sessione all'ultimo turno era già `low` (nessuna label potrebbe abbassarlo);
- i subagent che girano già su Haiku: per modello esplicito, perché il padre è su Haiku, o perché il loro tipo ci finisce da solo (es. un agente con `model: haiku` nella definizione). Quest'ultimo il plugin lo impara alla prima occorrenza e lo ricorda tra le sessioni; se la definizione cambia, se ne accorge e lo dimentica.

Se imposti a mano `/effort low` o `medium`, il plugin non rialza mai l'effort.

## Cache e statistiche

Per ogni richiesta del turno principale fatta entro 4 minuti dalla precedente e con lo stesso modello, il plugin registra quanta parte dell'input ha servito la prompt cache, separando le richieste con l'**effort cambiato** da quelle con l'**effort invariato**. Con almeno 10 campioni per tipo:
- se la quota servita dalla cache cala di oltre 30 punti quando l'effort cambia, cambiare effort invalida la cache: con `cacheGuard` attivo (default) il plugin smette di abbassare l'effort del turno principale, e smette anche di classificarne i prompt. L'effort dei subagent resta gestito: lo fissano all'avvio e non lo cambiano mai.
- altrimenti continua come prima.

`/effort-router` mostra turni abbassati, label, costo del classificatore, subagent, le due quote di cache e il verdetto. `/effort-router reset` azzera statistiche e tipi di subagent ricordati (per esempio per rimisurare dopo un aggiornamento di Claude Code). I dati stanno nello store del plugin (`~/.claude/plugins/store/effort-router_*.json`) e sono cumulativi tra tutte le sessioni: ogni sessione salva solo i propri incrementi, sommandoli al file riletto in quel momento, quindi più sessioni aperte in parallelo non si cancellano a vicenda. Se lo store non è disponibile il plugin funziona lo stesso, senza memoria.

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

Plugin id: `effort-router@skills-dir`. Le opzioni (`timeoutMs`, `minChars`, `maxChars`, `escalateAfter`, `inheritShort`, `cacheGuard`, `routeSubagents`, `logDecisions`) si cambiano dal menu config oppure in `pluginConfigs["effort-router@skills-dir"].options`.

## Verificare

In una sessione headless `claude -p "/effort-router"` non esegue i comandi registrati dai plugin (il testo arriva al modello): per provarlo senza interfaccia usa `--input-format stream-json`.

La status line mostra `effort low · banale · abbassato` (poi `· rialzato` se il turno si allunga, `· cache guard` se la protezione è scattata). Il log di debug (`claude --debug`) contiene le righe `[effort-router]`.

## Test

```
npm test                  # logica pura (node --test)
claude plugin test .      # hook sul motore reale
claude plugin validate .
```

I tipi dell'API si rigenerano con `/plugin-types .claude/types` dopo un aggiornamento di Claude Code.

## Disattivare

Rimuovi la junction `~/.claude/skills/effort-router`, oppure imposta `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` a `0`.
