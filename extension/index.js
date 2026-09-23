import { getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../script.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { world_names } from '../../world-info.js';

// ── VERSION MARKER (module-level, impostato appena il modulo carica) ──────────
// Per verificare quale versione è in memoria: console → window.MEMPALACE_VERSION
window.MEMPALACE_VERSION = 'v5.9-gpu-a-riposo';
console.log('[MemPalace] Module loaded:', window.MEMPALACE_VERSION);

const MEMPALACE_URL = 'http://localhost:8052';
let activeCharacterName = null;

/**
 * [LLAMACPP] Vero mentre è in corso un'estrazione dei fatti col modello.
 *
 * `generateQuietPrompt()` non manda al modello solo l'istruzione: passa da
 * `Generate('quiet')`, che monta il prompt INTERO: scheda, cronologia, world info e
 * ogni blocco iniettato dalle estensioni, MemPalace compreso. Due conseguenze, e la
 * seconda è peggio della prima:
 *
 *  1. Su llama.cpp lanciato con `--no-context-shift` un prompt che sfonda il contesto
 *     non viene accorciato: la richiesta fallisce. Su una chat lunga l'estrazione
 *     smetteva di funzionare proprio quando c'era più materiale da estrarre.
 *  2. Dentro quel prompt ci sono i ricordi che MemPalace ha appena iniettato, quindi
 *     il modello estraeva fatti dai propri ricordi invece che dal messaggio: il grafo
 *     si autoalimentava, rinforzando ogni errore già dentro.
 *
 * Il rimedio non tocca il valore dei blocchi (ci sarebbe una corsa con l'interceptor,
 * che li riscrive all'inizio di ogni generazione): usa il `filter` che SillyTavern
 * accetta in `setExtensionPrompt` e che consulta a ogni montaggio del prompt. Mentre
 * questo flag è alzato i blocchi di MemPalace restano fuori, e tornano da soli dopo.
 */
let _estrazioneAlModello = false;
const _fuoriDallEstrazione = () => !_estrazioneAlModello;

/**
 * Esito dell'ULTIMA chiamata al modello, per poter distinguere due guasti diversi.
 *
 * `raggiungibile` dice se il backend ha risposto qualcosa, `grezza` cos'ha risposto.
 * Serve perché "zero fatti" ha due cause opposte e curarle allo stesso modo è un
 * errore: il backend spento va segnalato e aggirato, un modello che risponde ma non
 * scrive triple su UNA frase di prova non va aggirato affatto, perché sul materiale
 * vero quasi sempre le scrive. La prima versione della sonda faceva proprio questa
 * confusione e dichiarava morto un llama-server acceso e funzionante.
 */
const _ultimaEstrazione = { raggiungibile: false, grezza: '', errore: null, via: null };
let _charSelectedGen = 0; // [R1] generation counter per cancellare invocazioni sovrapposte di onCharacterSelected
window.localWipedWings = window.localWipedWings || {};

// Cache AAAK dialect: evita una chiamata API extra a ogni generazione
let _aaakDialectCache = null;
let _aaakDialectWingId = null;

// ── SESSION NARRATIVE MEMORY ─────────────────────────────────────────────────────
// Traccia tutti i frammenti iniettati durante la sessione con il numero di generazione.
// Due obiettivi:
//   1. FRESHNESS SORT: frammenti mai visti (o visti da molte gen.) vengono prima nel budget
//      la storia avanza portando in superficie ricordi sempre nuovi.
//   2. LORE COOLDOWN: entry [Common-Vibe] enciclopediche vengono bloccate per N generazioni
//      per evitare che saturino il contesto con lo stesso lore ad ogni turno.
const _fragmentSessionMemory = new Map(); // dedupeKey → { lastGen, count }
const _loreInjectionHistory  = new Map(); // dedupeKey → lastGen  (solo Common-Vibe, per cooldown hard)
let _interceptorGenCount = 0;
const LORE_COOLDOWN_GENS  = 2;  // Generazioni di hard-block totale per lore (era 4, ora decay in 2 fasi)
const LORE_SOFT_COOLDOWN_GENS = 6; // Generazioni di soft-zone: max 1 fragment lore per generazione
let _loreSoftAllowedGen = -1;   // Numero di generazione dell'ultimo soft-allow lore
let _ragHitCount = 0;   // Generazioni con almeno 1 frammento iniettato
let _ragMissCount = 0;  // Generazioni con 0 frammenti (ma almeno 1 fase attiva)
const ECHO_SOFT_COOLDOWN  = 6;  // Generazioni dopo le quali un echo è di nuovo "fresco"
// [C2] Module-level sync flag: shared by manual sync, auto-scan, AND deep-scan so none run concurrently.
// Previously declared inside setupUI closure → performDeepKnowledgeScan (module scope) couldn't see it.
let _isSyncing = false;
// Stato dell'estrazione continua. Dichiarato qui, accanto agli altri flag di modulo,
// e non vicino alle funzioni che lo usano: cosi' non ci sono usi che precedono la
// dichiarazione nel file, che e' legale ma e' il tipo di cosa che confonde a rileggerla.
let _estrazioneInCorso = false;
let _generazioneInCorso = false;
let _timerEstrazione = null;
let _sbloccoGenerazione = null;
const SESSION_MEMORY_MAX  = 300; // Cap per evitare memory leak su sessioni infinite
// [C10] IT_NOISE and EN_NOISE as module-level Sets: were recreated as `new Set([...])` on EVERY
// interceptor call (i.e., every AI generation). Moving them here allocates them once at module load.
const IT_NOISE = new Set(['il','la','lo','le','gli','un','una','uno','dei','delle','degli',
    'di','da','in','con','su','per','tra','fra','e','o','ma','se','che','non','ho','ha',
    'hai','sono','è','era','ero','sei','siete','siamo','stai','sta','sto','poi','qui','lì',
    'mi','ti','si','ci','vi','li','me','te','ce','ve','già','ora','anche','però','quindi',
    'allora','mentre','dopo','prima','sempre','mai','più','meno','molto','poco','bene',
    'male','così','questo','questa','questi','queste','quello','quella','quegli','quelle']);
const EN_NOISE = new Set(['the','a','an','in','at','on','to','for','of','and','or','but',
    'is','was','are','were','be','have','has','had','do','did','will','would','could',
    'should','i','you','he','she','it','we','they','my','your','his','her','its','our',
    'their','this','that','these','those','just','very','so','well','now','here','there']);

// [C10] Module-level: was recreated inside the interceptor closure on each generation.
function buildSemanticCore(text, entities) {
    if (entities.length >= 2) return entities.join(' ');
    const words = text
        .replace(/[^\w\sàáâãäåæçèéêëìíîïðñòóôõöùúûüýþÿ]/gi, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !IT_NOISE.has(w.toLowerCase()) && !EN_NOISE.has(w.toLowerCase()));
    const combined = [...new Set([...entities, ...words])];
    return combined.slice(0, 6).join(' ') || text.substring(0, 80);
}

// [C10] Module-level: NER extractor, was recreated inside the interceptor closure each generation.
// The compoundRe regex literal inside is compiled once per module load, not per call.
const _COMPOUND_RE = /\b([A-ZÀ-Ú][a-zà-ú]{2,})(?:\s+(?:da|di|del|della|du|de|the|of|at|in|von|van|le|la|lo)\s+([A-ZÀ-Ú][a-zà-ú]{2,})|\s+([A-ZÀ-Ú][a-zà-ú]{2,}))\b/g;
const _ENTITY_STOPWORDS = new Set([
    'The','This','That','She','Her','His','You','Your','My','Our','Its','For','And','But',
    'With','From','Have','Has','Had','Was','Were','Are','Can','Will','Not','Yes','No',
    'Then','Now','Here','Also','Just','Even','Very','Well','Still','Only','Both',
    'Each','Such','Some','Many','Most','More','Less','Much','They','What','When',
    'Where','How','Why','Been','Does','Into','Over','After','Before','About','There',
    'Please','Thanks','Thank','Sorry','Welcome','Excuse','Pardon','Hello','Goodbye','Bye',
    'Hey','Sure','Okay','Fine','Right','Good','Nice','Great','Alright','Indeed',
    'Come','Give','Take','Make','Know','Think','Help','Need','Want','Feel','Tell',
    'Show','Keep','Look','Work','Play','Stop','Move','Find','Call','Seem','Seems',
    'Enjoy','Looks','Stay','Wait','Watch','Turn','Open','Close','Walk','Runs',
    'Bring','Leave','Speak','Goes','Gets','Done','Said','Went','Came',
    'Sei','Sono','Siamo','Mio','Tuo','Suo','Per','Con','Dal','Del','Dei','Gli','Una',
    'Era','Poi','Ora','Non','Mai','Chi','Che','Dove','Come','Cosa','Quando','Anche',
    'Dopo','Prima','Mentre','Forse','Quindi','Ancora','Invece','Subito','Certo',
    'Però','Perché','Allora','Adesso','Sempre','Davanti','Dentro','Fuori','Sopra','Sotto',
    'Senza','Lungo','Verso','Contro','Quasi','Spesso','Tanto','Poco','Molto','Troppo',
    'Bene','Male','Solo','Oggi','Ieri','Niente','Tutto','Ecco','Basta','Avanti','Dietro',
    'Questo','Quello','Quella','Questi','Quegli','Intanto','Almeno','Insieme','Proprio',
    'Magari','Eppure','Oppure','Dunque','Tuttavia','Essere','Avere','Fare','Dire',
    'Stare','Dare','Sapere','Volere','Potere','Dovere',
    'Grazie','Prego','Scusa','Scusi','Ciao','Salve','Arrivederci','Permesso',
    'Buongiorno','Buonasera','Buonanotte','Benvenuto','Benvenuta','Benvenuti',
]);
function extractEntities(text) {
    if (!text) return [];
    const results = new Set();
    // Reset lastIndex before each use (global regex must be reset between calls)
    _COMPOUND_RE.lastIndex = 0;
    let m;
    while ((m = _COMPOUND_RE.exec(text)) !== null) {
        const first = m[1];
        if (!_ENTITY_STOPWORDS.has(first)) results.add(m[0].trim());
    }
    const singles = text.match(/\b[A-ZÀ-Ú][a-zà-ú]{3,}\b/g) || [];
    singles
        .filter(tok => !_ENTITY_STOPWORDS.has(tok))
        .filter(tok => ![...results].some(r => r.includes(tok)))
        .forEach(tok => results.add(tok));
    return [...results].slice(0, 3);
}

// Room-hint patterns: pre-compiled word-boundary regexes to detect scene location in user messages.
const _ROOM_HINT_PATTERNS = [
    'dojo','casa','sala','piazza','strada','palazzo','bar','ristorante','ospedale',
    'scuola','parco','foresta','torre','dungeon','arena','temple','castle','city',
    'village','market','tavern','inn','gym','beach','mountain','river','hall',
    'garden','roof','porto','nave','treno','stazione','cantina','soffitta','prigione',
].map(kw => ({ kw, re: new RegExp(`\\b${kw}\\b`) }));

// [C10] Module-level: room hint extractor, used _ROOM_HINT_PATTERNS (declared above).
function extractRoomHint(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const { kw, re } of _ROOM_HINT_PATTERNS) {
        if (re.test(lower)) return kw;
    }
    return null;
}

// [C10] Module-level: isSecret, tiny helper, was recreated inside interceptor each gen.
function isSecret(text) {
    const secretTags = ['[SECRET]', '[SEGRETO]', '[PRIVATE]', '[PRIVATO]', '[HIDDEN]', '[NASCOSTO]'];
    const upper = text.toUpperCase();
    return secretTags.some(tag => upper.includes(tag));
}

// [C10] Module-level: sanitizeContent, was recreated inside interceptor each gen, compiling
// ALL its internal regexes on every AI generation. Now compiled once at module load.
function sanitizeContent(text) {
    if (!text) return "";
    return text
        .replace(/\[Image:[^\]]*\d+x\d+[^\]]*\]/gi, '')
        .replace(/Multiply coordinates by [\d.]+ to map to [^.]+\./gi, '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/<img\s[^>]*>/gi, '')
        .replace(/(?:original|displayed(?: at)?)\s+\d{3,}x\d{3,}/gi, '')
        .replace(/\[(Key|Source|Location|Room|Wing|Match|Tags|Type|Age|Occupation|Score|Distance|Source_File|ID|UUID|Metadata|Confidence):[^\]]*\]/gi, '')
        .replace(/(Building Profile|Penthouse Description|Exterior|Interior|Lifestyle and Interests|Business Ventures|Relationships|Personality|Appearance|Occupation|Structure|Clientele|Atmosphere|Daily Life|Notable Places|Mako Reactor|Description|Behavior|Stats|Attributes|Data|Content|Context|User|Character|Entry|Record|Field|Property|Note):/gi, '')
        .replace(/^[^\n\r]*(?:Current Status|Scenario Advancement|Timeline|Atmosphere|Phase|Status Flag|Alert Level)[^\n\r]*=\s*[^\n\r]*$/gim, '')
        .replace(/^[^\n\r]*[📅🌡️🛈⚠️🔴🟡🟢🔵⚡🎯📌][^\n\r]*=\s*[^\n\r]*$/gm, '')
        .replace(/^(?:[A-ZÀÁÂÃÄÅÆ][a-zàáâãäåæ]+\s+){1,4}=\s*.+$/gm, '')
        // ── SEPARATORI DECORATIVI ───────────────────────────────────────────────
        // Solo se occupano una RIGA INTERA. Le due regole di prima agivano ovunque,
        // e `([#\-*]\s?){3,}` in particolare consumava anche lo SPAZIO fra un
        // marcatore e l'altro: su `**"...cookies?"** *She grins.*` agganciava
        // `*`,`*`,`* ` e restituiva `cookies?"She grins.`, le due frasi incollate.
        // Da qui uscivano `smile."I'm`, `butter!"Turning`, `stretches.**`: il
        // modello se li rileggeva fra i ricordi e imparava a scrivere così.
        // Finché Phase B e C erano rotte il difetto c'era ma non si vedeva, perché
        // quei frammenti non li recuperava nessuno.
        .replace(/^\s*[-=─_*#~]{3,}\s*$/gm, '')
        // Marcatori di enfasi: in un ricordo non hanno significato, e vanno tolti
        // SENZA toccare gli spazi intorno, altrimenti le parole si saldano.
        .replace(/\*+/g, '')
        .replace(/\[(UNDEVELOPED|NULL|HIDDEN|UNKNOWN|EMPTY|NO-RAG)\]/gi, '')
        // ── IMPAGINAZIONE DA COPIONE ────────────────────────────────────────────
        // Questi frammenti sono messaggi passati veri, e finche' Phase B e C erano
        // rotte non li rileggeva nessuno: il RAG era solo lorebook, cioe' prosa
        // enciclopedica. Ora che funzionano, il modello si rilegge davanti la forma
        // dei propri messaggi vecchi, e la imita. Il risultato e' un personaggio
        // che smette di parlare e comincia a scrivere una sceneggiatura.
        //
        // Un ricordo deve tornare come PROSA. Cio' che si toglie qui e' solo
        // impaginazione: il contenuto resta tutto.

        // Catene di didascalie sceniche: "(luce calda) | (due seduti al tavolo) | (lei sorride)".
        // Riga intera, va via intera: non e' un ricordo, e' una regia.
        .replace(/^\s*\([^)\n]*\)(?:\s*\|\s*\([^)\n]*\))+\s*$/gm, '')
        // Blocchi meta del Motore del Fato di Silly Quantum. Finiscono nei cassetti
        // perche' SQ riscrive il messaggio dell'utente PRIMA che MemPalace lo salvi,
        // quindi il testo memorizzato contiene gia' le intestazioni.
        .replace(/\*{0,2}\[[^\]]*(?:\bINTENTION\b|WHAT ACTUALLY HAPPENS)[^\]]*\]\*{0,2}/gi, '')
        // Etichette del parlante a inizio riga ("Utente:", "Aria:"). Si toglie
        // l'etichetta e si tiene la battuta: il nome lo sa gia' chi legge, e la sua
        // presenza e' proprio cio' che insegna al modello a impaginare a copione.
        .replace(/^\s*[A-ZÀ-Þ][\p{L}'’-]{1,24}\s*:\s+(?=\S)/gmu, '')
        // Etichette di Silly Quantum sui propri ricordi. Il contenuto e' buono, la
        // forma no: "OUTCOME_WAS" e' linguaggio da macchina, e un modello che se lo
        // ritrova fra i ricordi impara che si scrive cosi'.
        .replace(/\[Oracle Twist\]\s*/gi, '')
        .replace(/\[Judgement\]\s*/gi, '')
        .replace(/\s+OUTCOME_WAS\s+/g, ', esito: ')
        .replace(/\{\{[^}]+\}\}/g, '')
        .replace(/^\{[^:{}]+:\s*-?\s*/gm, '')
        .replace(/^\}\s*$/gm, '')
        .replace(/\[[A-Z][A-Za-z0-9\s''àáâèéêìíîòóôùúû]+\s+-\s+[A-Za-z0-9\s]+\]/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join(' ')
        // Rete di sicurezza: uno spazio dove la punteggiatura di fine frase tocca
        // direttamente una virgoletta o una maiuscola. Copre quello che i filtri di
        // sopra potrebbero ancora saldare, e anche i cassetti gia' salvati storti.
        // Il vincolo sul carattere PRIMA (minuscola o virgoletta) protegge le
        // abbreviazioni: in "U.S.A" il punto e' preceduto da una maiuscola, quindi
        // non viene toccato; in "smile.\"I'm" da una minuscola, e viene separato.
        // Dopo la virgoletta facoltativa DEVE esserci una maiuscola: è ciò che
        // distingue una virgoletta che apre una battuta nuova da una che chiude
        // quella appena finita. Senza questo vincolo `sweet."` diventava `sweet. "`,
        // con lo spazio dalla parte sbagliata.
        .replace(/([\p{Ll}"'”»][.!?])(?=["'“«]?\p{Lu})/gu, '$1 ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// [L1] KG subject quality filter, array module-level per evitare riallocazione ad ogni iterazione forEach
const KG_SUBJ_BLACKLIST = [
    // Avverbi e congiunzioni EN
    'suddenly','however','meanwhile','therefore','although','nevertheless',
    'furthermore','moreover','consequently','nonetheless','afterwards',
    'eventually','immediately','apparently','basically','generally',
    'actually','literally','certainly','obviously','clearly',
    // Avverbi narrativi IT
    'improvvisamente','tuttavia','intanto','pertanto','comunque',
    'nonostante','inoltre','dunque','quindi','infine','subito',
    // Metadati di formattazione
    'character-wise','note','notes','overall','summary','context',
    // Articoli/preposizioni che sfuggono al NER
    'the','a','an','this','that','these','those','it','its',
];

// --- MULTI-LANGUAGE SYSTEM (i18n) ---
const TRANSLATIONS = {
    it: {
        lore_bg_label: "Leggi la lore in sottofondo",
        lore_bg_hint: "Solo a chat ferma da un minuto. Spegnilo se senti la scheda video lavorare",
        lore_prep_toast: "Sto leggendo {count} voci di lore in sottofondo (~{min} min). Puoi giocare intanto.",
        stat_rag_hit: "Ricordi trovati:",
        aaak_label: "Attiva il dialetto AAAK",
        // Contenitori del pannello riordinato per logica funzionale
        grp_memoria: "Memoria del personaggio",
        grp_memoria_sub: "chi è, cosa ricorda, dove finisce",
        grp_mondo: "Mondo e lore",
        grp_mondo_sub: "i libri che il personaggio conosce",
        grp_conoscenza: "Conoscenza",
        grp_conoscenza_sub: "fatti, entità, eventi, mappa",
        grp_recupero: "Come pesca i ricordi",
        grp_recupero_sub: "quanto e cosa finisce nel prompt",
        grp_scrittura: "Come registra i ricordi",
        grp_scrittura_sub: "cosa salva e come estrae i fatti",
        grp_manutenzione: "Manutenzione",
        grp_manutenzione_sub: "copie di sicurezza e azzeramento",
        grp_interfaccia: "Interfaccia",
        grp_interfaccia_sub: "lingua del pannello",
        autoscan_hint: "Ri-allinea da solo i messaggi non ancora in archivio",
        llm_extract_hint: "Molti più fatti del regex, ma occupa il modello per qualche secondo",
        aaak_hint: "Dialetto compresso: meno token, lettura meno naturale",
        wipe_warning: "Cancella tutti i ricordi di questo personaggio. Non si torna indietro: fai prima una copia.",
        ui_lang: "Lingua Interfaccia:",
        iso_label: "Isolamento Memoria:",
        iso_global: "Globale",
        iso_local: "Isolata",
        stats_title: "📊 Storage e Parametri",
        refresh_title: "Aggiorna Statistiche al Volo",
        stat_mem: "Ricordi in Memoria:",
        stat_weight: "Peso dei Dati:",
        stat_diary: "Nucleo Memoria (Bio):",
        stat_kg_nodes: "Entità KG (Nodi):",
        stat_kg_triples: "Fatti KG (Triple):",
        edit_mem_title: "Modifica Memoria Permanente",
        diary_edit_title: "Modifica Nucleo Memoria",
        diary_load_txt: "Carica TXT",
        diary_load_txt_title: "Carica da file .txt",
        diary_placeholder: "Inserisci qui i fatti 'sacri' del personaggio (es. biografia, relazioni fisse, traumi) che devono sempre finire nel prompt per coerenza di lungo termine...",
        diary_save: "Salva Memoria",
        diary_close: "Chiudi",
        autoscan_label: "Auto-scansiona ogni chat se disallineata",
        lore_title: "Ingestione Lorebook (Manuale)",
        lore_desc: "Seleziona una Lorebook per \"insegnarla\" a MemPalace. Una volta ingerita, l'IA potrà cercarla semanticamente.",
        lore_select_default: "-- Seleziona una Lorebook --",
        lore_btn: "Ingerisci Lore",
        sync_btn: "Risincronizza Chat (Manuale)",
        sync_title: "Scandaglia l'intera chat storicamente per registrarla in MemPalace",
        wipe_btn: "Elimina Memoria Personaggio",
        wipe_title: "Wipe Character's Long-Term Memory",
        backup_btn: "Backup",
        backup_title: "Esporta un backup JSON di tutte le memorie di questo personaggio",
        restore_btn: "Ripristina",
        restore_title: "Ripristina le memorie da un file di backup JSON",
        support_dev: "Support development on LibrePay",
        status_waiting_title: "In attesa...",
        status_waiting_stats: "Seleziona un personaggio",
        status_active: "Attivo su:",
        status_offline: "Disconnesso su:",
        status_db_ok: "Database risponde: OK",
        status_endpoint_error: "Impossibile contattare l'endpoint MemPalace.",
        toast_no_char: "Nessun personaggio attivo.",
        toast_wipe_success: "Memoria di {name} eliminata con successo.",
        toast_wipe_error: "Errore Wipe: ",
        toast_sync_success: "MemPalace ha appreso il passato! Sincronizzati {count} messaggi per {name}.",
        toast_sync_error: "Sync interrotta. Controlla console log.",
        toast_backup_success: "Backup esportato! {count} ricordi salvati.",
        toast_restore_success: "Ripristino completato: {imported} importati, {skipped} già presenti, {errors} errori.",
        toast_restore_invalid: "File di backup non valido: struttura non riconosciuta.",
        toast_restore_empty: "Il backup è vuoto, nessun ricordo da ripristinare.",
        toast_ingest_done: "Ingestione completata: {saved} elementi da {bookName}.",
        toast_ingest_success: "Ingestione riuscita: {saved} nuovi elementi, {duplicates} duplicati saltati.",
        toast_ingest_warn: "Ingestione parziale: {saved} salvati, {duplicates} duplicati, {errors} errori.",
        toast_lore_error: "Errore durante l'ingestione della Lorebook.",
        toast_lore_empty: "La Lorebook selezionata è vuota.",
        toast_no_lore: "Seleziona prima una Lorebook.",
        toast_no_sync: "Nessun messaggio da sincronizzare in questa chat.",
        toast_auto_align: "Riallineamento Sinaptico: MemPalace sta analizzando {count} messaggi per sincronizzare la memoria...",
        toast_file_loaded: "File caricato con successo nel Nucleo!",
        btn_saving: "Salvataggio...",
        conf_sure: "Sicuro? (Clicca Ancora)",
        conf_sync: "Sincronizzare l'intera Chat? (Clicca Ancora)",
        btn_exporting: "Esportazione...",
        btn_reading: "Lettura...",
        btn_loading: "Caricamento...",
        btn_preparing: "Preparazione...",
        btn_ingesting: "Ingestione {count}/{total}...",
        btn_syncing: "Sync {count}/{total}...",
        rag_header: "--- Frammenti del Subconscio ---",
        rag_instruction: "Mentre rifletti, questi ricordi del tuo passato riemergono nella mente. Incorporali naturalmente nei tuoi pensieri e azioni, come se fossero tue esperienze vissute, senza dichiarare esplicitamente che ti sono forniti dal sistema.",
        rag_lore: "[Conoscenze Radicate]",
        rag_events: "[Ricordi Vividi]",
        rag_echoes: "[Echi Lontani]",
        diary_header: "--- Essenza Eterna (Memoria Biografica e Nucleo) ---",
        rag_public: "[Conoscenze del Mondo]",
        rag_secrets: "[Segreti Custoditi]",
        rag_secret_instruction: "Custodisci dei segreti che non devono essere rivelati facilmente. Sii prudente nel discutere quanto segue:",
        rag_personal: "[Memorie Interiori]",
        info_conn_title: "Guida alla Connessione",
        info_conn_body: "MemPalace comunica tramite un bridge sulla porta **8052**. Consigli:<br>1. Assicurati che il server MCP sia in esecuzione.<br>2. Se usi Docker, usa `host.docker.internal` come indirizzo.<br>3. Se ST è su HTTPS, assicurati di usare SSL anche per il bridge.",
        info_iso_title: "Isolamento Memoria",
        info_iso_body: "<b>Globale:</b> Il personaggio ricorda le avventure passate in tutte le sue chat precedenti, mantenendo una continuità storica totale.<br><b>Isolata:</b> La memoria è limitata a questa singola sessione corrente (wing), ideale per storie separate o test 'What If'.",
        info_lore_title: "Ingestione Avanzata",
        info_lore_body: "Il sistema Lorebook nativo di SillyTavern è passivo e basato su parole chiave esatte. Ingerendolo in MemPalace, abiliti la ricerca semantica: i dati vengono 'insegnati' al personaggio e riaffiorano proattivamente come ricordi fluidi durante la generazione.",
        info_aaak_title: "Protocollo Dialetto AAAK",
        info_aaak_body: "AAAK è un sistema di compressione semantica della memoria. Invece di inviare frasi intere, i ricordi vengono codificati in token compatti (es. <code>[E:SAD][ID:CL][F:MISS_FATHER]</code>).<br><br>Questo riduce drasticamente l'occupazione dei token, permettendo al personaggio di 'ricordare' decenni di storia in pochissimo spazio nel contesto del prompt.",
        kg_no_timeline: "Nessun evento temporale registrato per questa timeline.",
        kg_no_facts: "Nessun fatto stabilito trovato nel registro.",
        kg_browser_title: "CONOSCENZA STRUTTURATA (KB)",
        kg_timeline_btn: "Cronologia",
        kg_entities_btn: "Anagrafe Entità",
        llm_extract_label: "Estrai i fatti col modello (continuo + Deep Scan)",
        kg_fact_subject: "Soggetto",
        kg_fact_predicate: "Relazione",
        kg_fact_object: "Oggetto",
        kg_fact_archive: "Archivia: non è più vero",
        kg_fact_archived: "Archiviato: {fact}",
        kg_fact_added: "Fatto aggiunto alla memoria",
        kg_fact_incomplete: "Servono soggetto, relazione e oggetto",
        kg_fact_error: "Operazione sul grafo non riuscita",
        lore_manage_btn: "Lore collegata",
        lore_linked: "Collegata a {name}",
        lore_unlinked: "Scollegata da {name}",
        lore_none: "Nessuna wing di lore disponibile",
        kg_deepscan_btn: "Scansione Sinaptica Profonda",
        kg_graph_btn: "Mappa Sinaptica Globale",
        stat_aaak: "Compressione AAAK:",
        nucleus_preview: "Anteprima Nucleo",
        rag_preview_title: "Ultima Iniezione RAG",
        rag_preview_waiting: "In attesa della prossima generazione…",
        rag_preview_fragments: "{count} frammenti",
        relevance_label: "Soglia Rilevanza RAG",
        relevance_hint_low: "Tutto",
        relevance_hint_high: "Solo rilevante",
        rag_budget_label: "Budget RAG (caratteri)",
        rag_budget_hint_low: "Compatto",
        rag_budget_hint_high: "Completo",
        max_frag_label: "Max car./frammento",
        max_frag_hint_low: "Conciso",
        max_frag_hint_high: "Dettagliato",
        rag_retrieving: "Recupero…",
        status_no_char: "Nessun personaggio selezionato",
        nucleus_empty: "Nucleo vuoto.",
        aaak_saved_pct: "{pct}% salvati",
        diary_from_kg: "Genera da KG",
        diary_from_kg_title: "Pre-popola il Nucleo con i fatti del Knowledge Graph"
    },
    en: {
        lore_bg_label: "Read lore in the background",
        lore_bg_hint: "Only when the chat has been idle a minute. Turn off if you hear the GPU working",
        lore_prep_toast: "Reading {count} lore entries in the background (~{min} min). You can play meanwhile.",
        stat_rag_hit: "Memories found:",
        aaak_label: "Enable AAAK dialect",
        // Contenitori del pannello riordinato per logica funzionale
        grp_memoria: "Character memory",
        grp_memoria_sub: "who they are, what they recall, where it lands",
        grp_mondo: "World and lore",
        grp_mondo_sub: "the books this character knows",
        grp_conoscenza: "Knowledge",
        grp_conoscenza_sub: "facts, entities, events, map",
        grp_recupero: "How it recalls",
        grp_recupero_sub: "how much and what reaches the prompt",
        grp_scrittura: "How it records",
        grp_scrittura_sub: "what it saves and how it extracts facts",
        grp_manutenzione: "Maintenance",
        grp_manutenzione_sub: "backups and wiping",
        grp_interfaccia: "Interface",
        grp_interfaccia_sub: "panel language",
        autoscan_hint: "Re-files messages that are not in storage yet",
        llm_extract_hint: "Far more facts than the regex, but it occupies the model for a few seconds",
        aaak_hint: "Compressed dialect: fewer tokens, less natural reading",
        wipe_warning: "Deletes every memory of this character. There is no undo: make a backup first.",
        ui_lang: "UI Language:",
        iso_label: "Memory Isolation:",
        iso_global: "Global",
        iso_local: "Isolated",
        stats_title: "📊 Storage & Parameters",
        refresh_title: "Refresh Stats on the fly",
        stat_mem: "Memories in Storage:",
        stat_weight: "Data Weight:",
        stat_diary: "Memory Nucleus (Bio):",
        stat_kg_nodes: "KG Entities (Nodes):",
        stat_kg_triples: "KG Facts (Triples):",
        edit_mem_title: "Edit Permanent Memory",
        diary_edit_title: "Edit Memory Nucleus",
        diary_load_txt: "Load TXT",
        diary_load_txt_title: "Load from .txt file",
        diary_placeholder: "Enter the 'sacred' facts of the character here (e.g., biography, fixed relationships, traumas) that must always end up in the prompt for long-term consistency...",
        diary_save: "Save Memory",
        diary_close: "Close",
        autoscan_label: "Auto-scan every chat if misaligned",
        lore_title: "Lorebook Ingestion (Manual)",
        lore_desc: "Select a Lorebook to \"teach\" it to MemPalace. Once ingested, the AI will be able to search it semantically.",
        lore_select_default: "-- Select a Lorebook --",
        lore_btn: "Ingest Lore",
        sync_btn: "Resync Chat (Manual)",
        sync_title: "Historically scan the entire chat to register it in MemPalace",
        wipe_btn: "Delete Character Memory",
        wipe_title: "Wipe Character's Long-Term Memory",
        backup_btn: "Backup",
        backup_title: "Export a JSON backup of all memories for this character",
        restore_btn: "Restore",
        restore_title: "Restore memories from a JSON backup file",
        support_dev: "Support development on LibrePay",
        status_waiting_title: "Waiting...",
        status_waiting_stats: "Select a character",
        status_active: "Active on:",
        status_offline: "Disconnected on:",
        status_db_ok: "Database responds: OK",
        status_endpoint_error: "Could not contact MemPalace endpoint.",
        toast_no_char: "No active character.",
        toast_wipe_success: "Memory for {name} deleted successfully.",
        toast_wipe_error: "Wipe error: ",
        toast_sync_success: "MemPalace has learned the past! Synchronized {count} messages for {name}.",
        toast_sync_error: "Sync interrupted. Check console logs.",
        toast_backup_success: "Backup exported! {count} memories saved.",
        toast_restore_success: "Restore completed: {imported} imported, {skipped} skipped, {errors} errors.",
        toast_restore_invalid: "Invalid backup file: structure not recognized.",
        toast_restore_empty: "Backup is empty, no memories to restore.",
        toast_ingest_done: "Ingestion complete: {saved} entries from {bookName}.",
        toast_ingest_success: "Ingestion successful: {saved} new entries, {duplicates} duplicates skipped.",
        toast_ingest_warn: "Partial ingestion: {saved} saved, {duplicates} duplicates, {errors} errors.",
        toast_lore_error: "Error during Lorebook ingestion.",
        toast_lore_empty: "Selected Lorebook is empty.",
        toast_no_lore: "Please select a Lorebook first.",
        toast_no_sync: "No messages to sync in this chat.",
        toast_auto_align: "Synaptic Alignment: MemPalace is analyzing {count} messages to synchronize memory...",
        toast_file_loaded: "File loaded successfully into the Nucleus!",
        btn_saving: "Saving...",
        conf_sure: "Sure? (Click Again)",
        conf_sync: "Sync entire Chat? (Click Again)",
        btn_exporting: "Exporting...",
        btn_reading: "Reading...",
        btn_loading: "Loading...",
        btn_preparing: "Preparing...",
        btn_ingesting: "Ingesting {count}/{total}...",
        btn_syncing: "Sync {count}/{total}...",
        rag_header: "--- Subconscious Fragments ---",
        rag_instruction: "As you think, these memories from your past surface in your mind. Incorporate them naturally into your thoughts and actions as if they were your own lived experiences, without explicitly stating they are provided by a system.",
        rag_lore: "[Deep-seated Knowledge]",
        rag_events: "[Vivid Remembrances]",
        rag_echoes: "[Faint Whispers]",
        diary_header: "--- Eternal Essence (Biographical Memory & Core) ---",
        rag_public: "[World Knowledge]",
        rag_secrets: "[Held Secrets]",
        rag_secret_instruction: "You hold secret knowledge that must not be revealed easily. Be cautious when discussing the following:",
        rag_personal: "[Inner Memories]",
        info_conn_title: "Connection Guide",
        info_conn_body: "MemPalace connects via a bridge on port **8052**. Tips:<br>1. Ensure the MCP server is running.<br>2. If using Docker, use `host.docker.internal` as the address.<br>3. If ST is on HTTPS, ensure you use SSL for the bridge too.",
        info_iso_title: "Memory Isolation",
        info_iso_body: "<b>Global:</b> Character remembers past adventures across all previous chats, maintaining total historical continuity.<br><b>Isolated:</b> Memory is limited to this single current session (wing), perfect for separate arcs or 'What If' scenarios.",
        info_lore_title: "Advanced Ingestion",
        info_lore_body: "SillyTavern's native Lorebook system is passive and keyword-dependent. By ingesting it into MemPalace, you enable proactive semantic search: the data is 'taught' to the character and resurfaces as fluid memories during generation.",
        info_aaak_title: "AAAK Dialect Protocol",
        info_aaak_body: "AAAK is a semantic memory compression system. Instead of sending full sentences, memories are encoded into compact tokens (e.g. <code>[E:SAD][ID:CL][F:MISS_FATHER]</code>).<br><br>This drastically reduces token usage, allowing the character to 'remember' decades of history within minimal prompt context space.",
        kg_no_timeline: "No temporal facts recorded for this timeline yet.",
        kg_no_facts: "No established facts found in the registry.",
        kg_browser_title: "KNOWLEDGE BROWSER (KB)",
        kg_timeline_btn: "Timeline",
        kg_entities_btn: "Entity Registry",
        llm_extract_label: "Extract facts with the model (continuous + Deep Scan)",
        kg_fact_subject: "Subject",
        kg_fact_predicate: "Relation",
        kg_fact_object: "Object",
        kg_fact_archive: "Archive: no longer true",
        kg_fact_archived: "Archived: {fact}",
        kg_fact_added: "Fact added to memory",
        kg_fact_incomplete: "Subject, relation and object are required",
        kg_fact_error: "Graph operation failed",
        lore_manage_btn: "Linked lore",
        lore_linked: "Linked to {name}",
        lore_unlinked: "Unlinked from {name}",
        lore_none: "No lore wings available",
        kg_deepscan_btn: "Deep Knowledge Scan",
        kg_graph_btn: "Open Synaptic Map",
        stat_aaak: "AAAK Compression:",
        nucleus_preview: "Nucleus Preview",
        rag_preview_title: "Last RAG Injection",
        rag_preview_waiting: "Awaiting next generation…",
        rag_preview_fragments: "{count} fragments",
        relevance_label: "RAG Relevance Threshold",
        relevance_hint_low: "All",
        relevance_hint_high: "Relevant only",
        rag_budget_label: "RAG Budget (chars)",
        rag_budget_hint_low: "Compact",
        rag_budget_hint_high: "Full",
        max_frag_label: "Max chars/fragment",
        max_frag_hint_low: "Concise",
        max_frag_hint_high: "Detailed",
        rag_retrieving: "Retrieving…",
        status_no_char: "No character selected",
        nucleus_empty: "Empty nucleus.",
        aaak_saved_pct: "{pct}% saved",
        diary_from_kg: "Generate from KG",
        diary_from_kg_title: "Pre-populate the Nucleus with Knowledge Graph facts"
    },
    es: {
        lore_bg_label: "Leer el lore en segundo plano",
        lore_bg_hint: "Solo con el chat parado un minuto. Apagalo si oyes trabajar la grafica",
        lore_prep_toast: "Leyendo {count} entradas de lore en segundo plano (~{min} min). Puedes jugar mientras tanto.",
        stat_rag_hit: "Recuerdos encontrados:",
        aaak_label: "Activar el dialecto AAAK",
        // Contenitori del pannello riordinato per logica funzionale
        grp_memoria: "Memoria del personaje",
        grp_memoria_sub: "quién es, qué recuerda, dónde acaba",
        grp_mondo: "Mundo y lore",
        grp_mondo_sub: "los libros que conoce el personaje",
        grp_conoscenza: "Conocimiento",
        grp_conoscenza_sub: "hechos, entidades, eventos, mapa",
        grp_recupero: "Cómo recupera los recuerdos",
        grp_recupero_sub: "cuánto y qué llega al prompt",
        grp_scrittura: "Cómo registra los recuerdos",
        grp_scrittura_sub: "qué guarda y cómo extrae los hechos",
        grp_manutenzione: "Mantenimiento",
        grp_manutenzione_sub: "copias de seguridad y borrado",
        grp_interfaccia: "Interfaz",
        grp_interfaccia_sub: "idioma del panel",
        autoscan_hint: "Vuelve a archivar los mensajes que aún no están guardados",
        llm_extract_hint: "Muchos más hechos que el regex, pero ocupa el modelo unos segundos",
        aaak_hint: "Dialecto comprimido: menos tokens, lectura menos natural",
        wipe_warning: "Borra todos los recuerdos de este personaje. No hay vuelta atrás: haz antes una copia.",
        ui_lang: "Idioma de Interfaz:",
        iso_label: "Aislamiento de Memoria:",
        iso_global: "Global",
        iso_local: "Aislada",
        stats_title: "📊 Almacenamiento y Parámetros",
        refresh_title: "Actualizar Estadísticas al Vuelo",
        stat_mem: "Recuerdos en Memoria:",
        stat_weight: "Peso de Datos:",
        stat_diary: "Núcleo de Memoria (Bio):",
        edit_mem_title: "Editar Memoria Permanente",
        diary_edit_title: "Editar Núcleo de Memoria",
        diary_load_txt: "Cargar TXT",
        diary_load_txt_title: "Cargar desde archivo .txt",
        diary_placeholder: "Ingrese aquí los hechos 'sagrados' del personaje...",
        diary_save: "Guardar Memoria",
        diary_close: "Cerrar",
        autoscan_label: "Auto-escanear cada chat si está desalineado",
        lore_title: "Ingestión de Lorebook (Manual)",
        lore_desc: "Selecciona un Lorebook para enseñárselo a MemPalace...",
        lore_select_default: "-- Selecciona un Lorebook --",
        lore_btn: "Ingerir Lore",
        sync_btn: "Resincronizar Chat (Manual)",
        sync_title: "Escanear todo el chat históricamente para registrarlo en MemPalace",
        wipe_btn: "Eliminar Memoria del Personaje",
        wipe_title: "Borrar memoria a largo plazo del personaje",
        backup_btn: "Respaldo",
        backup_title: "Exportar respaldo JSON de todas las memorias",
        restore_btn: "Restaurar",
        restore_title: "Restaurar recuerdos desde un archivo JSON",
        support_dev: "Apoya el desarrollo en LibrePay",
        status_waiting_title: "Esperando...",
        status_waiting_stats: "Selecciona un personaje",
        status_active: "Activo en:",
        status_offline: "Desconectado en:",
        status_db_ok: "Base de datos responde: OK",
        status_endpoint_error: "No se pudo contactar con MemPalace.",
        toast_no_char: "Sin personaje activo.",
        toast_wipe_success: "Memoria de {name} eliminada con éxito.",
        toast_wipe_error: "Error de borrado: ",
        toast_sync_success: "¡MemPalace ha aprendido el pasado! {count} mensajes sincronizados para {name}.",
        toast_sync_error: "Sincronización interrumpida. Revisa la consola.",
        toast_backup_success: "¡Respaldo exportado! {count} recuerdos guardados.",
        toast_restore_success: "Restauración completada: {imported} importados, {skipped} omitidos, {errors} errores.",
        toast_restore_invalid: "Archivo de respaldo no válido.",
        toast_restore_empty: "El respaldo está vacío.",
        toast_ingest_done: "Ingestión completada: {saved} elementos de {bookName}.",
        toast_ingest_success: "Ingestión exitosa: {saved} nuevos, {duplicates} duplicados omitidos.",
        toast_ingest_warn: "Ingestión parcial: {saved} guardados, {duplicates} duplicados, {errors} errores.",
        toast_lore_error: "Error durante la ingestión del Lorebook.",
        toast_lore_empty: "El Lorebook seleccionado está vacío.",
        toast_no_lore: "Por favor, selecciones un Lorebook primero.",
        toast_no_sync: "No hay mensajes para sincronizar.",
        toast_auto_align: "Sincronización Sináptica: MemPalace está analizando {count} mensajes para sincronizar la memoria...",
        toast_file_loaded: "¡Archivo cargado con éxito!",
        btn_saving: "Guardando...",
        conf_sure: "¿Seguro? (Clic de nuevo)",
        conf_sync: "¿Sincronizar todo el chat? (Clic de nuevo)",
        btn_exporting: "Exportando...",
        btn_reading: "Leyendo...",
        btn_loading: "Cargando...",
        btn_preparing: "Preparando...",
        btn_ingesting: "Ingiriendo {count}/{total}...",
        btn_syncing: "Sync {count}/{total}...",
        rag_header: "--- Fragmentos del Subconsciente ---",
        rag_instruction: "Mientras reflexionas, estos recuerdos de su pasado resurgen en tu mente. Incorpóralos naturalmente a tus pensamientos y acciones como si fueran tus propias experiencias vividas, sin declarar explícitamente que son proporcionados por un sistema.",
        rag_lore: "[Conocimientos Arraigados]",
        rag_events: "[Recuerdos Vívidos]",
        rag_echoes: "[Ecos Lejanos]",
        diary_header: "--- Esencia Eterna (Memoria Biográfica y Núcleo) ---",
        rag_public: "[Conocimientos del Mundo]",
        rag_secrets: "[Secretos Guardados]",
        rag_secret_instruction: "Posees conocimientos secretos che non deben revelarse fácilmente. Sé cauteloso al discutir lo siguiente:",
        rag_personal: "[Memorias Interiores]",
        stat_aaak: "Compresión AAAK:",
        nucleus_preview: "Vista Previa del Núcleo",
        rag_preview_title: "Última Inyección RAG",
        rag_preview_waiting: "Esperando la próxima generación…",
        rag_preview_fragments: "{count} fragmentos",
        relevance_label: "Umbral de Relevancia RAG",
        relevance_hint_low: "Todo",
        relevance_hint_high: "Solo relevante",
        rag_budget_label: "Presupuesto RAG (chars)",
        rag_budget_hint_low: "Compacto",
        rag_budget_hint_high: "Completo",
        max_frag_label: "Máx. chars/fragmento",
        max_frag_hint_low: "Conciso",
        max_frag_hint_high: "Detallado",
        rag_retrieving: "Recuperando…",
        status_no_char: "Ningún personaje seleccionado",
        nucleus_empty: "Núcleo vacío.",
        aaak_saved_pct: "{pct}% guardado",
        stat_kg_nodes: "Entidades KG (Nodos):",
        stat_kg_triples: "Hechos KG (Triples):",
        kg_timeline_btn: "Cronología",
        kg_entities_btn: "Registro de Entidades",
        llm_extract_label: "Extraer hechos con el modelo (continuo + Deep Scan)",
        kg_fact_subject: "Sujeto",
        kg_fact_predicate: "Relación",
        kg_fact_object: "Objeto",
        kg_fact_archive: "Archivar: ya no es cierto",
        kg_fact_archived: "Archivado: {fact}",
        kg_fact_added: "Hecho añadido a la memoria",
        kg_fact_incomplete: "Se requieren sujeto, relación y objeto",
        kg_fact_error: "Error en la operación del grafo",
        lore_manage_btn: "Lore vinculado",
        lore_linked: "Vinculado a {name}",
        lore_unlinked: "Desvinculado de {name}",
        lore_none: "No hay alas de lore disponibles",
        kg_deepscan_btn: "Escaneo Profundo",
        kg_graph_btn: "Mapa Sináptico",
        diary_from_kg: "Generar desde KG",
        diary_from_kg_title: "Pre-popular el Núcleo con hechos del Knowledge Graph",
        info_conn_title: "Guía de Conexión",
        info_conn_body: "MemPalace se comunica a través de un bridge en el puerto **8052**.<br>1. Asegúrate de que el servidor MCP esté en ejecución.<br>2. Si usas Docker, usa `host.docker.internal` como dirección.<br>3. Si ST está en HTTPS, usa también SSL para el bridge.",
        info_iso_title: "Aislamiento de Memoria",
        info_iso_body: "<b>Global:</b> El personaje recuerda aventuras pasadas en todos los chats anteriores.<br><b>Aislada:</b> La memoria se limita a la sesión actual (wing), ideal para escenarios 'What If'.",
        info_lore_title: "Ingestión Avanzada",
        info_lore_body: "El sistema Lorebook nativo de SillyTavern es pasivo y basado en palabras clave. Al ingerirlo en MemPalace, habilitas la búsqueda semántica: los datos se 'enseñan' al personaje y afloran como recuerdos fluidos durante la generación.",
        info_aaak_title: "Protocolo Dialecto AAAK",
        info_aaak_body: "AAAK es un sistema de compresión semántica de la memoria. En lugar de enviar frases completas, los recuerdos se codifican en tokens compactos (ej. <code>[E:SAD][ID:CL][F:MISS_FATHER]</code>).<br><br>Esto reduce drásticamente el uso de tokens, permitiendo al personaje 'recordar' décadas de historia en poco espacio de contexto."
    },
    fr: {
        lore_bg_label: "Lire le lore en arriere-plan",
        lore_bg_hint: "Seulement apres une minute sans activite. A couper si la carte graphique travaille",
        lore_prep_toast: "Lecture de {count} entrees de lore en arriere-plan (~{min} min). Vous pouvez jouer entre-temps.",
        stat_rag_hit: "Souvenirs trouvés :",
        aaak_label: "Activer le dialecte AAAK",
        // Contenitori del pannello riordinato per logica funzionale
        grp_memoria: "Mémoire du personnage",
        grp_memoria_sub: "qui il est, ce dont il se souvient, où cela va",
        grp_mondo: "Monde et lore",
        grp_mondo_sub: "les livres que ce personnage connaît",
        grp_conoscenza: "Connaissance",
        grp_conoscenza_sub: "faits, entités, événements, carte",
        grp_recupero: "Comment il retrouve les souvenirs",
        grp_recupero_sub: "combien et quoi arrive dans le prompt",
        grp_scrittura: "Comment il enregistre",
        grp_scrittura_sub: "ce qu'il garde et comment il extrait les faits",
        grp_manutenzione: "Maintenance",
        grp_manutenzione_sub: "sauvegardes et effacement",
        grp_interfaccia: "Interface",
        grp_interfaccia_sub: "langue du panneau",
        autoscan_hint: "Réaligne les messages qui ne sont pas encore archivés",
        llm_extract_hint: "Bien plus de faits que le regex, mais occupe le modèle quelques secondes",
        aaak_hint: "Dialecte compressé : moins de jetons, lecture moins naturelle",
        wipe_warning: "Efface tous les souvenirs de ce personnage. Sans retour possible : faites d'abord une sauvegarde.",
        ui_lang: "Langue de l'Interface :",
        iso_label: "Isolation de la Mémoire :",
        iso_global: "Global",
        iso_local: "Isolée",
        stats_title: "📊 Stockage et Paramètres",
        refresh_title: "Actualiser les Statistiques à la volée",
        stat_mem: "Souvenirs en Mémoire :",
        stat_weight: "Poids des Données :",
        stat_diary: "Noyau de Mémoire (Bio) :",
        edit_mem_title: "Modifier la Mémoire Permanente",
        diary_edit_title: "Modifier le Noyau de Mémoire",
        diary_load_txt: "Charger TXT",
        diary_load_txt_title: "Charger depuis un fichier .txt",
        diary_placeholder: "Entrez ici les faits 'sacrés' du personnage...",
        diary_save: "Sauvegarder la Mémoire",
        diary_close: "Fermer",
        autoscan_label: "Auto-scanner chaque chat si désaligné",
        lore_title: "Ingestion de Lorebook (Manuel)",
        lore_desc: "Sélectionnez un Lorebook pour l'enseigner à MemPalace...",
        lore_select_default: "-- Sélectionner un Lorebook --",
        lore_btn: "Ingérer Lore",
        sync_btn: "Resynchroniser Chat (Manuel)",
        sync_title: "Scanner tout le chat historiquement pour l'enregistrer dans MemPalace",
        wipe_btn: "Supprimer la Mémoire",
        wipe_title: "Effacer la mémoire à long terme du personnage",
        backup_btn: "Sauvegarde",
        backup_title: "Exporter une sauvegarde JSON",
        restore_btn: "Restaurer",
        restore_title: "Restaurer depuis un fichier JSON",
        support_dev: "Soutenir le développement sur LibrePay",
        status_waiting_title: "En attente...",
        status_waiting_stats: "Sélectionnez un personnage",
        status_active: "Actif sur :",
        status_offline: "Déconnecté sur :",
        status_db_ok: "Base de données répond : OK",
        status_endpoint_error: "Impossible de contacter MemPalace.",
        toast_no_char: "Aucun personnage actif.",
        toast_wipe_success: "Mémoire de {name} supprimée avec succès.",
        toast_wipe_error: "Erreur de suppression : ",
        toast_sync_success: "MemPalace a appris le passé ! {count} messages synchronisés pour {name}.",
        toast_sync_error: "Sync interrompue. Vérifiez la console.",
        toast_backup_success: "Sauvegarde exportée ! {count} souvenirs sauvegardés.",
        toast_restore_success: "Restauration terminée : {imported} importés, {skipped} sautés, {errors} erreurs.",
        toast_restore_invalid: "Fichier non valide.",
        toast_restore_empty: "Sauvegarde vide.",
        toast_ingest_done: "Ingestion terminée : {saved} éléments de {bookName}.",
        toast_ingest_success: "Ingestion réussie : {saved} nouveaux, {duplicates} doublons ignorés.",
        toast_ingest_warn: "Ingestion partielle : {saved} sauvés, {duplicates} doublons, {errors} erreurs.",
        toast_lore_error: "Erreur lors de l'ingestion du Lorebook.",
        toast_lore_empty: "Le Lorebook sélectionné est vide.",
        toast_no_lore: "Veuillez sélectionner un Lorebook d'abord.",
        toast_no_sync: "Aucun message à synchroniser.",
        toast_auto_align: "Réalignement Synaptique : MemPalace analyse {count} messages pour synchroniser la mémoire...",
        toast_file_loaded: "Fichier chargé avec succès !",
        btn_saving: "Enregistrement...",
        conf_sure: "Sûr ? (Cliquez encore)",
        conf_sync: "Synchroniser tout le chat ? (Cliquez encore)",
        btn_exporting: "Exportation...",
        btn_reading: "Lecture...",
        btn_loading: "Chargement...",
        btn_preparing: "Préparation...",
        btn_ingesting: "Ingestion {count}/{total}...",
        btn_syncing: "Sync {count}/{total}...",
        rag_header: "--- Fragments du Subconscient ---",
        rag_instruction: "Pendant que vous réfléchissez, ces souvenirs de votre passé refont surface dans votre esprit. Incorporez-les naturellement dans vos pensées et vos actions comme s'il s'agissait de vos propres expériences vécues, sans déclarer explicitement qu'ils sont fournis par un système.",
        rag_lore: "[Connaissances Profondes]",
        rag_events: "[Souvenirs Vifs]",
        rag_echoes: "[Échos Lointains]",
        diary_header: "--- Essence Éternelle (Mémoire Biographique et Noyau) ---",
        rag_public: "[Connaissances du Monde]",
        rag_secrets: "[Secrets Gardés]",
        rag_secret_instruction: "Vous détenez des connaissances secrètes qui ne doivent pas être révélées facilement. Soyez prudent lorsque vous discutez de ce qui suit :",
        rag_personal: "[Mémoires Intérieures]",
        stat_aaak: "Compression AAAK :",
        nucleus_preview: "Aperçu du Noyau",
        rag_preview_title: "Dernière Injection RAG",
        rag_preview_waiting: "En attente de la prochaine génération…",
        rag_preview_fragments: "{count} fragments",
        relevance_label: "Seuil de Pertinence RAG",
        relevance_hint_low: "Tout",
        relevance_hint_high: "Pertinent seulement",
        rag_budget_label: "Budget RAG (caractères)",
        rag_budget_hint_low: "Compact",
        rag_budget_hint_high: "Complet",
        max_frag_label: "Max chars/fragment",
        max_frag_hint_low: "Concis",
        max_frag_hint_high: "Détaillé",
        rag_retrieving: "Récupération…",
        status_no_char: "Aucun personnage sélectionné",
        nucleus_empty: "Noyau vide.",
        aaak_saved_pct: "{pct}% économisé",
        stat_kg_nodes: "Entités KG (Nœuds) :",
        stat_kg_triples: "Faits KG (Triplets) :",
        kg_timeline_btn: "Chronologie",
        kg_entities_btn: "Registre des Entités",
        llm_extract_label: "Extraire les faits avec le modèle (continu + Deep Scan)",
        kg_fact_subject: "Sujet",
        kg_fact_predicate: "Relation",
        kg_fact_object: "Objet",
        kg_fact_archive: "Archiver : n'est plus vrai",
        kg_fact_archived: "Archivé : {fact}",
        kg_fact_added: "Fait ajouté à la mémoire",
        kg_fact_incomplete: "Sujet, relation et objet sont requis",
        kg_fact_error: "Échec de l'opération sur le graphe",
        lore_manage_btn: "Lore liée",
        lore_linked: "Liée à {name}",
        lore_unlinked: "Déliée de {name}",
        lore_none: "Aucune aile de lore disponible",
        kg_deepscan_btn: "Scan Profond",
        kg_graph_btn: "Carte Synaptique",
        diary_from_kg: "Générer depuis KG",
        diary_from_kg_title: "Pré-remplir le Noyau avec les faits du Knowledge Graph",
        info_conn_title: "Guide de Connexion",
        info_conn_body: "MemPalace communique via un bridge sur le port **8052**.<br>1. Assurez-vous que le serveur MCP est en cours d'exécution.<br>2. Avec Docker, utilisez `host.docker.internal`.<br>3. Si ST est en HTTPS, utilisez aussi SSL pour le bridge.",
        info_iso_title: "Isolation de la Mémoire",
        info_iso_body: "<b>Global:</b> Le personnage se souvient de toutes ses aventures passées dans tous les chats.<br><b>Isolée:</b> La mémoire est limitée à la session actuelle (wing), idéale pour les scénarios 'What If'.",
        info_lore_title: "Ingestion Avancée",
        info_lore_body: "Le système Lorebook natif de SillyTavern est passif et basé sur des mots-clés. En l'ingerant dans MemPalace, vous activez la recherche sémantique : les données sont 'enseignées' au personnage et remontent comme des souvenirs fluides.",
        info_aaak_title: "Protocole Dialecte AAAK",
        info_aaak_body: "AAAK est un système de compression sémantique de la mémoire. Au lieu d'envoyer des phrases entières, les souvenirs sont encodés en tokens compacts (ex. <code>[E:SAD][ID:CL][F:MISS_FATHER]</code>).<br><br>Cela réduit drastiquement l'utilisation des tokens, permettant au personnage de 'se souvenir' de décennies d'histoire en très peu d'espace."
    },
    de: {
        lore_bg_label: "Lore im Hintergrund lesen",
        lore_bg_hint: "Nur bei einer Minute Ruhe im Chat. Ausschalten, wenn die Grafikkarte arbeitet",
        lore_prep_toast: "Lese {count} Lore-Eintraege im Hintergrund (~{min} Min). Du kannst inzwischen spielen.",
        stat_rag_hit: "Gefundene Erinnerungen:",
        aaak_label: "AAAK-Dialekt aktivieren",
        // Contenitori del pannello riordinato per logica funzionale
        grp_memoria: "Charakter-Gedächtnis",
        grp_memoria_sub: "wer er ist, woran er sich erinnert, wo es landet",
        grp_mondo: "Welt und Lore",
        grp_mondo_sub: "die Bücher, die dieser Charakter kennt",
        grp_conoscenza: "Wissen",
        grp_conoscenza_sub: "Fakten, Entitäten, Ereignisse, Karte",
        grp_recupero: "Wie es Erinnerungen holt",
        grp_recupero_sub: "wie viel und was in den Prompt kommt",
        grp_scrittura: "Wie es Erinnerungen speichert",
        grp_scrittura_sub: "was gespeichert und wie extrahiert wird",
        grp_manutenzione: "Wartung",
        grp_manutenzione_sub: "Sicherungen und Löschen",
        grp_interfaccia: "Oberfläche",
        grp_interfaccia_sub: "Sprache des Panels",
        autoscan_hint: "Trägt Nachrichten nach, die noch nicht im Speicher sind",
        llm_extract_hint: "Weit mehr Fakten als der Regex, belegt aber das Modell für einige Sekunden",
        aaak_hint: "Komprimierter Dialekt: weniger Token, weniger natürlich zu lesen",
        wipe_warning: "Löscht alle Erinnerungen dieses Charakters. Ohne Rückweg: vorher eine Sicherung anlegen.",
        ui_lang: "Oberflächensprache:",
        iso_label: "Speicherisolierung:",
        iso_global: "Global",
        iso_local: "Isoliert",
        stats_title: "📊 Speicher & Parameter",
        refresh_title: "Statistiken aktualisieren",
        stat_mem: "Erinnerungen im Speicher:",
        stat_weight: "Datengewicht:",
        stat_diary: "Gedächtniskern (Bio):",
        edit_mem_title: "Dauerspeicher bearbeiten",
        diary_edit_title: "Gedächtniskern bearbeiten",
        diary_load_txt: "TXT laden",
        diary_load_txt_title: "Aus .txt-Datei laden",
        diary_placeholder: "Geben Sie hier die 'heiligen' Fakten ein...",
        diary_save: "Speichern",
        diary_close: "Schließen",
        autoscan_label: "Chats automatisch scannen",
        lore_title: "Lorebook-Aufnahme (Manuell)",
        lore_desc: "Lorebook auswählen, um es MemPalace beizubringen...",
        lore_select_default: "-- Lorebook auswählen --",
        lore_btn: "Lore aufnehmen",
        sync_btn: "Chat synchronisieren",
        sync_title: "Chat historisch scannen",
        wipe_btn: "Gedächtnis löschen",
        wipe_title: "Langzeitgedächtnis löschen",
        backup_btn: "Backup",
        backup_title: "JSON-Backup exportieren",
        restore_btn: "Wiederherstellen",
        restore_title: "Aus JSON-Datei wiederherstellen",
        support_dev: "Entwicklung auf LibrePay unterstützen",
        status_waiting_title: "Warten...",
        status_waiting_stats: "Charakter auswählen",
        status_active: "Aktiv auf:",
        status_offline: "Getrennt auf:",
        status_db_ok: "Datenbank bereit: OK",
        status_endpoint_error: "MemPalace nicht erreichbar.",
        toast_no_char: "Kein aktiver Charakter.",
        toast_wipe_success: "Gedächtnis von {name} gelöscht.",
        toast_wipe_error: "Fehler beim Löschen: ",
        toast_sync_success: "MemPalace hat gelernt! {count} Nachrichten sychronisiert.",
        toast_sync_error: "Sync unterbrochen.",
        toast_backup_success: "Backup exportiert! {count} Einträge.",
        toast_restore_success: "Wiederherstellung: {imported} importiert.",
        toast_restore_invalid: "Ungültige Backup-Datei.",
        toast_restore_empty: "Backup ist leer.",
        toast_ingest_done: "Aufnahme abgeschlossen: {saved} Einträge aus {bookName}.",
        toast_ingest_success: "Erfolgreich: {saved} neu, {duplicates} Duplikate übersprungen.",
        toast_ingest_warn: "Teilweise: {saved} gespeichert, {duplicates} Duplikate, {errors} Fehler.",
        toast_lore_error: "Fehler bei der Lorebook-Aufnahme.",
        toast_lore_empty: "Lorebook ist leer.",
        toast_no_lore: "Bitte zuerst ein Lorebook auswählen.",
        toast_no_sync: "Keine Nachrichten zum Synchronisieren.",
        toast_auto_align: "Synaptische Ausrichtung: MemPalace analysiert {count} Nachrichten zur Synchronisierung...",
        toast_file_loaded: "Datei erfolgreich geladen!",
        btn_saving: "Speichern...",
        conf_sure: "Sicher? (Erneut klicken)",
        conf_sync: "Ganze Chat synchronisieren? (Erneut klicken)",
        btn_exporting: "Exportieren...",
        btn_reading: "Lesen...",
        btn_loading: "Laden...",
        btn_preparing: "Vorbereitung...",
        btn_ingesting: "Aufnahme {count}/{total}...",
        btn_syncing: "Sync {count}/{total}...",
        rag_header: "--- Fragmente des Unterbewusstseins ---",
        rag_instruction: "Während du nachdenkst, tauchen diese Erinnerungen an deine Vergangenheit in deinem Geist auf. Integriere sie ganz naturlich in deine Gedanken und Handlungen, als wären es deine eigenen Erlebnisse, ohne explizit zu erwahnen, dass sie von einem System bereitgestellt werden.",
        rag_lore: "[Tief verwurzeltes Wissen]",
        rag_events: "[Lebhafte Erinnerungen]",
        rag_echoes: "[Ferne Echos]",
        diary_header: "--- Ewige Essenz (Biografisches Gedächtnis & Kern) ---",
        rag_public: "[Weltwissen]",
        rag_secrets: "[Gehütete Geheimnisse]",
        rag_secret_instruction: "Du bewahrst geheimes Wissen, das nicht leichtfertig verraten werden darf. Sei vorsichtig, wenn du Folgendes ansprichst:",
        rag_personal: "[Innere Erinnerungen]",
        stat_aaak: "AAAK-Kompression:",
        nucleus_preview: "Kernvorschau",
        rag_preview_title: "Letzte RAG-Injektion",
        rag_preview_waiting: "Warte auf nächste Generierung…",
        rag_preview_fragments: "{count} Fragmente",
        relevance_label: "RAG-Relevanzschwelle",
        relevance_hint_low: "Alles",
        relevance_hint_high: "Nur relevant",
        rag_budget_label: "RAG-Budget (Zeichen)",
        rag_budget_hint_low: "Kompakt",
        rag_budget_hint_high: "Vollständig",
        max_frag_label: "Max Zeichen/Fragment",
        max_frag_hint_low: "Prägnant",
        max_frag_hint_high: "Detailliert",
        rag_retrieving: "Abrufen…",
        status_no_char: "Kein Charakter ausgewählt",
        nucleus_empty: "Kern leer.",
        aaak_saved_pct: "{pct}% gespart",
        stat_kg_nodes: "KG-Entitäten (Knoten):",
        stat_kg_triples: "KG-Fakten (Tripel):",
        kg_timeline_btn: "Zeitleiste",
        kg_entities_btn: "Entitätsregister",
        llm_extract_label: "Fakten mit dem Modell extrahieren (laufend + Deep Scan)",
        kg_fact_subject: "Subjekt",
        kg_fact_predicate: "Beziehung",
        kg_fact_object: "Objekt",
        kg_fact_archive: "Archivieren: nicht mehr wahr",
        kg_fact_archived: "Archiviert: {fact}",
        kg_fact_added: "Fakt zum Gedächtnis hinzugefügt",
        kg_fact_incomplete: "Subjekt, Beziehung und Objekt erforderlich",
        kg_fact_error: "Graph-Operation fehlgeschlagen",
        lore_manage_btn: "Verknüpfte Lore",
        lore_linked: "Verknüpft mit {name}",
        lore_unlinked: "Getrennt von {name}",
        lore_none: "Keine Lore-Flügel verfügbar",
        kg_deepscan_btn: "Tiefen-Scan",
        kg_graph_btn: "Synaptische Karte",
        diary_from_kg: "Aus KG generieren",
        diary_from_kg_title: "Den Kern mit Knowledge-Graph-Fakten vorausfüllen",
        info_conn_title: "Verbindungsanleitung",
        info_conn_body: "MemPalace kommuniziert über einen Bridge auf Port **8052**.<br>1. Stelle sicher, dass der MCP-Server läuft.<br>2. Mit Docker verwende `host.docker.internal`.<br>3. Bei HTTPS in ST auch SSL für den Bridge verwenden.",
        info_iso_title: "Speicher-Isolation",
        info_iso_body: "<b>Global:</b> Der Charakter erinnert sich an vergangene Abenteuer in allen vorherigen Chats.<br><b>Isoliert:</b> Der Speicher ist auf die aktuelle Sitzung (Wing) beschränkt, ideal für 'Was wäre wenn'-Szenarien.",
        info_lore_title: "Erweiterte Einspeisung",
        info_lore_body: "SillyTaverns natives Lorebook-System ist passiv und schlüsselwortbasiert. Durch Einspeisung in MemPalace aktivierst du semantische Suche: Daten werden dem Charakter 'beigebracht' und tauchen als fließende Erinnerungen auf.",
        info_aaak_title: "AAAK-Dialekt-Protokoll",
        info_aaak_body: "AAAK ist ein semantisches Speicherkomprimierungssystem. Statt ganzer Sätze werden Erinnerungen in kompakte Token kodiert (z.B. <code>[E:SAD][ID:CL][F:MISS_FATHER]</code>).<br><br>Dies reduziert den Token-Verbrauch drastisch und ermöglicht es dem Charakter, Jahrzehnte Geschichte in minimalem Kontextraum zu 'erinnern'."
    },
    ja: {
        lore_bg_label: "ロアをバックグラウンドで読む",
        lore_bg_hint: "チャットが1分静かなときだけ。GPUが働くのが気になるならオフに",
        lore_prep_toast: "ロアを{count}件、バックグラウンドで読んでいます（約{min}分）。その間も遊べます。",
        stat_rag_hit: "見つかった記憶:",
        aaak_label: "AAAK方言を有効にする",
        // Contenitori del pannello riordinato per logica funzionale
        grp_memoria: "キャラクターの記憶",
        grp_memoria_sub: "誰であるか、何を覚えているか、どこに入るか",
        grp_mondo: "世界とロア",
        grp_mondo_sub: "このキャラクターが知っている本",
        grp_conoscenza: "ナレッジ",
        grp_conoscenza_sub: "事実・エンティティ・出来事・マップ",
        grp_recupero: "記憶の取り出し方",
        grp_recupero_sub: "プロンプトに何をどれだけ入れるか",
        grp_scrittura: "記憶の記録方法",
        grp_scrittura_sub: "何を保存し、どう事実を抽出するか",
        grp_manutenzione: "メンテナンス",
        grp_manutenzione_sub: "バックアップと消去",
        grp_interfaccia: "インターフェース",
        grp_interfaccia_sub: "パネルの言語",
        autoscan_hint: "まだ保存されていないメッセージを自動で取り込みます",
        llm_extract_hint: "正規表現よりずっと多くの事実を抽出しますが、数秒モデルを占有します",
        aaak_hint: "圧縮方言：トークンは減りますが読みにくくなります",
        wipe_warning: "このキャラクターの記憶をすべて削除します。取り消せません。先にバックアップを。",
        ui_lang: "インターフェース言語:",
        iso_label: "メモリの分離:",
        iso_global: "グローバル（チャット間統合）",
        iso_local: "分離（現在のチャットのみ）",
        stats_title: "📊 ストレージとパラメータ",
        refresh_title: "統計を更新",
        stat_mem: "メモリ内の記憶:",
        stat_weight: "データ容量:",
        stat_diary: "メモリ核 (Bio):",
        edit_mem_title: "永久保存メモリを編集",
        diary_edit_title: "メモリ核を編集",
        diary_load_txt: "TXTを読込",
        diary_load_txt_title: ".txtから読込",
        diary_placeholder: "キャラクターの「神聖な」事実を入力してください...",
        diary_save: "保存",
        diary_close: "閉じる",
        autoscan_label: "不一致の場合に自動スキャン",
        lore_title: "ロアブックの取り込み",
        lore_desc: "MemPalaceに「教える」ロアブックを選択...",
        lore_select_default: "-- ロアブックを選択 --",
        lore_btn: "ロアを取り込む",
        sync_btn: "チャットを同期",
        sync_title: "全体をスキャンしてMemPalaceを登録",
        wipe_btn: "メモリ削除",
        wipe_title: "長期記憶を消去",
        backup_btn: "バックアップ",
        backup_title: "JSONバックアップをエクスポート",
        restore_btn: "復元",
        restore_title: "JSONから復元",
        support_dev: "LibrePayで支援する",
        status_waiting_title: "待機中...",
        status_waiting_stats: "キャラクターを選択してください",
        status_active: "有効:",
        status_offline: "切断:",
        status_db_ok: "DB応答: OK",
        status_endpoint_error: "接続エラー。",
        toast_no_char: "キャラ未選択。",
        toast_wipe_success: "{name} の記憶を削除しました。",
        toast_wipe_error: "エラー: ",
        toast_sync_success: "学習完了しました！ {count} 件同期。",
        toast_sync_error: "中断されました。",
        toast_backup_success: "バックアップ完了！ {count} 件。",
        toast_restore_success: "復元完了: {imported} 件を読込。",
        toast_restore_invalid: "ファイル形式エラー。",
        toast_restore_empty: "ファイルが空です。",
        toast_ingest_done: "取り込み完了: {bookName} から {saved} 件。",
        toast_ingest_success: "成功: {saved} 件追加、{duplicates} 件重複スキップ。",
        toast_ingest_warn: "一部完了: {saved} 保存、{duplicates} 重複、{errors} エラー。",
        toast_lore_error: "ロアブックの取り込み中にエラーが発生しました。",
        toast_lore_empty: "選択したロアブックは空です。",
        toast_no_lore: "最初にロアブックを選択してください。",
        toast_no_sync: "同期するメッセージがありません。",
        toast_auto_align: "シナプス再整列: MemPalaceはメモリ同期のために {count} 件のメッセージを分析しています...",
        toast_file_loaded: "ファイルの読み込みに成功しました！",
        btn_saving: "保存中...",
        conf_sure: "よろしいですか？（再クリック）",
        conf_sync: "チャット全体を同期しますか？（再クリック）",
        btn_exporting: "エクスポート中...",
        btn_reading: "読込中...",
        btn_loading: "読込中...",
        btn_preparing: "準備中...",
        btn_ingesting: "取り込み中 {count}/{total}...",
        btn_syncing: "同期 {count}/{total}...",
        rag_header: "--- 潜在意識の断片 ---",
        rag_instruction: "思索に耽る中、過去の記憶が脳裏に浮かんできます。これらをシステムから提供された情報としてではなく、自分自身の記憶として自然に思考や行動に取り入れてください。",
        rag_lore: "[根付いた知識]",
        rag_events: "[鮮明な追憶]",
        rag_echoes: "[遠い残響]",
        diary_header: "--- 永遠の真髄（伝記的記憶と核） ---",
        rag_public: "[世界の知識]",
        rag_secrets: "[守るべき秘密]",
        rag_secret_instruction: "あなたは簡単に明かしてはならない秘密の知識を持っています。以下の内容について話すときは注意してください：",
        rag_personal: "[心の奥底の記憶]",
        stat_aaak: "AAAK圧縮：",
        nucleus_preview: "核プレビュー",
        rag_preview_title: "最後のRAG注入",
        rag_preview_waiting: "次の生成を待っています…",
        rag_preview_fragments: "{count}フラグメント",
        relevance_label: "RAG関連性しきい値",
        relevance_hint_low: "すべて",
        relevance_hint_high: "関連のみ",
        rag_budget_label: "RAGバジェット（文字数）",
        rag_budget_hint_low: "コンパクト",
        rag_budget_hint_high: "フル",
        max_frag_label: "最大文字数/フラグメント",
        max_frag_hint_low: "簡潔",
        max_frag_hint_high: "詳細",
        rag_retrieving: "取得中…",
        status_no_char: "キャラクター未選択",
        nucleus_empty: "核が空です。",
        aaak_saved_pct: "{pct}%節約",
        stat_kg_nodes: "KGエンティティ (ノード):",
        stat_kg_triples: "KG事実 (トリプル):",
        kg_timeline_btn: "タイムライン",
        kg_entities_btn: "エンティティ登録",
        llm_extract_label: "モデルで事実を抽出（継続 + Deep Scan）",
        kg_fact_subject: "主語",
        kg_fact_predicate: "関係",
        kg_fact_object: "目的語",
        kg_fact_archive: "アーカイブ：もう真実ではない",
        kg_fact_archived: "アーカイブ済み：{fact}",
        kg_fact_added: "事実を記憶に追加しました",
        kg_fact_incomplete: "主語・関係・目的語が必要です",
        kg_fact_error: "グラフ操作に失敗しました",
        lore_manage_btn: "リンク済みロア",
        lore_linked: "{name} にリンクしました",
        lore_unlinked: "{name} からリンク解除しました",
        lore_none: "利用可能なロアウィングがありません",
        kg_deepscan_btn: "ディープスキャン",
        kg_graph_btn: "シナプスマップ",
        diary_from_kg: "KGから生成",
        diary_from_kg_title: "ナレッジグラフの事実でNucleusを事前入力",
        info_conn_title: "接続ガイド",
        info_conn_body: "MemPalaceはポート**8052**のブリッジで通信します。<br>1. MCPサーバーが起動していることを確認。<br>2. Dockerの場合は`host.docker.internal`を使用。<br>3. STがHTTPSの場合はブリッジにもSSLを使用。",
        info_iso_title: "メモリの分離",
        info_iso_body: "<b>グローバル:</b> キャラクターは過去のすべてのチャットの冒険を覚えています。<br><b>分離:</b> メモリは現在のセッション(wing)に限定されます。'What If'シナリオに最適。",
        info_lore_title: "高度な取り込み",
        info_lore_body: "SillyTavernのネイティブLorebook システムはキーワードに依存した受動的なシステムです。MemPalaceに取り込むことでセマンティック検索が有効になり、データがキャラクターに'教えられ'、生成中に流れるような記憶として浮かび上がります。",
        info_aaak_title: "AAKダイアレクトプロトコル",
        info_aaak_body: "AAKはセマンティックメモリ圧縮システムです。文章全体を送る代わりに、記憶はコンパクトなトークンにエンコードされます（例: <code>[E:SAD][ID:CL][F:MISS_FATHER]</code>）。<br><br>これによりトークン使用量が大幅に削減され、キャラクターが最小限のコンテキストスペースで数十年の歴史を'記憶'できます。"
    },
    zh: {
        lore_bg_label: "后台读取知识库",
        lore_bg_hint: "仅在聊天静止一分钟后。若听到显卡在工作可关闭",
        lore_prep_toast: "正在后台读取 {count} 条知识库条目（约 {min} 分钟）。期间可以继续游戏。",
        stat_rag_hit: "命中的记忆：",
        aaak_label: "启用 AAAK 方言",
        // Contenitori del pannello riordinato per logica funzionale
        grp_memoria: "角色记忆",
        grp_memoria_sub: "他是谁、记得什么、存到哪里",
        grp_mondo: "世界与知识库",
        grp_mondo_sub: "该角色知道的书",
        grp_conoscenza: "知识图谱",
        grp_conoscenza_sub: "事实、实体、事件、图谱",
        grp_recupero: "如何检索记忆",
        grp_recupero_sub: "有多少、哪些进入提示词",
        grp_scrittura: "如何记录记忆",
        grp_scrittura_sub: "保存什么、如何提取事实",
        grp_manutenzione: "维护",
        grp_manutenzione_sub: "备份与清空",
        grp_interfaccia: "界面",
        grp_interfaccia_sub: "面板语言",
        autoscan_hint: "自动补录尚未入库的消息",
        llm_extract_hint: "比正则提取多得多的事实，但会占用模型几秒",
        aaak_hint: "压缩方言：token 更少，可读性更低",
        wipe_warning: "删除该角色的全部记忆。无法撤销：请先备份。",
        ui_lang: "界面语言：",
        iso_label: "内存隔离：",
        iso_global: "全局（聊天间统一）",
        iso_local: "隔离（仅限当前聊天）",
        stats_title: "📊 存储与参数",
        refresh_title: "刷新统计数据",
        stat_mem: "内存中的记忆：",
        stat_weight: "数据重量：",
        stat_diary: "核心记忆 (Bio)：",
        edit_mem_title: "编辑永久记忆",
        diary_edit_title: "编辑核心记忆",
        diary_load_txt: "加载 TXT",
        diary_load_txt_title: "从 .txt 文件加载",
        diary_placeholder: "在此输入角色的“神圣”事实...",
        diary_save: "保存记忆",
        diary_close: "关闭",
        autoscan_label: "如果不一致，则自动扫描聊天",
        lore_title: "知识库导入",
        lore_desc: "选择知识库以教导 MemPalace...",
        lore_select_default: "-- 选择知识库 --",
        lore_btn: "导入知识",
        sync_btn: "同步聊天",
        sync_title: "扫描整个聊天历史以注册",
        wipe_btn: "删除角色记忆",
        wipe_title: "擦除角色的长期记忆",
        backup_btn: "备份",
        backup_title: "导出 JSON 备份",
        restore_btn: "还原",
        restore_title: "从 JSON 还原记忆",
        support_dev: "在 LibrePay 上支持开发",
        status_waiting_title: "等待中...",
        status_waiting_stats: "选择一个角色",
        status_active: "已激活：",
        status_offline: "已断开：",
        status_db_ok: "数据库响应：OK",
        status_endpoint_error: "无法联系终端。",
        toast_no_char: "没有激活角色。",
        toast_wipe_success: "{name} 的记忆已删除。",
        toast_wipe_error: "删除错误：",
        toast_sync_success: "同步完成！已学习 {count} 条消息。",
        toast_sync_error: "同步中断。",
        toast_backup_success: "备份导出成功！共 {count} 条。",
        toast_restore_success: "还原完成：已导入 {imported} 条。",
        toast_restore_invalid: "备份文件无效。",
        toast_restore_empty: "备份为空。",
        toast_ingest_done: "导入完成：从 {bookName} 导入了 {saved} 条。",
        toast_ingest_success: "导入成功：新增 {saved} 条，跳过 {duplicates} 条重复。",
        toast_ingest_warn: "部分导入：保存 {saved} 条，重复 {duplicates} 条，错误 {errors} 条。",
        toast_lore_error: "知识库导入时出错。",
        toast_lore_empty: "选定的知识库为空。",
        toast_no_lore: "请先选择一个知识库。",
        toast_no_sync: "没有可同步的消息。",
        toast_auto_align: "突触对齐：MemPalace 正在分析 {count} 条消息以同步记忆...",
        toast_file_loaded: "文件加载成功！",
        btn_saving: "保存中...",
        conf_sure: "确定吗？（再次点击）",
        conf_sync: "同步整个聊天？（再次点击）",
        btn_exporting: "导出中...",
        btn_reading: "读取中...",
        btn_loading: "加载中...",
        btn_preparing: "准备中...",
        btn_ingesting: "正在导入 {count}/{total}...",
        btn_syncing: "同步 {count}/{total}...",
        rag_header: "--- 潜意识的碎片 ---",
        rag_instruction: "当你思考时，这些过去的记忆会在脑海中浮现。请自然地将它们融入你的思想和行动中，就像它们是你亲身经历过的一样，不要明确说明它们是由系统提供的。",
        rag_lore: "[根深蒂固的知识]",
        rag_events: "[生动回忆]",
        rag_echoes: "[遥远的回声]",
        diary_header: "--- 永恒精髓（传记记忆与核心） ---",
        rag_public: "[世界知识]",
        rag_secrets: "[深藏的秘密]",
        rag_secret_instruction: "你掌握着不得轻易泄露的秘密知识。在讨论以下内容时请保持谨慎：",
        rag_personal: "[内心记忆]",
        stat_aaak: "AAAK压缩：",
        nucleus_preview: "核心预览",
        rag_preview_title: "上次RAG注入",
        rag_preview_waiting: "等待下一次生成…",
        rag_preview_fragments: "{count}个片段",
        relevance_label: "RAG相关性阈值",
        relevance_hint_low: "全部",
        relevance_hint_high: "仅相关",
        rag_budget_label: "RAG预算（字符）",
        rag_budget_hint_low: "紧凑",
        rag_budget_hint_high: "完整",
        max_frag_label: "最大字符/片段",
        max_frag_hint_low: "简洁",
        max_frag_hint_high: "详细",
        rag_retrieving: "检索中…",
        status_no_char: "未选择角色",
        nucleus_empty: "核心为空。",
        aaak_saved_pct: "{pct}%已节省",
        stat_kg_nodes: "KG实体（节点）：",
        stat_kg_triples: "KG事实（三元组）：",
        kg_timeline_btn: "时间线",
        kg_entities_btn: "实体注册表",
        llm_extract_label: "用模型提取事实（持续 + Deep Scan）",
        kg_fact_subject: "主语",
        kg_fact_predicate: "关系",
        kg_fact_object: "宾语",
        kg_fact_archive: "归档：不再为真",
        kg_fact_archived: "已归档：{fact}",
        kg_fact_added: "事实已加入记忆",
        kg_fact_incomplete: "需要主语、关系和宾语",
        kg_fact_error: "图谱操作失败",
        lore_manage_btn: "关联传说",
        lore_linked: "已关联到 {name}",
        lore_unlinked: "已解除与 {name} 的关联",
        lore_none: "没有可用的传说侧翼",
        kg_deepscan_btn: "深度扫描",
        kg_graph_btn: "突触图",
        diary_from_kg: "从KG生成",
        diary_from_kg_title: "用知识图谱事实预填充核心",
        info_conn_title: "连接指南",
        info_conn_body: "MemPalace通过端口**8052**的桥接进行通信。<br>1. 确保MCP服务器正在运行。<br>2. 使用Docker时，请使用`host.docker.internal`。<br>3. 如果ST使用HTTPS，桥接也需要使用SSL。",
        info_iso_title: "记忆隔离",
        info_iso_body: "<b>全局:</b> 角色记得所有过去聊天中的冒险，保持完整的历史连续性。<br><b>隔离:</b> 记忆仅限于当前会话(wing)，适合'假设'场景。",
        info_lore_title: "高级摄取",
        info_lore_body: "SillyTavern的原生Lorebook系统是被动的、基于关键词的。将其摄取到MemPalace中，可启用语义搜索：数据被'教给'角色，并在生成过程中作为流畅的记忆浮现。",
        info_aaak_title: "AAAK方言协议",
        info_aaak_body: "AAAK是一种语义记忆压缩系统。记忆被编码为紧凑的令牌（如<code>[E:SAD][ID:CL][F:MISS_FATHER]</code>），而不是发送完整的句子。<br><br>这大幅减少了令牌使用量，使角色能够在最小的上下文空间内'记住'数十年的历史。"
    }
};

/**
 * Helper: Ottiene una stringa tradotta con supporto per i parametri {key}
 */
function t(key, params = {}) {
    const lang = localStorage.getItem('mempalace_lang') || 'it';
    let str = TRANSLATIONS[lang]?.[key] || TRANSLATIONS['it'][key] || key;
    
    // Sostituzione parametri {name}, {count}, ecc.
    Object.keys(params).forEach(p => {
        str = str.replaceAll(`{${p}}`, params[p]);
    });
    return str;
}

/**
 * Applica le traduzioni a tutti gli elementi con attributi 'data-i18n'
 */
function applyLanguage(lang) {
    localStorage.setItem('mempalace_lang', lang);
    const dictate = TRANSLATIONS[lang] || TRANSLATIONS['it'];

    $('[data-i18n]').each(function() {
        const key = $(this).attr('data-i18n');
        if (dictate[key]) $(this).text(dictate[key]);
    });

    $('[data-i18n-title]').each(function() {
        const key = $(this).attr('data-i18n-title');
        if (dictate[key]) $(this).attr('title', dictate[key]);
    });

    $('[data-i18n-placeholder]').each(function() {
        const key = $(this).attr('data-i18n-placeholder');
        if (dictate[key]) $(this).attr('placeholder', dictate[key]);
    });
}


/**
 * Call MemPalace Tool API with timeout
 */
async function callMemPalace(toolName, payload) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds max

        const response = await fetch(`${MEMPALACE_URL}/call/${toolName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-MemPalace-Version': _MP_VERSION
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.error(`[MemPalace] Error calling ${toolName}: ${response.statusText}`);
            return null;
        }
        
        const json = await response.json();
        
        // La API FastAPI/MCP wrappa la roba in { result: ... }
        const unwrapped = json.result !== undefined ? json.result : json;
        
        // Mantieni registro locale dello stato se l'API non ha metriche perfette
        if (toolName === 'mempalace_wipe' && payload.wing) {
            window.localWipedWings[payload.wing] = true;
            localStorage.setItem('mempalace_synced_mem_' + payload.wing, 0);
        } else if (toolName === 'mempalace_add_drawer' && payload.wing) {
            window.localWipedWings[payload.wing] = false;
            // Incrementa solo se l'operazione ha avuto successo (non duplicato)
            if (unwrapped && unwrapped.success) {
                let count = parseInt(localStorage.getItem('mempalace_synced_mem_' + payload.wing)) || 0;
                localStorage.setItem('mempalace_synced_mem_' + payload.wing, count + 1);
            }
        }
        
        return unwrapped;
    } catch (error) {
        console.error(`[MemPalace] Fetch error for ${toolName}:`, error);
        return null;
    }
}

/** Escape HTML per prevenire XSS nei modal costruiti da dati backend */
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEZZETTAMENTO DEI RICORDI (tappa 1 del progetto "La Mente del Palazzo")
//
// L'indice semantico del palazzo legge 256 token e basta, e finora nessuno
// spezzava niente: `add_drawer` scriveva `chunk_index: 0` e finiva li'. Tutto cio'
// che stava dopo il primo quarto di un ricordo lungo era, alla lettera,
// irrecuperabile. Misurato su un ricordo da 780 token:
//
//   query sulla coda   "her real name is Veldrina" -> 0.05 intero / 0.57 spezzato
//   query sulla coda   "born in Kaelmoor"          -> 0.00 intero / 0.44 spezzato
//   query sulla testa  "crowded tavern fire"       -> 0.59 intero / 0.61 spezzato
//
// E il 27% dei cassetti superava quella soglia. La testa si e' sempre trovata, la
// coda mai: non era un problema di taratura, era meta' archivio cieco.
//
// I pezzi restano legati da `doc_id`, che il backend conserva perche' `add_drawer`
// fonde i kwargs nei metadati e la ricerca li restituisce (verificato). In lettura
// si ricuce: dei pezzi dello stesso ricordo se ne tiene UNO, il piu' pertinente,
// se no il prompt si riempirebbe di quattro fette dello stesso messaggio.
// ─────────────────────────────────────────────────────────────────────────────

const PEZZO_CAR   = 800;   // ~200 token, sta comodo dentro la finestra dell'indice
const SOVRAP_CAR  = 150;   // una frase a cavallo non si perde nel taglio
const SOGLIA_CAR  = 900;   // sotto questa lunghezza non vale la pena spezzare

// Quante scritture possono stare in volo insieme.
//
// Non e' una precauzione teorica, e' la riparazione di una perdita misurata. Un
// lorebook ingerito lanciava OTTO voci in parallelo, e ogni voce lanciava tutti i
// suoi pezzi in parallelo: fino a 168 scritture insieme. Misurato sul backend:
// 8 insieme 3,4 s | 32 insieme 14,3 s | 64 insieme 28,4 s. E `callMemPalace`
// abortisce a 15 secondi. Quindi oltre la trentina le richieste morivano di
// timeout, e `.catch(() => null)` le faceva sparire senza dire niente: su
// "Final Fantasy 7 World" sono rimasti fuori 31 pezzi su 222, e l'utente ha visto
// una lore assorbita a meta' senza un solo messaggio di errore.
//
// Sei alla volta stanno abbondantemente sotto il timeout e non rallentano niente:
// il collo di bottiglia e' l'embedding, non il numero di connessioni.
const SCRITTURE_INSIEME = 6;

/** Sopra questa somiglianza due ricordi INTERI sono lo stesso ricordo. Vedi scriviRicordo. */
const SOGLIA_DOC_DUPLICATO = 0.98;

/** Esegue i lavori a piccoli gruppi invece che tutti insieme. */
async function aGruppi(elementi, quanti, lavoro) {
    const esiti = [];
    for (let i = 0; i < elementi.length; i += quanti) {
        esiti.push(...await Promise.all(elementi.slice(i, i + quanti).map(lavoro)));
    }
    return esiti;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUNTEGGIO DEI RICORDI (tappe 2 e 3 del progetto "La Mente del Palazzo")
//
// Finora un ricordo valeva per quanto somigliava alla domanda, e basta. Ogni
// cassetto pesava quanto ogni altro, per sempre: quello scritto sei mesi fa e mai
// piu' toccato competeva ad armi pari con quello di ieri sera. Un cervello non
// funziona cosi'.
//
// Il punteggio somma quattro cose che rispondono a domande diverse:
//   somiglianza  quanto c'entra col momento               (la ricerca)
//   salienza     quanto ha colpito QUESTO personaggio     (la tappa 4, per ora neutra)
//   freschezza   quanto e' recente, secondo il suo tipo   (`filed_at`)
//   ripasso      quante volte gli e' tornato in mente     (il registro qui sotto)
//
// ATTENZIONE alla tensione fra ripasso e anti-ripetizione. Il ripasso PREMIA un
// ricordo richiamato spesso, l'ordinamento esistente PENALIZZA un frammento appena
// iniettato. Non si contraddicono perche' parlano di orizzonti diversi: il ripasso
// e' "questo ricordo conta, torna sempre a galla nei giorni"; l'anti-ripetizione e'
// "non ridirlo due turni di fila". Restano separati: il primo entra nel punteggio,
// il secondo resta una penalita' applicata dopo.
// ─────────────────────────────────────────────────────────────────────────────

const PESI = { somiglianza: 0.40, salienza: 0.25, freschezza: 0.20, ripasso: 0.15 };

/** Emivita in giorni, per tipo di ricordo. Infinity = non sbiadisce mai. */
const EMIVITA = {
    scheda: Infinity,      // chi e' il personaggio non invecchia
    lore: Infinity,        // il mondo non invecchia
    apertura: 120,         // l'inizio di un capitolo e' un punto di riferimento
    char: 21,              // una scena vissuta
    user: 21,
    pensiero: 3,           // una riflessione si consuma in fretta (tappa 4)
    secret: Infinity,
};

/** Salienza di un ricordo su cui il modello non si e' ancora pronunciato. */
const SALIENZA_NEUTRA = 0.5;

// Registro della salienza: quanto ogni ricordo ha colpito QUESTO personaggio, e su
// quale asse del suo carattere. Sta a fianco dei cassetti e non dentro, per un motivo
// pratico: la salienza la decide il modello qualche secondo DOPO che il ricordo e'
// stato scritto, e i metadati di un cassetto non si possono piu' toccare una volta
// depositati. Stessa scelta, e stesso comportamento in caso di perdita, del registro
// dei ripassi: si torna a 0.5 per tutti, cioe' a com'era prima della tappa 4.
const SALIENZE_MAX = 3000;
let _salienze = null;
let _salienzeDaSalvare = false;

function leggiSalienze() {
    if (_salienze) return _salienze;
    try { _salienze = JSON.parse(localStorage.getItem('mempalace_salienze') || '{}'); }
    catch (_) { _salienze = {}; }
    return _salienze;
}

function salvaSalienze() {
    if (!_salienzeDaSalvare || !_salienze) return;
    _salienzeDaSalvare = false;
    try {
        const chiavi = Object.keys(_salienze);
        if (chiavi.length > SALIENZE_MAX) {
            // Si buttano le piu' BASSE, non le piu' vecchie: un ricordo che non ha
            // colpito nessuno puo' tornare neutro senza che si perda niente, mentre
            // uno che ha segnato il personaggio deve restare segnato.
            chiavi.sort((a, b) => (_salienze[b][0] || 0) - (_salienze[a][0] || 0));
            const tenuti = {};
            for (const k of chiavi.slice(0, SALIENZE_MAX)) tenuti[k] = _salienze[k];
            _salienze = tenuti;
        }
        localStorage.setItem('mempalace_salienze', JSON.stringify(_salienze));
    } catch (e) {
        console.warn('[MemPalace] Registro della salienza non salvato:', e);
    }
}

/** Segna quanto un ricordo ha colpito il personaggio, e su quale suo asse. */
function registraSalienza(ids, valore, asse) {
    if (!ids || !ids.length) return;
    const v = Math.max(0, Math.min(1, Number(valore)));
    if (!Number.isFinite(v)) return;
    const s = leggiSalienze();
    // Tutti i pezzi di uno stesso ricordo condividono la salienza: e' il ricordo ad
    // aver colpito il personaggio, non la fetta in cui e' stato tagliato.
    for (const id of ids) s[id] = [v, String(asse || '').slice(0, 24)];
    _salienzeDaSalvare = true;
}

/** Punteggio fisso dei fatti del grafo, che non sono cassetti e non hanno metadati. */
const PUNTEGGIO_FATTO_KG = 0.70;

// Registro dei ripassi: quante volte un cassetto e' finito davvero nel prompt.
// Sta in localStorage e non in archivio perche' va aggiornato a ogni generazione e
// una scrittura sul backend per frammento costerebbe piu' del recupero stesso. Se
// il browser lo perde, i ricordi tornano semplicemente a ripasso zero: si degrada
// piano, non si rompe.
const RIPASSI_MAX = 3000;
let _ripassi = null;
let _ripassiDaSalvare = false;

function leggiRipassi() {
    if (_ripassi) return _ripassi;
    try { _ripassi = JSON.parse(localStorage.getItem('mempalace_ripassi') || '{}'); }
    catch (_) { _ripassi = {}; }
    return _ripassi;
}

function salvaRipassi() {
    if (!_ripassiDaSalvare || !_ripassi) return;
    _ripassiDaSalvare = false;
    try {
        const chiavi = Object.keys(_ripassi);
        if (chiavi.length > RIPASSI_MAX) {
            // Si tengono i piu' recenti: un ricordo che non torna a galla da mesi non
            // ha bisogno che si ricordi quante volte tornava a galla prima.
            chiavi.sort((a, b) => (_ripassi[b][1] || 0) - (_ripassi[a][1] || 0));
            const tenuti = {};
            for (const k of chiavi.slice(0, RIPASSI_MAX)) tenuti[k] = _ripassi[k];
            _ripassi = tenuti;
        }
        localStorage.setItem('mempalace_ripassi', JSON.stringify(_ripassi));
    } catch (e) {
        console.warn('[MemPalace] Registro dei ripassi non salvato:', e);
    }
}

/** Segna che questo cassetto e' finito nel prompt. */
function registraRipasso(id) {
    if (!id) return;
    const r = leggiRipassi();
    const [n] = r[id] || [0, 0];
    r[id] = [n + 1, Date.now()];
    _ripassiDaSalvare = true;
}

/**
 * Il punteggio di un ricordo candidato, fra 0 e 1.
 *
 * `filed_at` lo scrive il container in UTC mentre l'host e' in ora locale: sulle
 * ore la differenza si vede, su un decadimento misurato in giorni non cambia nulla.
 */
function punteggioRicordo(res, somiglianza) {
    const stanza = res?.room || 'char';
    const emivita = EMIVITA[stanza] !== undefined ? EMIVITA[stanza] : 21;

    let freschezza = 1;
    if (emivita !== Infinity && res?.filed_at) {
        const quando = Date.parse(res.filed_at);
        if (!Number.isNaN(quando)) {
            const giorni = Math.max(0, (Date.now() - quando) / 86400000);
            freschezza = Math.exp(-giorni / emivita);
        }
    }

    // ln(1+n) normalizzato: dieci ripassi valgono 1, e il primo ripasso pesa molto
    // piu' del decimo. E' la curva giusta: la differenza fra "mai" e "una volta" e'
    // enorme, quella fra "nove volte" e "dieci" non la nota nessuno.
    const [volte] = (res?.id && leggiRipassi()[res.id]) || [0];
    const ripasso = Math.min(1, Math.log1p(volte) / Math.log1p(10));

    // La salienza vera se il modello si e' pronunciato su questo ricordo, se no neutra.
    // E' il termine che fa ricordare cose diverse a personaggi diversi: la stessa scena
    // puo' valere 0.2 per uno e 0.9 per un altro, secondo i suoi assi di attenzione.
    const [salienza] = (res?.id && leggiSalienze()[res.id]) || [SALIENZA_NEUTRA];

    return PESI.somiglianza * Math.max(0, Math.min(1, somiglianza))
         + PESI.salienza    * salienza
         + PESI.freschezza  * freschezza
         + PESI.ripasso     * ripasso;
}

/**
 * Divide un testo lungo in pezzi sovrapposti, tagliando su un confine di frase
 * quando ce n'e' uno vicino. Restituisce sempre almeno un elemento.
 */
function spezzaRicordo(testo) {
    const t = String(testo || '');
    if (t.length <= SOGLIA_CAR) return [t];

    const pezzi = [];
    let i = 0;
    while (i < t.length) {
        let fine = Math.min(i + PEZZO_CAR, t.length);
        if (fine < t.length) {
            // Cerca un confine di frase nell'ultimo quarto del pezzo: tagliare a
            // meta' parola rende il frammento illeggibile una volta iniettato.
            const coda = t.slice(i + Math.floor(PEZZO_CAR * 0.75), fine);
            const punto = Math.max(coda.lastIndexOf('. '), coda.lastIndexOf('! '),
                                   coda.lastIndexOf('? '), coda.lastIndexOf('\n'));
            if (punto > 0) fine = i + Math.floor(PEZZO_CAR * 0.75) + punto + 1;
        }
        pezzi.push(t.slice(i, fine).trim());
        if (fine >= t.length) break;
        i = Math.max(fine - SOVRAP_CAR, i + 1);
    }
    return pezzi.filter(p => p.length > 0);
}

/**
 * L'UNICO punto da cui si scrive un ricordo. Spezza se serve e scrive i pezzi in
 * parallelo, cosi' un messaggio lungo costa quanto uno corto invece che quattro volte.
 *
 * Restituisce {success, pezzi, salvati, duplicati}: `success` e' vero se almeno un
 * pezzo e' entrato, perche' su un ri-allineamento e' normale che alcuni pezzi
 * risultino gia' presenti e altri no.
 */
async function scriviRicordo({ wing, room, content, source_file, ...extra }) {
    const pezzi = spezzaRicordo(content);

    if (pezzi.length === 1) {
        const r = await callMemPalace('mempalace_add_drawer', {
            wing, room, content: pezzi[0],
            ...(source_file ? { source_file } : {}), ...extra,
        });
        return {
            success: !!(r && r.success), pezzi: 1,
            salvati: r && r.success ? 1 : 0,
            duplicati: r && r.reason === 'duplicate' ? 1 : 0,
            ids: (r && r.drawer_id) ? [r.drawer_id] : [],
        };
    }

    // Il controllo duplicati si fa UNA VOLTA sul ricordo intero, non pezzo per pezzo.
    //
    // Misurato: due pezzi contigui si somigliano fino a 0.96, cioe' sopra la soglia
    // normale, perche' si sovrappongono di 150 caratteri per non tagliare una frase a
    // meta'. Lasciando il controllo su ogni pezzo, il secondo veniva rifiutato come
    // duplicato del primo e la coda del ricordo non entrava mai: esattamente il guasto
    // che lo spezzettamento doveva risolvere. Su un libro di lore vero, 0 voci su 2.
    // L'unita' giusta e' il documento: se il ricordo intero e' gia' in archivio non si
    // riscrive, se non c'e' entrano tutti i suoi pezzi.
    // Il controllo sul ricordo INTERO usa una soglia alta di proposito.
    //
    // Con quella di serie, due voci di lorebook che parlano dello stesso argomento si
    // scambiavano per la stessa voce e la seconda spariva per intera: su "Final
    // Fantasy 7 World" una voce su 28 non e' mai entrata. Due voci di un libro sono
    // due voci per definizione, anche se si somigliano. Resta bloccato solo cio' che
    // e' praticamente identico, e comunque i pezzi identici li ferma il controllo per
    // pezzo, che a 0.999 riconosce il testo uguale (somiglianza 1.0, misurata).
    const gia = await callMemPalace('mempalace_check_duplicate',
        { content, wing, threshold: SOGLIA_DOC_DUPLICATO }).catch(() => null);
    if (gia && gia.is_duplicate) {
        return { success: false, pezzi: pezzi.length, salvati: 0, duplicati: pezzi.length, persi: 0 };
    }

    // Un identificativo che lega i pezzi fra loro e non collide fra messaggi.
    const docId = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const esiti = await aGruppi(pezzi.map((p, i) => [p, i]), SCRITTURE_INSIEME, ([p, i]) =>
        callMemPalace('mempalace_add_drawer', {
            wing, room, content: p,
            ...(source_file ? { source_file } : {}),
            doc_id: docId, chunk_index: i, chunk_tot: pezzi.length,
            // Quasi uno: fra i pezzi resta bloccato solo il testo identico.
            dup_threshold: 0.999,
            ...extra,
        }).catch(() => null)
    );
    const salvati = esiti.filter(r => r && r.success).length;
    const duplicati = esiti.filter(r => r && r.reason === 'duplicate').length;
    // Un pezzo che non e' ne' salvato ne' duplicato e' un pezzo PERSO: una richiesta
    // abortita, un errore di rete. Prima finiva in un `null` che nessuno contava, ed
    // e' cosi' che una lore si assorbiva a meta' senza dirlo.
    const persi = pezzi.length - salvati - duplicati;
    if (persi > 0) console.warn(`[MemPalace] ${persi} pezzi su ${pezzi.length} non scritti (wing ${wing}).`);
    // Gli id servono a chi deve attaccare qualcosa a QUESTO ricordo dopo averlo
    // scritto: la salienza, per esempio, che arriva dal modello qualche secondo dopo.
    const ids = esiti.filter(r => r && r.drawer_id).map(r => r.drawer_id);
    return { success: salvati > 0, pezzi: pezzi.length, salvati, duplicati, persi, doc_id: docId, ids };
}

/**
 * Helper to get the canonical character name from the active context
 */
function getActiveCharacterName() {
    const context = getContext();
    if (!context || context.characterId === undefined) return null;
    
    if (window.characters && window.characters[context.characterId]) {
        return window.characters[context.characterId].name;
    }
    
    if (context.chat && context.chat.length > 0) {
        for (let i = context.chat.length - 1; i >= 0; i--) {
            const msg = context.chat[i];
            if (!msg.is_user && !msg.is_system && msg.name) {
                return msg.name;
            }
        }
    }
    
    return `char_${context.characterId}`;
}

/**
 * [FIX-WINGNAME] Normalizza il nome personaggio in una chiave wing CANONICA.
 * Va usata in OGNI percorso (status/ingest/wipe/search/auto-scan/grafo) e in
 * ENTRAMBE le modalità di isolamento, così che varianti come "Character Name", "Character-Name"
 * e "Character_Name" collassino sempre sulla STESSA wing → memoria a tenuta stagna per
 * ciascun personaggio. Prima la modalità 'character' usava il nome GREZZO (con
 * spazi) mentre 'chat' lo sanitizzava (\s+→_): lo stesso personaggio finiva su
 * wing diverse, quindi wipe e ingest colpivano archivi diversi e comparivano
 * falsi "duplicati" dopo un wipe.
 */
function canonicalCharKey(name) {
    return String(name ?? '').trim().replace(/\s+/g, '_');
}

/**
 * [WING-MODEL] La wing del PERSONAGGIO: sempre la chiave canonica, mai l'id di chat.
 *
 * È l'identità stabile del personaggio, e ci vivono le cose che NON devono sparire
 * quando si apre una chat nuova: il Nucleo Biografico e il legame con i lorebook.
 * Separarla dalla wing episodica è ciò che permette a una chat isolata di partire
 * senza i ricordi delle chat vecchie ma sapendo ancora chi è e com'è fatto il suo
 * mondo, prima l'isolamento si portava via anche quello, e il personaggio nasceva
 * smemorato di sé stesso.
 */
function getCharacterWingId() {
    // [R14] Always sync the module-level cache against the live ST context before use.
    // activeCharacterName can be stale when onCharacterSelected fires but returns early
    // (context not ready yet): in that case all subsequent calls return the previous
    // character's wing, silently routing lore ingestion and RAG queries to the wrong
    // character. getActiveCharacterName() is the authoritative source.
    const liveChar = getActiveCharacterName();
    if (liveChar) activeCharacterName = liveChar;
    if (!activeCharacterName) return null;
    return canonicalCharKey(activeCharacterName) || null;
}

/**
 * [WING-MODEL] La modalità di isolamento DI QUESTO personaggio.
 *
 * Prima era un interruttore unico per tutti: cambiarlo per il personaggio con cui
 * si voleva una chat a tenuta stagna lo cambiava anche a tutti gli altri, che da
 * quel momento scrivevano i ricordi su una wing nuova per ogni chat senza che
 * nessuno lo avesse chiesto. La scelta ora sta per personaggio; la vecchia chiave
 * globale resta come default per chi non ha ancora scelto niente, così le
 * impostazioni esistenti non cambiano significato da sole.
 */
function getIsolationMode(charKey) {
    const key = charKey || getCharacterWingId();
    try {
        const mappa = JSON.parse(localStorage.getItem('mempalace_isolation_by_char') || '{}');
        if (key && mappa[key]) return mappa[key];
    } catch (_) { /* mappa illeggibile: si ricade sul default globale */ }
    return localStorage.getItem('mempalace_isolation') || 'character';
}

function setIsolationMode(charKey, mode) {
    if (!charKey) return;
    let mappa = {};
    try { mappa = JSON.parse(localStorage.getItem('mempalace_isolation_by_char') || '{}'); } catch (_) { mappa = {}; }
    mappa[charKey] = mode;
    localStorage.setItem('mempalace_isolation_by_char', JSON.stringify(mappa));
}

/**
 * [WING-MODEL] La wing dei RICORDI EPISODICI: dove finiscono i messaggi di questa
 * conversazione e i fatti che se ne estraggono.
 *
 * In modalità 'character' coincide con la wing del personaggio (tutte le sue chat
 * condividono la memoria); in modalità 'chat' è sigillata sull'id della chat.
 * Il nome storico è rimasto perché lo usano quasi trenta punti del file, e per
 * tutti quelli il significato non è cambiato.
 */
function getWingId() {
    const base = getCharacterWingId();
    if (!base) return null;

    if (getIsolationMode(base) === 'chat') {
        const context = getContext();
        if (context && context.chatId) {
            return `${base}_chat_${context.chatId}`;
        }
    }
    return base;
}

/**
 * [WING-MODEL] Le wing da cui leggere la LORE.
 *
 * Un lorebook di mondo è uno solo e sta in una wing sua (`lore:<NomeLibro>`), non
 * ricopiato dentro ogni personaggio che lo usa: prima 7094 frammenti memorizzati
 * erano 1377 testi unici, e soprattutto la wing di un personaggio conteneva le
 * schede di TUTTI gli altri personaggi del suo mondo, che il RAG pescava, a
 * ragione, facendo sembrare che la memoria colasse da un personaggio all'altro.
 *
 * La wing del personaggio resta nell'elenco per la lore che gli appartiene davvero
 * (la sua scheda) e per gli archivi ingeriti prima di questa separazione.
 */
function getLoreWings() {
    const base = getCharacterWingId();
    if (!base) return [];
    const wings = [base];
    try {
        const registro = JSON.parse(localStorage.getItem('mempalace_lore_books') || '{}');
        for (const libro of (registro[base] || [])) {
            const w = `lore:${libro}`;
            if (!wings.includes(w)) wings.push(w);
        }
    } catch (_) { /* registro illeggibile: si legge solo la wing del personaggio */ }
    return wings;
}

/** I lorebook collegati a un personaggio (registro locale, alimentato dall'ingestione). */
function getLoreBooks(charKey) {
    try {
        const registro = JSON.parse(localStorage.getItem('mempalace_lore_books') || '{}');
        return registro[charKey || getCharacterWingId()] || [];
    } catch (_) { return []; }
}

/**
 * [WING-MODEL] Importa una volta sola il registro personaggio→libri prodotto dalla
 * migrazione della lore.
 *
 * La migrazione lato server sa quale personaggio aveva ingerito quale libro, ma il
 * registro vive nel browser: senza questo passaggio i personaggi resterebbero
 * scollegati da una lore che nell'archivio c'è ancora, e Phase A tornerebbe a mani
 * vuote su tutto il mondo. Si fonde con le scelte già presenti invece di
 * sovrascriverle, e si segna come fatto per non ripetersi a ogni avvio.
 */
async function importaRegistroLore() {
    if (localStorage.getItem('mempalace_lore_map_imported') === 'true') return;
    try {
        const risposta = await fetch('/scripts/extensions/MemPlace/lore_map.json', { cache: 'no-store' });
        if (!risposta.ok) return; // nessuna migrazione eseguita: non è un errore
        const mappa = await risposta.json();
        let registro = {};
        try { registro = JSON.parse(localStorage.getItem('mempalace_lore_books') || '{}'); } catch (_) { registro = {}; }
        let collegamenti = 0;
        for (const [personaggio, libri] of Object.entries(mappa)) {
            const elenco = registro[personaggio] || [];
            for (const libro of libri) {
                if (!elenco.includes(libro)) { elenco.push(libro); collegamenti++; }
            }
            registro[personaggio] = elenco;
        }
        localStorage.setItem('mempalace_lore_books', JSON.stringify(registro));
        localStorage.setItem('mempalace_lore_map_imported', 'true');
        console.log(`[MemPalace] Registro lore importato: ${Object.keys(mappa).length} personaggi, ${collegamenti} collegamenti.`);
    } catch (e) {
        // Un import fallito non deve impedire l'avvio: si riprova al giro dopo,
        // visto che il segnaposto "fatto" si scrive solo in caso di successo.
        console.warn('[MemPalace] Import registro lore non riuscito:', e);
    }
}

function addLoreBook(charKey, bookName) {
    if (!charKey || !bookName) return;
    let registro = {};
    try { registro = JSON.parse(localStorage.getItem('mempalace_lore_books') || '{}'); } catch (_) { registro = {}; }
    const elenco = registro[charKey] || [];
    if (!elenco.includes(bookName)) elenco.push(bookName);
    registro[charKey] = elenco;
    localStorage.setItem('mempalace_lore_books', JSON.stringify(registro));
}

/**
 * Update UI connection status and stats
 */
function updateUIStatus(name, status) {
    const avatarImg = $('#mempalace-status-avatar');
    const icon = $('#mempalace-status-icon');
    const text = $('#mempalace-status-text');
    const stats = $('#mempalace-status-stats');
    
    // Stats board
    const statMem = $('#mp-stat-memories');
    const statWeight = $('#mp-stat-weight');
    const statDiary = $('#mp-stat-diary');
    const statKgNodes = $('#mp-stat-kg-nodes');
    const statKgTriples = $('#mp-stat-kg-triples');

    if (!icon.length) return; // UI non ancora montata

    // Update Avatar (Safe Loading)
    try {
        const context = getContext();
        if (name && context && context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
            const char = context.characters[context.characterId];
            if (char.avatar && typeof context.getThumbnailUrl === 'function') {
                const thumbUrl = context.getThumbnailUrl('avatar', char.avatar);
                avatarImg.attr('src', thumbUrl).css('border-color', 'rgba(255,255,255,0.2)').show();
            } else {
                avatarImg.hide();
            }
        } else {
            avatarImg.hide();
        }
    } catch (err) {
        console.warn('[MemPalace] Error updating avatar:', err);
        avatarImg.hide();
    }

    if (!name) {
        icon.removeClass().addClass('fa-solid fa-circle-xmark').css('color', 'gray');
        text.text(t('status_no_char')).css('color', 'gray');
        stats.text(t('status_waiting_stats'));
        
        statMem.text('?').css('color', '#aaa');
        statWeight.text('?').css('color', '#aaa');
        statDiary.text('?').css('color', '#aaa');
        statKgNodes.text('?').css('color', '#aaa');
        statKgTriples.text('?').css('color', '#aaa');
        return;
    }

    if (status) {
        icon.removeClass().addClass('fa-solid fa-circle-check').css('color', '#4ade80');
        text.text(`${t('status_active')} ${name}`).css('color', '#4ade80');
        
        // Estrazione Parametri Backend o Fallback
        let memCount = undefined;
        let weightStr = undefined;
        let diaryCount = undefined;
        
        if (status && typeof status === 'object') {
            if (status.total_drawers !== undefined) memCount = status.total_drawers;
            else if (status.count !== undefined) memCount = status.count;
            else if (status.memories !== undefined) memCount = status.memories;
            else if (status.total !== undefined) memCount = status.total;
            else if (status.length !== undefined) memCount = status.length;
            
            // weight_kb è il dato reale calcolato dal backend (byte reali dei documenti)
            if (status.weight_kb !== undefined) {
                weightStr = parseFloat(status.weight_kb).toFixed(2) + " KB";
            } else if (status.weight) {
                weightStr = status.weight;
            } else if (status.size) {
                weightStr = status.size;
            }
            
            // diary_entries è il conteggio reale restituito dal backend
            if (status.diary_entries !== undefined) {
                diaryCount = status.diary_entries > 0 ? status.diary_entries : '-';
            } else {
                diaryCount = status.diary || '-';
            }
        }

        // Fallback Strict Proxy (se l'API remota non restituisce i parametri JSON)
        if (memCount === undefined) {
            const wingId = getWingId();
            if (window.localWipedWings[wingId]) {
                memCount = 0;
                weightStr = "0.00 KB";
                diaryCount = 0;
            } else {
                let strictSentCount = parseInt(localStorage.getItem('mempalace_synced_mem_' + wingId)) || 0;
                memCount = strictSentCount;
                diaryCount = '-';
            }
        }
        
        // Se anche dopo il fallback non abbiamo il peso, lo calcoliamo dal conteggio
        if (weightStr === undefined && memCount !== undefined) {
            weightStr = ((memCount * 250) / 1024).toFixed(2) + " KB";
        }
        
        if (memCount !== undefined) {
            // "19 + 516 lore" invece di un 19 nudo: il primo numero sono i ricordi
            // vissuti in chat, il secondo la lore dei mondi che il personaggio
            // consulta e che ora sta in wing condivise. Mostrare solo il primo farebbe
            // sembrare svanita una memoria che è tutta ancora lì.
            const lore = status.lore_drawers || 0;
            statMem.text(lore > 0 ? `${memCount} + ${lore} lore` : String(memCount)).css('color', '#4ade80');
            statMem.attr('title', lore > 0
                ? `${memCount} ricordi di chat · ${lore} frammenti di lore da ${status.lore_books} lorebook condivisi`
                : `${memCount} ricordi di chat`);
            stats.text(t('status_db_ok'));
        } else {
            statMem.text('?').css('color', 'yellow');
            stats.text(`${t('status_active')} ${name}`);
        }
        
        if (weightStr !== undefined) {
            statWeight.text(weightStr).css('color', '#4ade80');
        } else {
            statWeight.text('?').css('color', 'yellow');
        }
        
        if (diaryCount !== undefined && diaryCount !== null) {
            statDiary.text(diaryCount).css('color', diaryCount === '-' ? '#aaa' : '#4ade80');
        } else {
            statDiary.text('-').css('color', '#aaa');
        }

        // KG Stats
        if (status && status.kg_entities !== undefined) {
            statKgNodes.text(status.kg_entities).css('color', '#4ade80');
        } else {
            statKgNodes.text('?').css('color', 'yellow');
        }

        if (status && status.kg_facts !== undefined) {
            statKgTriples.text(status.kg_facts).css('color', '#4ade80');
        } else {
            statKgTriples.text('?').css('color', 'yellow');
        }

        // AAAK Compression stats (opzionale: mostrato solo se il backend lo restituisce)
        const aaakWrap = $('#mp-stat-aaak-wrap');
        const aaakStat = $('#mp-stat-aaak');
        if (status && (status.aaak_ratio !== undefined || status.aaak_compression !== undefined || status.aaak_tokens_saved !== undefined)) {
            let aaakLabel = 'n/d';
            if (status.aaak_ratio !== undefined) {
                aaakLabel = t('aaak_saved_pct', { pct: (status.aaak_ratio * 100).toFixed(0) });
            } else if (status.aaak_compression !== undefined) {
                aaakLabel = status.aaak_compression;
            } else if (status.aaak_tokens_original !== undefined && status.aaak_tokens_compressed !== undefined) {
                aaakLabel = `${status.aaak_tokens_original} → ${status.aaak_tokens_compressed} tok`;
            } else if (status.aaak_tokens_saved !== undefined) {
                aaakLabel = `−${status.aaak_tokens_saved} tok`;
            }
            aaakStat.text(aaakLabel);
            aaakWrap.show();
        } else {
            aaakWrap.hide();
        }

        // RAG Hit Rate (contatore in-session, si azzera al reload)
        const ragTotal = _ragHitCount + _ragMissCount;
        const ragHitEl = $('#mp-stat-rag-hit');
        if (ragHitEl.length && ragTotal > 0) {
            const pct = Math.round(_ragHitCount / ragTotal * 100);
            ragHitEl.text(`${pct}% (${_ragHitCount}/${ragTotal})`).css('color', pct >= 60 ? '#4ade80' : pct >= 30 ? 'yellow' : '#ff6b6b');
            ragHitEl.closest('[id$="-rag-hit-wrap"]').show();
        } else if (ragHitEl.length) {
            ragHitEl.text('n/d').css('color', '#aaa');
        }

    } else {
        icon.removeClass().addClass('fa-solid fa-circle-xmark').css('color', '#ff6b6b');
        text.text(`${t('status_offline')} ${name}`).css('color', '#ff6b6b');
        stats.text(t('status_endpoint_error'));
        
        statMem.text('Offline').css('color', '#ff6b6b');
        statWeight.text('Offline').css('color', '#ff6b6b');
        statDiary.text('Offline').css('color', '#ff6b6b');
        statKgNodes.text('Offline').css('color', '#ff6b6b');
        statKgTriples.text('Offline').css('color', '#ff6b6b');
    }
}

/**
 * Refresh status stats in the UI panel (module-scope so performDeepKnowledgeScan can call it)
 */
async function refreshMemPalaceStats() {
    const baseName = activeCharacterName || getActiveCharacterName();
    if (!baseName) return;
    const wingId = getWingId();
    if (!wingId) return;

    const refreshBtn = $('#mempalace-refresh-stats');
    if (refreshBtn.length) {
        refreshBtn.addClass('fa-spin').css('color', '#4ade80');
    }

    const status = await callMemPalace('mempalace_status', { wing: wingId });

    // [WING-MODEL] La lore non abita più dentro il personaggio, quindi il suo
    // conteggio non arriva più da questa chiamata. Senza sommarla, il pannello
    // annuncerebbe un crollo dei ricordi il giorno della migrazione, un personaggio da 85
    // a 19, mentre in archivio non si è perso niente: sono gli stessi frammenti,
    // in una wing condivisa invece che in sei copie. Le due voci restano distinte
    // perché sono due cose diverse: cosa il personaggio ha VISSUTO e cosa SA.
    const libri = getLoreBooks(getCharacterWingId());
    if (status && libri.length > 0) {
        const conteggi = await Promise.all(
            libri.map(b => callMemPalace('mempalace_status', { wing: `lore:${b}` }).catch(() => null))
        );
        status.lore_drawers = conteggi.reduce((n, s) => n + ((s && s.total_drawers) || 0), 0);
        status.lore_books = libri.length;
    }
    updateUIStatus(baseName, status);

    if (refreshBtn.length) {
        setTimeout(() => {
            refreshBtn.removeClass('fa-spin').css('color', '#aaa');
        }, 500);
    }
}

/**
 * Handle Diary Injection
 */
async function updateDiaryContext(wingName) {
    const diaryData = await callMemPalace('mempalace_diary_read', { agent_name: wingName });
    if (diaryData && (diaryData.content || (diaryData.entries && diaryData.entries.length > 0))) {
        const entryList = diaryData.entries || [];
        // [R6] Guard: alcune entry possono avere content null/undefined (storage corrotto o migrazione).
        // Senza questo filtro, e.content.trim() lanciava TypeError e interrompeva l'intera diary injection.
        const uniqueEntries = [...new Set(entryList.map(e => (e.content ?? '').trim()).filter(s => s.length > 0))];
        let text = uniqueEntries.join('\n');

        // --- PROTEZIONE CONTEXT (Anti-Book Overflow) ---
        const MAX_CHARS = 4000;
        if (text.length > MAX_CHARS) {
            console.warn(`[MemPalace] Memory Nucleus too large (${text.length} char). Truncating to ${MAX_CHARS}...`);
            // Il troncamento si segnala all'utente col toast qui sotto, non al
            // modello: una riga di avviso tecnica dentro il prompt è solo un altro
            // pezzo di impaginazione da imitare.
            text = text.substring(0, MAX_CHARS);
            toastr.warning('Memory Nucleus too large! Truncated for safety.', 'MemPalace Alert', { timeOut: 10000 });
        }

        // [FORMA-PROMPT] L'intestazione era `[Character Permanent Memory - Lore &
        // Biography]`: un'etichetta fra parentesi quadre, messa in cima al testo che
        // descrive il personaggio, dentro il prompt. È esattamente lo schema che il
        // modello ha ricominciato a produrre da solo aprendo le risposte con
        // `[Nome Personaggio]`. Un modello piccolo non distingue fra un'etichetta
        // che struttura il prompt e una che deve scrivere: impara la forma e la
        // ripete. Qui la stessa informazione è data in prosa, senza schema da copiare.
        const diaryStr = `What follows is what you know about yourself and your world. It is your own memory, not a document.\n\n${text}`;
        // [LLAMACPP] Il filtro tiene il Nucleo fuori dai prompt di estrazione.
        setExtensionPrompt('MemPalace Diary', diaryStr, extension_prompt_types.IN_PROMPT,
            extension_prompt_roles.SYSTEM, false, extension_prompt_roles.SYSTEM, _fuoriDallEstrazione);
        console.log(`[MemPalace] Memory Nucleus injected for ${wingName}`);
    } else {
        setExtensionPrompt('MemPalace Diary', '', extension_prompt_types.IN_PROMPT, extension_prompt_roles.SYSTEM);
    }
}

/**
 * Hook: On Character Selected
 */
async function onCharacterSelected() {
    const name = getActiveCharacterName();
    if (!name) return;

    // [R1] Generation guard: se arriva una seconda chiamata mentre questa è sospesa
    // sull'await, la chiamata più vecchia si autocancella al risveglio.
    const myGen = ++_charSelectedGen;

    activeCharacterName = name;
    // Invalida cache AAAK: un nuovo personaggio può avere un dialect diverso
    _aaakDialectCache = null;
    _aaakDialectWingId = null;

    // [R10] Clear diary synchronously before any await: prevents stale diary from previous
    // character persisting into the new one when the backend call returns null (offline / error).
    setExtensionPrompt('MemPalace Diary', '', extension_prompt_types.IN_PROMPT, extension_prompt_roles.SYSTEM);

    // [FIX-RAG-LEAK] Il blocco RAG del personaggio PRECEDENTE va tolto qui, subito.
    //
    // `setExtensionPrompt('MemPalace RAG', …)` resta registrato in SillyTavern finché
    // qualcuno non lo riscrive, e l'unico posto che lo riscriveva era l'interceptor,
    // che però ha tre uscite anticipate (nessun personaggio attivo, chat vuota, query
    // troppo corta). Bastava passare da un personaggio a una chat nuova di un altro
    // perché la prima generazione ricevesse in prompto i ricordi di quello di prima, e
    // il pannello "Ultima Iniezione RAG" li mostrasse come se fossero suoi. Il diario
    // aveva già questa pulizia (R10); il RAG no.
    setExtensionPrompt('MemPalace RAG', '', extension_prompt_types.BEFORE_PROMPT, 0);
    window.mempalaceLastFished = null;
    updateRagPreviewPanel(null);

    // [R11] Reset RAG session state on character switch.
    // _loreInjectionHistory carries cooldown timestamps from the previous character's session.
    // If both characters share lore entries (same world/lorebook), those keys would still be
    // within LORE_COOLDOWN_GENS and block ALL lore for the new character → only 1 echo fragment
    // survives. Clearing these maps and resetting the gen counter gives the new character a
    // clean slate so retrieval works correctly from the first generation.
    _fragmentSessionMemory.clear();
    _loreInjectionHistory.clear();
    _interceptorGenCount = 0;
    _loreSoftAllowedGen = -1;      // reset soft-lore cooldown su cambio personaggio
    _autoDiaryGensSinceLast = 0;   // reset auto-diary counter su cambio personaggio
    _ragHitCount = 0;              // reset metrica hit rate: mostra dati per-personaggio, non cross-sessione
    _ragMissCount = 0;

    // [WING-MODEL] Il menù a tendina deve mostrare la scelta DI QUESTO personaggio.
    // Ora che la modalità è per personaggio, un menù che resta su quello di prima non
    // è solo cosmetico: dice il falso su dove stanno finendo i ricordi.
    const isoSelect = $('#mempalace-isolation-mode');
    if (isoSelect.length) isoSelect.val(getIsolationMode(canonicalCharKey(name)));

    const wingId = getWingId();
    console.log(`[MemPalace] Character selected: ${activeCharacterName} (Wing: ${wingId} | lore: ${getLoreWings().join(', ')})`);

    // Check status
    const status = await callMemPalace('mempalace_status', { wing: wingId });
    if (_charSelectedGen !== myGen) return; // [R1] personaggio cambiato durante l'await → annulla

    updateUIStatus(activeCharacterName, status);

    if (status) {
        // Read diary and inject
        await updateDiaryContext(getCharacterWingId() || wingId);
        if (_charSelectedGen !== myGen) return; // [R1] seconda guard dopo il diary await
    }

    // Perform passive auto-scan if setup checkbox requires it
    // [FIX-AUTOSCAN-GEN] passa myGen così la sync si cancella se il personaggio cambia durante i batch
    if (typeof window.mempalace_auto_scan === 'function') {
        window.mempalace_auto_scan(wingId, myGen);
    }

    // [LORE PRONTA] Quello che e' gia' distillato arriva al personaggio in pochi
    // secondi; quello che manca si legge in sottofondo, a piccole dosi. Il primo
    // turno non aspetta niente.
    // [SCHEDA] Prima di tutto: chi e' il personaggio. Costa una scrittura sola e solo
    // quando la scheda e' cambiata davvero.
    await ingeriScheda(getCharacterWingId() || wingId);

    preparaLore(getCharacterWingId() || wingId, myGen);

    // [DIAGNOSI] Una prova del modello per sessione, il cui esito finisce in archivio.
    //
    // Il motivo e' pratico: quando l'estrazione non parte, il perche' si vede solo
    // nella console del browser, e chiedere ogni volta di copiarla e' scomodo e
    // lento. Scrivendo l'esito in una wing di servizio, chi guarda l'archivio (io da
    // riga di comando, o l'utente dal pannello) lo trova senza dover fare niente.
    // Non tocca nessun personaggio e non contiene testo di gioco.
    provaModelloUnaVolta();

    // Ripristina i badge RAG sulla chat appena caricata
    setTimeout(() => {
        // [R1] Ricontrolla la generazione dentro il setTimeout: potrebbe essere scattato
        // dopo un altro cambio personaggio avvenuto nei 500 ms di attesa.
        if (_charSelectedGen !== myGen) return;
        const context = getContext();
        if (context && context.chat) {
            context.chat.forEach((msg, idx) => {
                if (msg.extra && msg.extra.mempalace_rag) {
                    injectBadgeIntoMessage(idx, msg.extra.mempalace_rag);
                }
            });
        }
    }, 500);
}

/**
 * Utility: Parses raw RAG text into structured synaptic fragments.
 * Detects tags like (Soul-Echo), (Common-Vibe), (Forbidden-Void) and extracts image URLs.
 */
function parseSynapticFragments(text) {
    if (!text) return [];
    
    // Split by the ellipsis used in generation construction or the tags themselves
    // [B10] Filter out the RAG header segment (starts with "---"): it is the rag_header +
    // rag_instruction preamble that precedes the first tag, not an actual memory fragment.
    const segments = text.split(/\s\.\.\.\s|\s?\[(Soul-Echo|Common-Vibe|Forbidden-Void)\]\s?/g)
        .filter(s => s && s.trim() && !s.trim().startsWith('---'));
    
    const fragments = [];
    let currentType = 'common'; 
    let currentTag = 'Common-Vibe';

    // segments can be [Type, Content, Type, Content...] because of the capture group in split
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i].trim();
        
        if (seg === 'Soul-Echo') {
            currentType = 'soul';
            currentTag = '[Soul-Echo]';
            continue;
        } else if (seg === 'Common-Vibe') {
            currentType = 'common';
            currentTag = '[Common-Vibe]';
            continue;
        } else if (seg === 'Forbidden-Void') {
            currentType = 'void';
            currentTag = '[Forbidden-Void]';
            continue;
        }

        // It's content
        // Extract images
        const imgRegex = /<img\s[^>]*src=['"]([^'"]+)['"][^>]*>|!\[[^\]]*\]\(([^)]+)\)/gi;
        let match;
        const images = [];
        let cleanContent = seg;
        
        while ((match = imgRegex.exec(seg)) !== null) {
            images.push(match[1] || match[2]);
        }
        
        // Remove image tags and strip leading/trailing punctuation artifacts
        cleanContent = seg.replace(imgRegex, '')
                          .replace(/^[:\-\s]+/, '')
                          // [C1] strip trailing "\n-" list artifact: content between two tags includes
                          // the "- " prefix of the next bullet which sticks to the end after split.
                          .replace(/[\n\r]\s*-\s*$/, '')
                          .trim();

        if (cleanContent || images.length > 0) {
            fragments.push({
                type: currentType,
                tag: currentTag,
                content: cleanContent,
                images: images
            });
        }
    }
    
    return fragments;
}

/**
 * Aggiorna il pannello RAG Preview con l'ultimo contesto iniettato
 */
function updateRagPreviewPanel(ragText) {
    const previewText = $('#mempalace-rag-preview-text');
    const previewCount = $('#mempalace-rag-preview-count');
    if (!previewText.length) return;

    if (!ragText) {
        previewText.text(t('rag_preview_waiting')).removeClass('mp-rag-preview-active');
        previewCount.text('');
        return;
    }

    const fragmentCount = (ragText.match(/^- /gm) || []).length;
    const lines = ragText.split('\n').filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, ''));
    const displayText = lines.slice(0, 5).join('\n') + (lines.length > 5 ? '\n…' : '');

    previewText.text(displayText || ragText.substring(0, 200)).addClass('mp-rag-preview-active');
    previewCount.text(fragmentCount > 0 ? t('rag_preview_fragments', { count: fragmentCount }) : '');
}

function injectBadgeIntoMessage(messageId, ragText) {
    const extraButtons = $(`#chat .mes[mesid="${messageId}"] .extraMesButtons`);
    if (extraButtons.length > 0 && extraButtons.find('.mempalace-rag-badge').length === 0) {
        const titleSafe = ragText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        // Conta i frammenti iniettati per mostrarlo nel badge (righe che iniziano con "- ")
        const fragmentCount = (ragText.match(/^- /gm) || []).length;
        const countLabel = fragmentCount > 0 ? ` (${fragmentCount})` : '';

        const badgeHtml = `
            <div class="mes_button mempalace-rag-badge" title="RAG Memory: ${fragmentCount} fragment${fragmentCount !== 1 ? 's' : ''} injected. Click to inspect." data-rag="${titleSafe}" style="cursor: pointer; order: -1; display: flex !important; align-items: center; gap: 6px;">
                <i class="fa-solid fa-brain" style="color: #3296ff; opacity: 0.8;"></i>
                <span class="mempalace-badge-text" style="font-size: 0.85em; opacity: 0.9; line-height: 1;">MemPalace${countLabel}</span>
            </div>`;
        extraButtons.prepend(badgeHtml);
        
        extraButtons.find('.mempalace-rag-badge').first().on('click', function(e) {
            e.stopPropagation();
            const ragData = $(this).attr('data-rag');
            const fragments = parseSynapticFragments(ragData);
            
            if ($('#mempalace-rag-modal').length > 0) $('#mempalace-rag-modal').remove();
            
            let fragmentsHtml = '';
            fragments.forEach(f => {
                const icon = f.type === 'soul' ? 'fa-heart-pulse' : (f.type === 'void' ? 'fa-triangle-exclamation' : 'fa-dna');
                let imgsHtml = '';
                f.images.forEach(img => {
                    // [B11] Use data attribute + delegated handler: avoids onclick template-string XSS
                    // where HTML-escaped ' (&#39;) is decoded by the browser before JS executes.
                    const imgSafe = escHtml(img);
                    imgsHtml += `<img src="${imgSafe}" class="mp-fragment-img mp-img-open" data-open="${imgSafe}" style="cursor:pointer">`;
                });

                fragmentsHtml += `
                <div class="mp-fragment-card ${f.type}">
                    <div class="mp-fragment-tag"><i class="fa-solid ${icon}"></i> ${f.tag}</div>
                    <div class="mp-fragment-content">${escHtml(f.content)}</div>
                    ${imgsHtml}
                </div>`;
            });

            const modalHtml = `
            <div id="mempalace-rag-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:99999; display:flex; justify-content:center; align-items:center; backdrop-filter: blur(4px);">
                <div class="mempalace-glass" style="width: 85%; max-width: 650px; max-height:85%; display:flex; flex-direction:column; border-radius: 16px; overflow: hidden; border: 1px solid rgba(50, 150, 255, 0.2);">
                    <div style="padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center; background: rgba(50, 150, 255, 0.05);">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <i class="fa-solid fa-brain" style="font-size: 1.4em; color:#3296ff; filter: drop-shadow(0 0 5px rgba(50, 150, 255, 0.5));"></i>
                            <h3 style="margin:0; color:#fff; letter-spacing: 1px; font-weight: 300;">SYNAPTIC RESONANCE</h3>
                        </div>
                        <i class="fa-solid fa-xmark mempalace-modal-close" style="cursor:pointer; font-size:1.4em; color:#aaa; transition: 0.2s;"></i>
                    </div>
                    <div style="padding: 20px; overflow-y:auto; flex: 1; scrollbar-width: thin; scrollbar-color: #3296ff transparent;">
                        ${fragmentsHtml || '<div style="text-align:center; padding: 40px; color:#666;">No resonance fragments detected.</div>'}
                    </div>
                    <div style="padding: 15px; border-top: 1px solid rgba(255,255,255,0.05); text-align:right; background: rgba(0,0,0,0.2);">
                        <button class="mempalace-modal-close" style="background: rgba(50, 150, 255, 0.1); color:#3296ff; border: 1px solid #3296ff; padding:8px 25px; border-radius:8px; font-weight:bold; cursor:pointer; transition: 0.2s;">CLOSE</button>
                    </div>
                </div>
            </div>`;
            $('body').append(modalHtml);

            $('#mempalace-rag-modal').on('click', '.mp-img-open', function() {
                const url = $(this).attr('data-open');
                if (url) window.open(url, '_blank');
            });

            const $ragModal = $('#mempalace-rag-modal');
            $ragModal.find('.mempalace-modal-close').on('click', () => {
                $ragModal.fadeOut(200, function() { $(this).remove(); });
            });

            $ragModal.find('.mempalace-modal-close').on('mouseenter', function() { $(this).css('color', '#fff'); });
            $ragModal.find('.mempalace-modal-close').on('mouseleave', function() { $(this).css('color', '#aaa'); });
        });
    }
}

const _MP_INFO_KEYS = ['conn', 'iso', 'lore', 'aaak'];
function showMemPalaceInfo(infoKey) {
    if (!_MP_INFO_KEYS.includes(infoKey)) return;
    const title = t(`info_${infoKey}_title`);
    const body = t(`info_${infoKey}_body`);

    if ($('#mempalace-info-modal').length > 0) $('#mempalace-info-modal').remove();

    const modalHtml = `
    <div id="mempalace-info-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:999999; display:flex; justify-content:center; align-items:center; backdrop-filter: blur(8px);">
        <div class="mempalace-glass" style="width: 90%; max-width: 500px; border-radius: 20px; overflow: hidden; border: 1px solid rgba(50, 150, 255, 0.3); box-shadow: 0 0 40px rgba(0,0,0,0.5);">
            <div style="padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center; background: rgba(50, 150, 255, 0.1);">
                <div style="display:flex; align-items:center; gap:12px;">
                    <i class="fa-solid fa-circle-info" style="font-size: 1.2em; color:var(--mp-common);"></i>
                    <h3 style="margin:0; color:#fff; letter-spacing: 1px; font-weight: 300; font-size: 1.1em;">${title}</h3>
                </div>
                <i class="fa-solid fa-xmark mp-info-close" style="cursor:pointer; font-size:1.2em; color:#aaa; transition: 0.2s;"></i>
            </div>
            <div style="padding: 25px; color: #eee; line-height: 1.6; font-size: 0.95em;">
                ${body}
            </div>
            <div style="padding: 15px; border-top: 1px solid rgba(255,255,255,0.05); text-align:right; background: rgba(0,0,0,0.2);">
                <button class="mp-info-close mp-btn-primary" style="padding:6px 20px; font-size: 0.9em;">OK</button>
            </div>
        </div>
    </div>`;

    $('body').append(modalHtml);
    
    $('.mp-info-close').on('click', () => {
        $('#mempalace-info-modal').fadeOut(200, function() { $(this).remove(); });
    });
}

/**
 * Hook: On Message Sent (User -> Character)
 */
async function onMessageSent(messageId) {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const lastMessage = context.chat[context.chat.length - 1];
    if (lastMessage.is_system) return;
    
    const wingId = getWingId();
    if (!wingId) return;
    
    // Save to room_history
    await scriviRicordo({ wing: wingId, room: "user", content: lastMessage.mes });

    // Auto-scan for facts if enabled
    if (localStorage.getItem('mempalace_autoscan') === 'true') {
        callMemPalace('mempalace_extract_facts', { 
            text: lastMessage.mes, 
            character: wingId, 
            save: true 
        }).catch(e => console.error("[MemPalace] Auto-scan error (User):", e));
    }
    // La ricerca RAG non viene più fatta qui in modo asincrono per evitare 'race conditions' (ovvero che ST 
    // compili il prompt per il modello PRIMA che la ricerca asincrona sia finita).
    // È stata spostata nel 'generate_interceptor' ufficiale.
}

/**
 * Tronca il testo a maxChars caratteri preferendo il confine di frase più vicino.
 * Se non trova un punto abbastanza vicino alla fine, taglia netto con "…".
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncateAtSentence(text, maxChars) {
    if (!text || text.length <= maxChars) return text;
    const sub = text.substring(0, maxChars);
    // Cerca l'ultimo punto/esclamativo/interrogativo seguiti da spazio o fine stringa
    const lastStop = Math.max(
        sub.lastIndexOf('. '),
        sub.lastIndexOf('! '),
        sub.lastIndexOf('? '),
        sub.lastIndexOf('.\n'),
        sub.lastIndexOf('!\n'),
        sub.lastIndexOf('?\n')
    );
    // Usa il confine di frase solo se è nella seconda metà del testo (evita troncature troppo aggressive)
    if (lastStop > maxChars * 0.55) {
        return sub.substring(0, lastStop + 1).trimEnd() + '…';
    }
    return sub.trimEnd() + '…';
}

/**
 * Hook Bloccante: Intercetta l'inizio della generazione testo dell'LLM (dichiarato in manifest.json)
 * Questo Hook mette in pausa ST finché la ricerca MemPalace non è terminata,
 * garantendo che l'esito venga sempre iniettato in-prompt!
 */
// ── VERSION TAG per cache-busting (cambia questo se vuoi verificare che il nuovo codice è caricato) ──
const _MP_VERSION = 'v5.9-gpu-a-riposo';  // una sola costante di versione: prima l'header API diceva v3.7 e la UI v3.10
window['mempalace_generate_interceptor'] = async function(chat, contextSize, abort, type) {
    if (type === 'quiet') return;

    // PRIMA ESECUZIONE: mostra toast versione per confermare che il codice aggiornato è caricato
    if (!window._mpVersionShown) {
        window._mpVersionShown = true;
        toastr.info(`MemPalace ${_MP_VERSION} loaded`, 'MemPalace', { timeOut: 3000 });
        console.log(`[MemPalace ${_MP_VERSION}] Code loaded OK`);
    }

    window.mempalaceLastFished = null;
    // Una generazione è partita: l'estrazione continua deve stare ferma, se no
    // contende lo stesso modello e rallenta proprio il turno dell'utente.
    _generazioneInCorso = true;
    if (_timerEstrazione) { clearTimeout(_timerEstrazione); _timerEstrazione = null; }
    // Rete di sicurezza: se la generazione viene annullata e nessun evento di fine
    // arriva, questo flag resterebbe alzato per sempre e l'estrazione continua non
    // ripartirebbe mai piu'. Un timer lo libera comunque.
    if (_sbloccoGenerazione) clearTimeout(_sbloccoGenerazione);
    _sbloccoGenerazione = setTimeout(() => { _generazioneInCorso = false; }, 180000);
    // [R14] getWingId() now self-heals stale activeCharacterName from live context
    // no separate recovery block needed. The null check below handles the true "no char" case.
    let wingId = getWingId();

    // [FIX-RAG-LEAK] Uscire senza pulire lasciava iniettato il blocco del turno prima.
    //
    // Le tre uscite qui sotto sono i casi in cui non c'è niente da pescare, e finora
    // tornavano indietro in silenzio: SillyTavern però tiene registrato l'ultimo
    // `setExtensionPrompt('MemPalace RAG', …)`, quindi "niente da pescare" non voleva
    // dire "nessun ricordo nel prompt", voleva dire "i ricordi dell'ultima pesca
    // utile", anche quando erano di un altro personaggio. Ora ogni uscita azzera.
    const _mpNienteRag = (motivo) => {
        setExtensionPrompt('MemPalace RAG', '', extension_prompt_types.BEFORE_PROMPT, 0);
        window.mempalaceLastFished = null;
        updateRagPreviewPanel(null);
        if (motivo) console.log(`[MemPalace] Interceptor: RAG azzerato (${motivo}).`);
    };

    if (!wingId) {
        console.warn(`[MemPalace] Interceptor: no active character, RAG skipped.`);
        _mpNienteRag('nessun personaggio attivo');
        return;
    }
    console.log(`[MemPalace] Interceptor: wing="${wingId}" | char="${activeCharacterName}"`);

    // 1. ESTRAZIONE CONTESTO E QUERY EXPANSION
    const validChat = chat.filter(m => !m.is_system && m.mes);
    if (validChat.length === 0) { _mpNienteRag('chat vuota'); return; }

    const lastUserMsg = validChat.slice().reverse().find(m => m.is_user);
    const lastCharMsg = validChat.slice().reverse().find(m => !m.is_user);
    const recentHistory = validChat.slice(-5).map(m => m.mes).join('\n');

    const queryBase = lastUserMsg ? lastUserMsg.mes : "";
    const queryContext = lastCharMsg ? lastCharMsg.mes : "";
    const finalQuery = `${queryBase} ${queryContext}`.trim();

    if (finalQuery.length < 2) { _mpNienteRag('query troppo corta'); return; }

    // Base per limiti adattativi (usato dall'Intent Router sotto)
    const qLen = queryBase.length;
    // Amplificazione Phase C via bitstring SQ: stati caotici (111xxx) indicano alta entropia narrativa
    // → il personaggio è in uno stato emotivo instabile → più echi personali nel prompt.
    let dynEchoLim = qLen > 150 ? 2 : 1;
    try {
        const _sqStates = window.__sillybridge?.quantumStates || window.characterQuantumStates || {};
        // [FIX-BRIDGE-MATCH] La ricerca era `k.includes(activeCharacterName)`, cioè per
        // sottostringa sulla chiave: un personaggio di nome "Eva" agganciava lo stato
        // quantistico di "Eva_Neri" e leggeva l'umore di qualcun altro. Le chiavi di SQ
        // sono il nome canonico (spazi→underscore), quindi il confronto giusto è secco:
        // prima sul campo `name` grezzo, poi sulla chiave canonica.
        const _sqKeyAtteso = canonicalCharKey(activeCharacterName);
        const _sqCharId = Object.keys(_sqStates).find(k =>
            _sqStates[k]?.name === activeCharacterName || k === _sqKeyAtteso
        );
        if (_sqCharId) {
            const _sqBits = _sqStates[_sqCharId]?.last_collapse || '000000';
            const _sqChaos = (_sqBits.startsWith('111') || _sqBits.startsWith('110'));
            if (_sqChaos) dynEchoLim = Math.min(dynEchoLim + 1, 3);
        }
    } catch (_) { /* SQ non disponibile: dynEchoLim resta al valore base */ }

    // [C10] extractEntities, extractRoomHint moved to module level, no local redefinition needed.
    // Entità contestuali presenti nell'ultimo messaggio (esclude il protagonista già coperto)
    // [H1] Salviamo il raw PRIMA del filter per isPureChat: un messaggio come "Character Name, stai bene?"
    // ha rawQueryEntities=['Character Name'] ma contextEntities=[] dopo il filter → senza questo fix
    // isPureChat=true e il personaggio risponde alla domanda su sé stesso con zero RAG.
    const _rawQueryEntities = extractEntities(queryBase);
    const contextEntities = _rawQueryEntities.filter(e => e !== activeCharacterName);
    // Phase D multi-entità: protagonista + entità menzionate (max 3 query KG in parallelo)
    const kgEntities = [activeCharacterName, ...contextEntities].filter(Boolean).slice(0, 3);
    // Room hint per Phase B (passato come parametro opzionale)
    const roomHint = extractRoomHint(queryBase) || extractRoomHint(queryContext);

    // ── NUCLEO SEMANTICO ─────────────────────────────────────────────────────────
    // [C10] IT_NOISE, EN_NOISE, buildSemanticCore moved to module level, no local redefinition.
    const semanticCore = buildSemanticCore(queryBase, contextEntities);

    // ── NARRATIVE WINDOW QUERY ───────────────────────────────────────────────────
    // Costruisce una query dai ULTIMI 4 messaggi (sia utente che personaggio) per
    // catturare l'ARCO NARRATIVO CORRENTE invece del singolo ultimo messaggio.
    // Esempio: se negli ultimi 4 turni si è parlato di pizza / Piero / cena romantica,
    // la narrative query = "pizza Piero cena romantica", Phase B troverà ricordi
    // correlati a TUTTO l'arco, non solo all'ultima battuta.
    const narrativeWindowMsgs = validChat.slice(-4);
    const narrativeWindowText = narrativeWindowMsgs
        .map(m => m.mes.substring(0, 180))
        .join(' ');
    const narrativeQuery = buildSemanticCore(narrativeWindowText, contextEntities);

    // ── INTENT ROUTER ────────────────────────────────────────────────────────────
    // Classifica l'intenzione dell'utente per attivare solo le fasi necessarie.
    // Obiettivo: "pescare a risparmio", non sparare tutto ogni volta.
    const lower = queryBase.toLowerCase();
    const intent = {
        // Lore: domande su come funziona qualcosa, sul mondo, su entità specifiche
        needsLore: contextEntities.length > 0 ||
            /\b(cos[aè]|come|perché|spieg|chi è|storia|cos'è|tell me|what is|how|why|explain|lore|world|funziona|significa)\b/.test(lower),
        // Echo personale: memorie soggettive, emozioni, ricordi diretti
        needsEcho: /\b(ricord|sento|provo|emozione|paura|amore|manc|penso|sembra|feel|remember|miss|love|afraid|think|seems|nostalg)\b/.test(lower),
        // Plot/eventi: cose accadute, luoghi visitati, eventi narrativi.
        // roomHint viene usato per Phase B room_hint param ma NON come trigger di needsPlot
        // altrimenti l'intro del personaggio ("a Bar where you can rest") lo forza sempre a true.
        needsPlot: contextEntities.length > 0 ||
            /\b(andiamo|siamo stati|ieri|prima|quando|accad|succ|visit|event|happen|went|been|was there)\b/.test(lower),
        // Pura conversazione breve senza entità nel MESSAGGIO UTENTE → non serve lore enciclopedica.
        // [H1] Fix: usa _rawQueryEntities (prima del filter activeCharacterName).
        // "Character Name, stai bene?" → rawEntities=['Character Name'] → NON è pure chat → RAG si attiva.
        // Solo messaggi senza NESSUNA entità (nemmeno il nome del personaggio) sono isPureChat.
        // NOTA: roomHint continua ad essere escluso (l'intro del personaggio contiene location
        // che NON devono invalidare isPureChat, fix critico v2.4).
        isPureChat: queryBase.length < 60 && _rawQueryEntities.length === 0
    };

    // Limiti adattativi per fase, se l'intent non richiede una fase, limit=0 → skip call API
    const activeLoreLim  = (!intent.isPureChat && intent.needsLore)
        ? (qLen > 150 ? 3 : qLen > 60 ? 2 : 1)
        : 0;
    // isPureChat → SKIP Phase B/C (limit=0): chat breve senza entità/room hint → nessuna memoria narrativa
    // necessaria. Il lorebook è semanticamente troppo dominante rispetto a memorie episodiche sparse
    // in una chat nuova → Phase B/C ritornerebbero lore anche con skipLoreRoom attivo.
    // Phase D (KG) continua a girare per i fatti base del personaggio.
    const activeEchoLim  = intent.isPureChat ? 0 : ((intent.needsEcho || intent.needsPlot) ? dynEchoLim : 1);
    const activePlotLim  = intent.isPureChat ? 0 : (intent.needsPlot ? 3 : 2);
    // Phase E (neighbors) solo se stiamo parlando di entità/persone
    const needsNeighbors = activeCharacterName && (contextEntities.length > 0 || intent.needsLore);

    console.log(`[MemPalace] Intent-Router | core="${semanticCore.substring(0, 30)}" arc="${narrativeQuery.substring(0, 30)}" | lore=${activeLoreLim} echo=${activeEchoLim} plot=${activePlotLim} nbr=${needsNeighbors} | ent=[${kgEntities.join(',')}] ctx=[${contextEntities.join(',')}] room=${roomHint || '-'} pureChat=${intent.isPureChat}`);

    $('#mempalace-rag-preview').addClass('mp-interceptor-active');
    try {
        // ── RETRIEVAL PARALLELO (solo fasi attive per questo intent) ──────────────
        // Phase B usa la narrativeQuery (arco degli ultimi 4 msg) → cattura il momentum narrativo.
        // Phase A usa il semanticCore (entità/concetti precisi) → lore mirato.
        // Phase C usa queryBase (ultimo messaggio puro) → risonanza personale immediata.
        // [WING-MODEL] Da dove pesca ciascuna fase:
        //   Phase A (lore)          → le wing di lore del personaggio (mondo condiviso + sua scheda)
        //   Phase B/C (episodiche)  → SOLO la wing episodica, con room "lore" esclusa
        //   Phase D/E (grafo)       → la wing episodica, che è anche il closet dei fatti
        const loreWings = getLoreWings();
        // [APERTURE] Le fasi episodiche saltano la lore E le aperture di chat: la lore
        // e' enciclopedia, l'apertura e' la scenografia di una singola partita, e in
        // modalita' Condivisa pescarla vorrebbe dire riportare in scena l'inizio di
        // un'altra storia dello stesso personaggio.
        const phaseBParams = { wing: wingId, query: narrativeQuery, limit: activePlotLim, room_exclude: STANZE_NON_EPISODICHE };
        if (roomHint) phaseBParams.room_hint = roomHint;

        const [lorePulse, plotPulse, echoPulse, neighborsPulse, ...kgPulseArr] = await Promise.all([
            // FASE A: Lore, query sul nucleo semantico (non sul messaggio grezzo); SKIP se chat pura
            activeLoreLim > 0
                ? callMemPalace('mempalace_search', { wings: loreWings, room: "lore", query: semanticCore, limit: activeLoreLim }).catch(e => { console.warn('[MemPalace] Phase A failed:', e); return null; })
                : Promise.resolve(null),
            // FASE B: Plot/Eventi, SKIP se isPureChat
            activePlotLim > 0
                ? callMemPalace('mempalace_search', phaseBParams).catch(e => { console.warn('[MemPalace] Phase B failed:', e); return null; })
                : Promise.resolve(null),
            // FASE C: Echo personale, usa semanticCore (rumore rimosso; fallback a queryBase impossibile per design)
            activeEchoLim > 0
                ? callMemPalace('mempalace_search', { wing: wingId, query: semanticCore, limit: activeEchoLim, room_exclude: STANZE_NON_EPISODICHE }).catch(e => { console.warn('[MemPalace] Phase C failed:', e); return null; })
                : Promise.resolve(null),
            // FASE E: Rete sociale, solo se ci sono entità da esplorare.
            // [FIX-PHASE-E] `wing` non è facoltativo: senza, la traversata gira su un
            // grafo condiviso da tutti i personaggi e riporta i fatti degli altri.
            // L'entità è il nome del personaggio, non la wing: in modalità isolata la
            // wing è "Nome_chat_42" e come nome di persona non esiste in nessun grafo.
            needsNeighbors
                ? callMemPalace('mempalace_kg_neighbors', { entity: getCharacterWingId(), depth: 2, wing: wingId }).catch(e => { console.warn('[MemPalace] Phase E failed:', e); return null; })
                : Promise.resolve(null),
            // FASE D: Knowledge Graph multi-entità, [FIX-PHASE-D] filtra entità null/undefined
            ...kgEntities.filter(Boolean).map(entity => callMemPalace('mempalace_kg_query', { wing: wingId, entity }).catch(e => { console.warn(`[MemPalace] Phase D failed (${entity}):`, e); return null; }))
        ]);

        // [DBG] Phase-level raw results, helps diagnose why RAG returns 0 despite backend having data
        console.log(`[MemPalace] Phase raw | A(lore):${lorePulse?.results?.length ?? 'null'} B(plot):${plotPulse?.results?.length ?? 'null'} C(echo):${echoPulse?.results?.length ?? 'null'} E(nbr):${neighborsPulse?.facts?.length ?? 'null'} D(kg):${kgPulseArr.map(p => p?.facts?.length ?? 0).join('+')} | kgEntities:[${kgEntities.join(',')}]`);

        // Unifica i risultati KG di tutte le entità, deduplicando per chiave subject|predicate|object
        const seenFactKeys = new Set();
        const kgPulse = {
            facts: kgPulseArr
                .filter(Boolean)
                .flatMap(p => p.facts || [])
                .filter(f => {
                    const key = `${f.subject}|${f.predicate}|${f.object}`;
                    if (seenFactKeys.has(key)) return false;
                    seenFactKeys.add(key);
                    return true;
                })
        };

        const memoryMap = {
            fragments: []
        };

        const seenTexts = new Set();
        // [SPEZZETTAMENTO] I ricordi di uno stesso documento gia' entrati nel prompt.
        const docVisti = new Set();
        // [APERTURE] Calcolato una volta sola: serve a ogni frammento esaminato.
        const _aperturaDiQuestaChat = marchioAperturaCorrente();
        // [SCHEDA] I frammenti che vengono dalla scheda del personaggio.
        const chiaviScheda = new Set();
        // [PUNTEGGIO] I frammenti restano stringhe, perche' il budget e tutto cio' che
        // viene dopo lavorano su stringhe e cambiarli sarebbe un rischio senza guadagno.
        // Punteggio e id viaggiano a fianco, indicizzati sulla stessa chiave di deduplica.
        const punteggi = new Map();
        const idPerChiave = new Map();
        // Vero se fra i frammenti finisce almeno una frase detta dall'UTENTE: in quel
        // caso al promemoria sul confine serve dare una riga, non prima.
        let _ricordiDiAltri = false;
        
        // Parole chiave del query corrente (solo quelle > 3 char, senza stopwords) per self-echo detection
        const queryKeywords = new Set(
            queryBase.toLowerCase().replace(/[^\w\sàáâèéêìíîòóôùúû]/g, ' ')
                .split(/\s+/).filter(w => w.length > 3 && !IT_NOISE.has(w) && !EN_NOISE.has(w))
        );

        // Funzione di utilità per filtrare ed evitare ripetizioni di ciò che è già 'fresco' nella mente (ultimi messaggi)
        const isAlreadyInRecentMind = (text) => {
            const cleanText = text.toLowerCase().trim();
            // Abbassato da 20 a 10: cattura anche frasi brevi come "Hi, a beer, please!" (19 car.)
            if (cleanText.length < 10) return false;
            const probe = cleanText.substring(0, 80);
            return recentHistory.toLowerCase().includes(probe);
        };

        // Rileva se un frammento è essenzialmente una riformulazione del messaggio corrente
        // (es. DB ha memorizzato "Hi, a beer, please!" e l'utente dice "A cold beer, please!").
        // Previene il self-echo: il personaggio "ricorda" il messaggio appena ricevuto.
        const isTooSimilarToQuery = (text) => {
            if (queryKeywords.size === 0) return false;
            const textWords = new Set(
                text.toLowerCase().replace(/[^\w\sàáâèéêìíîòóôùúû]/g, ' ')
                    .split(/\s+/).filter(w => w.length > 3 && !IT_NOISE.has(w) && !EN_NOISE.has(w))
            );
            // TF-IDF-inspired: le parole brevi (4-5 car.) sono più probabilmente comuni → peso ridotto.
            // Parole lunghe (9+ car.) sono quasi sempre specifiche al dominio → peso pieno.
            // Questo riduce i falsi positivi da verbi brevi comuni (disse, vide, fece) che
            // sfuggono alle noise list pur non essendo semanticamente discriminanti.
            let weightedOverlap = 0;
            let weightedTotal = 0;
            for (const w of queryKeywords) {
                const weight = w.length >= 9 ? 1.0 : w.length >= 6 ? 0.7 : 0.3;
                weightedTotal += weight;
                if (textWords.has(w)) weightedOverlap += weight;
            }
            return weightedTotal > 0 && (weightedOverlap / weightedTotal) > 0.65;
        };

        // [C10] isSecret and sanitizeContent moved to module level, no local redefinition needed.
        // 3. PROMPT CONSTRUCTION, usa header tradotto per evitare echo di meta-istruzioni in chat
        const ragHeader = t('rag_header');
        const ragInstruction = t('rag_instruction');
        let sharedHeader = `${ragHeader}\n${ragInstruction}\n\n`;

        // Integration of AAAK Dialect Protocol if enabled (con cache per wing, evita N+1 calls)
        if (localStorage.getItem('mempalace_aaak') === 'true') {
            if (_aaakDialectCache === null || _aaakDialectWingId !== wingId) {
                const aaakStatus = await callMemPalace('mempalace_status', { wing: wingId });
                _aaakDialectCache = (aaakStatus && aaakStatus.aaak_dialect) ? aaakStatus.aaak_dialect : '';
                _aaakDialectWingId = wingId;
            }
            if (_aaakDialectCache) {
                sharedHeader += `\n${_aaakDialectCache}\n`;
            }
        }

        // Soglia di rilevanza configurabile (0.0 = nessun filtro, 1.0 = solo perfetti match)
        const relevanceThreshold = parseFloat(localStorage.getItem('mempalace_relevance_threshold') || '0');

        // Processiamo i risultati con logica di Risonanza Sinaptica
        const processResults = (search, resonanceTag, isEcho = false, skipLoreRoom = false) => {
            if (search && search.results) {
                search.results.forEach(res => {
                    // [M3] Rilevamento lorebook-origin robusto: controlla tutti i campi noti del backend
                    // (room, source_file, source, type). Se il backend non popola nessuno di questi
                    // il filtro è inerte, meglio che far passare lore che non dovrebbe.
                    const isLoreOrigin = res.room === 'lore' ||
                                          res.source_file?.startsWith('lorebook:') ||
                                          res.source?.startsWith('lorebook:') ||
                                          res.type === 'lore';
                    // Room secret: frammenti marcati come segreti non entrano mai nel prompt.
                    // Il personaggio "sa" ma non può dirlo, il KG li tratta normalmente.
                    if (res.room === 'secret' || res.source_file?.startsWith('secret:')) return;
                    // Filtro room: se skipLoreRoom=true, salta le entry lorebook
                    if (skipLoreRoom && isLoreOrigin) return;
                    // Filtro soglia: supporta sia score (similarity, alto=buono) che distance (basso=buono)
                    if (relevanceThreshold > 0) {
                        // [FIX-SOGLIA] `cosine` per primo. Il campo `similarity` del backend
                        // NON è un coseno: l'indice è in spazio L2, quindi vale 2·cos−1 e
                        // scende sotto zero appena il coseno cala sotto 0.5. Un cursore
                        // "rilevanza 0…1" confrontato con quel numero chiedeva in pratica
                        // il doppio di quanto mostrava, e da 0.3 in su scartava quasi tutto
                        // senza che nulla lo segnalasse. `similarity` resta come ripiego
                        // per i backend più vecchi che non mandano ancora `cosine`.
                        const sim = res.cosine !== undefined ? res.cosine
                                  : res.score !== undefined ? res.score
                                  : res.similarity !== undefined ? res.similarity
                                  : res.distance !== undefined ? (1 - res.distance)
                                  : 1;
                        if (sim < relevanceThreshold) return;
                    }

                    let rawContent = res.text || res.content || res.body || '';
                    if (!rawContent || typeof rawContent !== 'string') return;
                    // Self-echo filter: scarta frammenti che riformulano il messaggio corrente dell'utente
                    // [R15] Lore-origin fragments are encyclopedic background, exempt from self-echo filter.
                    // A user intro using the character's title vocabulary must not block lore retrieval.
                    if (!isLoreOrigin && isTooSimilarToQuery(String(rawContent))) return;

                    // Pulizia profonda del frammento per renderlo narrativo
                    // NOTA: va prima del cooldown check così usiamo la chiave sanitizzata (coerente con
                    // post-injection tracking che setta _loreInjectionHistory con la chiave sanitizzata).
                    let content = sanitizeContent(rawContent);
                    if (!content || content.length < 10) return; // Scarta frammenti troppo brevi o svuotati

                    // [FIX-IMPERSONAZIONE] I frammenti della stanza `user` sono parole
                    // DELL'UTENTE, non del personaggio, e finivano nel prompt sotto
                    // l'istruzione "incorporali come se fossero tue esperienze vissute".
                    // Al modello si stava dicendo, alla lettera, che le frasi in prima
                    // persona dell'utente erano ricordi propri: da lì a scrivere il
                    // turno dell'utente il passo è brevissimo, ed è successo, una
                    // risposta intera recitata al posto suo. Misurato: su due query
                    // reali, 5 frammenti episodici su 8 venivano dalla stanza `user`.
                    // Attribuirli non li butta via (sono ricordi preziosi: è quello che
                    // l'utente ha detto) ma li rimette al loro posto, come parole
                    // altrui che il personaggio ricorda di aver sentito.
                    if (res.room === 'user') {
                        const nomeUtente = (getContext()?.name1 || 'they').trim();
                        content = `${nomeUtente} once said: “${content}”`;
                        _ricordiDiAltri = true;
                    }

                    // [R9] dedupeKey calcolato da `content` (post-sanitization), non da rawContent.
                    // Prima: rawContent "**Titolo**: testo" → key "**titolo**: testo..."
                    //        content "Titolo: testo"       → cooldown key "titolo: testo..."
                    // Le due chiavi divergevano → stesso frammento bypassava seenTexts E cooldown.
                    // Ora entrambe le chiavi usano la stessa stringa sanitizzata.
                    const dedupeKey = content.toLowerCase().trim().substring(0, 80);
                    // [R17] isLoreOrigin exempt from isAlreadyInRecentMind, same reasoning as R15.
                    // Lore fragments whose first 80 chars appear in recent messages (e.g., char card
                    // quoting the lorebook, or AI response that cited lore verbatim) must not be blocked.
                    if (seenTexts.has(dedupeKey) || (!isLoreOrigin && isAlreadyInRecentMind(content))) return;

                    // [SPEZZETTAMENTO] Un ricordo lungo sta in archivio come piu' pezzi
                    // legati da `doc_id`. Se la ricerca ne riporta indietro tre, sono tre
                    // fette dello STESSO ricordo e finirebbero tutte nel prompt, mangiando
                    // il budget e ripetendo la stessa cosa tre volte. I risultati arrivano
                    // gia' ordinati per pertinenza, quindi il primo pezzo che passa di qui
                    // e' il piu' pertinente: si tiene quello e si scartano i fratelli.
                    if (res.doc_id) {
                        if (docVisti.has(res.doc_id)) return;
                        docVisti.add(res.doc_id);
                    }

                    // [APERTURE] L'apertura della chat IN CORSO sta gia' nella cronologia
                    // sotto gli occhi del modello: ripescarla sarebbe ripetersi. Quelle
                    // delle chat passate invece restano, perche' in modalita' Condivisa
                    // sono il primo ricordo di un capitolo che il personaggio ha vissuto.
                    if (res.source_file && res.source_file === _aperturaDiQuestaChat) return;

                    // AUTO-RECLASSIFICAZIONE LORE (universale, tutte le fasi, inclusa Phase C isEcho=true):
                    // Frammenti con formato enciclopedico "Titolo: Sottotitolo Maiuscolo..." vengono
                    // convertiti da [Soul-Echo] a [Common-Vibe] → si applicano cooldown e rotazione.
                    // [M3] isLoreOrigin bypassa la soglia 200 chars: se il backend dichiara lorebook,
                    // anche le entry brevi entrano nel cooldown (fix per lore <200 che bypassavano LORE_COOLDOWN).
                    // La soglia 200 rimane attiva solo per il rilevamento via content-pattern (falsi positivi).
                    let effectiveTag = resonanceTag;
                    if (isLoreOrigin) {
                        // Provenienza lorebook confermata dai campi backend → sempre [Common-Vibe]
                        effectiveTag = '[Common-Vibe]';
                    } else if (content.length > 200) {
                        // Pattern 1: "Sector 4 Slums: The Shadow District…", Titolo: Sottotitolo Maiuscolo
                        const colonPattern   = /^[A-ZÀÁÂÃÄÅÆ][A-Za-zÀ-ÿ0-9\s'']{3,60}:\s+[A-ZÀÁÂÃÄÅÆ]/.test(content);
                        // Pattern 2: "Seventh Heaven Seventh Heaven is a bar…", Titolo ripetuto (lorebook title + content concatenati)
                        // Cattura: titolo 3-50 chars ripetuto esattamente all'inizio
                        const repeatPattern  = /^([A-ZÀÁÂÃÄÅÆ][A-Za-zÀ-ÿ0-9\s''-]{3,50})\s+\1\b/.test(content);
                        if (colonPattern || repeatPattern) effectiveTag = '[Common-Vibe]';
                    }

                    // LORE COOLDOWN: si applica a tutti i [Common-Vibe] inclusi quelli reclassificati
                    // da qualsiasi fase, NON limitato a !isEcho come prima.
                    // USA la chiave sanitizzata per coerenza con _loreInjectionHistory.set() nel post-tracking.
                    if (effectiveTag === '[Common-Vibe]') {
                        const sanitizedKey = content.toLowerCase().substring(0, 80);
                        const lastGen = _loreInjectionHistory.get(sanitizedKey) ?? -999;
                        const gensSince = _interceptorGenCount - lastGen;
                        if (gensSince < LORE_COOLDOWN_GENS) return; // hard block
                        if (gensSince < LORE_SOFT_COOLDOWN_GENS) {
                            // soft zone: massimo 1 fragment lore per generazione
                            if (_loreSoftAllowedGen === _interceptorGenCount) return;
                            _loreSoftAllowedGen = _interceptorGenCount;
                        }
                    }

                    let resonance = effectiveTag;
                    // Se è un segreto rilevato nel testo, sovrascriviamo con Forbidden
                    if (isSecret(rawContent)) {
                        resonance = "[Forbidden-Void]";
                    }

                    const taggedContent = `${resonance} ${content}`;
                    memoryMap.fragments.push(taggedContent);
                    seenTexts.add(dedupeKey);
                    // [PUNTEGGIO] `sim` qui e' gia' stata calcolata sopra per la soglia di
                    // rilevanza; se la soglia e' a zero non viene calcolata, quindi si
                    // ricava di nuovo dallo stesso campo con lo stesso ordine di ripieghi.
                    const somiglianza = res.cosine !== undefined ? res.cosine
                                      : res.score !== undefined ? res.score
                                      : res.similarity !== undefined ? res.similarity
                                      : res.distance !== undefined ? (1 - res.distance)
                                      : 0.5;
                    punteggi.set(dedupeKey, punteggioRicordo(res, somiglianza));
                    if (res.id) idPerChiave.set(dedupeKey, res.id);
                    // [SCHEDA] Da dove viene serve dopo, per la precedenza nel budget.
                    if (res.room === STANZA_SCHEDA) chiaviScheda.add(dedupeKey);
                });
            }
        };

        // Associazione per Cluster Strategico (v3.0 - Cognitive Synergy)
        // Phase B/C: skipLoreRoom=true → salta entry con res.room==='lore' o source_file lorebook:*
        // (se il backend non restituisce room metadata, il filtro è no-op ma la reclassificazione
        // + cooldown già gestiscono il caso; il DEBUG log sopra mostrerà se res.room è disponibile)
        processResults(plotPulse, "[Soul-Echo]", false, true);   // Memoria vissuta (no lore)
        processResults(lorePulse, "[Common-Vibe]");              // Conoscenza pubblica (Phase A, lore OK)
        processResults(echoPulse, "[Soul-Echo]", true, true);    // Echi personali (no lore)

        // FASE D, INTEGRAZIONE KNOWLEDGE GRAPH (Fatti Strutturati)
        if (kgPulse && kgPulse.facts && kgPulse.facts.length > 0) {
            // Confidence score: favorisce fatti con soggetto/oggetto ricchi e predicato specifico.
            // Criteri: lunghezza oggetto (4-80 = ideale), predicato lungo (> 5 car. = specifico),
            // soggetto medio (5-30 = entità nominata, non descrizione). Range [0,3].
            const kgConfidence = (f) => {
                const pred = (f.predicate || '').replace(/_/g, ' ');
                const obj = (f.object || '').trim();
                const subj = (f.subject || '').trim();
                let score = 0;
                if (obj.length >= 4 && obj.length <= 80) score++;
                if (pred.length > 5) score++;
                if (subj.length >= 5 && subj.length <= 30) score++;
                return score;
            };
            // [FIX-FATTI-SCADUTI] Il grafo sa che un fatto può smettere di essere vero
            // ha `valid_to` e restituisce `current: false`, ma nessuno lo guardava:
            // un fatto invalidato continuava a entrare nel prompt esattamente come
            // quelli veri. Finché nulla invalidava niente il difetto era invisibile;
            // nel momento in cui la verità temporale viene usata, questo filtro è
            // ciò che le dà senso. `!== false` e non `=== true`: i backend che il
            // campo non lo mandano affatto devono continuare a passare.
            const fattiValidi = kgPulse.facts.filter(f => f.current !== false);
            const sortedFacts = [...fattiValidi].sort((a, b) => kgConfidence(b) - kgConfidence(a));
            sortedFacts.slice(0, 5).forEach(f => {
                const predClean = (f.predicate || '').replace(/_/g, ' ').trim();
                const objClean  = (f.object  || '').trim();
                const subjClean = (f.subject  || '').trim();
                if (predClean.length < 3 || objClean.length < 4) return;
                if (objClean.length > 300) return;
                if (subjClean.length > 60) return;
                if (KG_SUBJ_BLACKLIST.includes(subjClean.toLowerCase())) return;

                const factStr = `${f.subject} ${predClean} ${objClean}`;
                const dedupeKey = factStr.toLowerCase().substring(0, 80);
                if (!seenTexts.has(dedupeKey)) {
                    memoryMap.fragments.push(`[Common-Vibe] ${factStr}`);
                    seenTexts.add(dedupeKey);
                    // [PUNTEGGIO] Un fatto del grafo non e' un cassetto: non ha ne' data
                    // ne' ripassi. Prende un valore fisso alto, perche' e' verita'
                    // strutturata gia' filtrata per confidenza e per `current`.
                    punteggi.set(dedupeKey, PUNTEGGIO_FATTO_KG);
                }
            });
        }

        // FASE E, RETE SOCIALE DEL PROTAGONISTA (Neighbors depth 2, fatti non ancora visti)
        if (neighborsPulse && neighborsPulse.facts && neighborsPulse.facts.length > 0) {
            // [FIX-PHASE-E] Doppia rete di sicurezza sulla provenienza. Il filtro vero
            // lo fa il backend, ma un backend non aggiornato ignora il parametro `wing`
            // e restituisce lo stesso i fatti di altri personaggi: qui si scarta tutto
            // ciò che dichiara un closet diverso da quello in corso. I fatti che non
            // dichiarano provenienza passano, sono quelli dei backend vecchi, dove il
            // campo non esiste, e scartarli spegnerebbe la fase invece di ripararla.
            const fattiPropri = neighborsPulse.facts.filter(f =>
                (!f.source_closet || String(f.source_closet).toLowerCase() === String(wingId).toLowerCase())
                // [FIX-FATTI-SCADUTI] stesso filtro di Phase D: un fatto non più vero
                // non torna vero perché è arrivato dalla rete sociale.
                && f.current !== false
            );
            const scartati = neighborsPulse.facts.length - fattiPropri.length;
            if (scartati > 0) console.warn(`[MemPalace] Phase E: scartati ${scartati} fatti di altre wing (backend non aggiornato?)`);

            fattiPropri.slice(0, 4).forEach(f => {
                const key = `${f.subject}|${f.predicate}|${f.object}`;
                if (seenFactKeys.has(key)) return;
                seenFactKeys.add(key);
                // Stessa lista di Phase D: un soggetto che non è un'entità non lo
                // diventa per il fatto di essere arrivato dalla rete sociale.
                if (KG_SUBJ_BLACKLIST.includes(String(f.subject || '').trim().toLowerCase())) return;
                const factStr = `${f.subject || ''} ${(f.predicate || '').replace(/_/g, ' ')} ${f.object || ''}`;
                const dedupeKey = factStr.toLowerCase().substring(0, 80);
                if (seenTexts.has(dedupeKey)) return;
                // Phase E ha tag [Common-Vibe] → applica lo stesso decay lore di Phase A
                // per evitare che gli stessi fatti di rete sociale si ripetano in generazioni consecutive
                const lastGen = _loreInjectionHistory.get(dedupeKey) ?? -999;
                const gensSince = _interceptorGenCount - lastGen;
                if (gensSince < LORE_COOLDOWN_GENS) return;
                if (gensSince < LORE_SOFT_COOLDOWN_GENS) {
                    if (_loreSoftAllowedGen === _interceptorGenCount) return;
                    _loreSoftAllowedGen = _interceptorGenCount;
                }
                memoryMap.fragments.push(`[Common-Vibe] ${factStr}`);
                seenTexts.add(dedupeKey);
            });
        }

        // === FASE F, KG-SEMANTIC BRIDGE (Associazione a catena) ===
        // Il cuore dell'intelligenza contestuale:
        //   Utente cita "Ristorante da Piero"
        //   → Phase D trova nel KG: "Da Piero → serve → pizza"
        //   → Phase F usa "pizza" come query semantica su ChromaDB
        //   → Trova la memoria episodica "quella volta che mangiammo una pizza perfetta lì"
        //   → Personaggio dice naturalmente: "Ah sì, da Piero fanno una pizza ottima!"
        //
        // In pratica: trasforma i fatti strutturati del KG in "chiavi" per recuperare
        // memorie narrative corrispondenti che il personaggio può usare in modo organico.
        //
        // GATING: disabilitato per isPureChat, la query bridge su fatti geografici/locazione
        // (es. "located_in Sector 7 Slums") tira fuori lore enciclopedica del lorebook
        // (Train Stations, Sector 4 Slums) che non serve per conversazione breve senza entità.
        if (!intent.isPureChat && kgPulse.facts && kgPulse.facts.length > 0) {
            // Estrai gli OGGETTI e i PREDICATI dei fatti KG come termini di ricerca
            // Escludi quelli che sono già entità della query (evita ricerche ridondanti)
            const bridgeTerms = [...new Set(
                kgPulse.facts
                    .slice(0, 4)
                    .flatMap(f => [
                        f.object,
                        (f.predicate || '').replace(/_/g, ' ')
                    ])
                    .filter(term =>
                        term &&
                        term.length > 3 &&
                        !kgEntities.some(e => e.toLowerCase() === term.toLowerCase()) &&
                        // Escludi predicati troppo generici
                        !['is', 'has', 'are', 'was', 'have', 'è', 'ha', 'sono', 'essere', 'avere'].includes(term.toLowerCase())
                    )
            )];

            if (bridgeTerms.length > 0) {
                const bridgeQuery = bridgeTerms.slice(0, 4).join(' ');
                console.log(`[MemPalace] Phase F KG-Bridge | query="${bridgeQuery}" (from ${kgPulse.facts.length} KG facts)`);
                try {
                    const bridgePulse = await callMemPalace('mempalace_search', {
                        wing: wingId,
                        query: bridgeQuery,
                        limit: 2
                    });
                    // I frammenti bridge sono [Soul-Echo]: memorie episodiche triggerAte dall'associazione KG
                    processResults(bridgePulse, "[Soul-Echo]", true);
                } catch (bridgeErr) {
                    console.warn('[MemPalace] Phase F bridge failed (non-critical):', bridgeErr);
                }
            }
        }

        // === FRESHNESS SORT ═══════════════════════════════════════════════════════
        // Ordina i frammenti per "freschezza narrativa" prima del budget compression.
        // LOGICA: un frammento mai visto (o non visto da molte generazioni) vale di più
        // di uno che il personaggio ha già usato di recente. Questo garantisce che la storia
        // *avanzi* portando in superficie ricordi sempre nuovi anziché ripetere gli stessi.
        //
        //   freshness = _interceptorGenCount - lastSeenGeneration
        //   freshness alta (→ ∞) = ricordo "vergine" o molto vecchio → viene PRIMA
        //   freshness bassa (→ 0) = ricordo appena iniettato        → viene DOPO
        //
        // Il budget compression prende i primi N frammenti → prende automaticamente i più freschi.
        //
        // [PUNTEGGIO] Ordina per punteggio, con una penalita' di ripetizione a parte.
        //
        // Il punteggio dice quanto un ricordo vale in assoluto (pertinenza, freschezza,
        // quante volte e' tornato a galla). La penalita' dice tutt'altro: che quel
        // frammento e' appena stato messo nel prompt e ridirlo subito e' ripetersi.
        // Tenerle separate e' la ragione per cui il ripasso puo' premiare un ricordo
        // ricorrente senza che il personaggio si metta a ripetere la stessa frase.
        //
        // Chi non ha un punteggio (i frammenti del ponte KG, quelli di backend che non
        // mandano i metadati) prende 0.5, cioe' il centro: non avvantaggiato, non punito.
        const penalitaRipetizione = (chiave) => {
            const mem = _fragmentSessionMemory.get(chiave);
            if (!mem) return 0;                                   // mai visto in sessione
            const generazioniFa = _interceptorGenCount - mem.lastGen;
            if (generazioniFa <= 1) return 0.35;                  // appena detto
            if (generazioniFa <= 3) return 0.15;                  // ancora nell'orecchio
            return 0;
        };
        const chiaveDi = (f) => f.replace(/^\[(?:Soul-Echo|Common-Vibe|Forbidden-Void)\]\s*/, '').toLowerCase().substring(0, 80);
        memoryMap.fragments.sort((a, b) => {
            const kA = chiaveDi(a), kB = chiaveDi(b);
            const vA = (punteggi.get(kA) ?? 0.5) - penalitaRipetizione(kA);
            const vB = (punteggi.get(kB) ?? 0.5) - penalitaRipetizione(kB);
            if (Math.abs(vA - vB) > 0.001) return vB - vA;        // punteggio piu' alto prima
            // Pareggio: si torna al criterio storico, il meno visto in assoluto.
            const memA = _fragmentSessionMemory.get(kA);
            const memB = _fragmentSessionMemory.get(kB);
            return (memA ? memA.count : 0) - (memB ? memB.count : 0);
        });
        // [SCHEDA] La Descrizione ha la precedenza, e non e' una preferenza: e' uno dei
        // cuori del personaggio. Sedicimila caratteri in cima al prompt sono passivi e
        // sempre uguali; qui entra il PEZZO che c'entra col momento, e ci entra per
        // primo, prima che il budget se lo mangino i ricordi. Uno solo, il migliore:
        // riservargliene di piu' vorrebbe dire ripetergli addosso la sua stessa scheda.
        const iScheda = memoryMap.fragments.findIndex(f => chiaviScheda.has(chiaveDi(f)));
        if (iScheda > 0) {
            const [chiScheda] = memoryMap.fragments.splice(iScheda, 1);
            memoryMap.fragments.unshift(chiScheda);
            console.log('[MemPalace] Scheda: un frammento portato in testa al budget.');
        }

        if (memoryMap.fragments.length > 0) {
            const migliore = chiaveDi(memoryMap.fragments[0]);
            console.log(`[MemPalace] Punteggio: ${memoryMap.fragments.length} candidati, il primo vale ` +
                `${((punteggi.get(migliore) ?? 0.5) - penalitaRipetizione(migliore)).toFixed(2)}`);
        }

        // === SMART BUDGET COMPRESSION ═══════════════════════════════════════════
        // Garantisce che il RAG non superi mai il budget configurato.
        // Passo 1: tronca ogni singolo frammento al limite per-frammento (al confine di frase).
        // Passo 2: riempie il budget totale in modo greedy, scartando i frammenti in eccesso.
        const maxRagBudget  = parseInt(localStorage.getItem('mempalace_rag_budget')     || '2000');
        const maxFragChars  = parseInt(localStorage.getItem('mempalace_max_frag_chars') || '500');

        memoryMap.fragments = memoryMap.fragments.map(frag => {
            const tagMatch = frag.match(/^(\[(?:Soul-Echo|Common-Vibe|Forbidden-Void)\])\s*/);
            const tag  = tagMatch ? tagMatch[1] : '';
            const body = tagMatch ? frag.slice(tagMatch[0].length) : frag;
            if (body.length > maxFragChars) {
                return tag ? `${tag} ${truncateAtSentence(body, maxFragChars)}` : truncateAtSentence(body, maxFragChars);
            }
            return frag;
        });

        let usedChars = 0;
        const budgetedFrags = [];
        for (const frag of memoryMap.fragments) {
            const cost = frag.length + 4; // "- " + newline
            if (usedChars + cost > maxRagBudget) break;
            budgetedFrags.push(frag);
            usedChars += cost;
        }
        // Garantisce almeno 1 frammento anche se supera il budget (troncato al limite)
        if (budgetedFrags.length === 0 && memoryMap.fragments.length > 0) {
            const first = memoryMap.fragments[0];
            const tagMatch = first.match(/^(\[(?:Soul-Echo|Common-Vibe|Forbidden-Void)\])\s*/);
            const tag  = tagMatch ? tagMatch[1] : '';
            const body = tagMatch ? first.slice(tagMatch[0].length) : first;
            budgetedFrags.push(tag ? `${tag} ${truncateAtSentence(body, maxRagBudget - 20)}` : truncateAtSentence(body, maxRagBudget));
        }

        const droppedCount = memoryMap.fragments.length - budgetedFrags.length;
        memoryMap.fragments = budgetedFrags;
        // Log compatto: frammenti inclusi, scartati, quanti sono "freschi" (mai visti prima)
        const freshCount = budgetedFrags.filter(f => {
            const k = f.replace(/^\[(?:Soul-Echo|Common-Vibe|Forbidden-Void)\]\s*/, '').toLowerCase().substring(0, 80);
            const mem = _fragmentSessionMemory.get(k);
            return !mem || mem.count <= 1;
        }).length;
        console.log(`[MemPalace] RAG gen#${_interceptorGenCount} | ${budgetedFrags.length} frammenti (${freshCount} freschi, ${droppedCount} scartati) | ${usedChars}/${maxRagBudget} car.`);

        // ── POST-INJECTION TRACKING ───────────────────────────────────────────────
        // Aggiorna la Session Memory per TUTTI i frammenti iniettati:
        //   - _fragmentSessionMemory → freshness sort nelle generazioni future
        //   - _loreInjectionHistory  → hard cooldown per Common-Vibe (no repeat)
        budgetedFrags.forEach(f => {
            const key = f.replace(/^\[(?:Soul-Echo|Common-Vibe|Forbidden-Void)\]\s*/, '').toLowerCase().substring(0, 80);
            // Session Memory: aggiorna lastGen e incrementa count
            const existing = _fragmentSessionMemory.get(key);
            _fragmentSessionMemory.set(key, {
                lastGen: _interceptorGenCount,
                count: existing ? existing.count + 1 : 1
            });
            // Hard cooldown: solo per lore (Common-Vibe), gestito separatamente
            if (f.startsWith('[Common-Vibe]')) {
                _loreInjectionHistory.set(key, _interceptorGenCount);
            }
            // [PUNTEGGIO] Il ripasso si segna qui e non al momento del recupero: conta
            // essere finito DAVVERO nel prompt, non essere stato fra i candidati.
            registraRipasso(idPerChiave.get(key));
        });
        salvaRipassi();

        // Pulizia periodica per evitare memory leak su chat infinite (500+ messaggi)
        if (_fragmentSessionMemory.size > SESSION_MEMORY_MAX) {
            const pruneBefore = _interceptorGenCount - ECHO_SOFT_COOLDOWN - 2;
            for (const [k, v] of _fragmentSessionMemory) {
                if (v.lastGen < pruneBefore && v.count <= 1) _fragmentSessionMemory.delete(k);
            }
            // [C3] Hard cap: if soft prune wasn't enough (all remaining entries are high-count),
            // evict the oldest by lastGen until we're back to 80% of the cap.
            // Without this, a session with many recurring fragments could grow the map without bound.
            if (_fragmentSessionMemory.size > SESSION_MEMORY_MAX) {
                const target = Math.floor(SESSION_MEMORY_MAX * 0.8);
                const sorted = [..._fragmentSessionMemory.entries()].sort((a, b) => a[1].lastGen - b[1].lastGen);
                sorted.slice(0, _fragmentSessionMemory.size - target).forEach(([k]) => _fragmentSessionMemory.delete(k));
            }
        }
        if (_loreInjectionHistory.size > 150) {
            const pruneBefore = _interceptorGenCount - LORE_COOLDOWN_GENS - 1;
            for (const [k, v] of _loreInjectionHistory) {
                if (v < pruneBefore) _loreInjectionHistory.delete(k);
            }
        }
        _interceptorGenCount++;
        // Auto-diary: counter avanza ad ogni generazione (non solo su RAG hit)
        // così l'intervallo di 20 turni è reale indipendentemente da hit/miss/pure-chat
        maybeWriteAutoDiary(wingId).catch(() => {});

        if (memoryMap.fragments.length > 0) {
            // Versione taggata: usata solo per il badge RAG (visualizzazione interna)
            const taggedOutput = sharedHeader + "\n- " + memoryMap.fragments.join('\n- ');

            // Versione pulita per il prompt AI: le etichette [Soul-Echo] ecc. vengono rimosse
            // per evitare che il modello le riproduca letteralmente in chat
            const spoglia = (f) => f.replace(/^\[(Soul-Echo|Common-Vibe|Forbidden-Void)\]\s*/, '');

            // [SEGRETI] I frammenti marcati [SECRET]/[SEGRETO] nel testo venivano
            // riconosciuti ed etichettati [Forbidden-Void]... e poi l'etichetta veniva
            // tolta insieme a tutte le altre. Il modello riceveva un segreto
            // indistinguibile da un ricordo qualunque, quindi lo trattava come tale e
            // poteva dirlo alla prima occasione: la funzione non era solo inerte, era
            // controproducente rispetto a quello che prometteva. Le due stringhe che
            // servono a spiegarlo esistono già tradotte in tutte e sette le lingue
            // (`rag_secrets`, `rag_secret_instruction`) ma non erano mai state
            // collegate a niente. Qui i segreti vanno in una sezione loro, con
            // l'istruzione che dice al modello come comportarsi.
            const segreti = memoryMap.fragments.filter(f => f.startsWith('[Forbidden-Void]')).map(spoglia);
            const normali = memoryMap.fragments.filter(f => !f.startsWith('[Forbidden-Void]')).map(spoglia);

            let promptOutput = sharedHeader;
            if (_ricordiDiAltri) {
                // Una riga sola, e solo quando fra i frammenti c'è davvero una frase
                // dell'utente: ricordare le parole di qualcuno non autorizza a
                // pronunciarle di nuovo al posto suo.
                const nomeUtente = (getContext()?.name1 || 'the other person').trim();
                promptOutput += `Some of these are words ${nomeUtente} said to you. Remember them, but never speak or act in ${nomeUtente}'s place.\n`;
            }
            if (normali.length > 0) promptOutput += "\n- " + normali.join('\n- ');
            if (segreti.length > 0) {
                promptOutput += `\n\n${t('rag_secrets')}\n${t('rag_secret_instruction')}\n- ` + segreti.join('\n- ');
            }

            // [LLAMACPP] Il filtro tiene il blocco RAG fuori dai prompt di estrazione:
            // se no il modello estrae fatti dai ricordi appena iniettati, non dal messaggio,
            // e il grafo si autoalimenta rinforzando gli errori che ha già dentro.
            setExtensionPrompt('MemPalace RAG', `\n${promptOutput}\n`, extension_prompt_types.BEFORE_PROMPT, 100,
                false, extension_prompt_roles.SYSTEM, _fuoriDallEstrazione);
            window.mempalaceLastFished = taggedOutput;
            _ragHitCount++;
            console.log(`[MemPalace] Prompt updated: ${seenTexts.size} narrative fragments injected. RAG hit rate: ${Math.round(_ragHitCount / (_ragHitCount + _ragMissCount) * 100)}% (${_ragHitCount}/${_ragHitCount + _ragMissCount})`);
        } else {
            // [R14] Distinguish: zero results due to empty backend vs. pure-chat skip.
            const anyPhaseActive = activeLoreLim > 0 || activePlotLim > 0 || activeEchoLim > 0;
            if (anyPhaseActive) {
                _ragMissCount++;
                console.warn(`[MemPalace] ⚠️ 0 frammenti per wing="${wingId}". RAG hit rate: ${Math.round(_ragHitCount / (_ragHitCount + _ragMissCount) * 100)}% (${_ragHitCount}/${_ragHitCount + _ragMissCount})`);
            } else {
                console.log("[MemPalace] RAG skip: pure chat (no entities, short message).");
            }
            setExtensionPrompt('MemPalace RAG', '', extension_prompt_types.BEFORE_PROMPT, 0);
            window.mempalaceLastFished = null;
        }
    } catch (e) {
        console.error("[MemPalace] RAG Interceptor Critical Error:", e);
        setExtensionPrompt('MemPalace RAG', '', extension_prompt_types.BEFORE_PROMPT, 0);
    } finally {
        $('#mempalace-rag-preview').removeClass('mp-interceptor-active');
    }
}

/**
 * Hook: On Message Received (Character -> User)
 */
/**
 * La stanza in cui vivono le aperture di chat.
 *
 * Un'apertura NON viene esclusa dal recupero in blocco, e la distinzione conta:
 *
 *  - in modalita' **Isolata** ogni chat ha una wing sua, quindi l'unica apertura
 *    raggiungibile e' quella della chat in corso, che sta gia' nella cronologia
 *    sotto gli occhi del modello: ripescarla sarebbe ripetersi;
 *  - in modalita' **Condivisa** il personaggio ricorda le chat passate, e l'apertura
 *    di una partita giocata mesi fa **e' una cosa che gli e' successa**: e' il primo
 *    ricordo di quel capitolo, e vale quanto gli altri.
 *
 * Quindi si toglie dai candidati soltanto l'apertura della chat CORRENTE, per non
 * duplicare cio' che e' gia' in cronologia. Una regola sola che si comporta bene in
 * entrambe le modalita', senza doverle distinguere.
 */
const STANZA_APERTURA = 'apertura';
const STANZE_NON_EPISODICHE = ['lore'];

/** Il marchio dell'apertura di questa chat, quello da non ripescare. */
function marchioAperturaCorrente() {
    const ctx = getContext();
    return `apertura:${ctx?.chatId ?? 'senza-id'}`;
}

/**
 * Estrae i fatti dall'apertura, ma solo quando la storia e' partita davvero.
 *
 * Il momento e' scelto apposta. SillyTavern permette di cambiare inizio alternativo
 * **solo finche' la chat non e' andata oltre il saluto** (`script.js:8409`: la
 * rigenerazione richiede `chat.length <= 1`). Aspettare il secondo messaggio vuol
 * dire aspettare che la scelta sia bloccata: cosi' provare sei inizi non costa un
 * fatto, e l'inizio che si finisce per giocare entra nel grafo come merita.
 *
 * Vale in modalita' **Condivisa**, dove il personaggio accumula il proprio passato
 * attraverso le chat. In Isolata l'apertura resta sotto gli occhi del modello per
 * tutta la partita e non c'e' niente da imparare che non sia gia' li'.
 */
async function forseEstraiApertura(wingId) {
    try {
        if (getIsolationMode() !== 'character') return;     // solo in Condivisa
        const ctx = getContext();
        const messaggi = (ctx?.chat || []).filter(m => !m.is_system && m.mes);
        if (messaggi.length < 2) return;                    // la storia non e' ancora partita
        if (messaggi[0].is_user) return;                    // non c'e' un saluto d'apertura
        const chiave = `mempalace_apertura_estratta_${ctx.chatId}`;
        if (localStorage.getItem(chiave) === 'true') return;
        localStorage.setItem(chiave, 'true');               // prima del lavoro: mai due volte

        const r = await callMemPalace('mempalace_extract_facts', {
            text: messaggi[0].mes,
            character: wingId,
            save: true,
            source_file: marchioAperturaCorrente(),
        }).catch(() => null);
        console.log(`[MemPalace] Fatti dall'apertura di questa chat: ${r?.facts_found ?? 0}`);
    } catch (e) {
        console.warn('[MemPalace] Estrazione dell\'apertura non riuscita (non critica):', e);
    }
}

/**
 * Archivia l'apertura di questa chat, sostituendo quella precedente.
 *
 * Una chat ha UNA apertura: se si cambia inizio alternativo, il nuovo prende il posto
 * del vecchio invece di affiancarlo. L'identificativo della chat viaggia dentro
 * `source_file` e non in un metadato qualunque perche' `list_drawers` restituisce
 * `source_file` ma non i metadati liberi: e' l'unico campo su cui si possa ritrovare
 * l'apertura vecchia per toglierla.
 */
async function registraApertura(wingId, testo) {
    if (!testo || !String(testo).trim()) return;
    const ctx = getContext();
    const marchio = `apertura:${ctx?.chatId ?? 'senza-id'}`;

    try {
        const gia = await callMemPalace('mempalace_list_drawers', {
            wing: wingId, room: STANZA_APERTURA, limit: 50,
        });
        for (const d of (gia?.drawers || [])) {
            if (d.source_file === marchio && d.content !== testo) {
                await callMemPalace('mempalace_delete_drawer', { drawer_id: d.id }).catch(() => null);
            }
        }
    } catch (e) {
        console.warn('[MemPalace] Non sono riuscito a togliere l\'apertura precedente:', e);
    }

    // Qui il controllo duplicati si spegne del tutto (soglia oltre l'uno), e non e' una
    // scorciatoia: due chat diverse possono partire dallo STESSO inizio alternativo,
    // parola per parola, e sono due aperture distinte. Con la soglia normale la seconda
    // veniva rifiutata, quella chat restava senza apertura registrata, e spariva del
    // tutto se la prima chat poi cambiava inizio. L'unicita' qui la garantisce il
    // marchio `apertura:<chat>` insieme alla cancellazione esplicita qui sopra, non
    // la somiglianza del testo.
    const r = await scriviRicordo({
        wing: wingId, room: STANZA_APERTURA, content: testo, source_file: marchio,
        dup_threshold: 1.01,
    });
    console.log(`[MemPalace] Apertura della chat archiviata (${marchio}): ${r.salvati} pezzi, ${r.duplicati} gia' presenti.`);
}

async function onMessageReceived(messageId, tipo) {
    // La risposta e' arrivata: il modello e' di nuovo libero.
    _generazioneInCorso = false;
    _ultimaGenerazione = Date.now();   // da qui si conta il silenzio prima del sottofondo
    if (_sbloccoGenerazione) { clearTimeout(_sbloccoGenerazione); _sbloccoGenerazione = null; }
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;

    const lastMessage = context.chat[context.chat.length - 1];
    if (lastMessage.is_system) return;

    const wingId = getWingId();
    if (!wingId) return;

    // [APERTURE] Il messaggio di apertura non e' una cosa accaduta.
    //
    // SillyTavern manda l'evento con tipo 'first_message' sia quando apre una chat
    // nuova sia quando si sceglie un inizio alternativo dal pannello dei saluti.
    // Finora quel messaggio veniva archiviato come un ricordo qualunque, e su un
    // personaggio con sei inizi diversi il risultato era che nell'archivio ci
    // finivano tutti e sei: in modalita' Condivisa, dove tutte le chat scrivono
    // nella stessa wing, il personaggio si ritrovava a "ricordare" sei aperture di
    // storia che si escludono a vicenda, come se fossero successe tutte.
    //
    // Un'apertura e' la scenografia di UNA partita. Va tenuta, ma nella sua stanza,
    // una sola per chat, e fuori dalle fasi episodiche del recupero. I fatti non si
    // estraggono: la scheda del personaggio e' gia' tutta nel prompt, quindi da li'
    // non si impara niente di nuovo, e da un inizio alternativo si imparerebbe una
    // realta' che in questa partita non e' mai avvenuta.
    if (tipo === 'first_message' || (messageId === 0 && context.chat.length === 1)) {
        await registraApertura(wingId, lastMessage.mes);
        return;
    }

    // [APERTURE] La storia e' andata oltre il saluto: da qui l'inizio non si puo' piu'
    // cambiare, quindi i suoi fatti si possono estrarre senza rischio.
    forseEstraiApertura(wingId);

    // Save to room_history
    const _scritto = await scriviRicordo({ wing: wingId, room: "char", content: lastMessage.mes });

    // [TAPPA 4] Dopo il turno il personaggio si ferma un momento a pensarci: quanto
    // l'ha colpito e cosa gli resta. Una chiamata sola, a modello libero.
    programmaRiflessione(wingId, getCharacterWingId() || wingId, _scritto?.ids || []);
    // [TAPPA 5] E ogni tanto si guarda indietro: cosa di tutto questo e' diventato
    // parte di lui, e cosa era soltanto lo stato d'animo di un giorno.
    forseConsolida(wingId, getCharacterWingId() || wingId);

    // Auto-scan for facts if enabled
    if (localStorage.getItem('mempalace_autoscan') === 'true') {
        callMemPalace('mempalace_extract_facts', { 
            text: lastMessage.mes, 
            character: wingId, 
            save: true 
        }).catch(e => console.error("[MemPalace] Auto-scan error (Char):", e));
    }
    // Estrazione continua: il grafo cresce da solo mentre la storia va avanti.
    // Programmata, non immediata: il modello ha appena finito di scrivere e fra un
    // attimo potrebbe servire di nuovo all'utente.
    programmaEstrazione(wingId);

    // Se c'è stata una RAG injection, aggiungiamo la spunta visuale (badge) e storicizziamo il dato
    if (window.mempalaceLastFished) {
        // Salviamo persistentemente nella chat JSON nativa di SillyTavern!
        // NOTA: salviamo una versione compatta (max 1200 car.) per evitare il bloat del file chat
        // su sessioni lunghe (500+ messaggi × ~2KB = >1MB di overhead inutile).
        // La versione in-memory (window.mempalaceLastFished) rimane integra per il rendering UI.
        const msgIdx = parseInt(messageId);
        const msg = (!isNaN(msgIdx) && msgIdx >= 0 && msgIdx < context.chat.length)
            ? context.chat[msgIdx] : null;
        if (msg) {
            msg.extra = msg.extra || {};
            const ragFull = window.mempalaceLastFished;
            // [R16] Limit raised to 3500: AAAK header (~800) + maxRagBudget (2000) + margin.
            // Old 1200-char limit caused badge-on-reload to show fewer fragments than were actually injected.
            msg.extra.mempalace_rag = ragFull.length > 3500 ? ragFull.substring(0, 3497) + '…' : ragFull;
            
            // Forziamo il salvataggio della chat per non perdere i metadati
            if (typeof window.saveChatConditional === 'function') {
                window.saveChatConditional();
            }
        }

        // [B7] Capture ragSnapshot BEFORE the timeout: if another generation fires within
        // 300ms (regen / auto-continue), mempalaceLastFished would be overwritten and the
        // badge would show the wrong injection. Capturing here freezes the correct snapshot.
        const ragSnapshot = window.mempalaceLastFished;
        setTimeout(() => {
            injectBadgeIntoMessage(messageId, ragSnapshot);
            updateRagPreviewPanel(ragSnapshot);
            window.mempalaceLastFished = null;
        }, 300);
    }
}

// F4, Auto-diary: ogni AUTO_DIARY_INTERVAL generazioni, riassume i fatti KG recenti nel diary
const AUTO_DIARY_INTERVAL = 20;
let _autoDiaryGensSinceLast = 0;

async function maybeWriteAutoDiary(wingId) {
    _autoDiaryGensSinceLast++;
    if (_autoDiaryGensSinceLast < AUTO_DIARY_INTERVAL) return;
    _autoDiaryGensSinceLast = 0;
    try {
        // [FIX-AUTODIARY] entity usa wingId (già canonico) invece di activeCharacterName che può essere stale
        const kgResult = await callMemPalace('mempalace_kg_query', { wing: wingId, entity: wingId });
        if (!kgResult || !kgResult.facts || kgResult.facts.length === 0) return;
        const topFacts = kgResult.facts
            .slice(0, 8)
            .map(f => `- ${f.subject || ''} ${(f.predicate || '').replace(/_/g, ' ')} ${f.object || ''}`)
            .join('\n');
        const entry = `[Auto-Memo, gen ${_interceptorGenCount}]\n${topFacts}`;
        await callMemPalace('mempalace_diary_write', { agent_name: getCharacterWingId() || wingId, entry });
        console.log(`[MemPalace] Auto-diary written at gen ${_interceptorGenCount}`);
    } catch (e) {
        console.warn('[MemPalace] Auto-diary failed (non-critical):', e);
    }
}

/**
 * --- KNOWLEDGE BROWSER LOGIC ---
 */

/**
 * [WING-MODEL] Le wing da cui leggere i FATTI di questo personaggio.
 *
 * Stessa coppia che usa già la Mappa Sinaptica: la wing episodica (dove finiscono i
 * fatti estratti dalla chat) e quella d'identità (dove finiscono quelli della lore).
 * In modalità Condivisa sono la stessa cosa e la coppia si riduce a una; in Isolata
 * leggerne una sola vuol dire mostrare metà del grafo, ed era il motivo per cui
 * l'Anagrafe restava vuota su un personaggio con la lore appena sincronizzata.
 */
function getFactWings() {
    return [...new Set([getWingId(), getCharacterWingId()].filter(Boolean))];
}

/**
 * Interroga un tool del grafo su tutte le wing dei fatti e unisce gli esiti,
 * deduplicando su soggetto|predicato|oggetto. Il backend accetta una wing per
 * chiamata: la fusione si fa qui, così non serve toccare il server (che è condiviso
 * con l'altro palazzo e non va riavviato).
 */
async function leggiFattiWing(tool, campo, args = {}) {
    const wings = getFactWings();
    if (wings.length === 0) return [];
    const esiti = await Promise.all(
        wings.map(w => callMemPalace(tool, { ...args, wing: w }).catch(() => null))
    );
    const visti = new Set();
    const uniti = [];
    for (const e of esiti) {
        for (const f of ((e && e[campo]) || [])) {
            const chiave = `${f.subject}|${f.predicate}|${f.object}`;
            if (visti.has(chiave)) continue;
            visti.add(chiave);
            uniti.push(f);
        }
    }
    return uniti;
}

async function showKGTimeline() {
    const wingId = getWingId();
    if (!wingId) return toastr.warning(t('toast_no_char'));

    console.log('[MemPalace] Fetching Timeline for wings:', getFactWings());

    // Fetch all events for the current wing context
    // [TAPPA 5] La Timeline racconta EVENTI. Il backend ne toglie gia' la lore
    // (`lorebook:`, `lore_`, `lore:`) ma non conosce il marcatore `consolidamento`,
    // che e' nato dopo: un tratto consolidato come "osserva la propria mancanza di
    // fiducia" non e' una cosa accaduta un giorno preciso, e' cio' che il personaggio
    // e' diventato. Verificato che senza questo filtro ci finisce dentro.
    const eventi = (await leggiFattiWing('mempalace_kg_timeline', 'timeline', { entity: null }))
        .filter(f => f.source_file !== 'consolidamento');
    const result = { timeline: eventi };
    console.log('[MemPalace] Timeline result:', result);

    let html = '<div class="mempalace-lore-list" style="max-height: 60vh; overflow-y: auto; padding-right: 10px;">';
    if (!result || !result.timeline || result.timeline.length === 0) {
        html += `
            <div style="text-align:center; opacity:0.6; padding:40px;">
                <i class="fa-solid fa-hourglass-empty" style="font-size: 3em; margin-bottom: 15px; display: block; color: var(--mp-void);"></i>
                <p>${t('kg_no_timeline', { default: 'No temporal facts recorded for this timeline yet.' })}</p>
                <small style="display:block; margin-top:8px; opacity:0.7; line-height:1.5;">La Timeline mostra solo eventi, non la lore dei libri.<br>Si riempie dai fatti del grafo: se l'Anagrafe è vuota, lo è anche questa.</small>
                <small style="display:block; margin-top:10px; opacity:0.5;">Context: ${wingId}</small>
            </div>`;
    } else {
        result.timeline.forEach(f => {
            const date = escHtml(f.date || f.valid_from || '???');
            html += `
                <div class="mp-timeline-item" style="margin-bottom: 20px; padding-left: 20px; border-left: 3px solid var(--mp-void); position:relative;">
                    <div style="position:absolute; left:-7px; top:0; width:12px; height:12px; background:var(--mp-void); border-radius:50%; box-shadow: 0 0 10px var(--mp-void);"></div>
                    <div style="font-size:0.75em; color:var(--mp-void); font-weight:800; margin-bottom:6px; letter-spacing: 1px; text-transform: uppercase;">${date}</div>
                    <div style="font-size:1em; line-height:1.5; color: #eee; background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px;">
                        <strong style="color: #fff;">${escHtml(f.subject || '')}</strong>
                        <span style="opacity: 0.7; font-style: italic;">${escHtml((f.predicate || '').replace(/_/g, ' '))}</span>
                        <strong style="color: #fff;">${escHtml(f.object || '')}</strong>
                    </div>
                </div>`;
        });
    }
    html += '</div>';

    showMemPalaceModal('Temporal Timeline', html, 'fa-timeline', 'var(--mp-void)');
}

/**
 * Anagrafe Entità, ora si può anche SCRIVERE, non solo guardare.
 *
 * Il grafo ha sempre saputo che un fatto può smettere di essere vero (`valid_to`,
 * `current`) e ha sempre avuto `kg_add`/`kg_invalidate` funzionanti, ma nessuna
 * interfaccia li chiamava: i fatti di un personaggio nascevano e restavano veri per
 * sempre. È la differenza fra un elenco e una memoria, un personaggio che si è
 * trasferito continuava a "vivere" anche dove abitava prima, e il RAG glielo
 * ricordava come presente.
 *
 * Archiviare non cancella: il fatto resta nel grafo con la sua data di fine, esce
 * dal prompt ma sopravvive nella Timeline come parte del passato del personaggio.
 */
async function showKGRegistry() {
    const wingId = getWingId();
    if (!wingId) return toastr.warning(t('toast_no_char'));

    const result = { facts: await leggiFattiWing('mempalace_kg_query', 'facts', { entity: null }) };

    let html = `<div style="display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap; align-items:center;">
        <input id="mp-fact-s" class="mp-input-select" placeholder="${escHtml(t('kg_fact_subject'))}" style="flex:1; min-width:110px;">
        <input id="mp-fact-p" class="mp-input-select" placeholder="${escHtml(t('kg_fact_predicate'))}" style="flex:1; min-width:110px;">
        <input id="mp-fact-o" class="mp-input-select" placeholder="${escHtml(t('kg_fact_object'))}" style="flex:1; min-width:110px;">
        <button id="mp-fact-add" class="mp-btn-primary" style="padding:6px 14px;"><i class="fa-solid fa-plus"></i></button>
    </div>`;
    html += '<div class="mempalace-lore-list" style="max-height: 46vh; overflow-y: auto; padding-right: 10px;">';

    if (!result || !result.facts || result.facts.length === 0) {
        // Stato vuoto utile invece che muto: su prosa di roleplay il regex raccoglie
        // pochissimo (misurato: 57 messaggi -> 7 fatti), quindi un pannello vuoto è
        // la norma per un personaggio nuovo, non un guasto. Meglio dire cosa fare.
        html += `<div style="text-align:center; opacity:0.7; padding:18px; line-height:1.6;">
            <p style="margin:0 0 10px;">Nessun fatto ancora registrato per questo personaggio.</p>
            <p style="font-size:0.88em; opacity:0.8; margin:0;">
                Il grafo si riempie con le <b>affermazioni</b> del racconto, non col dialogo:
                un personaggio che chiacchiera a lungo può averne pochissimi.<br>
                Aggiungine uno a mano qui sopra, oppure usa <b>Deep Knowledge Scan</b>:
                attivando <i>estrai i fatti col modello</i> ne trova molti di più.
            </p></div>`;
    } else {
        const groups = {};
        result.facts.forEach(f => {
            if (!groups[f.subject]) groups[f.subject] = [];
            groups[f.subject].push(f);
        });

        for (const subj in groups) {
            html += `<div style="margin-bottom: 15px; border: 1px solid #c084fc; border-radius: 8px; overflow: hidden; background: rgba(0,0,0,0.2);">`;
            html += `<div style="background: #c084fc; color: white; padding: 5px 10px; font-weight: bold; font-size: 0.9em;">${escHtml(subj)}</div>`;
            html += `<div style="padding: 10px;">`;
            groups[subj].forEach(f => {
                // I fatti archiviati restano visibili ma barrati: nascondere il passato
                // renderebbe impossibile capire perché un ricordo non compare più.
                const passato = f.current === false;
                const stile = passato ? 'opacity:0.45; text-decoration:line-through;' : '';
                html += `<div style="font-size: 0.9em; margin-bottom: 4px; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.05); display:flex; align-items:center; gap:8px;">`;
                html += `<span style="flex:1; ${stile}"><b style="color: #c084fc;">${escHtml((f.predicate || '').replace(/_/g, ' '))}:</b> ${escHtml(f.object || '')}</span>`;
                if (passato) {
                    html += `<span style="font-size:0.75em; opacity:0.5;">${escHtml(f.valid_to || '')}</span>`;
                } else {
                    html += `<i class="fa-solid fa-box-archive mp-fact-archive" title="${escHtml(t('kg_fact_archive'))}"
                             data-s="${escHtml(f.subject || '')}" data-p="${escHtml(f.predicate || '')}" data-o="${escHtml(f.object || '')}"
                             style="cursor:pointer; opacity:0.5; padding:2px 4px;"></i>`;
                }
                html += `</div>`;
            });
            html += `</div></div>`;
        }
    }
    html += '</div>';

    showMemPalaceModal('Entity Registry', html, 'fa-users-rectangle', 'var(--mp-void)');

    // Handler delegati: il modal viene ricostruito da zero a ogni apertura, quindi
    // agganciarsi ai singoli elementi lascerebbe listener orfani a ogni riapertura.
    $('#mempalace-custom-modal').off('click.mpfact').on('click.mpfact', '.mp-fact-archive', async function () {
        const s = $(this).data('s'), p = $(this).data('p'), o = $(this).data('o');
        // [FIX-LORE-KG] L'Anagrafe mostra i fatti di DUE closet (l'episodico e quello
        // d'identità, dove vive la lore), quindi archiviare su uno solo non basta: il
        // backend risponde success anche quando non ha chiuso niente (closed=0) e il
        // fatto ricompariva alla riapertura del pannello. Si prova wing per wing e si
        // smette alla prima che chiude davvero: mai un invalidate globale, che
        // toccherebbe gli stessi fatti negli altri personaggi.
        let r = null;
        for (const w of getFactWings()) {
            r = await callMemPalace('mempalace_kg_invalidate', { subject: s, predicate: p, object: o, wing: w });
            if (r && r.success && (r.closed === undefined || r.closed > 0)) break;
        }
        if (r && r.success) {
            toastr.success(t('kg_fact_archived', { fact: `${s} ${String(p).replace(/_/g, ' ')} ${o}` }));
            showKGRegistry();
        } else {
            toastr.error(t('kg_fact_error'));
        }
    });

    $('#mp-fact-add').off('click.mpfact').on('click.mpfact', async () => {
        const s = ($('#mp-fact-s').val() || '').trim();
        const p = ($('#mp-fact-p').val() || '').trim().toLowerCase().replace(/\s+/g, '_');
        const o = ($('#mp-fact-o').val() || '').trim();
        if (!s || !p || !o) return toastr.warning(t('kg_fact_incomplete'));
        const r = await callMemPalace('mempalace_kg_add', { subject: s, predicate: p, object: o, wing: wingId });
        if (r && r.success) {
            toastr.success(t('kg_fact_added'));
            showKGRegistry();
        } else {
            toastr.error(t('kg_fact_error'));
        }
    });
}

/**
 * Gestore della lore collegata a un personaggio.
 *
 * Colma il buco aperto dal modello a wing separate: da quando i lorebook vivono in
 * wing proprie (`lore:<Libro>`), un personaggio NUOVO che abita un mondo già
 * ingerito non aveva modo di dirlo. L'unico appiglio era ri-selezionare il lorebook
 * e premere Ingerisci, funziona, perché il collegamento viene scritto anche quando
 * è tutto duplicato, ma bisogna sapere che funziona, e nessuno può indovinarlo.
 *
 * Qui si vedono tutti i mondi in archivio e si spunta quali il personaggio conosce.
 * Non si copia e non si cancella niente: si cambia solo chi ha la chiave.
 */
async function showLoreWingManager() {
    const charKey = getCharacterWingId();
    if (!charKey) return toastr.warning(t('toast_no_char'));

    const res = await callMemPalace('mempalace_list_wings', {});
    const tutte = Object.entries((res && res.wings) || {})
        .filter(([w]) => w.startsWith('lore:'))
        .sort((a, b) => b[1] - a[1]);
    const collegati = getLoreBooks(charKey);

    let html = '';
    if (tutte.length === 0) {
        html = `<p style="text-align:center; opacity:0.6; padding:20px;">${escHtml(t('lore_none'))}</p>`;
    } else {
        html = '<div class="mempalace-lore-list" style="max-height:50vh; overflow-y:auto; padding-right:10px;">';
        for (const [wing, quanti] of tutte) {
            const libro = wing.slice(5);
            const attivo = collegati.includes(libro);
            html += `<div class="mp-lore-row" data-book="${escHtml(libro)}" style="display:flex; align-items:center; gap:10px; padding:10px; margin-bottom:6px; border-radius:8px; cursor:pointer; border:1px solid ${attivo ? '#4ade80' : 'rgba(255,255,255,0.08)'}; background:${attivo ? 'rgba(74,222,128,0.08)' : 'rgba(0,0,0,0.2)'};">
                <i class="fa-solid ${attivo ? 'fa-link' : 'fa-link-slash'}" style="color:${attivo ? '#4ade80' : '#6b7280'};"></i>
                <span style="flex:1; color:#eee;">${escHtml(libro)}</span>
                <span style="font-size:0.78em; opacity:0.5;">${quanti}</span>
            </div>`;
        }
        html += '</div>';
    }

    showMemPalaceModal(t('lore_manage_btn'), html, 'fa-book-atlas', 'var(--mp-void)');

    $('#mempalace-custom-modal').off('click.mplore').on('click.mplore', '.mp-lore-row', function () {
        const libro = $(this).data('book');
        let registro = {};
        try { registro = JSON.parse(localStorage.getItem('mempalace_lore_books') || '{}'); } catch (_) { registro = {}; }
        const elenco = registro[charKey] || [];
        const i = elenco.indexOf(libro);
        if (i >= 0) {
            elenco.splice(i, 1);
            toastr.info(t('lore_unlinked', { name: libro }));
        } else {
            elenco.push(libro);
            toastr.success(t('lore_linked', { name: libro }));
        }
        registro[charKey] = elenco;
        localStorage.setItem('mempalace_lore_books', JSON.stringify(registro));
        showLoreWingManager();
        refreshMemPalaceStats();
    });
}

async function openSynapticMap() {
    if (typeof vis === 'undefined') {
        console.log('[MemPalace] vis-network missing, attempting dynamic load...');
        const script = document.createElement('script');
        script.src = 'scripts/extensions/MemPlace/vis-network.min.js';
        script.async = false;
        document.head.appendChild(script);
        
        // Wait for script to load before continuing
        await new Promise((resolve) => {
            script.onload = resolve;
            script.onerror = () => {
                console.error('[MemPalace] Failed to load vis-network script from:', script.src);
                toastr.error('Could not load graph library. Check file path.');
                resolve();
            };
        });
        
        if (typeof vis === 'undefined') {
            return toastr.error('Vis-Network library missing. Please reload SillyTavern.');
        }
    }

    const wingId = getWingId();
    if (!wingId) return toastr.warning(t('toast_no_char'));

    await $('#mempalace-graph-modal').fadeIn(300).css('display', 'flex').promise();
    $('#mempalace-graph-loading').show();

    try {
        // Opzionale: chiediamo al backend di normalizzare i nodi prima del fetch
        // kg_normalize è opzionale: se fallisce (server offline o errore), il grafo carica ugualmente senza normalizzazione.
        const normResult = await callMemPalace('mempalace_kg_normalize', {});
        if (normResult && normResult.error) console.warn('[MemPalace] kg_normalize server error (non bloccante):', normResult.error);
        
        // [FIX-WINGNAME] usa canonicalCharKey per coerenza con getWingId(), trim() da solo non basta
        let charName = canonicalCharKey(activeCharacterName || getActiveCharacterName() || '');
        // [WING-MODEL] La mappa deve mostrare la memoria del personaggio per intero:
        // la sua wing d'identità E quella della chat in corso. Passando la sola wing
        // episodica, in modalità Isolata il grafo di una chat appena aperta risultava
        // vuoto anche con decine di fatti in archivio sul personaggio.
        const graphWings = [...new Set([getCharacterWingId(), wingId].filter(Boolean))];
        const data = await callMemPalace('mempalace_get_graph', { character: charName, wings: graphWings });
        $('#mempalace-graph-loading').hide();

        const container = document.getElementById('mempalace-graph-container');
        const legendContainer = $('#mempalace-graph-legend');
        
        if (!data || !data.nodes || data.nodes.length === 0) {
            $(container).html('<div style="display:flex; flex-direction: column; align-items:center; justify-content:center; height:100%; color:#aaa; font-style:italic; gap: 15px;"><i class="fa-solid fa-circle-nodes" style="font-size: 3em; opacity: 0.2;"></i><span>Il grafo &egrave; vuoto per questo personaggio.</span><span style="font-size:0.82em; opacity:0.7; max-width:420px; text-align:center; line-height:1.5;">Nasce dai fatti registrati nell&rsquo;Anagrafe Entit&agrave;. Aggiungine a mano, oppure lancia un Deep Knowledge Scan con l&rsquo;estrazione col modello attiva.</span></div>');
            legendContainer.hide();
            return;
        }

        const iconMap = {
            'agent': { face: "'Font Awesome 6 Free'", code: '\uf4fb', color: '#f59e0b', label: 'SOUL-ECHO' },
            'person': { face: "'Font Awesome 6 Free'", code: '\uf007', color: '#0ea5e9', label: 'Person' },
            'place': { face: "'Font Awesome 6 Free'", code: '\uf3c5', color: '#10b981', label: 'Place' },
            'object': { face: "'Font Awesome 6 Free'", code: '\uf1b2', color: '#3b82f6', label: 'Object' },
            'event': { face: "'Font Awesome 6 Free'", code: '\uf133', color: '#a855f7', label: 'Event' },
            'concept': { face: "'Font Awesome 6 Free'", code: '\uf0eb', color: '#facc15', label: 'Concept' },
            'feeling': { face: "'Font Awesome 6 Free'", code: '\uf004', color: '#ec4899', label: 'Feeling' },
            'dream': { face: "'Font Awesome 6 Free'", code: '\uf186', color: '#6366f1', label: 'Dream' },
            'threat': { face: "'Font Awesome 6 Free'", code: '\uf06a', color: '#ef4444', label: 'Threat' },
            'money': { face: "'Font Awesome 6 Free'", code: '\uf155', color: '#84cc16', label: 'Currency' },
            'unknown': { face: "'Font Awesome 6 Free'", code: '\uf128', color: '#6b7280', label: 'Other' }
        };

        if (legendContainer.length) {
            legendContainer.empty().show().css('display', 'flex');
            ['agent', 'person', 'place', 'object', 'event', 'concept', 'feeling', 'dream', 'threat', 'money'].forEach(cat => {
                const info = iconMap[cat];
                legendContainer.append(`<div class="mp-legend-item" title="${info.label}" style="display: flex; align-items: center; gap: 6px; font-size: 0.75em; padding: 4px 10px; background: rgba(255,255,255,0.05); border-radius: 20px; border: 1px solid rgba(255,255,255,0.05);">
                    <i class="fa-solid" style="color: ${info.color};">${info.code}</i>
                    <span style="opacity: 0.8;">${info.label}</span>
                </div>`);
            });
        }

        const vis_data = {
            nodes: new vis.DataSet(data.nodes.map(n => {
                let rT = (n.group || 'unknown').toString().toLowerCase();
                // [FIX-NODO-PROTAGONISTA] Il confronto era contro `wingId`, cioè la wing
                // EPISODICA: in modalità Isolata vale "Nome_Cognome_chat_42", che come nodo
                // del grafo non esiste. E anche in modalità Condivisa non bastava, perché
                // il nodo è scritto come compare nel testo ("nome-cognome") mentre la chiave
                // usa l'underscore. Risultato: il protagonista non veniva mai riconosciuto
                // e la sua icona non compariva mai, in nessuna mappa. Ora si confronta la
                // chiave d'identità del personaggio, appiattendo trattini e spazi da
                // entrambe le parti.
                const piatto = (s) => (s || '').toString().toLowerCase().replace(/'/g, '').replace(/[-\s]/g, '_');
                const nID = piatto(n.id);
                const cID = piatto(getCharacterWingId());
                const lbl = (n.label || '').toLowerCase();

                if (nID === cID) rT = 'agent';
                else if (rT === 'unknown' || rT === 'object') {
                    if (lbl.includes('story') || lbl.includes('event')) rT = 'event';
                    else if (lbl.includes('experience') || lbl.includes('memory') || lbl.includes('feeling')) rT = 'feeling';
                    else if (lbl.includes('user') || lbl.includes('subject')) rT = 'person';
                }
                
                const ic = iconMap[rT] || iconMap['unknown'];
                return { 
                    id: n.id, 
                    label: n.label, 
                    shape: 'icon', 
                    icon: { face: ic.face, code: ic.code, size: 40, color: ic.color }, 
                    font: { color: '#eee', size: 13, strokeWidth: 4, strokeColor: 'rgba(0,0,0,0.7)' },
                    shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 10 }
                };
            })),
            edges: new vis.DataSet((data.edges || []).map(e => ({
                ...e, 
                arrows: 'to', 
                color: { color: 'rgba(255,255,255,0.25)', highlight: '#f59e0b' },
                font: { size: 10, color: '#aaa', align: 'top', strokeWidth: 0 }
            })))
        };

        const options = {
            physics: {
                forceAtlas2Based: {
                    gravitationalConstant: -80,
                    centralGravity: 0.005,
                    springLength: 150,
                    springConstant: 0.18,
                },
                maxVelocity: 146,
                solver: 'forceAtlas2Based',
                timestep: 0.35,
                stabilization: { iterations: 150 }
            },
            interaction: {
                hover: true,
                tooltipDelay: 200,
                hideEdgesOnDrag: true
            }
        };

        new vis.Network(container, vis_data, options);
    } catch (e) { 
        console.error('[MemPalace] Graph Error:', e); 
        toastr.error('Failed to render synaptic map.'); 
    }
}

const DEEP_SCAN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minuti: su chat >1000 messaggi il loop è l'unico rischio di blocco

/**
 * Estrazione dei fatti affidata al MODELLO invece che al regex.
 *
 * Il regex ha un tetto, e su prosa narrativa e' basso: misurato su messaggi veri,
 * 57 messaggi di roleplay danno 7 fatti. Non e' un difetto dell'espressione
 * regolare, e' che il roleplay e' dialogo e azione, non frasi dichiarative, e un
 * regex puo' solo riconoscere forme, non capire. Provate anche le varianti col
 * pattern permissivo (27 fatti, ma erano "Esclamazione -> Utente", "Risata -> frase
 * a caso") e con la risoluzione dei pronomi (zero fatti in piu').
 *
 * Lo stesso campione dato al modello locale: 27 fatti da 12 messaggi, con
 * contenuti che il regex non poteva vedere ("Aria was created by the engineers of
 * the first android series"). Costo misurato 3,9 s per messaggio: troppo per girare a
 * ogni turno, giusto per il Deep Scan, che e' gia' un'operazione a richiesta.
 *
 * Si usa generateQuietPrompt di SillyTavern e non una chiamata diretta a Ollama:
 * cosi' funziona con qualunque backend sia configurato, senza sapere quale sia.
 */
/**
 * Manda UNA domanda al modello e restituisce il testo, o null se il backend non parla.
 *
 * Non passa da `generateQuietPrompt()`, e la differenza e' sostanziale. Quella strada
 * passa da `Generate('quiet')`, che monta il prompt INTERO (scheda, cronologia, world
 * info, i blocchi delle estensioni) e ha parecchie uscite che risolvono la promessa
 * VUOTA invece di sollevare un errore: da fuori un'uscita silenziosa e un backend
 * spento sono indistinguibili, ed e' cosi' che MemPalace ha dichiarato morto un
 * llama-server acceso e funzionante.
 *
 * Qui si manda solo l'istruzione, formattata col template instruct scelto dall'utente,
 * attraverso `TextCompletionService`, che e' la via ufficiale di SillyTavern per una
 * completion grezza. Quattro vantaggi, tutti concreti:
 *
 *  - funziona con OGNI backend che ST supporta, llama.cpp e Ollama compresi: il tipo,
 *    l'indirizzo e il modello si leggono dalle impostazioni attive;
 *  - passa dal server di SillyTavern, quindi niente CORS e niente indirizzi da
 *    indovinare dentro il browser;
 *  - il prompt e' di poche centinaia di token invece di ventiquattromila: su un server
 *    con `--no-context-shift` non puo' piu' sfondare il contesto, e su una GPU piccola
 *    l'estrazione smette di essere il lavoro piu' lento della sessione;
 *  - nessuna contaminazione: il modello vede la frase da esaminare e basta, non i
 *    ricordi che MemPalace ha appena iniettato. Prima estraeva fatti dai propri
 *    ricordi e il grafo si autoalimentava, rinforzando gli errori che aveva dentro.
 *
 * Se questa strada non e' disponibile (una versione di ST che non espone il servizio)
 * si ripiega su `generateQuietPrompt()`, che resta il comportamento storico.
 *
 * @returns {Promise<string|null>} il testo, oppure null se il backend non ha parlato.
 */
/**
 * Il nome del modello attivo, per i backend che lo pretendono.
 *
 * SillyTavern supporta quindici tipi di backend testuale e ognuno tiene il proprio
 * modello in un campo suo: `ollama_model`, `vllm_model`, `togetherai_model` e cosi'
 * via. Leggere solo i due o tre che usiamo noi avrebbe funzionato qui e rotto
 * altrove, quindi si guarda il TIPO attivo e si prende il campo giusto, come fa
 * SillyTavern stessa. Chi non richiede un modello (llama.cpp, koboldcpp, ooba)
 * torna undefined, e il campo viene tolto dal payload.
 */
const CAMPO_MODELLO = {
    ollama: 'ollama_model', vllm: 'vllm_model', aphrodite: 'aphrodite_model',
    tabby: 'tabby_model', togetherai: 'togetherai_model', mancer: 'mancer_model',
    infermaticai: 'infermaticai_model', dreamgen: 'dreamgen_model',
    openrouter: 'openrouter_model', featherless: 'featherless_model',
    generic: 'custom_model',
};
function modelloAttivo(imp) {
    if (!imp) return undefined;
    if (imp.type === 'huggingface') return 'tgi';
    return imp[CAMPO_MODELLO[imp.type]] || imp.custom_model || undefined;
}

/**
 * Stampa in console lo STATO di tutto ciò che serve a capire perché il modello tace.
 *
 * Non è un lusso: tre versioni di fila l'avviso diceva soltanto "non risponde", che è
 * una conclusione e non un dato, e per tre volte ha portato a curare la cosa
 * sbagliata (una volta il server era acceso e verificato). Qui si stampano i fatti.
 */
function stampaStatoModello(quando) {
    try {
        const ctx = getContext();
        const imp = ctx?.textCompletionSettings || {};
        const instruct = ctx?.powerUserSettings?.instruct;
        const righe = {
            'quando': quando,
            'API principale': ctx?.mainApi,
            'stato connessione': ctx?.onlineStatus,
            'tipo backend': imp.type,
            'indirizzo': (typeof ctx?.getTextGenServer === 'function' && imp.type)
                ? ctx.getTextGenServer(imp.type) : '(sconosciuto)',
            'modello': modelloAttivo(imp) || '(non richiesto)',
            'template instruct': instruct?.enabled ? instruct?.name : '(disattivato)',
            'via diretta esposta': typeof ctx?.TextCompletionService?.processRequest === 'function',
            'generateQuietPrompt': typeof ctx?.generateQuietPrompt === 'function',
            'via usata': _ultimaEstrazione.via || '(nessuna)',
            'errore': _ultimaEstrazione.errore
                ? (_ultimaEstrazione.errore.message || String(_ultimaEstrazione.errore))
                : '(nessuno: risposta vuota senza eccezione)',
        };
        console.error('[MemPalace] STATO del backend di generazione');
        for (const [k, v] of Object.entries(righe)) console.error(`  ${k.padEnd(22)} ${v}`);
        if (_ultimaEstrazione.errore) console.error('  oggetto errore:', _ultimaEstrazione.errore);
        console.error('  Per una prova completa: mempalaceDiagnosiModello()');
    } catch (e) {
        console.error('[MemPalace] Non sono riuscito nemmeno a leggere lo stato:', e);
    }
}

async function chiediAlModello(istruzione) {
    const ctx = getContext();
    _ultimaEstrazione.via = null;

    const servizio = ctx?.TextCompletionService;
    if (servizio && typeof servizio.processRequest === 'function') {
        try {
            const imp = ctx.textCompletionSettings || {};
            const tipo = imp.type;
            // Il modello serve solo ad alcuni backend (Ollama lo pretende, llama.cpp no).
            // Si prende quello gia' scelto dall'utente: nessun elenco da tenere
            // aggiornato, e se il campo non esiste resta undefined e viene tolto dal
            // payload da createRequestData().
            const modello = modelloAttivo(imp);
            const instruct = ctx.powerUserSettings?.instruct;
            const esito = await servizio.processRequest(
                {
                    prompt: [{ role: 'system', content: istruzione }],
                    max_tokens: 220,
                    // Bassa di proposito: qui non si racconta, si compila un elenco.
                    // La temperatura del preset narrativo fa inventare relazioni.
                    temperature: 0.2,
                    stream: false,
                    api_type: tipo,
                    api_server: (tipo && typeof ctx.getTextGenServer === 'function')
                        ? ctx.getTextGenServer(tipo) : undefined,
                    model: modello,
                },
                {
                    instructName: instruct?.enabled ? instruct?.name : undefined,
                    // Le sequenze VIVE, non quelle del file che porta quel nome.
                    //
                    // `processRequest` cerca il preset per nome e usa il contenuto del
                    // file. Ma il nome puo' non corrispondere piu' a cio' che e' attivo:
                    // in questa installazione `instruct.name` diceva "Mistral V3-Tekken"
                    // mentre le sequenze in memoria erano gia' quelle di Gemma 4
                    // (`<|turn>user`, `<|turn>model`, col canale del pensiero
                    // pre-riempito). Passandole qui, il template usato e' quello che
                    // l'utente vede davvero nel pannello, comunque si chiami.
                    instructSettings: instruct || undefined,
                },
                true,
            );
            const testo = typeof esito === 'string' ? esito : (esito?.content ?? '');
            if (String(testo || '').trim()) {
                _ultimaEstrazione.via = 'diretta';
                return String(testo);
            }
            console.warn('[MemPalace] Via diretta: risposta vuota, provo generateQuietPrompt.');
        } catch (e) {
            console.warn('[MemPalace] Via diretta non riuscita, provo generateQuietPrompt:', e);
            _ultimaEstrazione.errore = e;
        }
    }

    // Ripiego storico.
    if (typeof ctx?.generateQuietPrompt !== 'function') return null;
    try {
        _estrazioneAlModello = true;   // esclude i blocchi di MemPalace da QUESTO prompt
        const r = await ctx.generateQuietPrompt({
            quietPrompt: istruzione,
            responseLength: 220,
            skipWIAN: true,
            removeReasoning: true,
        });
        if (String(r || '').trim()) {
            _ultimaEstrazione.via = 'generateQuietPrompt';
            _ultimaEstrazione.errore = null;
            return String(r);
        }
        return null;
    } catch (e) {
        _ultimaEstrazione.errore = e;
        return null;
    } finally {
        // Sempre, anche se la richiesta esplode: se restasse alzato, il blocco RAG e il
        // Nucleo sparirebbero da tutte le generazioni successive e il personaggio
        // diventerebbe smemorato senza che niente lo spieghi.
        _estrazioneAlModello = false;
    }
}

/**
 * Legge le triple "soggetto | relazione | oggetto" da una risposta del modello.
 *
 * Vive da sola perche' la usano in due: l'estrazione dei fatti da un messaggio e il
 * consolidamento, che dai pensieri ricava cosa e' cambiato nel personaggio. Erano la
 * stessa lettura scritta due volte, ed e' il tipo di duplicato che si scopre sei mesi
 * dopo, quando una delle due copie viene corretta e l'altra no.
 */
function leggiTriple(risposta) {
    const fatti = [];
    // Ripuliture della FORMA, non del contenuto, tarate su come rispondono davvero i
    // modelli instruct: recinti di codice, blocchi di pensiero, grassetto attorno ai
    // campi, e i marcatori di canale di Gemma 4, che il template "NoThink" pre-riempie
    // ma che il modello a volte riscrive da se' e che restano INCOLLATI alla prima
    // tripla. Misurato: `<channel|>Ada Lovelace | is | mathematician` si spezza in
    // quattro campi e quella riga andava persa per intera, quindi si perdeva la prima
    // tripla di ogni estrazione, in silenzio.
    const ripulita = String(risposta)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\|channel>[^\n<]*/gi, '')
        .replace(/<channel\|>/gi, '')
        .replace(/^\s*```[a-z]*\s*$/gim, '')
        .replace(/\*\*/g, '');
    for (let riga of ripulita.split('\n')) {
        riga = riga.trim().replace(/^[-*•\d.\s]+/, '');
        if (!riga || /^none\b/i.test(riga)) continue;
        // I bordi vuoti si tolgono prima di contare i campi: parecchi modelli rispondono
        // in forma di tabella (`| Aria | is | Android |`), e con lo split secco
        // quella riga vale cinque pezzi e veniva buttata via intera. Si scartano solo le
        // caselle vuote AI BORDI: una vuota in mezzo e' un campo che manca davvero.
        const p = riga.split('|').map(x => x.trim());
        while (p.length && p[0] === '') p.shift();
        while (p.length && p[p.length - 1] === '') p.pop();
        if (p.length !== 3 || !p[0] || !p[1] || !p[2]) continue;
        const [s, rel, o] = p;
        // Riga d'intestazione della tabella: la si riconosce dai trattini di separazione.
        if (/^:?-{2,}:?$/.test(s) || /^:?-{2,}:?$/.test(rel)) continue;
        // Scarti misurati sull'output vero del modello: "Utente | is a human |
        // Utente" (soggetto e oggetto uguali) e relazioni che si sono mangiate
        // l'oggetto ("is a Android"). Meglio perdere un fatto che salvarne uno storto.
        if (s.length < 2 || s.length > 40 || o.length < 2 || o.length > 60) continue;
        if (s.toLowerCase() === o.toLowerCase()) continue;
        if (rel.split(/\s+/).length > 3) continue;
        if (/^(subject|relation|object|none)$/i.test(s)) continue;
        fatti.push({ subject: s, predicate: rel.toLowerCase().replace(/\s+/g, '_'), object: o });
    }
    return fatti;
}
async function estraiFattiConModello(testo, nomePersonaggio) {
    const istruzione =
        'Extract lasting facts from this roleplay message as triples.\n' +
        'Only facts that will still be true tomorrow: identity, relationships, places, ' +
        'possessions, history, stable fears or wishes. Ignore gestures, greetings and small talk.\n' +
        'Answer ONLY with lines "subject | relation | object". Use names, never pronouns. ' +
        'The relation must be 1-3 words. If there is nothing lasting, answer NONE.\n\n' +
        'MESSAGE:\n' + String(testo).substring(0, 1500);

    _ultimaEstrazione.raggiungibile = false;
    _ultimaEstrazione.grezza = '';
    _ultimaEstrazione.errore = null;

    const risposta = await chiediAlModello(istruzione);
    if (risposta === null) {
        // Il guasto si racconta da solo. Le tre versioni precedenti di questo avviso
        // dicevano soltanto "non risponde", che e' una conclusione, non un dato: per
        // tre giri di seguito ha portato a diagnosticare la cosa sbagliata. Qui si
        // stampa lo STATO, e la conclusione la si trae dopo averlo letto.
        stampaStatoModello('estrazione fallita');
        if (!window._mpModelloMutoAvvisato) {
            window._mpModelloMutoAvvisato = true;
            const dettaglio = _ultimaEstrazione.errore
                ? String(_ultimaEstrazione.errore.message || _ultimaEstrazione.errore).slice(0, 120)
                : 'ha risposto vuoto, sia per via diretta sia col ripiego';
            toastr.error(`Estrazione col modello ferma: ${dettaglio}. In console c'e' lo stato completo (cerca [MemPalace] STATO).`, 'MemPalace', { timeOut: 20000 });
        }
        return [];
    }
    // Da qui in poi il backend HA parlato: qualunque cosa succeda al lettore di triple,
    // non e' un problema di raggiungibilita' e non va curato spegnendo il modello.
    _ultimaEstrazione.raggiungibile = true;
    _ultimaEstrazione.grezza = risposta;

    return leggiTriple(risposta);
}

/**
 * Il modello risponde? Non "estrae bene": RISPONDE.
 *
 * La prima versione di questa prova contava le triple e, se erano zero, dichiarava
 * il backend morto. Sbagliato due volte: un llama-server acceso e funzionante veniva
 * dichiarato spento, e il lavoro ripiegava sul regex che sulla lore non vede niente.
 * "Zero triple su una frase di prova" e "nessuna risposta" sono guasti diversi:
 *  - nessuna risposta  → backend spento o non collegato: si ripiega e lo si dice.
 *  - risposta senza triple → il modello c'è. Sul materiale vero quasi sempre le
 *    scrive, e comunque non è spegnendolo che si migliora la resa. Si va avanti,
 *    lasciando in console la risposta grezza per poterla guardare.
 *
 * @returns {Promise<boolean>} true se si può usare il modello.
 */
async function modelloRisponde(nomePersonaggio) {
    const ctx = getContext();
    if (typeof ctx?.generateQuietPrompt !== 'function') return false;
    const fatti = await estraiFattiConModello(
        'Ada Lovelace is a mathematician. Ada Lovelace lives in London.', nomePersonaggio);
    if (_ultimaEstrazione.errore) {
        console.warn('[MemPalace] Prova del modello: il backend non ha risposto.', _ultimaEstrazione.errore);
        return false;
    }
    if (!_ultimaEstrazione.raggiungibile) {
        console.warn('[MemPalace] Prova del modello: risposta vuota dal backend.');
        return false;
    }
    if (fatti.length === 0) {
        console.warn('[MemPalace] Prova del modello: il backend risponde ma sulla frase di prova ' +
            'non ha scritto triple. Si procede lo stesso. Risposta grezza:\n' + _ultimaEstrazione.grezza);
    } else {
        console.log(`[MemPalace] Prova del modello: risponde, ${fatti.length} triple sulla frase di prova.`);
    }
    return true;
}

/**
 * Prova il modello una volta per sessione e lascia l'esito in archivio.
 *
 * Serve a rendere diagnosticabile da fuori un guasto che finora si vedeva solo nella
 * console del browser. L'esito va nella wing di servizio `diagnostica`, stanza
 * `modello`: nessun personaggio viene toccato e non ci finisce dentro testo di gioco,
 * solo la configurazione attiva e cosa ha risposto il backend su una frase di prova.
 *
 * Gira solo se l'estrazione col modello e' accesa: se e' spenta non c'e' niente da
 * diagnosticare, ed e' una scelta legittima dell'utente.
 */
async function provaModelloUnaVolta() {
    if (window._mpProvaModelloFatta) return;
    if (localStorage.getItem('mempalace_llm_extract') !== 'true') return;
    window._mpProvaModelloFatta = true;

    // Un respiro: all'apertura della chat SillyTavern sta ancora collegandosi all'API,
    // e una prova lanciata troppo presto misurerebbe l'avvio, non il backend.
    await new Promise(r => setTimeout(r, 8000));

    try {
        const ctx = getContext();
        const imp = ctx?.textCompletionSettings || {};
        const instruct = ctx?.powerUserSettings?.instruct;
        const t0 = Date.now();
        const risponde = await modelloRisponde('Prova');
        const ms = Date.now() - t0;

        const righe = [
            `esito: ${risponde ? 'IL MODELLO RISPONDE' : 'NESSUNA RISPOSTA'}`,
            `quando: ${new Date().toISOString()}`,
            `durata: ${ms} ms`,
            `via usata: ${_ultimaEstrazione.via || 'nessuna'}`,
            `API principale: ${ctx?.mainApi}`,
            `stato connessione: ${ctx?.onlineStatus}`,
            `tipo backend: ${imp.type}`,
            `indirizzo: ${(typeof ctx?.getTextGenServer === 'function' && imp.type) ? ctx.getTextGenServer(imp.type) : '(sconosciuto)'}`,
            `modello: ${modelloAttivo(imp) || '(non richiesto)'}`,
            `template instruct: ${instruct?.enabled ? instruct?.name : '(disattivato)'}`,
            `via diretta esposta: ${typeof ctx?.TextCompletionService?.processRequest === 'function'}`,
            `generateQuietPrompt: ${typeof ctx?.generateQuietPrompt === 'function'}`,
            `errore: ${_ultimaEstrazione.errore ? (_ultimaEstrazione.errore.message || String(_ultimaEstrazione.errore)) : '(nessuno)'}`,
            `risposta grezza: ${JSON.stringify(String(_ultimaEstrazione.grezza || '').slice(0, 300))}`,
            `versione estensione: ${_MP_VERSION}`,
        ];

        // Si tiene solo l'ultima prova: e' una fotografia dello stato adesso, non uno storico.
        const vecchie = await callMemPalace('mempalace_list_drawers', { wing: 'diagnostica', room: 'modello', limit: 20 }).catch(() => null);
        for (const d of (vecchie?.drawers || [])) {
            await callMemPalace('mempalace_delete_drawer', { drawer_id: d.id }).catch(() => null);
        }
        await callMemPalace('mempalace_add_drawer', {
            wing: 'diagnostica', room: 'modello', content: righe.join('\n'),
            source_file: 'prova-automatica', dup_threshold: 1.01,
        }).catch(() => null);
        console.log(`[MemPalace] Prova del modello scritta in diagnostica/modello: ${risponde ? 'risponde' : 'non risponde'}.`);
    } catch (e) {
        console.warn('[MemPalace] Prova automatica del modello non riuscita:', e);
    }
}

/** Il motivo dell'ultimo fallimento, in una riga, da mettere nel messaggio a schermo. */
function motivoModelloMuto() {
    if (_ultimaEstrazione.errore) {
        return `errore: ${_ultimaEstrazione.errore.message || _ultimaEstrazione.errore}`;
    }
    return 'ha risposto vuoto (due volte, anche senza opzioni)';
}

/**
 * Diagnosi da console: `mempalaceDiagnosiModello()`.
 *
 * Serve quando l'estrazione non parte e il motivo non si vede da fuori. Prova la
 * stessa domanda in tre modi diversi e stampa cosa torna da ciascuno, così si
 * distingue un backend spento da un'opzione che svuota la risposta.
 */
window.mempalaceDiagnosiModello = async function () {
    const ctx = getContext();
    const imp = ctx?.textCompletionSettings || {};
    const instruct = ctx?.powerUserSettings?.instruct;
    console.log('%c[MemPalace] Diagnosi del modello', 'font-weight:bold');
    console.log('  API principale ........ ', ctx?.mainApi);
    console.log('  stato connessione ..... ', ctx?.onlineStatus);
    console.log('  tipo backend .......... ', imp.type);
    console.log('  indirizzo ............. ', (typeof ctx?.getTextGenServer === 'function' && imp.type)
        ? ctx.getTextGenServer(imp.type) : '(sconosciuto)');
    console.log('  modello ............... ', modelloAttivo(imp) || '(non richiesto da questo backend)');
    console.log('  template instruct ..... ', instruct?.enabled ? instruct?.name : '(disattivato)');
    console.log('  via diretta disponibile:', typeof ctx?.TextCompletionService?.processRequest === 'function');
    console.log('  generateQuietPrompt ...:', typeof ctx?.generateQuietPrompt === 'function');

    const domanda = 'Answer with exactly this line and nothing else: PONG';

    // 1. La via che MemPalace usa davvero.
    if (typeof ctx?.TextCompletionService?.processRequest === 'function') {
        try {
            const t0 = Date.now();
            const esito = await ctx.TextCompletionService.processRequest(
                {
                    prompt: [{ role: 'system', content: domanda }],
                    max_tokens: 40, temperature: 0.2, stream: false,
                    api_type: imp.type,
                    api_server: (typeof ctx.getTextGenServer === 'function' && imp.type)
                        ? ctx.getTextGenServer(imp.type) : undefined,
                    model: modelloAttivo(imp),
                },
                { instructName: instruct?.enabled ? instruct?.name : undefined },
                true,
            );
            const testo = typeof esito === 'string' ? esito : (esito?.content ?? '');
            console.log(`  [via diretta] ${Date.now() - t0} ms ->`, JSON.stringify(String(testo).slice(0, 200)));
        } catch (e) {
            console.log('  [via diretta] ECCEZIONE:', e?.message || e, e);
        }
    }

    // 2. Il ripiego storico, per confronto.
    if (typeof ctx?.generateQuietPrompt === 'function') {
        for (const [nome, opzioni] of [
            ['ripiego nudo', { quietPrompt: domanda }],
            ['ripiego come lo usa MemPalace', { quietPrompt: domanda, responseLength: 220, skipWIAN: true, removeReasoning: true }],
        ]) {
            try {
                _estrazioneAlModello = true;
                const t0 = Date.now();
                const r = await ctx.generateQuietPrompt(opzioni);
                console.log(`  [${nome}] ${Date.now() - t0} ms ->`, JSON.stringify(String(r ?? '').slice(0, 200)));
            } catch (e) {
                console.log(`  [${nome}] ECCEZIONE:`, e?.message || e);
            } finally {
                _estrazioneAlModello = false;
            }
        }
    }

    // 3. L'estrazione vera, quella che conta.
    const fatti = await estraiFattiConModello(
        'Ada Lovelace is a mathematician. Ada Lovelace lives in London.', 'Prova');
    console.log(`  [estrazione vera] via: ${_ultimaEstrazione.via || 'nessuna'} | triple: ${fatti.length}`, fatti);
    if (_ultimaEstrazione.grezza) console.log('  risposta grezza:', JSON.stringify(_ultimaEstrazione.grezza.slice(0, 400)));

    console.log('  Se NIENTE risponde: SillyTavern non e collegata all API (pulsante Connect nel pannello API),');
    console.log('  oppure il server del modello e spento.');
    return { via: _ultimaEstrazione.via, triple: fatti.length };
};

// ─────────────────────────────────────────────────────────────────────────────
// TAPPA 4: gli assi di attenzione e la zona del pensiero
//
// E' la parte che si vede. Fin qui i ricordi pesavano tutti uguale nel termine
// "salienza" (0.5 fisso), quindi due personaggi davanti alla stessa scena
// ricordavano le stesse cose. Da qui in poi no.
//
// COME: una volta per personaggio si ricavano dalla sua scheda cinque o sei ASSI DI
// ATTENZIONE, cioe' le cose a cui quel personaggio reagisce (non tratti generici:
// cio' che nota). Poi, dopo ogni turno, il modello guarda cosa e' appena successo
// **attraverso quegli assi** e restituisce due cose insieme:
//   - quanto l'ha colpito, da 0 a 1, e su quale asse   -> entra nel punteggio
//   - due o tre righe in prima persona                 -> diventano un ricordo suo
//
// UNA SOLA CHIAMATA per entrambe, e non e' avarizia: `llama-server` gira senza
// `-np`, cioe' serve una richiesta per volta, e ogni chiamata di servizio si alterna
// col prompt di gioco invalidando la cache. Due chiamate per turno raddoppierebbero
// il conto piu' caro della sessione. Il pensiero contiene gia' il giudizio: chiederli
// insieme e' anche piu' naturale che chiederli separati.
// ─────────────────────────────────────────────────────────────────────────────

const ATTESA_RIFLESSIONE_MS = 3000;   // il modello ha appena finito: gli si lascia respiro
let _timerRiflessione = null;
let _riflessioneInCorso = false;

/**
 * Gli assi di attenzione di un personaggio, ricavati una volta sola dalla sua scheda.
 *
 * Restano modificabili a mano in `localStorage`: sono un'interpretazione, e se
 * l'utente conosce il suo personaggio meglio del modello ha ragione lui.
 */
async function assiDelPersonaggio(charKey) {
    if (!charKey) return [];
    const chiave = `mempalace_assi_${charKey}`;
    try {
        const salvati = JSON.parse(localStorage.getItem(chiave) || 'null');
        if (Array.isArray(salvati) && salvati.length) return salvati;
    } catch (_) { /* illeggibile: si rifanno */ }

    const ctx = getContext();
    const scheda = window.characters?.[ctx?.characterId];
    if (!scheda) return [];
    // Si guardano i campi che descrivono chi e', non come scrive: `mes_example` e'
    // un campione di stile e riempirebbe gli assi di modi di dire.
    const testo = [scheda.description, scheda.personality, scheda.scenario]
        .filter(Boolean).join('\n').slice(0, 2500);
    if (!testo.trim()) return [];

    const istruzione =
        'Read this character sheet and name the things this character NOTICES and REACTS TO.\n' +
        'Not personality traits: the kinds of events that leave a mark on them.\n' +
        'Answer ONLY with 5 to 7 short labels, one or two words each, separated by commas. ' +
        'Lowercase. No explanation.\n\n' +
        'CHARACTER SHEET:\n' + testo;

    const risposta = await chiediAlModello(istruzione);
    if (!risposta) return [];
    const assi = String(risposta)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\|channel>[^\n<]*/gi, '').replace(/<channel\|>/gi, '')
        .split('\n').filter(r => r.includes(',')).slice(-1)[0] || String(risposta)
        .split('\n').pop();
    const elenco = String(assi).split(',')
        .map(x => x.trim().toLowerCase().replace(/^[-*\d.\s]+/, '').replace(/[.:;]+$/, ''))
        .filter(x => x.length >= 3 && x.length <= 28 && x.split(/\s+/).length <= 3)
        .slice(0, 7);
    if (elenco.length >= 3) {
        localStorage.setItem(chiave, JSON.stringify(elenco));
        console.log(`[MemPalace] Assi di attenzione di ${charKey}: ${elenco.join(', ')}`);
        return elenco;
    }
    console.warn('[MemPalace] Assi non ricavati dalla scheda, risposta inattesa:', String(risposta).slice(0, 200));
    return [];
}

/**
 * Dopo il turno: quanto ha colpito il personaggio, e cosa gli resta in testa.
 *
 * Il pensiero e' scritto in prima persona e finisce nella stanza `pensiero` della
 * wing d'identita', con emivita di tre giorni. Serve a tre cose: dare continuita'
 * interiore fra un turno e l'altro, permettere a una reazione di maturare invece di
 * scattare subito, e lasciare al consolidamento (tappa 5) la traccia di cio' che il
 * personaggio non riesce a lasciare andare.
 */
async function rifletti(wingId, charKey, idsUltimoRicordo) {
    // La riflessione segue il turno, quindi NON usa il cancello di inattivita': e'
    // il suo momento, subito dopo la risposta. Basta che non si accavalli.
    if (_riflessioneInCorso || _generazioneInCorso || _isSyncing) return;
    if (localStorage.getItem('mempalace_llm_extract') !== 'true') return;
    const ctx = getContext();
    if (typeof ctx?.generateQuietPrompt !== 'function' && !ctx?.TextCompletionService) return;

    _riflessioneInCorso = true;
    try {
        const assi = await assiDelPersonaggio(charKey);
        if (_generazioneInCorso) return;   // l'utente ha ripreso a giocare: il modello serve a lui

        const messaggi = (ctx.chat || []).filter(m => !m.is_system && m.mes).slice(-2);
        if (messaggi.length === 0) return;
        const scena = messaggi.map(m => `${m.is_user ? 'THEM' : 'YOU'}: ${String(m.mes).slice(0, 700)}`).join('\n');
        const nome = (charKey || '').replace(/_/g, ' ');

        // [CONTINUITA'] Il pensiero di oggi legge quelli di ieri.
        //
        // Senza questo ogni turno ripartiva da zero: cinque reazioni simili scritte in
        // isolamento invece di una preoccupazione che si trascina e matura. E' la
        // differenza fra un personaggio che rimugina e uno che ha cinque scatti
        // scollegati. Bastano gli ultimi tre: piu' indietro ci pensa il consolidamento.
        const precedenti = await ultimiPensieri(charKey, PENSIERI_NEL_PROMPT);
        const filo = precedenti.length
            ? 'What you have been turning over lately, newest first:' + String.fromCharCode(10)
              + precedenti.map(x => '- ' + String(x.content).slice(0, 220)).join(String.fromCharCode(10))
              + String.fromCharCode(10, 10)
            : '';

        const istruzione =
            `You are ${nome}. This just happened:\n\n${scena}\n\n` + filo +
            (assi.length ? `The things you notice: ${assi.join(', ')}.\n\n` : '') +
            'Answer in exactly two lines, nothing else:\n' +
            `IMPRESSION: <a number 0.0 to 1.0, how much this stayed with you>${assi.length ? ' <one label from the list above>' : ''}\n` +
            'THOUGHT: <two or three sentences, first person, what stayed with you and what you expect now. ' +
            'Not a summary: what you did not say out loud.>';

        const risposta = await chiediAlModello(istruzione);
        if (!risposta) return;

        const pulita = String(risposta)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<\|channel>[^\n<]*/gi, '').replace(/<channel\|>/gi, '')
            .replace(/\*\*/g, '');

        // L'asse si ferma a fine riga. Con `\s` nella classe la cattura scavalcava
        // l'a capo e si portava dentro la parola "THOUGHT" della riga dopo: misurato
        // sull'output vero, l'asse salvato diventava "vulnerability" piu' la parola
        // della riga successiva. Spazio semplice e tabulazione, non `\s`.
        const mImp = pulita.match(/IMPRESSION\s*:?\s*([01](?:[.,]\d+)?)[^\S\n]*([a-zà-ÿ][a-zà-ÿ '-]{2,27})?/i);
        const mPen = pulita.match(/THOUGHT\s*:?\s*([\s\S]+)/i);

        if (mImp) {
            const valore = parseFloat(String(mImp[1]).replace(',', '.'));
            const asse = (mImp[2] || '').trim();
            registraSalienza(idsUltimoRicordo, valore, asse);
            salvaSalienze();
            console.log(`[MemPalace] Impressione: ${valore}${asse ? ' (' + asse + ')' : ''} su ${idsUltimoRicordo?.length || 0} pezzi`);
        }

        if (mPen) {
            // Si tiene solo la parte discorsiva, e si taglia: un pensiero e' breve per
            // definizione, e uno lungo mangerebbe il budget del recupero.
            const pensiero = mPen[1].split(/\n\s*\n/)[0].trim().slice(0, 600);
            if (pensiero.length >= 20) {
                await scriviRicordo({
                    wing: getCharacterWingId() || wingId,
                    room: 'pensiero',
                    content: pensiero,
                    source_file: `pensiero:${ctx.chatId ?? 'senza-id'}`,
                });
                console.log(`[MemPalace] Pensiero archiviato (${pensiero.length} car.)`);
            }
        }
    } catch (e) {
        console.warn('[MemPalace] Riflessione non riuscita (non critica):', e);
    } finally {
        _riflessioneInCorso = false;
    }
}

/** Programma la riflessione dopo il turno, lasciando respirare il modello. */
function programmaRiflessione(wingId, charKey, ids) {
    if (_timerRiflessione) clearTimeout(_timerRiflessione);
    _timerRiflessione = setTimeout(() => {
        _timerRiflessione = null;
        rifletti(wingId, charKey, ids).catch(() => {});
    }, ATTESA_RIFLESSIONE_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// TAPPA 5: il consolidamento, cioe' il punto in cui il personaggio cambia
//
// Fin qui la zona del pensiero era un blocco di appunti: dopo ogni turno il
// personaggio ci deposita una reazione, e in tre giorni quella reazione sbiadisce.
// Mancavano le due cose che trasformano un deposito in una evoluzione:
//
//   1. CONTINUITA'. Il pensiero di oggi deve poter leggere quelli di ieri, se no
//      ogni turno riparte da zero e nessuna preoccupazione matura. Una reazione che
//      si trascina per cinque turni e' un personaggio che ci sta rimuginando; cinque
//      reazioni identiche scritte in isolamento sono cinque scatti scollegati.
//
//   2. PROMOZIONE. Cio' che TORNA nei pensieri e' per definizione cio' che il
//      personaggio non riesce a lasciare andare. Se resta nella stanza `pensiero`
//      scade in tre giorni come tutto il resto; se diventa un fatto del grafo entra
//      fra le cose che il personaggio sa di se' e non scade piu'.
//
// La seconda e' il luogo dell'evoluzione: e' li' che una cosa successa smette di
// essere un episodio e diventa parte di chi e'.
// ─────────────────────────────────────────────────────────────────────────────

const CONSOLIDA_OGNI = 20;        // turni fra un consolidamento e l'altro
const PENSIERI_NEL_PROMPT = 3;    // quanti pensieri recenti legge la riflessione
const GIORNI_TENUTA_PENSIERI = 14; // oltre questo un pensiero non promosso si toglie
let _turniDaConsolidamento = 0;
let _consolidamentoInCorso = false;

/**
 * Gli ultimi pensieri del personaggio, dal piu' recente.
 *
 * Si leggono dalla stanza `pensiero` della wing d'identita', non dalla ricerca
 * semantica: qui non serve cio' che somiglia al momento, serve cio' che il
 * personaggio ha pensato per ultimo, in ordine di tempo.
 */
async function ultimiPensieri(charKey, quanti) {
    if (!charKey) return [];
    const r = await callMemPalace('mempalace_list_drawers', {
        wing: charKey, room: 'pensiero', limit: 60,
    }).catch(() => null);
    const elenco = (r?.drawers || [])
        .filter(d => d.content)
        .sort((a, b) => String(b.filed_at || '').localeCompare(String(a.filed_at || '')));
    return elenco.slice(0, quanti);
}

/**
 * Il consolidamento: cosa e' cambiato nel personaggio.
 *
 * Guarda i pensieri recenti e chiede cosa di quello sia diventato vero DI LUI, non
 * di quel momento. Quello che esce entra nel grafo come fatto duraturo, marcato
 * `consolidamento` cosi' si distingue sempre da cio' che e' stato estratto da una
 * scena, e resta quindi fuori dalla Timeline, che racconta eventi e non caratteri.
 */
async function consolida(wingId, charKey) {
    // Il consolidamento invece puo' aspettare: se l'utente sta giocando si rimanda al
    // prossimo giro di venti turni, che tanto arriva.
    if (_consolidamentoInCorso || _isSyncing || tavoloOccupato()) return;
    if (localStorage.getItem('mempalace_llm_extract') !== 'true') return;
    _consolidamentoInCorso = true;
    try {
        const pensieri = await ultimiPensieri(charKey, 12);
        if (pensieri.length < 4) return;   // troppo poco materiale per dire che qualcosa e' cambiato

        const nome = (charKey || '').replace(/_/g, ' ');
        const elenco = pensieri.map((p, i) => `${i + 1}. ${String(p.content).slice(0, 300)}`).join('\n');
        const istruzione =
            `These are ${nome}'s recent private thoughts, newest first:\n\n${elenco}\n\n` +
            `Look for what KEEPS COMING BACK. Not what happened: what has become true of ${nome} because of it.\n` +
            'Answer ONLY with lines "subject | relation | object", at most three, about ' +
            `${nome} themselves. Lasting changes only: a new fear, a new trust, a decision made, ` +
            'a belief that shifted. If nothing recurs, answer NONE.';

        const risposta = await chiediAlModello(istruzione);
        if (!risposta) return;

        const fatti = leggiTriple(risposta);
        let entrati = 0;
        for (const f of fatti.slice(0, 3)) {
            const r = await callMemPalace('mempalace_kg_add', {
                subject: f.subject, predicate: f.predicate, object: f.object,
                wing: charKey || wingId,
                // Il marcatore distingue cio' che il personaggio e' DIVENTATO da cio' che
                // ha semplicemente vissuto. La Timeline li esclude leggendo questo campo:
                // il filtro sta nel frontend, perche' il backend conosce solo i marcatori
                // della lore e non questo, nato dopo.
                source_file: 'consolidamento',
            }).catch(() => null);
            if (r && r.success) entrati++;
        }
        if (entrati > 0) {
            console.log(`[MemPalace] Consolidamento: ${entrati} cambiamenti duraturi da ${pensieri.length} pensieri.`);
            refreshMemPalaceStats?.();
        }

        // Potatura: i pensieri vecchi che non hanno prodotto niente si tolgono. Non e'
        // pulizia per far spazio, e' il punto: cio' che non si e' consolidato in due
        // settimane non era una trasformazione, era uno stato d'animo di quel giorno.
        const limite = Date.now() - GIORNI_TENUTA_PENSIERI * 86400000;
        const tutti = await callMemPalace('mempalace_list_drawers', {
            wing: charKey, room: 'pensiero', limit: 200,
        }).catch(() => null);
        let tolti = 0;
        for (const d of (tutti?.drawers || [])) {
            const quando = Date.parse(d.filed_at || '');
            if (!Number.isNaN(quando) && quando < limite) {
                await callMemPalace('mempalace_delete_drawer', { drawer_id: d.id }).catch(() => null);
                tolti++;
            }
        }
        if (tolti > 0) console.log(`[MemPalace] Consolidamento: ${tolti} pensieri vecchi lasciati andare.`);
    } catch (e) {
        console.warn('[MemPalace] Consolidamento non riuscito (non critico):', e);
    } finally {
        _consolidamentoInCorso = false;
    }
}

/** Conta i turni e lancia il consolidamento quando e' ora. */
function forseConsolida(wingId, charKey) {
    _turniDaConsolidamento++;
    if (_turniDaConsolidamento < CONSOLIDA_OGNI) return;
    _turniDaConsolidamento = 0;
    // Dopo la riflessione, non insieme: due chiamate al modello nello stesso momento
    // su un server a slot singolo si mettono in coda e il turno dopo ne paga il conto.
    setTimeout(() => { consolida(wingId, charKey).catch(() => {}); }, 12000);
}

// ─────────────────────────────────────────────────────────────────────────────
// LA SCHEDA DEL PERSONAGGIO IN MEMORIA
//
// Segnalazione dell'utente: «non colgo quello che c'e' scritto nella Descrizione».
// La Descrizione nel prompt c'e', la mette SillyTavern (il template di contesto
// contiene `{{description}}`, verificato). Il problema e' un altro, ed e' di scala:
//
//   Personaggio A  descrizione 16.089 caratteri    Personaggio B   8.742
//   Personaggio C              3.658               Personaggio D   2.473
//
// Sedicimila caratteri sono circa quattromila token piazzati in cima a un contesto
// da ventiquattromila, e un dettaglio preciso e' una riga dentro quel muro. Un
// modello con quattro miliardi di parametri attivi ci passa sopra.
//
// E finora MemPalace la scheda NON la conosceva: veniva letta in un punto solo, per
// ricavare gli assi di attenzione, e non finiva ne' in archivio ne' nel grafo.
// Quindi il recupero non poteva riportarne a galla il pezzo giusto quando serviva:
// l'unica copia era quella in cima al prompt, sempre uguale, sempre passiva.
//
// Mettendola in archivio a pezzi, quel dettaglio torna in superficie **quando
// c'entra**, accanto ai ricordi, con lo stesso punteggio degli altri.
//
// `mes_example` resta fuori di proposito: e' un campione di STILE, e un modello che
// se lo ritrova fra i ricordi impara a scrivere cosi'. Quattro passate di taratura
// del sanitizzatore sono nate da quel problema.
// ─────────────────────────────────────────────────────────────────────────────

const STANZA_SCHEDA = 'scheda';

/** Impronta del testo, per accorgersi se la scheda e' cambiata senza riscriverla ogni volta. */
function improntaTesto(t) {
    let h = 5381;
    const s = String(t || '');
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + '_' + s.length;
}

/**
 * Porta in archivio descrizione, personalita' e scenario del personaggio.
 *
 * Va nella wing d'IDENTITA' e in una stanza sua: e' cio' che il personaggio e', non
 * cio' che gli e' successo. Non decade (vedi EMIVITA) e viene riscritta solo se la
 * scheda cambia davvero, riconoscendolo dall'impronta.
 */
async function ingeriScheda(charKey) {
    if (!charKey) return;
    try {
        const ctx = getContext();
        const scheda = window.characters?.[ctx?.characterId];
        if (!scheda) return;

        // Quali campi entrano, e perche' gli altri no. Il criterio e' uno solo:
        // il campo dice CHI E' il personaggio, o dice al modello COME COMPORTARSI?
        //
        //   description        SI   e' il cuore del personaggio
        //   personality        SI   il sommario del carattere
        //   scenario           SI   la situazione in cui vive
        //   depth_prompt       SI   la Nota del Personaggio: contenuto suo, non istruzioni.
        //                           Un personaggio ne aveva 2042 caratteri, buttarli era uno spreco.
        //
        //   mes_example        NO   e' un campione di STILE. Un modello che se lo ritrova
        //                           fra i ricordi impara a scrivere cosi': quattro passate
        //                           di taratura del sanitizzatore sono nate da questo.
        //   creator_notes      NO   note dell'autore SULLA scheda, non sul personaggio.
        //                           Un'altra scheda ne aveva 74.711: e' un documento di
        //                           sviluppo, non la memoria di nessuno.
        //   system_prompt      NO   sono ISTRUZIONI al modello. Metterle fra i ricordi vuol
        //   post_history_instr NO   dire che il personaggio ricorda di aver ricevuto degli
        //                           ordini, ed e' il tipo di contaminazione che fa uscire
        //                           le risposte con le etichette.
        //   tags               NO   etichette di catalogo, non contenuto.
        const notaProfondita = scheda.data?.extensions?.depth_prompt?.prompt
            || scheda.extensions?.depth_prompt?.prompt || '';
        const pezzi = [];
        if (scheda.description) pezzi.push(String(scheda.description));
        if (scheda.personality) pezzi.push(`Personality: ${scheda.personality}`);
        if (scheda.scenario)    pezzi.push(`Scenario: ${scheda.scenario}`);
        if (notaProfondita)     pezzi.push(String(notaProfondita));
        const testo = pezzi.join('\n\n').trim();
        if (testo.length < 40) return;

        const impronta = improntaTesto(testo);
        const chiave = `mempalace_scheda_${charKey}`;
        if (localStorage.getItem(chiave) === impronta) return;   // invariata: niente da fare

        // La scheda e' cambiata (o non c'era): si toglie la vecchia e si riscrive.
        const vecchie = await callMemPalace('mempalace_list_drawers', {
            wing: charKey, room: STANZA_SCHEDA, limit: 200,
        }).catch(() => null);
        for (const d of (vecchie?.drawers || [])) {
            await callMemPalace('mempalace_delete_drawer', { drawer_id: d.id }).catch(() => null);
        }

        const r = await scriviRicordo({
            wing: charKey, room: STANZA_SCHEDA, content: testo,
            source_file: `scheda:${charKey}`,
            // La scheda e' una sola: nessun rischio di doppioni, e i suoi pezzi
            // possono somigliarsi fra loro quanto vogliono.
            dup_threshold: 1.01,
        });
        localStorage.setItem(chiave, impronta);
        console.log(`[MemPalace] Scheda di ${charKey} in archivio: ${r.salvati} pezzi da ${testo.length} caratteri.`);
    } catch (e) {
        console.warn('[MemPalace] Scheda non archiviata (non critica):', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LA LORE PRONTA ALL'USO QUANDO SI APRE UNA CHAT
//
// Il problema, misurato: dei 3 fatti di un personaggio nel grafo, ZERO venivano da un
// lorebook. La lore sta nell'archivio vettoriale (967 voci) ma nel grafo non c'e',
// perche' i fatti si estraggono solo premendo "Ingerisci" a mano. Un personaggio
// apre la chat sapendo cercare nel proprio mondo, ma senza saperlo strutturato.
//
// La soluzione ovvia sarebbe una scansione profonda all'avvio. Non regge:
//   Forgotten Realms 520 voci = 35 min | tutti i libri = 64 min
// e `llama-server` serve una richiesta per volta, quindi vorrebbe dire aspettare
// mezz'ora prima del primo turno, e rifarlo alla chat successiva.
//
// Due cambiamenti la rendono praticabile:
//
//   1. INCREMENTALE. Si distilla solo cio' che non e' gia' distillato, a piccole
//      dosi, fuori dal turno, e l'indice sopravvive alla sessione. La prima chat
//      su un mondo nuovo lavora, le successive trovano tutto pronto.
//
//   2. UNA VOLTA PER LIBRO, NON PER PERSONAGGIO. La distillazione col modello e'
//      la parte cara; scrivere una tripla in un closet costa 151 ms (misurato).
//      Quindi il libro si distilla in un closet suo, `lore:<Libro>`, e da li' i
//      fatti si COPIANO nel closet di ogni personaggio che usa quel libro: 30
//      secondi a personaggio invece di 35 minuti. Sei personaggi nello stesso
//      mondo pagano il conto una volta sola.
//
// L'isolamento non ne soffre: ogni personaggio continua ad avere i fatti nel
// proprio closet, e il closet del libro non viene mai letto dal recupero.
// ─────────────────────────────────────────────────────────────────────────────

// Quanto lavoro di sottofondo, e quando.
//
// La prima versione sbagliava i conti: tre voci per passata sono circa DODICI secondi
// di modello, seguiti da nove di pausa. Dodici su ventuno fa il 57% del tempo con la
// GPU occupata, ininterrottamente, per ore. L'utente se n'e' accorto guardando la
// scheda video lavorare a chat ferma, e aveva ragione: "in sottofondo" non puo'
// voler dire "sempre".
//
// Adesso due regole, e la prima conta piu' della seconda:
//   1. Si lavora SOLO a tavolo fermo. Se l'ultimo turno e' recente, non si tocca il
//      modello: chi sta giocando ha la precedenza assoluta.
//   2. La pausa e' proporzionale al lavoro appena fatto, non un numero fisso. Cosi'
//      il tempo di GPU occupata resta sotto un quarto qualunque cosa succeda, anche
//      se un giorno il modello diventasse tre volte piu' lento.
const DOSE_LORE = 2;                  // voci per passata
const RIPOSO_PER_LAVORO = 3;          // pausa = 3 volte il lavoro fatto (25% di occupazione)
const ATTESA_LORE_MIN_MS = 15000;     // e comunque mai meno di questo
const FERMO_DA_MS = 60000;            // silenzio richiesto prima di toccare il modello
let _timerLore = null;
let _loreInCorso = false;
let _ultimaGenerazione = 0;           // quando e' finito l'ultimo turno

/** Vero se l'utente sta giocando adesso: in quel caso il modello non si tocca. */
function tavoloOccupato() {
    return _generazioneInCorso || (Date.now() - _ultimaGenerazione) < FERMO_DA_MS;
}

/** Le voci di un libro gia' passate dal modello. */
function giaDistillati(libro) {
    try { return new Set(JSON.parse(localStorage.getItem(`mempalace_lore_distillato_${libro}`) || '[]')); }
    catch (_) { return new Set(); }
}
function segnaDistillato(libro, id) {
    const s = giaDistillati(libro);
    s.add(id);
    try { localStorage.setItem(`mempalace_lore_distillato_${libro}`, JSON.stringify([...s])); }
    catch (e) { console.warn('[MemPalace] Indice della lore distillata non salvato:', e); }
}

/**
 * Copia nel closet del personaggio i fatti gia' distillati dai suoi libri.
 *
 * E' la parte a buon mercato, e va fatta comunque a ogni apertura: un libro puo'
 * essere cresciuto perche' un altro personaggio lo ha distillato nel frattempo.
 * `add_triple` deduplica per closet, quindi ricopiare non moltiplica niente.
 */
async function copiaFattiLore(charKey) {
    const libri = getLoreBooks(charKey);
    let copiati = 0;
    for (const libro of libri) {
        const chiave = `mempalace_lore_copiati_${charKey}_${libro}`;
        const gia = parseInt(localStorage.getItem(chiave) || '0', 10) || 0;
        const q = await callMemPalace('mempalace_kg_query', { entity: null, wing: `lore:${libro}` }).catch(() => null);
        const fatti = q?.facts || [];
        if (fatti.length <= gia) continue;          // niente di nuovo da copiare

        for (const f of fatti.slice(gia)) {
            const r = await callMemPalace('mempalace_kg_add', {
                subject: f.subject, predicate: f.predicate, object: f.object,
                wing: charKey, source_file: `lorebook:${libro}`,
            }).catch(() => null);
            if (r && r.success) copiati++;
        }
        localStorage.setItem(chiave, String(fatti.length));
    }
    if (copiati > 0) console.log(`[MemPalace] Lore: ${copiati} fatti portati nel grafo di ${charKey}.`);
    return copiati;
}

/**
 * Distilla un poco di lore, poi si riprogramma finche' non ha finito.
 *
 * Piccole dosi e mai durante una generazione: il modello che distilla e' lo stesso
 * che scrive le risposte, e su uno slot solo una passata avida si sentirebbe
 * eccome. Meglio metterci un'ora in sottofondo che due minuti bloccando il gioco.
 */
async function distillaLoreUnPoco(charKey, genSnapshot) {
    if (_loreInCorso || _isSyncing || _riflessioneInCorso || tavoloOccupato()) {
        programmaDistillazioneLore(charKey, genSnapshot);
        return;
    }
    if (localStorage.getItem('mempalace_llm_extract') !== 'true') return;
    // Interruttore a parte: si puo' volere l'estrazione dai messaggi e NON la lettura
    // della lore in sottofondo, che e' il lavoro lungo, quello che si sente sulla GPU.
    if (localStorage.getItem('mempalace_lore_sottofondo') === 'false') return;
    if (_charSelectedGen !== genSnapshot) return;      // personaggio cambiato: si smette

    _loreInCorso = true;
    try {
        for (const libro of getLoreBooks(charKey)) {
            const fatti = giaDistillati(libro);
            const el = await callMemPalace('mempalace_list_drawers', {
                wing: `lore:${libro}`, room: 'lore', limit: 2000,
            }).catch(() => null);
            const voci = (el?.drawers || []).filter(d => d.content && !fatti.has(d.id));
            if (voci.length === 0) continue;

            const dose = voci.slice(0, DOSE_LORE);
            const inizioLavoro = Date.now();
            let nuovi = 0;
            for (const v of dose) {
                if (_generazioneInCorso || _charSelectedGen !== genSnapshot) break;
                // La macro si espande QUI e non in archivio: il modello deve leggere un
                // nome, non un segnaposto, ma il cassetto resta buono per tutti.
                const testo = String(v.content)
                    .replace(/\{\{(?:char|character)\}\}/gi, String(charKey).replace(/_/g, ' '))
                    .replace(/\{\{(?:user|persona)\}\}/gi, 'you');
                const triple = await estraiFattiConModello(testo, charKey);
                for (const f of triple) {
                    const r = await callMemPalace('mempalace_kg_add', {
                        subject: f.subject, predicate: f.predicate, object: f.object,
                        wing: `lore:${libro}`, source_file: `lorebook:${libro}`,
                    }).catch(() => null);
                    if (r && r.success) nuovi++;
                }
                segnaDistillato(libro, v.id);
            }
            const restano = voci.length - dose.length;
            const durata = Date.now() - inizioLavoro;
            console.log(`[MemPalace] Lore "${libro}": +${nuovi} fatti in ${(durata/1000).toFixed(0)} s, ${restano} voci ancora da leggere.`);
            programmaDistillazioneLore(charKey, genSnapshot, durata);
            return;                                    // un libro per volta, una dose per volta
        }
        // Niente piu' da distillare: si porta al personaggio quello che c'e'.
        await copiaFattiLore(charKey);
    } catch (e) {
        console.warn('[MemPalace] Distillazione della lore non riuscita (non critica):', e);
    } finally {
        _loreInCorso = false;
    }
}

function programmaDistillazioneLore(charKey, genSnapshot, durataLavoro = 0) {
    if (_timerLore) clearTimeout(_timerLore);
    // La pausa segue il lavoro: se una passata e' costata dodici secondi se ne
    // aspettano trentasei. Il rapporto e' il tetto all'occupazione della GPU.
    const attesa = Math.max(ATTESA_LORE_MIN_MS, durataLavoro * RIPOSO_PER_LAVORO);
    _timerLore = setTimeout(() => {
        _timerLore = null;
        distillaLoreUnPoco(charKey, genSnapshot).catch(() => {});
    }, attesa);
}

/**
 * All'apertura di una chat: prima si porta al personaggio cio' che e' gia' pronto
 * (secondi), poi si mette in sottofondo la distillazione di cio' che manca (minuti).
 * Il primo turno non aspetta niente.
 */
async function preparaLore(charKey, genSnapshot) {
    if (!charKey) return;
    try {
        const portati = await copiaFattiLore(charKey);
        const libri = getLoreBooks(charKey);
        let daFare = 0;
        for (const libro of libri) {
            const fatti = giaDistillati(libro);
            const el = await callMemPalace('mempalace_status', { wing: `lore:${libro}` }).catch(() => null);
            daFare += Math.max(0, (el?.total_drawers || 0) - fatti.size);
        }
        if (daFare > 0 && localStorage.getItem('mempalace_llm_extract') === 'true'
            && localStorage.getItem('mempalace_lore_sottofondo') !== 'false') {
            const min = Math.ceil(daFare * 4 / 60);
            console.log(`[MemPalace] Lore da leggere: ${daFare} voci (~${min} min in sottofondo).`);
            if (portati === 0 && daFare > 20) {
                toastr.info(t('lore_prep_toast', { count: daFare, min }), null, { timeOut: 7000 });
            }
            programmaDistillazioneLore(charKey, genSnapshot);
        }
    } catch (e) {
        console.warn('[MemPalace] Preparazione della lore non riuscita (non critica):', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTRAZIONE CONTINUA, il grafo cresce mentre la storia va avanti
//
// L'estrazione col modello costa ~4 secondi a messaggio e usa LO STESSO modello che
// scrive le risposte. Farla durante il turno significherebbe rallentare il turno di
// quattro secondi, ogni volta. Quindi lavora DOPO, a modello libero, e a piccole
// dosi: due messaggi per turno, mai in contemporanea con una generazione.
//
// Il risultato e' che i fatti di un turno sono disponibili dal turno successivo, che
// per una memoria narrativa e' il ritmo giusto: nessuno ricorda una cosa mentre la
// sta ancora dicendo.
// ─────────────────────────────────────────────────────────────────────────────

const ESTRAI_PER_TURNO = 2;      // messaggi per turno: piccole dosi, mai una coda
const ATTESA_PRIMA_MS = 2500;    // respiro dopo la risposta, prima di occupare il modello

/** Indice dei messaggi gia' esaminati, per wing: come il sync, non ricomincia da capo. */
function _chiaveEstrazione(wingId) {
    return `mempalace_kg_extract_idx_${wingId}`;
}

async function estrazioneIncrementale(wingId, genSnapshot) {
    if (_estrazioneInCorso || _isSyncing || _generazioneInCorso) return;
    if (localStorage.getItem('mempalace_llm_extract') !== 'true') return;
    const ctx = getContext();
    if (typeof ctx?.generateQuietPrompt !== 'function') return;

    _estrazioneInCorso = true;
    try {
        const chiave = _chiaveEstrazione(wingId);
        const gia = parseInt(localStorage.getItem(chiave) || '0', 10) || 0;
        const messaggi = (ctx.chat || []).filter(m => !m.is_system && m.mes);
        if (messaggi.length <= gia) return;

        const charName = getCharacterWingId() || wingId;
        const daFare = messaggi.slice(gia, gia + ESTRAI_PER_TURNO);
        let nuovi = 0;

        for (const m of daFare) {
            // Se nel frattempo e' partita una generazione o e' cambiato personaggio,
            // ci si ferma e si riprende al turno dopo: il modello serve a lui.
            if (_generazioneInCorso || _charSelectedGen !== genSnapshot) break;
            const fatti = await estraiFattiConModello(m.mes, charName);
            for (const f of fatti) {
                const r = await callMemPalace('mempalace_kg_add', {
                    subject: f.subject, predicate: f.predicate, object: f.object, wing: wingId,
                }).catch(() => null);
                if (r && r.success) nuovi++;
            }
            localStorage.setItem(chiave, String(parseInt(localStorage.getItem(chiave) || '0', 10) + 1));
        }

        if (nuovi > 0) {
            console.log(`[MemPalace] Estrazione continua: +${nuovi} fatti (wing ${wingId})`);
            refreshMemPalaceStats();
        }
    } catch (e) {
        console.warn('[MemPalace] Estrazione continua fallita (non critica):', e);
    } finally {
        _estrazioneInCorso = false;
    }
}

/** Programma l'estrazione dopo la risposta, lasciando respirare il modello. */
function programmaEstrazione(wingId) {
    if (_timerEstrazione) clearTimeout(_timerEstrazione);
    const genSnapshot = _charSelectedGen;
    _timerEstrazione = setTimeout(() => {
        _timerEstrazione = null;
        estrazioneIncrementale(wingId, genSnapshot).catch(() => {});
    }, ATTESA_PRIMA_MS);
}

async function performDeepKnowledgeScan() {
    // [C2] Respect module-level sync lock: don't run concurrently with manual sync or auto-scan.
    if (_isSyncing) return toastr.warning('Sync already in progress. Wait for it to complete.');
    const wingId = getWingId();
    if (!wingId) return toastr.warning(t('toast_no_char'));
    _isSyncing = true;
    const scanStart = Date.now();
    let timedOut = false;
    try {
        // Limite scalabile: si adatta alla dimensione reale della storia (fino a 2000 shards).
        const context = getContext();
        const chatLen = context && context.chat ? context.chat.filter(m => !m.is_system && m.mes).length : 0;
        const scanLimit = Math.min(Math.max(chatLen, 250), 2000);

        // Con l'estrazione affidata al modello ogni messaggio costa ~4 secondi
        // invece di ~30 millisecondi: il tetto di 5 minuti taglierebbe la scansione
        // dopo ~75 messaggi. Con questa modalità si concede molto più tempo, ma si
        // avvisa prima quanto durerà, perché è l'utente a doverlo decidere.
        let usaModello = localStorage.getItem('mempalace_llm_extract') === 'true';
        const charName = getCharacterWingId() || wingId;
        // Nome diverso dalla costante di modulo DEEP_SCAN_TIMEOUT_MS: ombreggiarla
        // funzionerebbe ma è il tipo di trappola che si paga sei mesi dopo.
        const tettoScan = usaModello ? 30 * 60 * 1000 : DEEP_SCAN_TIMEOUT_MS;

        if (usaModello) {
            const stima = Math.ceil(Math.min(chatLen, scanLimit) * 4 / 60);
            toastr.info(`Deep Scan col modello: ~${stima} min per ${Math.min(chatLen, scanLimit)} messaggi. Estrae molti più fatti, ma è lento.`, null, { timeOut: 9000 });
        } else {
            toastr.info(`Synaptic Resonance: Deep Scan initiated. Scanning up to ${scanLimit} narrative shards…`, null, { timeOut: 5000 });
        }

        const result = await callMemPalace('mempalace_list_drawers', { wing: wingId, limit: scanLimit });
        if (!result || !result.drawers || result.drawers.length === 0) {
            toastr.warning('No memories found in the palace to scan.');
            return;
        }

        // Pulizia preliminare del rumore nel grafo
        await callMemPalace('mempalace_kg_purge_noise', {});

        // [FIX-MODELLO-MUTO] Stessa prova che fa l'ingestione della lore: un Deep Scan
        // col modello su un backend spento impiegherebbe la sua mezz'ora per non
        // estrarre niente. Meglio scoprirlo sulla prima frase e ripiegare sul regex.
        if (usaModello && !await modelloRisponde(charName)) {
            usaModello = false;
            toastr.error(`Deep Scan col ripiego a regex: il backend di generazione ${motivoModelloMuto()}. Prova mempalaceDiagnosiModello() in console.`, null, { timeOut: 15000 });
        }

        let scanned = 0;
        let totalFacts = 0;

        const SCAN_BATCH = 8;
        const PROGRESS_EVERY = 40;
        for (let i = 0; i < result.drawers.length; i += SCAN_BATCH) {
            if (Date.now() - scanStart > tettoScan) {
                timedOut = true;
                console.warn(`[MemPalace] Deep Scan timed out after ${Math.round(tettoScan / 60000)} min at shard ${scanned}/${result.drawers.length}`);
                break;
            }
            const batch = result.drawers.slice(i, i + SCAN_BATCH);
            const prevScanned = scanned;

            if (usaModello) {
                // Una alla volta, non in parallelo: le richieste passano per il
                // backend di generazione, che serve un prompt per volta comunque
                // mandargliene otto insieme non le rende più veloci, le mette in coda.
                for (const d of batch) {
                    const fatti = await estraiFattiConModello(d.content, charName);
                    for (const f of fatti) {
                        const r = await callMemPalace('mempalace_kg_add', {
                            subject: f.subject, predicate: f.predicate, object: f.object,
                            wing: wingId,
                        }).catch(() => null);
                        if (r && r.success) totalFacts++;
                    }
                    scanned++;
                    if (Date.now() - scanStart > tettoScan) break;
                }
            } else {
                const batchResults = await Promise.all(batch.map(d =>
                    callMemPalace('mempalace_extract_facts', {
                        text: d.content,
                        character: wingId,
                        save: true,
                        source_file: d.source_file || d.room
                    })
                ));
                batchResults.forEach(extraction => {
                    if (extraction && extraction.facts_found) totalFacts += extraction.facts_found;
                    scanned++;
                });
            }
            if (Math.floor(scanned / PROGRESS_EVERY) > Math.floor(prevScanned / PROGRESS_EVERY) && scanned < result.drawers.length) {
                const pct = Math.round(scanned / result.drawers.length * 100);
                toastr.info(`Deep Scan: ${pct}% (${scanned}/${result.drawers.length} shards…)`, null, { timeOut: 2000 });
            }
        }

        if (timedOut) {
            toastr.warning(`Deep Scan interrotto dopo ${Math.round(tettoScan/60000)} min: ${scanned}/${result.drawers.length} shards processed, ${totalFacts} facts extracted.`);
        } else {
            console.log(`[MemPalace] Deep Scan completed. Shards: ${scanned}, Facts Extracted: ${totalFacts}`);
            toastr.success(`Deep Scan Complete: Processed ${scanned} shards and crystallized ${totalFacts} new facts into the Knowledge Graph.`);
        }
        refreshMemPalaceStats();
    } finally {
        _isSyncing = false;
    }
}

function showMemPalaceModal(title, contentHtml, icon = 'fa-circle-info', accentColor = 'var(--mp-common)') {
    if ($('#mempalace-custom-modal').length > 0) $('#mempalace-custom-modal').remove();

    const modalHtml = `
    <div id="mempalace-custom-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:2000000; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px); pointer-events: auto;">
        <div class="mempalace-glass mempalace-lore-modal" style="display:flex; flex-direction:column; padding: 25px !important;">
            <div style="padding: 18px 25px; border-bottom: 1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center; background: rgba(0,0,0,0.3);">
                <div style="display:flex; align-items:center; gap:12px;">
                    <i class="fa-solid ${icon}" style="color: ${accentColor}; font-size: 1.2em;"></i>
                    <b style="color:#fff; font-size:1.1em; letter-spacing: 1px; font-weight: 300;">${escHtml(title).toUpperCase()}</b>
                </div>
                <i class="fa-solid fa-circle-xmark mp-modal-close" style="cursor:pointer; opacity:0.6; font-size: 1.3em; transition: 0.2s;"></i>
            </div>
            <div style="flex:1; padding:25px; overflow-y:auto; color:#eee; line-height: 1.6;">
                ${contentHtml}
            </div>
            <div style="padding: 15px 25px; text-align:right; border-top: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.1);">
                <button class="mp-modal-close mp-btn-primary" style="padding:8px 30px; border-radius: 8px;">CLOSE</button>
            </div>
        </div>
    </div>`;

    $('body').append(modalHtml);
    
    const closeModal = () => $('#mempalace-custom-modal').fadeOut(200, function() { $(this).remove(); });
    $('.mp-modal-close').on('click', closeModal);
    $('#mempalace-custom-modal').on('click', function(e) { if (e.target === this) closeModal(); });
    
    $('.mp-modal-close').on('mouseenter', function() { $(this).css('opacity', '1'); });
    $('.mp-modal-close').on('mouseleave', function() { $(this).css('opacity', '0.6'); });
}

/**
 * Settings UI Setup and Brain Eraser
 */
async function setupUI() {
    if ($('#mempalace-status-container').length) {
        console.warn('[MemPalace] setupUI called more than once: skipping to prevent duplicate handlers.');
        return;
    }
    const extContainer = $('#extensions_settings');
    const settingsHtml = await renderExtensionTemplateAsync('MemPlace', 'index');
    extContainer.append(settingsHtml);

    // Ensure modals are moved to body to avoid containment issues in SillyTavern columns
    if ($('#mempalace-graph-modal').length > 0) {
        $('#mempalace-graph-modal').appendTo('body');
    }
    
    // Initialize language
    const savedLang = localStorage.getItem('mempalace_lang') || 'en';
    $('#mempalace-lang-select').val(savedLang);
    applyLanguage(savedLang);

    // Event listener lingua
    $('#mempalace-lang-select').on('change', function() {
        const lang = $(this).val();
        applyLanguage(lang);
        const name = getActiveCharacterName();
        if (name) {
            callMemPalace('mempalace_status', { wing: getWingId() }).then(res => {
                updateUIStatus(name, res);
            });
        }
    });
    if (activeCharacterName) {
        const status = await callMemPalace('mempalace_status', { wing: getWingId() });
        updateUIStatus(activeCharacterName, status);
    } else {
        updateUIStatus(null, null);
    }

    const wipeBtn = $('#mempalace-wipe-btn');
    const syncBtn = $('#mempalace-sync-btn');
    const refreshBtn = $('#mempalace-refresh-stats');
    const autoScanChk = $('#mempalace-autoscan-chk');
    const isolationMode = $('#mempalace-isolation-mode');
    
    const aaakChk = $('#mempalace-aaak-chk');
    
    // Recupera la preferenza salvata (default false)
    const savedAutoScan = localStorage.getItem('mempalace_autoscan');
    if (savedAutoScan === null) {
        autoScanChk.prop('checked', true);
        localStorage.setItem('mempalace_autoscan', 'true');
    } else {
        autoScanChk.prop('checked', savedAutoScan === 'true');
    }

    const savedAaak = localStorage.getItem('mempalace_aaak') === 'true';
    aaakChk.prop('checked', savedAaak);
    
    // Se un personaggio è già attivo si mostra la SUA scelta; altrimenti il default
    // globale, che è anche quello che erediteranno i personaggi nuovi.
    isolationMode.val(getIsolationMode());
    
    // Estrazione col modello nel Deep Scan. Default SPENTO: costa ~4 secondi a
    // messaggio contro i ~30 millisecondi del regex, ed è una scelta che deve
    // restare dell'utente perché su una chat lunga si parla di minuti.
    const llmExtractChk = $('#mempalace-llm-extract-chk');
    // Default ACCESO: misurato, e' cio' che fa la differenza fra un grafo vuoto e un
    // grafo vivo (7 fatti col regex contro ~100 col modello, sugli stessi messaggi).
    if (localStorage.getItem('mempalace_llm_extract') === null) {
        localStorage.setItem('mempalace_llm_extract', 'true');
    }
    llmExtractChk.prop('checked', localStorage.getItem('mempalace_llm_extract') === 'true');
    llmExtractChk.on('change', () => {
        localStorage.setItem('mempalace_llm_extract', llmExtractChk.prop('checked'));
        console.log(`[MemPalace] Deep Scan col modello: ${llmExtractChk.prop('checked')}`);
    });

    // Lettura della lore in sottofondo: acceso di serie, ma spegnibile. E' il lavoro
    // piu' lungo che l'estensione fa, e chi ha una scheda video piccola lo sente.
    const loreBgChk = $('#mempalace-lore-bg-chk');
    loreBgChk.prop('checked', localStorage.getItem('mempalace_lore_sottofondo') !== 'false');
    loreBgChk.on('change', () => {
        localStorage.setItem('mempalace_lore_sottofondo', loreBgChk.prop('checked'));
        console.log(`[MemPalace] Lettura della lore in sottofondo: ${loreBgChk.prop('checked')}`);
    });

    autoScanChk.on('change', () => {
        localStorage.setItem('mempalace_autoscan', autoScanChk.prop('checked'));
    });

    aaakChk.on('change', () => {
        localStorage.setItem('mempalace_aaak', aaakChk.prop('checked'));
        // Invalida cache AAAK quando si attiva/disattiva il protocollo
        _aaakDialectCache = null;
        _aaakDialectWingId = null;
    });
    
    // Slider soglia di rilevanza
    const relevanceSlider = $('#mempalace-relevance-slider');
    const relevanceValueLabel = $('#mempalace-relevance-value');
    const savedThreshold = localStorage.getItem('mempalace_relevance_threshold') || '0';
    relevanceSlider.val(savedThreshold);
    relevanceValueLabel.text(parseFloat(savedThreshold).toFixed(2));
    relevanceSlider[0].style.setProperty('--mp-slider-pct', `${parseFloat(savedThreshold) * 100}%`);
    relevanceSlider.on('input', function() {
        const v = parseFloat(this.value);
        relevanceValueLabel.text(v.toFixed(2));
        this.style.setProperty('--mp-slider-pct', `${v * 100}%`);
        localStorage.setItem('mempalace_relevance_threshold', v);
    });

    // --- Slider Budget RAG ---
    const ragBudgetSlider = $('#mempalace-ragbudget-slider');
    const ragBudgetValue  = $('#mempalace-ragbudget-value');
    const savedRagBudget  = localStorage.getItem('mempalace_rag_budget') || '2000';
    ragBudgetSlider.val(savedRagBudget);
    ragBudgetValue.text(parseInt(savedRagBudget));
    ragBudgetSlider[0].style.setProperty('--mp-slider-pct', `${(parseInt(savedRagBudget) - 500) / 5500 * 100}%`);
    ragBudgetSlider.on('input', function() {
        const v = parseInt(this.value);
        ragBudgetValue.text(v);
        this.style.setProperty('--mp-slider-pct', `${(v - 500) / 5500 * 100}%`);
        localStorage.setItem('mempalace_rag_budget', v);
    });

    // --- Slider Max caratteri per frammento ---
    const maxFragSlider = $('#mempalace-maxfrag-slider');
    const maxFragValue  = $('#mempalace-maxfrag-value');
    const savedMaxFrag  = localStorage.getItem('mempalace_max_frag_chars') || '500';
    maxFragSlider.val(savedMaxFrag);
    maxFragValue.text(parseInt(savedMaxFrag));
    maxFragSlider[0].style.setProperty('--mp-slider-pct', `${(parseInt(savedMaxFrag) - 100) / 1900 * 100}%`);
    maxFragSlider.on('input', function() {
        const v = parseInt(this.value);
        maxFragValue.text(v);
        this.style.setProperty('--mp-slider-pct', `${(v - 100) / 1900 * 100}%`);
        localStorage.setItem('mempalace_max_frag_chars', v);
    });

    isolationMode.on('change', async () => {
        const newMode = isolationMode.val();

        // [WING-MODEL] La scelta è DI QUESTO personaggio. Prima si scriveva la chiave
        // globale e cambiava la modalità a tutti quanti: si voleva una chat sigillata
        // con un personaggio e da quel momento ogni altro personaggio cominciava a
        // scrivere i ricordi su una wing nuova a ogni chat, senza segnalarlo.
        // La chiave globale si aggiorna comunque, ma solo come default per i
        // personaggi che una scelta non l'hanno ancora espressa.
        const charBase = canonicalCharKey(activeCharacterName || getActiveCharacterName() || '');
        if (charBase) setIsolationMode(charBase, newMode);
        else localStorage.setItem('mempalace_isolation', newMode);

        // [FIX-ISOLATION-ORPHAN] Su cambio modalità, rimuovi le chiavi last_sync_idx
        // dell'altra modalità per il personaggio corrente: evita che al ritorno alla
        // vecchia modalità venga letto un indice stale e si salti la re-sync.
        if (charBase) {
            const context = getContext();
            const chatId = context?.chatId;
            if (newMode === 'chat') {
                // Passato a chat-mode: rimuovi la chiave character-mode (senza chatId)
                localStorage.removeItem(`mempalace_last_sync_idx_${charBase}`);
            } else {
                // Passato a character-mode: rimuovi la chiave chat-mode
                if (chatId) localStorage.removeItem(`mempalace_last_sync_idx_${charBase}_chat_${chatId}`);
            }
            console.log(`[MemPalace] Isolation mode changed to '${newMode}': ripulita la chiave di sync per ${charBase}`);
        }

        // Se si cambia l'isolamento in diretta, facciamo un giro di status
        const currentWing = getWingId();
        if (currentWing) {
            const status = await callMemPalace('mempalace_status', { wing: currentWing });
            updateUIStatus(activeCharacterName || getActiveCharacterName(), status);
            await updateDiaryContext(getCharacterWingId() || currentWing);
        }
    });

    // [C2] isSyncing is now module-level (_isSyncing), alias for readability inside setupUI.
    // Using the module-level flag allows performDeepKnowledgeScan to also check/set it.
    let syncConfirmTimer = null;
    let wipeConfirmTimer = null;

    refreshBtn.on('click', () => refreshMemPalaceStats());

    // Nucleus Quick-Preview: toggle collapsible + caricamento on-demand
    const nucleusPreview = $('#mempalace-nucleus-preview');
    const nucleusPreviewToggle = $('#mempalace-nucleus-preview-toggle');
    const nucleusPreviewText = $('#mempalace-nucleus-preview-text');
    let nucleusPreviewLoaded = false;

    nucleusPreviewToggle.on('click', async () => {
        const isOpen = nucleusPreview.hasClass('open');
        if (isOpen) {
            nucleusPreview.removeClass('open');
            return;
        }
        nucleusPreview.addClass('open');
        // Carica il contenuto solo la prima volta (o dopo cambio personaggio)
        if (!nucleusPreviewLoaded) {
            const wingId = getWingId();
            if (!wingId) {
                nucleusPreviewText.text('n/d');
                return;
            }
            nucleusPreviewText.text('...');
            const diaryData = await callMemPalace('mempalace_diary_read', { agent_name: getCharacterWingId() || wingId });
            if (diaryData && diaryData.entries && diaryData.entries.length > 0) {
                const fullText = [...new Set(diaryData.entries.map(e => (e.content ?? '').trim()).filter(s => s.length > 0))].join('\n');
                const preview = fullText.length > 300 ? fullText.substring(0, 300) + '…' : fullText;
                nucleusPreviewText.text(preview || 'n/d');
            } else {
                nucleusPreviewText.text(t('nucleus_empty'));
            }
            nucleusPreviewLoaded = true;
        }
    });

    // Invalida il preview quando si cambia personaggio o si salva il diary
    eventSource.on(event_types.CHAT_CHANGED, () => { nucleusPreviewLoaded = false; });

    // Logica tasti Diario
    const diaryEditBtn = $('#mempalace-edit-diary-btn');
    const diaryEditor = $('#mempalace-diary-editor');
    const diarySave = $('#mempalace-diary-save');
    const diaryCancel = $('#mempalace-diary-cancel');
    const diaryTextarea = $('#mempalace-diary-textarea');

    diaryEditBtn.on('click', async () => {
        const wingId = getWingId();
        if (!wingId) return toastr.warning(t('toast_no_char'));

        diaryEditor.slideDown(200);
        diaryTextarea.val('...');
        try {
            const diaryData = await callMemPalace('mempalace_diary_read', { agent_name: getCharacterWingId() || wingId });
            if (diaryData && diaryData.entries && diaryData.entries.length > 0) {
                const fullText = [...new Set(diaryData.entries.map(e => (e.content ?? '').trim()).filter(s => s.length > 0))].join('\n');
                diaryTextarea.val(fullText);
            } else {
                diaryTextarea.val('');
            }
        } catch (err) {
            console.error('[MemPalace] Failed to load diary for edit:', err);
            diaryTextarea.val('');
        }
    });

    // Gestione Caricamento File TXT nel Nucleo
    const diaryImportBtn = $('#mempalace-diary-import-btn');
    const diaryFileInput = $('#mempalace-diary-file-input');

    diaryImportBtn.on('click', () => {
        diaryFileInput.click();
    });

    diaryFileInput.on('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(event) {
            const content = event.target.result;
            const currentVal = diaryTextarea.val().trim();
            const newVal = currentVal ? (currentVal + '\n\n' + content) : content;
            diaryTextarea.val(newVal);
            toastr.success(t('toast_file_loaded'));
            diaryFileInput.val(''); // Reset per permettere ricaricamento stesso file
        };
        reader.readAsText(file);
    });

    // Genera da KG: recupera i fatti strutturati del KG e pre-popola il Nucleo
    const diaryFromKgBtn = $('#mempalace-diary-from-kg');
    let _diaryFromKgBusy = false;
    diaryFromKgBtn.on('click', async () => {
        if (_diaryFromKgBusy) return;
        const wingId = getWingId();
        if (!wingId) return toastr.warning(t('toast_no_char'));

        _diaryFromKgBusy = true;
        diaryFromKgBtn.css('opacity', '0.5');

        try {
            const result = await callMemPalace('mempalace_kg_query', { wing: wingId, entity: wingId }); // [FIX-KG-ENTITY] usa wingId canonico
            if (!result || !result.facts || result.facts.length === 0) {
                return toastr.warning('Nessun fatto KG trovato per questo personaggio.');
            }

            const lines = result.facts.map(f =>
                `- ${f.subject || ''} ${(f.predicate || '').replace(/_/g, ' ')} ${f.object || ''}`
            );
            const block = `[KG ${wingId}]\n` + lines.join('\n');

            const current = diaryTextarea.val().trim();
            diaryTextarea.val(current ? `${current}\n\n${block}` : block);
            toastr.success(`${result.facts.length} fatti KG inseriti nel Nucleo.`);
        } catch (err) {
            toastr.error('Errore recupero KG: ' + err.message);
        } finally {
            _diaryFromKgBusy = false;
            diaryFromKgBtn.css('opacity', '');
        }
    });

    diaryCancel.on('click', () => {
        diaryEditor.slideUp(200);
    });

    diarySave.on('click', async () => {
        const wingId = getWingId();
        if (!wingId) return;
        
        diarySave.text(t('btn_saving'));
        const rawText = diaryTextarea.val().trim();
        
        // Usiamo solo agent_name per massima compatibilità con bridge non riavviati
        const res = await callMemPalace('mempalace_diary_write', { agent_name: getCharacterWingId() || wingId, entry: rawText });
        
        if (res && res.success) {
            toastr.success(t('diary_save'), 'MemPalace Nucleus');
            diarySave.text(t('diary_save'));
            diaryTextarea.val('');
            diaryEditor.slideUp(200);
            nucleusPreviewLoaded = false; // Forza reload del preview al prossimo open
            nucleusPreview.removeClass('open');
            await updateDiaryContext(getCharacterWingId() || wingId);
            refreshMemPalaceStats();
        } else {
            const detail = (res && res.error) ? res.error : (res && res.reason ? res.reason : 'Bridge?');
            toastr.error('Error: ' + detail);
            console.error('[MemPalace] Diary save failed:', res);
            diarySave.text(t('diary_save'));
        }
    });
    
    // Aggiornamento automatico quando visualizzano il menu
    const drawerToggle = refreshBtn.closest('.inline-drawer').find('.inline-drawer-toggle');
    if (drawerToggle.length > 0) {
        drawerToggle.on('click', () => {
            setTimeout(refreshMemPalaceStats, 100);
        });
    } else {
        console.warn('[MemPalace] .inline-drawer-toggle not found: auto-refresh on open disabled.');
    }

    // Auto-scan logic bind on Selection (sync incrementale: solo messaggi nuovi dall'ultimo indice)
    // [FIX-AUTOSCAN-GEN] performAutoScanIfNeeded accetta opzionalmente myGen: se il personaggio
    // cambia durante i batch di sync, _charSelectedGen !== myGen e la sync si ferma
    // senza scrivere messaggi del vecchio personaggio nella wing del nuovo.
    async function performAutoScanIfNeeded(wingName, myGen) {
        if (!$("#mempalace-autoscan-chk").prop("checked")) return;
        if (_isSyncing) return;
        // Se myGen non è passato, cattura il valore corrente come snapshot
        const genSnapshot = (myGen !== undefined) ? myGen : _charSelectedGen;
        // [B8] Guard against concurrent sync: set _isSyncing so the manual sync button
        // won't fire in parallel if the user clicks while auto-scan is running.
        _isSyncing = true;

        const context = getContext();
        const allMessages = (context.chat || []).filter(m => !m.is_system && m.mes);
        if (allMessages.length === 0) { _isSyncing = false; return; }

        // [FIX-ISOLATION] Per-chat sync key: in global isolation mode the wing name is identical
        // across all chats for a character. Using a single shared lastSyncIdx causes a bug:
        // after chat A (50 msgs) syncs, opening chat B (30 msgs) gives allMessages.slice(50)=[]
        // → nothing ever synced for that chat. Using chatId in the key ensures each chat file
        // tracks sync progress independently, while data still lands in the correct wing
        // (global charName or per-chat charName_chat_chatId, per isolation mode).
        const chatId = context.chatId;
        const syncKey = chatId
            ? `mempalace_last_sync_idx_${wingName}_chat_${chatId}`
            : `mempalace_last_sync_idx_${wingName}`;
        const lastSyncIdx = parseInt(localStorage.getItem(syncKey)) || 0;
        const newMessages = allMessages.slice(lastSyncIdx);

        if (newMessages.length === 0) {
            console.log(`[MemPalace] Auto-scan: già sincronizzati ${lastSyncIdx} messaggi per ${wingName} [${chatId || 'no-chatId'}], nulla di nuovo.`);
            _isSyncing = false;
            return;
        }

        console.log(`[MemPalace] Auto-aligning ${newMessages.length} nuovi messaggi (delta da idx ${lastSyncIdx}) per ${wingName}...`);
        if (newMessages.length > 20) {
            toastr.info(t('toast_auto_align', {count: newMessages.length}), null, { timeOut: 3000 });
        }

        try {
            // Parallelizziamo in batch da 8 (come il Deep Scan), riduce drasticamente i tempi
            // per delta grandi (es. 200 messaggi nuovi da ~40s a ~5s).
            const SYNC_BATCH = 8;
            let sentCount = 0;
            for (let i = 0; i < newMessages.length; i += SYNC_BATCH) {
                // [FIX-AUTOSCAN-GEN] Se il personaggio è cambiato durante la sync, interrompi
                // prima di scrivere altri messaggi sulla wing sbagliata.
                if (_charSelectedGen !== genSnapshot) {
                    console.log(`[MemPalace] Auto-scan interrotto: personaggio cambiato durante la sync di ${wingName}`);
                    return;
                }
                const batch = newMessages.slice(i, i + SYNC_BATCH);
                await Promise.all(batch.map((msg, k) => {
                    // [APERTURE] Il primo messaggio della chat, se non e' dell'utente, e'
                    // il saluto d'apertura: va nella sua stanza, non fra gli episodi.
                    const indiceAssoluto = lastSyncIdx + i + k;
                    if (indiceAssoluto === 0 && !msg.is_user) {
                        return registraApertura(wingName, msg.mes);
                    }
                    return scriviRicordo({ wing: wingName, room: msg.is_user ? "user" : "char", content: msg.mes });
                }));
                sentCount += batch.length;
                // Breve respiro ogni 4 batch (32 messaggi) per non bloccare il browser
                if (sentCount % 32 === 0) await new Promise(r => setTimeout(r, 80));
            }

            // [FIX-RESYNC-KG] La ri-sincronizzazione deve ricostruire ANCHE il grafo.
            //
            // Fino a qui la sync rimetteva a posto solo i cassetti (add_drawer), e i fatti
            // venivano estratti soltanto dai messaggi NUOVI, uno per uno, mentre la storia
            // andava avanti. Dopo un wipe quindi tornavano i ricordi ma non le entità: il
            // grafo, la Timeline e l'Anagrafe restavano vuoti su una wing con decine di
            // cassetti dentro, e l'unico modo di rimetterli in piedi era lanciare a mano
            // il Deep Knowledge Scan, cosa che nessuno può indovinare.
            // Misurato sul backend: 3 cassetti risincronizzati davano 0 fatti / 0 nodi;
            // con questa passata gli stessi 3 danno 3 fatti e 5 nodi.
            // L'estrazione è quella a regex (~30 ms per messaggio), non quella col modello:
            // costa poco e non contende la GPU al turno dell'utente.
            let fattiRicostruiti = 0;
            let estratti = 0;
            for (let i = 0; i < newMessages.length; i += SYNC_BATCH) {
                // Stesso `return` del ciclo dei cassetti, e per lo stesso motivo: se il
                // personaggio cambia a metà, l'indice di sync NON va aggiornato. Con un
                // `break` la sync risulterebbe completa con il grafo fatto a metà, e
                // nessuno ripasserebbe mai più su quei messaggi. Uscendo di qui si
                // rifà tutto al giro dopo: i cassetti li rifiuta il controllo duplicati,
                // i fatti li deduplica add_triple per closet.
                if (_charSelectedGen !== genSnapshot) {
                    console.log(`[MemPalace] Ricostruzione grafo interrotta: personaggio cambiato durante la sync di ${wingName}`);
                    return;
                }
                const batch = newMessages.slice(i, i + SYNC_BATCH);
                const esiti = await Promise.all(batch.map((msg, k) => {
                    // [APERTURE] L'apertura si estrae solo in modalita' Condivisa, dove il
                    // personaggio accumula il proprio passato attraverso le chat: li'
                    // l'inizio di una partita giocata E' una cosa che gli e' successa. In
                    // Isolata resta sotto gli occhi del modello per tutta la partita e non
                    // c'e' niente da imparare che non sia gia' li'.
                    if (lastSyncIdx + i + k === 0 && !msg.is_user && getIsolationMode() !== 'character') {
                        return Promise.resolve(null);
                    }
                    return callMemPalace('mempalace_extract_facts', {
                        text: msg.mes,
                        character: wingName,
                        save: true,
                        source_file: msg.is_user ? 'user' : 'char'
                    }).catch(() => null);
                }));
                esiti.forEach(e => { if (e && e.facts_found) fattiRicostruiti += e.facts_found; });
                estratti += batch.length;
                if (estratti % 32 === 0) await new Promise(r => setTimeout(r, 80));
            }
            if (fattiRicostruiti > 0) {
                console.log(`[MemPalace] Grafo ricostruito dalla sync: +${fattiRicostruiti} fatti su ${wingName}`);
            }

            // Aggiorna l'indice con il numero totale di messaggi processati (per-chat key)
            localStorage.setItem(syncKey, allMessages.length);
            console.log(`[MemPalace] Auto-alignment completato per ${wingName} [${chatId || 'no-chatId'}]. Nuovo idx: ${allMessages.length}`);

            const st = await callMemPalace('mempalace_status', { wing: wingName });
            updateUIStatus(wingName, st);
        } finally {
            _isSyncing = false; // [B8] always release lock, even on backend error
        }
    }

    // --- LORE INGESTION LOGIC ---
    const loreSelect = $('#mempalace-lore-select');
    const ingestLoreBtn = $('#mempalace-ingest-lore-btn');
    let ingestConfirmTimer = null;

    /**
     * Populate the lorebook dropdown
     */
    let _loreListRetries = 0;
    async function updateLoreList() {
        // SillyTavern global exported array (from world-info.js)
        let worlds = world_names || [];

        // [B14] Capped retry: if world_names is empty at startup, retry up to 10×.
        // Without a cap, the old unbounded setTimeout(updateLoreList, 1000) fired every second
        // indefinitely if the user has no lorebooks, memory leak on long sessions.
        if (worlds.length === 0) {
            if (_loreListRetries < 10) {
                _loreListRetries++;
                console.log(`[MemPalace] world_names is empty, retrying in 1s… (${_loreListRetries}/10)`);
                setTimeout(updateLoreList, 1000);
            } else {
                console.log('[MemPalace] world_names still empty after 10 retries: no lorebooks found.');
            }
            return;
        }
        _loreListRetries = 0; // reset on success

        // Clear previous options (keep placeholder)
        loreSelect.find('option:not([value=""])').remove();
        
        worlds.forEach(name => {
            if (!name) return;
            loreSelect.append($('<option>', {
                value: name,
                text: name
            }));
        });
        console.log(`[MemPalace] Populated ${worlds.length} lorebooks into dropdown.`);
    }

    /**
     * Ingest a lorebook into the current wing (room: lore)
     */
    async function ingestLore(bookName) {
        const wingId = getWingId();
        if (!wingId) return toastr.warning(t('toast_no_char'));
        if (!bookName) return toastr.warning(t('toast_no_lore'));

        // [WING-MODEL] Il lorebook va in una wing SUA, non dentro il personaggio.
        // Un mondo è uno solo anche quando lo abitano sei personaggi: copiarlo dentro
        // ciascuno significava, oltre a moltiplicare per sei lo stesso testo, mettere
        // nella memoria di ognuno le schede di tutti gli altri, che il RAG pescava,
        // legittimamente, dando l'impressione che i personaggi si leggessero addosso.
        // Il personaggio non possiede più il libro: lo consulta, e Phase A cerca in
        // entrambe le wing con una sola interrogazione.
        const loreWing = `lore:${bookName}`;
        const charKey = getCharacterWingId();

        ingestLoreBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t('btn_reading')}`);
        
        try {
            const context = getContext();
            const loreData = await context.loadWorldInfo(bookName);
            
            if (!loreData || !loreData.entries) {
                toastr.error(t('toast_lore_error'));
                return;
            }

            const entries = Object.values(loreData.entries);
            const total = entries.length;
            
            if (total === 0) {
                toastr.info(t('toast_lore_empty'));
                return;
            }

            ingestLoreBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t('btn_ingesting', {count: 0, total: total})}`);
            
            let count = 0;
            let saved = 0;
            let duplicates = 0;   // [FIX-COUNTER] SOLO duplicati reali segnalati dal backend
            let skipped = 0;      // [FIX-COUNTER] scartati lato client (macro / NO-RAG): NON sono duplicati
            let errors = 0;

            // Filter entries first, then batch-send in parallel (same pattern as sync/auto-scan)
            // [LORE CONDIVISA] `{{char}}` NON si espande qui, e il motivo si e' visto sul campo.
            //
            // Un lorebook sta in una wing sua, condivisa da tutti i personaggi di quel
            // mondo. Espandendo la macro col nome di chi sta ingerendo, dentro quella
            // wing condivisa finiva il nome di UN personaggio: il secondo personaggio
            // che apriva lo stesso libro ci scriveva la propria versione dello stesso
            // testo, e il controllo duplicati non la riconosceva perche' il testo era
            // diverso davvero. Misurato: 39 pezzi doppi su un libro solo.
            //
            // La macro resta com'e' in archivio. SillyTavern la sostituisce quando monta
            // il prompt (`getExtensionPrompt` chiama `substituteParams`), quindi ogni
            // personaggio legge il proprio nome. Dove il testo NON passa dal prompt, cioe'
            // quando lo si manda al modello per distillarne i fatti, la macro va espansa
            // li' per li': vedi `distillaLoreUnPoco`.
            const charRef = canonicalCharKey(activeCharacterName || getActiveCharacterName() || '') || wingId;
            const validEntries = [];
            for (const entry of entries) {
                if (!entry.content) { count++; continue; }
                // [FIX-INGEST-ALL] L'unico motivo per saltare è [NO-RAG] esplicito.
                // Tutte le altre entry vengono espanse e ingestate: le macro vengono
                // risolte o rimosse per lasciare il testo semanticamente utile.
                if (/\[NO-RAG\]/i.test(entry.content) || (Array.isArray(entry.key) && entry.key.some(k => /NO-RAG/i.test(k)))) {
                    count++; skipped++; continue;
                }
                let expanded = entry.content;
                // `{{char}}` e `{{user}}` restano: le sostituisce SillyTavern per ciascun
                // personaggio quando monta il prompt. Si tolgono solo le altre macro, che
                // dipendono da uno stato di sessione e in archivio non vogliono dire nulla.
                expanded = expanded.replace(/\{\{(?!char\}|character\}|user\})[^}]+\}\}/gi, '').trim();
                if (!expanded) { count++; skipped++; continue; } // salta solo se rimane vuota
                const keys = Array.isArray(entry.key) ? entry.key.join(', ') : '';
                validEntries.push(keys ? `[Key: ${keys}]\n${expanded}` : expanded);
            }

            // [B12] Batch-8 ingestion: was sequential ~30ms/entry → same batching as sync/auto-scan.
            // Una voce per volta: il parallelismo sta gia' dentro `scriviRicordo`, che
            // scrive i pezzi a gruppi. Annidare i due livelli portava a 168 scritture
            // insieme e faceva scadere le richieste, perdendo pezzi in silenzio.
            const INGEST_BATCH = 1;
            // [FIX-LORE-KG] Il closet dove finiscono i fatti della lore.
            //
            // È la wing d'IDENTITÀ, non quella episodica: un mondo non smette di esistere
            // quando si apre una chat nuova, e in modalità Isolata salvarli sulla wing di
            // chat li farebbe morire con la chat. I pannelli che li leggono interrogano
            // entrambe le wing (vedi leggiFattiWing).
            const loreCloset = charKey || wingId;
            for (let i = 0; i < validEntries.length; i += INGEST_BATCH) {
                const batch = validEntries.slice(i, i + INGEST_BATCH);
                const batchResults = await Promise.all(batch.map(fullText =>
                    scriviRicordo({ wing: loreWing, room: "lore", content: fullText,
                                    source_file: `lorebook:${bookName}` })
                ));
                batchResults.forEach(res => {
                    if (res && res.success) saved++;
                    else if (res && res.reason === 'duplicate') duplicates++;
                    else errors++;
                    count++;
                });

                ingestLoreBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t('btn_ingesting', {count: count, total: total})}`);
                if (i % 32 === 0 && i > 0) await new Promise(r => setTimeout(r, 50));
            }

            // [FIX-LORE-KG] Le entità del mondo vanno anche nel grafo.
            //
            // Prima l'ingestione scriveva SOLO cassetti in `lore:<Libro>`, e quei cassetti
            // sono invisibili al Deep Scan (che legge la wing del personaggio): "rifaccio la
            // sincronizzazione della lore" riempiva l'archivio vettoriale e lasciava Anagrafe
            // e grafo a zero.
            //
            // CON QUALE ESTRATTORE, misurato sui lorebook veri dell'utente:
            //   regex   → un lorebook di 27 voci = 1 fatto, 26 voci su 27 a zero.
            //             Su 24.000 caratteri di prosa solo 7 frasi agganciano un predicato,
            //             e il 57% di quelle viene poi buttato dal tetto di 35 caratteri
            //             sull'oggetto (la mediana reale è 48). Non è tarabile: la prosa
            //             enciclopedica non ha la forma "X is a Y" che il regex sa vedere.
            //   modello → sullo stesso materiale, 27 fatti da 12 testi, con cose che il
            //             regex non può vedere ("Aria was created by the engineers of the
            //             first android series"). Costa circa 4 secondi a voce.
            // Quindi si usa il modello quando l'interruttore è acceso, e il regex resta
            // come ripiego per chi lo tiene spento (meglio poco che niente).
            //
            // L'estrazione gira SEMPRE, anche sulle voci risultate duplicate: un libro già
            // presente è il caso normale di chi ri-sincronizza dopo un azzeramento, ed è
            // proprio lì che i fatti vanno rimessi. add_triple deduplica per closet.
            //
            // `source_file: lorebook:<Libro>` non è decorativo: è il marcatore con cui il
            // backend tiene la lore FUORI dalla Timeline, che deve mostrare eventi e non
            // schede di mondo.
            let usaModelloLore = localStorage.getItem('mempalace_llm_extract') === 'true';
            const provenienza = `lorebook:${bookName}`;
            let fattiLore = 0;

            // [FIX-LORE-KG] Prima di un lavoro lungo si controlla che il backend risponda.
            //
            // Solo la RAGGIUNGIBILITÀ, non la resa: vedi modelloRisponde(). Un backend
            // spento fa girare l'ingestione su tutte le voci per non estrarre niente,
            // e questo va evitato; un modello che risponde va invece usato, anche se
            // sulla frase di prova non ha scritto triple.
            if (usaModelloLore && validEntries.length > 0) {
                ingestLoreBtn.html('<i class="fa-solid fa-spinner fa-spin"></i> provo il modello…');
                if (!await modelloRisponde(charRef || loreCloset)) {
                    usaModelloLore = false;
                    toastr.error(`La lore non può alimentare il grafo: il backend di generazione ${motivoModelloMuto()}. Uso il ripiego a regex, che sui lorebook rende quasi nulla. Prova mempalaceDiagnosiModello() in console.`, null, { timeOut: 18000 });
                }
            }

            if (usaModelloLore && validEntries.length > 0) {
                const stima = Math.max(1, Math.ceil(validEntries.length * 4 / 60));
                toastr.info(`Lore → grafo col modello: ~${stima} min per ${validEntries.length} voci. Puoi continuare a usare la chat, ma andrà più lenta.`, null, { timeOut: 9000 });
                // Una alla volta, non in parallelo: le richieste passano dal backend di
                // generazione, che serve un prompt per volta comunque.
                for (let i = 0; i < validEntries.length; i++) {
                    const fatti = await estraiFattiConModello(validEntries[i], charRef || loreCloset);
                    for (const f of fatti) {
                        const r = await callMemPalace('mempalace_kg_add', {
                            subject: f.subject, predicate: f.predicate, object: f.object,
                            wing: loreCloset, source_file: provenienza
                        }).catch(() => null);
                        if (r && r.success) fattiLore++;
                    }
                    ingestLoreBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t('btn_ingesting', {count: i + 1, total: validEntries.length})}`);
                }
            } else {
                for (let i = 0; i < validEntries.length; i += INGEST_BATCH) {
                    const batch = validEntries.slice(i, i + INGEST_BATCH);
                    const esitiKg = await Promise.all(batch.map(fullText =>
                        callMemPalace('mempalace_extract_facts', {
                            text: fullText,
                            character: loreCloset,
                            save: true,
                            source_file: provenienza
                        }).catch(() => null)
                    ));
                    esitiKg.forEach(e => { if (e && e.facts_found) fattiLore += e.facts_found; });
                }
            }
            console.log(`[MemPalace] Lore → grafo: +${fattiLore} fatti nel closet ${loreCloset} (${usaModelloLore ? 'modello' : 'regex'})`);
            if (fattiLore === 0 && !usaModelloLore) {
                toastr.warning("Nessun fatto estratto dalla lore: l'estrattore a regex non vede quasi niente nella prosa dei lorebook. Accendi «estrai i fatti col modello» e rilancia.", null, { timeOut: 12000 });
            }

            // Il collegamento personaggio→libro si scrive SEMPRE, anche quando non è
            // stato salvato niente di nuovo: "0 salvati, N duplicati" ora è il caso
            // normale del secondo personaggio che apre lo stesso mondo, e vuol dire
            // che il libro c'era già, non che l'operazione sia fallita. Senza questa
            // riga quel personaggio resterebbe scollegato da una lore già presente.
            addLoreBook(charKey, bookName);

            const skippedNote = skipped > 0 ? ` (+${skipped} saltati: [NO-RAG])` : '';
            // Il conteggio dei fatti va detto: è l'unico modo di sapere se il grafo si è
            // mosso. "N cassetti salvati" da solo diceva sempre che era andato bene anche
            // quando l'Anagrafe restava vuota, che è esattamente com'era nato il problema.
            const fattiNote = ` · ${fattiLore} fatti nel grafo`;
            if (errors > 0) {
                toastr.warning(t('toast_ingest_warn', {saved, duplicates, errors}) + skippedNote + fattiNote);
            } else if (duplicates > 0 || skipped > 0) {
                toastr.success(t('toast_ingest_success', {saved, duplicates}) + skippedNote + fattiNote);
            } else {
                toastr.success(t('toast_ingest_done', {saved, bookName}) + fattiNote);
            }
            refreshMemPalaceStats();
        } catch (e) {
            console.error('[MemPalace] Lore ingestion failed:', e);
            toastr.error(t('toast_lore_error'));
        } finally {
            ingestLoreBtn.html('<i class="fa-solid fa-brain"></i> ' + t('lore_btn'));
            ingestLoreBtn.css('background', '').css('border-color', '');
        }
    }

    ingestLoreBtn.on('click', async () => {
        const selectedBook = loreSelect.val();
        if (!selectedBook) return toastr.warning(t('toast_no_lore'));

        if (!ingestConfirmTimer) {
            ingestLoreBtn.css('background', 'rgba(255, 255, 0, 0.4)').css('border-color', 'yellow');
            ingestLoreBtn.html('<i class="fa-solid fa-triangle-exclamation"></i> ' + t('conf_sure'));
            
            ingestConfirmTimer = setTimeout(() => {
                ingestConfirmTimer = null;
                ingestLoreBtn.css('background', '').css('border-color', '');
                ingestLoreBtn.html('<i class="fa-solid fa-brain"></i> ' + t('lore_btn'));
            }, 3000);
        } else {
            clearTimeout(ingestConfirmTimer);
            ingestConfirmTimer = null;
            await ingestLore(selectedBook);
        }
    });

    /**
     * Lore Manager Popup: List and Delete lore entries
     */
    async function showLoreManager() {
        const wingId = getWingId();
        if (!wingId) return toastr.warning(t('toast_no_char'));

        const $modal = $(`
            <div id="mempalace-lore-modal-overlay" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:999999; backdrop-filter:blur(4px);">
                <div class="mempalace-lore-modal mempalace-glass">
                    <div class="mempalace-lore-modal-header">
                        <div class="mempalace-lore-modal-title">
                            <i class="fa-solid fa-list-check"></i> Managed Lore Entries
                        </div>
                        <i class="fa-solid fa-xmark" id="mempalace-lore-modal-close" style="cursor:pointer; font-size:1.2em; opacity:0.7;"></i>
                    </div>
                    <div id="mempalace-lore-modal-list" class="mempalace-lore-list">
                        <div style="text-align:center; padding:20px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading repository...</div>
                    </div>
                </div>
            </div>
        `).appendTo('body');

        // [B1] $list declared before try so it stays in scope for the delete handler below.
        // [B4] item.content passed through escHtml() to prevent XSS.
        const $list = $('#mempalace-lore-modal-list');

        // Fetch data with error handling
        try {
            // [WING-MODEL] La lore non abita più dentro la wing del personaggio: da
            // quando ogni lorebook ha la sua wing `lore:<Libro>`, cercarla qui dava
            // sempre zero risultati e il pannello annunciava "No ingested lore found"
            // a un personaggio che il suo mondo ce l'aveva eccome. Si interrogano le
            // stesse wing che legge Phase A, una per una: `list_drawers` accetta una
            // wing sola, e servono comunque separate per poter dire da quale libro
            // viene ogni voce.
            const wings = getLoreWings();
            const risposte = await Promise.all(
                wings.map(w => callMemPalace('mempalace_list_drawers', { wing: w, room: "lore", limit: 1000 })
                    .then(r => ({ wing: w, drawers: (r && r.drawers) || [] }))
                    .catch(() => ({ wing: w, drawers: [] })))
            );
            $list.empty();

            const totale = risposte.reduce((n, r) => n + r.drawers.length, 0);
            if (totale === 0) {
                // Se in archivio ci SONO mondi ma questo personaggio non ne ha
                // nessuno collegato, il pannello vuoto è un vicolo cieco: dice che
                // non c'è lore quando in realtà c'è, solo non è sua. Meglio indicare
                // dove si collega, invece di lasciar credere che manchi tutto.
                const inArchivio = await callMemPalace('mempalace_list_wings', {}).catch(() => null);
                const mondi = Object.keys((inArchivio && inArchivio.wings) || {}).filter(w => w.startsWith('lore:'));
                let msg = 'No ingested lore found for this character.';
                if (mondi.length > 0) {
                    msg += `<br><br><span style="opacity:0.75; font-size:0.9em;">${mondi.length} lorebook in archivio non collegati a questo personaggio.<br>Usa <b>${escHtml(t('lore_manage_btn'))}</b> nel Knowledge Browser per collegarli.</span>`;
                }
                $list.append(`<div style="text-align:center; padding:20px; opacity:0.6; line-height:1.6;">${msg}</div>`);
            } else {
                risposte.forEach(({ wing, drawers }) => {
                    if (drawers.length === 0) return;
                    // Intestazione per libro: con le wing condivise lo stesso pannello
                    // mostra più mondi, e senza un titolo non si capisce dove finisce
                    // uno e comincia l'altro.
                    const titolo = wing.startsWith('lore:') ? wing.slice(5) : `${wing} (propria)`;
                    $list.append(`<div style="margin:14px 0 8px; padding-bottom:4px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.82em; letter-spacing:1px; color:var(--mp-void); font-weight:700;">
                        <i class="fa-solid fa-book"></i> ${escHtml(titolo)} · ${drawers.length}
                    </div>`);
                    drawers.forEach(item => {
                        const source = item.source_file || "Manual Ingestion";
                        const cleanSource = escHtml(source.replace('lorebook:', 'From Lorebook: '));
                        const $item = $(`
                            <div class="mempalace-lore-item" data-id="${escHtml(String(item.id))}">
                                <div class="mempalace-lore-item-source">${cleanSource}</div>
                                <div class="mempalace-lore-item-content">${escHtml(item.content)}</div>
                                <i class="fa-solid fa-trash-can mempalace-lore-delete" title="Delete entry"></i>
                            </div>
                        `);
                        $list.append($item);
                    });
                });
            }
        } catch (err) {
            console.error('[MemPalace] Failed to load lore list:', err);
            $list.html('<div style="text-align:center; padding:20px; color:#ff4757;">Failed to connect to database.</div>');
        }

        // Close logic
        const closeModal = () => { $modal.fadeOut(200, function() { $(this).remove(); }); };
        $('#mempalace-lore-modal-close').on('click', closeModal);
        $modal.on('click', function(e) { if (e.target === this) closeModal(); });

        // Delete logic
        $list.on('click', '.mempalace-lore-delete', async function() {
            const $item = $(this).closest('.mempalace-lore-item');
            const drawerId = $item.data('id');
            
            // L'avviso è cambiato apposta: da quando i lorebook stanno in wing
            // condivise, cancellare una voce la toglie a OGNI personaggio collegato
            // a quel mondo, non solo a quello aperto adesso. Prima era una copia
            // privata e l'operazione non aveva conseguenze fuori da qui.
            if (confirm('Delete this lore entry? It will be removed for EVERY character linked to this lorebook.')) {
                const res = await callMemPalace('mempalace_delete_drawer', { drawer_id: drawerId });
                if (res && res.success) {
                    toastr.success('Lore entry deleted.', 'MemPalace');
                    $item.fadeOut(300, function() { 
                        $(this).remove(); 
                        if ($('#mempalace-lore-modal-list').children().length === 0) {
                            $('#mempalace-lore-modal-list').append('<div style="text-align:center; padding:20px; opacity:0.6;">No ingested lore found.</div>');
                        }
                    });
                    refreshMemPalaceStats();
                } else {
                    toastr.error('Failed to delete entry.');
                }
            }
        });
    }

    $('#mempalace-manage-lore-btn').on('click', showLoreManager);


    // Inizializza la lista
    updateLoreList();
    // Aggiorna quando cambia il personaggio
    eventSource.on(event_types.CHAT_CHANGED, updateLoreList);

    // Attach to global window or just call it from onCharacterSelected? 
    // Actually we need to call it from onCharacterSelected!
    // I'll export it so it can be called.
    window.mempalace_auto_scan = performAutoScanIfNeeded;
    window.callMemPalace = callMemPalace;

    // Bridge condiviso MP↔SQ: indipendente dall'ordine di caricamento e dalla ri-abilitazione mid-session.
    // Whichever loads first creates the object; the second one adds its own slot.
    window.__sillybridge = window.__sillybridge || {};
    window.__sillybridge.callMemPalace = callMemPalace;

    // [WING-MODEL] La wing giusta la sa solo MemPalace, quindi la espone lui.
    // Silly Quantum si calcolava il nome per conto suo (`char.name` con gli spazi
    // sostituiti) e ci scriveva Oracle twist e Judgement: con l'isolamento per
    // personaggio quel nome è la wing SBAGLIATA appena una chat è in modalità
    // Isolata, SQ scriveva sull'identità del personaggio mentre MemPalace leggeva
    // la wing di chat, e quei ricordi non sono mai più tornati indietro. Sono
    // getter, non valori: il personaggio attivo cambia, e una copia fatta all'init
    // resterebbe ferma al primo personaggio della sessione.
    Object.defineProperty(window.__sillybridge, 'wingId', {
        get: () => getWingId(), configurable: true,
    });
    Object.defineProperty(window.__sillybridge, 'characterWingId', {
        get: () => getCharacterWingId(), configurable: true,
    });
    Object.defineProperty(window.__sillybridge, 'loreWings', {
        get: () => getLoreWings(), configurable: true,
    });

    // Notifica SQ (o chiunque ascolti) che MP è pronto, utile se SQ ha caricato prima
    window.dispatchEvent(new CustomEvent('mempalace:ready', { detail: { version: _MP_VERSION } }));

    syncBtn.on('click', async () => {
        if (_isSyncing) return;
        const baseName = activeCharacterName || getActiveCharacterName();
        const wingId = getWingId();
        
        if (!wingId) {
            toastr.warning(t('toast_no_char'));
            return;
        }

        if (!syncConfirmTimer) {
            syncBtn.css('background', 'rgba(255, 255, 0, 0.4)').css('border-color', 'yellow');
            syncBtn.html('<i class="fa-solid fa-triangle-exclamation"></i> ' + t('conf_sync'));
            
            syncConfirmTimer = setTimeout(() => {
                syncConfirmTimer = null;
                syncBtn.css('background', '').css('border-color', '');
                syncBtn.html('<i class="fa-solid fa-rotate"></i> ' + t('sync_btn'));
            }, 3000);
        } else {
            clearTimeout(syncConfirmTimer);
            syncConfirmTimer = null;
            const context = getContext();
            const messages = (context.chat || []).filter(m => !m.is_system && m.mes);
            const total = messages.length;

            if (total === 0) {
                toastr.info(t('toast_no_sync'));
                syncBtn.css('background', '').css('border-color', '');
                syncBtn.html('<i class="fa-solid fa-rotate"></i> ' + t('sync_btn'));
                return;
            }

            _isSyncing = true;

            syncBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t('btn_preparing')}`);
            
            try {
                // Reset proxy counter before mass sending to prevent double counting
                localStorage.setItem('mempalace_synced_mem_' + wingId, 0);

                // [B9] Batched sync: 8 messages in parallel (same as auto-scan).
                // Was sequential with 60ms/msg → ~30s for 500 messages; now ~5s.
                const MANUAL_SYNC_BATCH = 8;
                let sentCount = 0;
                for (let i = 0; i < messages.length; i += MANUAL_SYNC_BATCH) {
                    const batch = messages.slice(i, i + MANUAL_SYNC_BATCH);
                    await Promise.all(batch.map((msg, k) => {
                        // [APERTURE] Come sopra: il saluto iniziale ha una stanza sua.
                        if (i + k === 0 && !msg.is_user) return registraApertura(wingId, msg.mes);
                        return scriviRicordo({ wing: wingId, room: msg.is_user ? "user" : "char", content: msg.mes });
                    }));
                    sentCount += batch.length;
                    syncBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t('btn_syncing', {count: sentCount, total: total})}`);
                    if (sentCount % 32 === 0) await new Promise(r => setTimeout(r, 80));
                }

                toastr.success(t('toast_sync_success', { count: total, name: wingId }));

                // Aggiorna l'indice di sync incrementale così l'auto-scan non ri-processa questi messaggi
                // [FIX-ISOLATION] usa per-chat key coerente con performAutoScanIfNeeded
                const _ctx = getContext();
                const _cId = _ctx.chatId;
                const _sk = _cId ? `mempalace_last_sync_idx_${wingId}_chat_${_cId}` : `mempalace_last_sync_idx_${wingId}`;
                localStorage.setItem(_sk, total);

                // Update final stats post sync
                refreshMemPalaceStats();

                syncBtn.css('background', '').css('border-color', '');
                syncBtn.html('<i class="fa-solid fa-rotate"></i> Sync Completed!');
                setTimeout(() => {
                     syncBtn.html('<i class="fa-solid fa-rotate"></i> Resync Chat (Manual)');
                }, 3000);
            } catch (err) {
                console.error("[MemPalace] Critical error during sync:", err);
                toastr.error("Sync interrupted. Check console logs.");
                syncBtn.css('background', '').css('border-color', '');
                syncBtn.html('<i class="fa-solid fa-rotate"></i> Resync Chat (Error)');
                setTimeout(() => {
                     syncBtn.html('<i class="fa-solid fa-rotate"></i> Resync Chat (Manual)');
                }, 3000);
            } finally {
                _isSyncing = false;
            }
        }
    });
    
    // --- BACKUP LOGIC ---
    const backupBtn = $('#mempalace-backup-btn');
    backupBtn.on('click', async () => {
        const wingId = getWingId();
        if (!wingId) return toastr.warning(t('toast_no_char'));

        backupBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t('btn_exporting')}`);

        try {
            // Full palace export: drawers + KG facts + diary
            const [drawersResult, kgResult, diaryResult] = await Promise.all([
                callMemPalace('mempalace_list_drawers', { wing: wingId, limit: 10000 }).catch(() => null),
                callMemPalace('mempalace_kg_query', { wing: wingId, entity: activeCharacterName || wingId }).catch(() => null),
                callMemPalace('mempalace_diary_read', { agent_name: getCharacterWingId() || wingId }).catch(() => null)
            ]);

            if (!drawersResult || drawersResult.error) {
                toastr.error('Error: ' + (drawersResult?.error || 'Offline'));
                return;
            }

            const exportData = {
                palace_export_version: '2.0',
                wing: wingId,
                exported_at: new Date().toISOString(),
                mp_version: _MP_VERSION,
                drawers: {
                    total: drawersResult.count,
                    items: drawersResult.drawers
                },
                kg: {
                    facts: kgResult?.facts || []
                },
                diary: {
                    entries: diaryResult?.entries || []
                }
            };

            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const safeName = wingId.replace(/[^a-z0-9_\-]/gi, '_');
            a.href = url;
            a.download = `mempalace_full_export_${safeName}_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);

            toastr.success(
                `Full Export: ${drawersResult.count} drawers, ${exportData.kg.facts.length} KG facts, ${exportData.diary.entries.length} diary entries`,
                'MemPalace Export'
            );
        } catch(e) {
            console.error('[MemPalace] Backup failed:', e);
            toastr.error('Error.');
        } finally {
            backupBtn.html('<i class="fa-solid fa-file-export"></i> ' + t('backup_btn'));
        }
    });

    // --- RESTORE LOGIC ---
    const restoreBtn = $('#mempalace-restore-btn');
    const restoreFileInput = $('#mempalace-restore-file-input');
    let restoreConfirmTimer = null;

    restoreBtn.on('click', () => {
        if (!restoreConfirmTimer) {
            restoreBtn.css('background', 'rgba(255, 200, 0, 0.25)').css('border-color', 'orange');
            restoreBtn.html('<i class="fa-solid fa-triangle-exclamation"></i> ' + t('conf_sure'));
            restoreConfirmTimer = setTimeout(() => {
                restoreConfirmTimer = null;
                restoreBtn.css('background', '').css('border-color', '');
                restoreBtn.html('<i class="fa-solid fa-file-import"></i> ' + t('restore_btn'));
            }, 3000);
        } else {
            clearTimeout(restoreConfirmTimer);
            restoreConfirmTimer = null;
            restoreBtn.css('background', '').css('border-color', '');
            restoreBtn.html('<i class="fa-solid fa-file-import"></i> ' + t('restore_btn'));
            restoreFileInput.val('');
            restoreFileInput.click();
        }
    });

    restoreFileInput.on('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        restoreBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t('btn_reading')}`);

        try {
            const text = await file.text();
            const backupData = JSON.parse(text);

            // Supporta sia formato v1 (drawers: [...]) che v2.0 (drawers: { total, items: [...] })
            const drawers = Array.isArray(backupData.drawers)
                ? backupData.drawers
                : (Array.isArray(backupData.drawers?.items) ? backupData.drawers.items : null);
            if (!drawers || !backupData.wing) {
                toastr.error(t('toast_restore_invalid'));
                return;
            }
            const total = drawers.length;

            if (total === 0) {
                toastr.info(t('toast_restore_empty'));
                return;
            }

            // [FIX-WINGNAME] canonicalCharKey() garantisce che backup con vecchio formato (es. "Character Name")
            // vengano ripristinati sulla wing corretta ("Character_Name") anche se il backup è pre-fix.
            const targetWing = canonicalCharKey(backupData.wing) || getWingId();

            let imported = 0;
            let skipped = 0;
            let errors = 0;

            // [B13] Batch-8 restore: was sequential ~30ms/entry → same batching as sync/ingest.
            const RESTORE_BATCH = 8;
            for (let i = 0; i < drawers.length; i += RESTORE_BATCH) {
                const batch = drawers.slice(i, i + RESTORE_BATCH).filter(d => d.content && d.room);
                errors += (drawers.slice(i, i + RESTORE_BATCH).length - batch.length);

                const batchResults = await Promise.all(batch.map(d =>
                    scriviRicordo({ wing: targetWing, room: d.room, content: d.content,
                                    source_file: d.source_file || 'backup_restore', added_by: 'restore' })
                ));
                batchResults.forEach(res => {
                    if (res && res.success) imported++;
                    else if (res && res.reason === 'duplicate') skipped++;
                    else errors++;
                });
                restoreBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${Math.min(i + RESTORE_BATCH, total)}/${total}...`);
                if (i % 32 === 0 && i > 0) await new Promise(r => setTimeout(r, 50));
            }

            toastr.success(
                t('toast_restore_success', {imported, skipped, errors}),
                'MemPalace Restore'
            );
            refreshMemPalaceStats();
        } catch(e) {
            console.error('[MemPalace] Restore failed:', e);
            toastr.error('Error: ' + e.message);
        } finally {
            restoreBtn.html('<i class="fa-solid fa-file-import"></i> ' + t('restore_btn'));
            restoreFileInput.val('');
        }
    });

    wipeBtn.on('click', async () => {
        const baseName = activeCharacterName || getActiveCharacterName();
        const wingId = getWingId();
        if (!wingId) {
            toastr.warning('No active character/chat.');
            return;
        }

        if (!wipeConfirmTimer) {
            wipeBtn.css('background', 'rgba(255, 255, 0, 0.4)').css('border-color', 'yellow');
            wipeBtn.html('<i class="fa-solid fa-triangle-exclamation"></i> ' + t('conf_sure'));
            
            wipeConfirmTimer = setTimeout(() => {
                wipeConfirmTimer = null;
                wipeBtn.css('background', '').css('border-color', '');
                wipeBtn.html('<i class="fa-solid fa-skull"></i> ' + t('wipe_btn'));
            }, 3000);
        } else {
            clearTimeout(wipeConfirmTimer);
            wipeConfirmTimer = null;
            
            wipeBtn.html('<i class="fa-solid fa-spinner fa-spin"></i> Erasing...');
            
            const result = await callMemPalace('mempalace_wipe', { wing: wingId });
            if (result && !result.error && result.success) {
                toastr.success(t('toast_wipe_success', { name: wingId }));
                localStorage.setItem('mempalace_synced_mem_' + wingId, 0);
                // [B3] Reset in-memory session state: stale cooldowns would block retrieval
                // on the next generation even though the backend data is gone.
                _fragmentSessionMemory.clear();
                _loreInjectionHistory.clear();
                _interceptorGenCount = 0;
                // Reset indice sync incrementale: dopo un wipe l'auto-scan deve ri-processare tutto
                // [FIX-ISOLATION] rimuove sia la chiave legacy wing-level sia quella per-chat corrente
                localStorage.removeItem('mempalace_last_sync_idx_' + wingId);
                const _wCtx = getContext();
                const _wCId = _wCtx.chatId;
                if (_wCId) localStorage.removeItem(`mempalace_last_sync_idx_${wingId}_chat_${_wCId}`);
                // [FIX-WIPE-KG-IDX] Anche l'indice dell'ESTRAZIONE continua va rimesso a zero.
                //
                // Era l'altra metà del guasto: `mempalace_last_sync_idx_*` tornava a zero e i
                // cassetti si ri-sincronizzavano, ma `mempalace_kg_extract_idx_*` restava
                // fermo al vecchio conteggio. L'estrattore continuo si convinceva di aver già
                // esaminato tutti i messaggi e non ne riguardava nemmeno uno: il grafo di un
                // personaggio azzerato non ricresceva più, per sempre, nemmeno continuando a
                // giocare. Si toglie sia la chiave della wing episodica sia quella
                // dell'identità, perché il wipe può arrivare da una delle due.
                localStorage.removeItem(`mempalace_kg_extract_idx_${wingId}`);
                // [APERTURE] Anche il segno "apertura gia' estratta": dopo un azzeramento
                // i fatti dell'apertura vanno rimessi come tutti gli altri.
                if (_wCId) localStorage.removeItem(`mempalace_apertura_estratta_${_wCId}`);
                const _wCharKey = getCharacterWingId();
                if (_wCharKey) localStorage.removeItem(`mempalace_kg_extract_idx_${_wCharKey}`);
                setExtensionPrompt('MemPalace RAG', '', extension_prompt_types.BEFORE_PROMPT, 0);
                // Il pannello "Ultima Iniezione RAG" mostrava ancora i frammenti pescati
                // prima dell'azzeramento: ricordi che non esistono più.
                window.mempalaceLastFished = null;
                updateRagPreviewPanel(null);
                // [FIX-WIPE-NUCLEO] Il Nucleo Biografico NON viene azzerato dal wipe.
                //
                // Vive in una wing sua (`wing_<nome minuscolo>`, creata da diary_write) e
                // `mempalace_wipe` cancella solo la wing che gli si passa: verificato, dopo
                // l'azzeramento il Nucleo è ancora tutto lì. Qui però lo si svuotava dal
                // prompto, quindi fino al cambio personaggio il personaggio restava senza
                // biografia mentre in archivio c'era, e ricompariva da sola più tardi:
                // sembrava un guasto. Si rilegge invece di cancellare, perché sono fatti
                // scritti a mano dall'utente e nessuno ha chiesto di buttarli.
                await updateDiaryContext(getCharacterWingId() || wingId);
                updateUIStatus(baseName, await callMemPalace('mempalace_status', { wing: wingId }));
            } else {
                const detail = (result && result.error) ? result.error : "Check bridge connection.";
                toastr.error(`Error erasing memory: ${detail}`);
            }

            wipeBtn.css('background', '').css('border-color', '');
            wipeBtn.html('<i class="fa-solid fa-skull"></i> ' + t('wipe_btn'));
        }
    });

    // Event Info Popups
    $(document).off('click.mempalaceInfo').on('click.mempalaceInfo', '.mp-info-icon', function() {
        const key = $(this).attr('data-mp-info');
        showMemPalaceInfo(key);
    });

    // Knowledge Browser: central router only, to avoid duplicated/overwritten bindings
    const kbRoot = $('#mempalace-kb-wrap');
    if (kbRoot.length) kbRoot.css({ 'pointer-events': 'auto', 'position': 'relative', 'z-index': 9999 });
    
    $(document).off('click.mempalaceKb').on('click.mempalaceKb', '#mempalace-kg-timeline-btn, #mempalace-kg-entities-btn, #mempalace-deepscan-btn, #mempalace-graph-btn, #mempalace-lore-link-btn', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const id = this.id;
        console.log('[MemPalace KB] routed', id);
        if (id === 'mempalace-kg-timeline-btn') return showKGTimeline();
        if (id === 'mempalace-kg-entities-btn') return showKGRegistry();
        if (id === 'mempalace-deepscan-btn') return performDeepKnowledgeScan();
        if (id === 'mempalace-graph-btn') return openSynapticMap();
        if (id === 'mempalace-lore-link-btn') return showLoreWingManager();
    });

    // Graph specific controls (can stay direct as they are part of the modal structure)
    $(document).off('click.mempalaceGraphClose').on('click.mempalaceGraphClose', '#mempalace-graph-close, .mp-graph-close-btn', function() {
        $('#mempalace-graph-modal').fadeOut(200);
    });
    $(document).off('click.mempalaceGraphRefresh').on('click.mempalaceGraphRefresh', '#mempalace-graph-refresh', function() {
        openSynapticMap();
    });
}

/**
 * Slash Command Registration
 */
function registerCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'diary',
        callback: async (args, value) => {
            // [H2] Fix: usare getWingId() (rispetta chat isolation) e agent_name: (coerente con UI save)
            // Prima: { wing: wingName } con bare name → diary scritto sotto 'Character Name'
            //                                         → updateDiaryContext leggeva 'Character_Name_chat_abc' → miss
            // Ora:   { agent_name: wingId } → stesso percorso del pulsante Salva nel pannello UI
            const wingId = getWingId();
            if (!wingId) {
                toastr.warning(t('toast_no_char'));
                return;
            }
            const displayName = activeCharacterName || getActiveCharacterName() || wingId;

            if (args.action === 'write') {
                if (!value) {
                    toastr.warning('Please provide diary content to write.');
                    return;
                }

                toastr.info(`MemPalace: Writing to diary for ${displayName}...`);
                const result = await callMemPalace('mempalace_diary_write', { agent_name: getCharacterWingId() || wingId, entry: value });

                if (result) {
                    await updateDiaryContext(getCharacterWingId() || wingId);
                    toastr.success(`Diary updated for ${displayName}.`, 'MemPalace');
                    return `Diary updated for ${displayName}.`;
                } else {
                    toastr.error(`Failed to update diary. Check backend connection.`, 'MemPalace');
                    return `Failed to update diary.`;
                }
            }
            return 'Usage: /diary action=write [text]';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'action', description: 'Action to perform', typeList: [ARGUMENT_TYPE.STRING], enumList: ['write'], isRequired: true })
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'The text to write to the diary', typeList: [ARGUMENT_TYPE.STRING] })
        ],
        returns: 'Status message',
        helpString: 'Manages the active character\'s MemPalace diary.'
    }));
}

// Setup Extension Module
/**
 * Diagnosi: stampa in console TUTTO ciò che le estensioni stanno iniettando nel
 * prompt, e segnala le forme che un modello piccolo tende a copiare.
 *
 * Esiste perché l'origine di un artefatto di formattazione non si indovina: va
 * guardata. Da console, con la chat aperta:  mempalaceDumpPrompt()
 */
window.mempalaceDumpPrompt = function () {
    const sorgenti = {};
    try {
        const ctx = getContext();
        const p = (ctx && ctx.extensionPrompts) || window.extension_prompts || {};
        for (const [nome, voce] of Object.entries(p)) {
            const testo = (voce && (voce.value ?? voce.content ?? voce)) || '';
            if (typeof testo === 'string' && testo.trim()) sorgenti[nome] = testo;
        }
    } catch (e) {
        console.warn('[MemPalace] Non riesco a leggere gli extension prompts:', e);
    }

    console.log('%c=== COSA RICEVE IL MODELLO ===', 'font-weight:bold; font-size:1.1em');
    let totale = 0;
    for (const [nome, testo] of Object.entries(sorgenti)) {
        totale += testo.length;
        // Le tre forme che insegnano a un modello a impaginare invece di narrare.
        const quadre = testo.match(/\[[^\]\n]{0,60}\]/g) || [];
        const etichette = testo.match(/(?:^|\n)\s*[A-ZÀ-Þ][\w '’-]{1,28}\s*:/g) || [];
        const intestazioni = testo.match(/(?:^|\n)#{1,4}\s/g) || [];
        console.groupCollapsed(`${nome} · ${testo.length} car. | quadre: ${quadre.length} | etichette: ${etichette.length} | ### : ${intestazioni.length}`);
        console.log(testo);
        if (quadre.length) console.log('  parentesi quadre:', [...new Set(quadre)].slice(0, 12));
        if (etichette.length) console.log('  etichette:', [...new Set(etichette.map(s => s.trim()))].slice(0, 12));
        console.groupEnd();
    }
    console.log(`%cTOTALE iniettato: ${totale} caratteri da ${Object.keys(sorgenti).length} sorgenti`, 'font-weight:bold');
    console.log('Chi ha più quadre/etichette/### è il candidato più probabile per gli artefatti di formattazione.');
    return sorgenti;
};

/**
 * Diagnosi dell'estrazione dei fatti: prova tutta la catena su UN messaggio vero e
 * dice a quale passo si ferma.
 *
 * Esiste perché "non si vede niente" può voler dire cinque cose diverse, pulsante
 * sbagliato, spunta spenta, modello che non risponde, risposta non interpretabile,
 * salvataggio rifiutato, e distinguerle a occhio è impossibile.
 *
 * Da console:  await mempalaceProvaEstrazione()
 */
window.mempalaceProvaEstrazione = async function () {
    const wingId = getWingId();
    const charName = getCharacterWingId();
    console.log('%c=== PROVA ESTRAZIONE FATTI ===', 'font-weight:bold');
    console.log('1. personaggio      :', charName, '| wing:', wingId);
    if (!wingId) return console.error('   nessun personaggio attivo: apri una chat.');

    const spunta = localStorage.getItem('mempalace_llm_extract') === 'true';
    console.log('2. spunta "estrai col modello":', spunta ? 'ATTIVA' : 'SPENTA (userebbe il regex)');

    const ctx = getContext();
    const haApi = typeof ctx?.generateQuietPrompt === 'function';
    console.log('3. API di generazione:', haApi ? 'disponibile' : 'ASSENTE: impossibile estrarre col modello');

    const r = await callMemPalace('mempalace_list_drawers', { wing: wingId, limit: 20 });
    const cassetti = (r && r.drawers || []).filter(d => d.room === 'char' || d.room === 'user');
    console.log('4. cassetti episodici:', cassetti.length);
    if (!cassetti.length) return console.warn('   nessun messaggio in archivio per questa wing: sincronizza prima.');

    const d = cassetti.find(x => (x.content || '').length > 200) || cassetti[0];
    console.log('5. messaggio di prova:', (d.content || '').substring(0, 100) + '…');

    if (!haApi) return;
    console.log('6. chiedo al modello… (può metterci qualche secondo)');
    const fatti = await estraiFattiConModello(d.content, charName);
    console.log('7. fatti interpretati:', fatti.length, fatti);
    if (!fatti.length) {
        console.warn('   Il modello non ha restituito righe "soggetto | relazione | oggetto" utilizzabili.');
        console.warn('   Se succede su tutti i messaggi, il modello non segue il formato richiesto.');
        return;
    }

    const f = fatti[0];
    const salv = await callMemPalace('mempalace_kg_add', {
        subject: f.subject, predicate: f.predicate, object: f.object, wing: wingId,
    });
    console.log('8. salvataggio del primo fatto:', salv);
    const dopo = await callMemPalace('mempalace_kg_query', { wing: wingId });
    console.log('9. fatti ora nella wing:', dopo && dopo.count);
    console.log('%cSe il passo 8 dice success e il 9 è cresciuto, la catena funziona: lancia Deep Knowledge Scan.', 'font-weight:bold');
    return fatti;
};

/** Lancia il Deep Scan da console, senza cercare il pulsante. */
window.mempalaceDeepScan = () => performDeepKnowledgeScan();

jQuery(async () => {
    try {
        if (typeof eventSource !== 'undefined') {
            // Prima di tutto il resto: se la lore è stata migrata nelle wing dedicate,
            // il collegamento personaggio→libri deve esistere già alla prima
            // generazione, altrimenti Phase A cerca in una wing sola e non trova il
            // mondo. È un await breve su un file locale e fallisce in silenzio.
            await importaRegistroLore();

            // Fine o interruzione della generazione: sblocca l'estrazione continua.
            // Serve soprattutto per lo STOP manuale, dove onMessageReceived non arriva.
            for (const ev of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
                if (event_types[ev]) {
                    eventSource.on(event_types[ev], () => {
                        _generazioneInCorso = false;
                        if (_sbloccoGenerazione) { clearTimeout(_sbloccoGenerazione); _sbloccoGenerazione = null; }
                    });
                }
            }

            eventSource.on(event_types.CHAT_CHANGED, onCharacterSelected);
            eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
            eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

            await setupUI();
            registerCommands();
            
            console.log('[MemPalace] Extension loaded successfully.');
        } else {
            console.error('[MemPalace] Failed to load: eventSource is undefined.');
        }
    } catch (e) {
        console.error('[MemPalace] Error during extension initialization:', e);
    }
});
