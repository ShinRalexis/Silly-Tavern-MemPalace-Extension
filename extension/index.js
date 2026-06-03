import { getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../script.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { world_names } from '../../world-info.js';

// ── VERSION MARKER (module-level, impostato appena il modulo carica) ──────────
// Per verificare quale versione è in memoria: console → window.MEMPALACE_VERSION
window.MEMPALACE_VERSION = 'v3.10-stable';
console.log('[MemPalace] Module loaded:', window.MEMPALACE_VERSION);

const MEMPALACE_URL = 'http://localhost:8052';
let activeCharacterName = null;
let _charSelectedGen = 0; // [R1] generation counter per cancellare invocazioni sovrapposte di onCharacterSelected
window.localWipedWings = window.localWipedWings || {};

// Cache AAAK dialect: evita una chiamata API extra a ogni generazione
let _aaakDialectCache = null;
let _aaakDialectWingId = null;

// ── SESSION NARRATIVE MEMORY ─────────────────────────────────────────────────────
// Traccia tutti i frammenti iniettati durante la sessione con il numero di generazione.
// Due obiettivi:
//   1. FRESHNESS SORT: frammenti mai visti (o visti da molte gen.) vengono prima nel budget —
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

// [C10] Module-level: NER extractor — was recreated inside the interceptor closure each generation.
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

// [C10] Module-level: room hint extractor — used _ROOM_HINT_PATTERNS (declared above).
function extractRoomHint(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const { kw, re } of _ROOM_HINT_PATTERNS) {
        if (re.test(lower)) return kw;
    }
    return null;
}

// [C10] Module-level: isSecret — tiny helper, was recreated inside interceptor each gen.
function isSecret(text) {
    const secretTags = ['[SECRET]', '[SEGRETO]', '[PRIVATE]', '[PRIVATO]', '[HIDDEN]', '[NASCOSTO]'];
    const upper = text.toUpperCase();
    return secretTags.some(tag => upper.includes(tag));
}

// [C10] Module-level: sanitizeContent — was recreated inside interceptor each gen, compiling
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
        .replace(/[=─*_]{3,}/g, '')
        .replace(/([#\-*]\s?){3,}/g, '')
        .replace(/\[(UNDEVELOPED|NULL|HIDDEN|UNKNOWN|EMPTY|NO-RAG)\]/gi, '')
        .replace(/\{\{[^}]+\}\}/g, '')
        .replace(/^\{[^:{}]+:\s*-?\s*/gm, '')
        .replace(/^\}\s*$/gm, '')
        .replace(/\[[A-Z][A-Za-z0-9\s''àáâèéêìíîòóôùúû]+\s+-\s+[A-Za-z0-9\s]+\]/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// [L1] KG subject quality filter — array module-level per evitare riallocazione ad ogni iterazione forEach
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
 * Helper: Calcola l'ID univoco per l'invio al MemPalace in base all'isolamento.
 */
function getWingId() {
    // [R14] Always sync the module-level cache against the live ST context before use.
    // activeCharacterName can be stale when onCharacterSelected fires but returns early
    // (context not ready yet): in that case all subsequent getWingId() calls return the
    // previous character's wing, silently routing lore ingestion and RAG queries to the
    // wrong character. Using getActiveCharacterName() as the authoritative source and
    // updating the cache here keeps all paths consistent for any character.
    const liveChar = getActiveCharacterName();
    if (liveChar) activeCharacterName = liveChar;

    const charName = activeCharacterName;
    if (!charName) return null;

    // [FIX-WINGNAME] chiave canonica identica in tutti i path e in entrambe le modalità.
    const base = canonicalCharKey(charName);
    if (!base) return null;

    const mode = localStorage.getItem('mempalace_isolation') || 'character';
    if (mode === 'chat') {
        const context = getContext();
        if (context && context.chatId) {
            // Isolamento per-chat ("Isolata"): stessa base canonica + id chat.
            return `${base}_chat_${context.chatId}`;
        }
    }
    // Isolamento per-personaggio ("Globale"): solo la base canonica.
    return base;
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
            statMem.text(memCount).css('color', '#4ade80');
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
            let aaakLabel = '—';
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
            ragHitEl.text('—').css('color', '#aaa');
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
            text = text.substring(0, MAX_CHARS) + "\n\n[... CONTENT TRUNCATED FOR STABILITY. MOVE LONG TEXTS TO LOREBOOK (RAG) ...]";
            toastr.warning('Memory Nucleus too large! Truncated for safety.', 'MemPalace Alert', { timeOut: 10000 });
        }

        const diaryStr = `[Character Permanent Memory - Lore & Biography]\n${text}`;
        setExtensionPrompt('MemPalace Diary', diaryStr, extension_prompt_types.IN_PROMPT, extension_prompt_roles.SYSTEM);
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

    const wingId = getWingId();
    console.log(`[MemPalace] Character selected: ${activeCharacterName} (Wing: ${wingId})`);

    // Check status
    const status = await callMemPalace('mempalace_status', { wing: wingId });
    if (_charSelectedGen !== myGen) return; // [R1] personaggio cambiato durante l'await → annulla

    updateUIStatus(activeCharacterName, status);

    if (status) {
        // Read diary and inject
        await updateDiaryContext(wingId);
        if (_charSelectedGen !== myGen) return; // [R1] seconda guard dopo il diary await
    }

    // Perform passive auto-scan if setup checkbox requires it
    // [FIX-AUTOSCAN-GEN] passa myGen così la sync si cancella se il personaggio cambia durante i batch
    if (typeof window.mempalace_auto_scan === 'function') {
        window.mempalace_auto_scan(wingId, myGen);
    }

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
    await callMemPalace('mempalace_add_drawer', {
        wing: wingId,
        room: "user",
        content: lastMessage.mes
    });

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
const _MP_VERSION = 'v3.10-stable';
window['mempalace_generate_interceptor'] = async function(chat, contextSize, abort, type) {
    if (type === 'quiet') return;

    // PRIMA ESECUZIONE: mostra toast versione per confermare che il codice aggiornato è caricato
    if (!window._mpVersionShown) {
        window._mpVersionShown = true;
        toastr.info(`MemPalace ${_MP_VERSION} loaded`, 'MemPalace', { timeOut: 3000 });
        console.log(`[MemPalace ${_MP_VERSION}] Code loaded OK`);
    }

    window.mempalaceLastFished = null;
    // [R14] getWingId() now self-heals stale activeCharacterName from live context —
    // no separate recovery block needed. The null check below handles the true "no char" case.
    let wingId = getWingId();
    if (!wingId) {
        console.warn(`[MemPalace] Interceptor: no active character, RAG skipped.`);
        return;
    }
    console.log(`[MemPalace] Interceptor: wing="${wingId}" | char="${activeCharacterName}"`);

    // 1. ESTRAZIONE CONTESTO E QUERY EXPANSION
    const validChat = chat.filter(m => !m.is_system && m.mes);
    if (validChat.length === 0) return;

    const lastUserMsg = validChat.slice().reverse().find(m => m.is_user);
    const lastCharMsg = validChat.slice().reverse().find(m => !m.is_user);
    const recentHistory = validChat.slice(-5).map(m => m.mes).join('\n');

    const queryBase = lastUserMsg ? lastUserMsg.mes : "";
    const queryContext = lastCharMsg ? lastCharMsg.mes : "";
    const finalQuery = `${queryBase} ${queryContext}`.trim();

    if (finalQuery.length < 2) return;

    // Base per limiti adattativi (usato dall'Intent Router sotto)
    const qLen = queryBase.length;
    // Amplificazione Phase C via bitstring SQ: stati caotici (111xxx) indicano alta entropia narrativa
    // → il personaggio è in uno stato emotivo instabile → più echi personali nel prompt.
    let dynEchoLim = qLen > 150 ? 2 : 1;
    try {
        const _sqStates = window.__sillybridge?.quantumStates || window.characterQuantumStates || {};
        const _sqCharId = Object.keys(_sqStates).find(k => _sqStates[k]?.name === activeCharacterName || k.includes(activeCharacterName));
        if (_sqCharId) {
            const _sqBits = _sqStates[_sqCharId]?.last_collapse || '000000';
            const _sqChaos = (_sqBits.startsWith('111') || _sqBits.startsWith('110'));
            if (_sqChaos) dynEchoLim = Math.min(dynEchoLim + 1, 3);
        }
    } catch (_) { /* SQ non disponibile: dynEchoLim resta al valore base */ }

    // [C10] extractEntities, extractRoomHint moved to module level — no local redefinition needed.
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
    // [C10] IT_NOISE, EN_NOISE, buildSemanticCore moved to module level — no local redefinition.
    const semanticCore = buildSemanticCore(queryBase, contextEntities);

    // ── NARRATIVE WINDOW QUERY ───────────────────────────────────────────────────
    // Costruisce una query dai ULTIMI 4 messaggi (sia utente che personaggio) per
    // catturare l'ARCO NARRATIVO CORRENTE invece del singolo ultimo messaggio.
    // Esempio: se negli ultimi 4 turni si è parlato di pizza / Piero / cena romantica,
    // la narrative query = "pizza Piero cena romantica" — Phase B troverà ricordi
    // correlati a TUTTO l'arco, non solo all'ultima battuta.
    const narrativeWindowMsgs = validChat.slice(-4);
    const narrativeWindowText = narrativeWindowMsgs
        .map(m => m.mes.substring(0, 180))
        .join(' ');
    const narrativeQuery = buildSemanticCore(narrativeWindowText, contextEntities);

    // ── INTENT ROUTER ────────────────────────────────────────────────────────────
    // Classifica l'intenzione dell'utente per attivare solo le fasi necessarie.
    // Obiettivo: "pescare a risparmio" — non sparare tutto ogni volta.
    const lower = queryBase.toLowerCase();
    const intent = {
        // Lore: domande su come funziona qualcosa, sul mondo, su entità specifiche
        needsLore: contextEntities.length > 0 ||
            /\b(cos[aè]|come|perché|spieg|chi è|storia|cos'è|tell me|what is|how|why|explain|lore|world|funziona|significa)\b/.test(lower),
        // Echo personale: memorie soggettive, emozioni, ricordi diretti
        needsEcho: /\b(ricord|sento|provo|emozione|paura|amore|manc|penso|sembra|feel|remember|miss|love|afraid|think|seems|nostalg)\b/.test(lower),
        // Plot/eventi: cose accadute, luoghi visitati, eventi narrativi.
        // roomHint viene usato per Phase B room_hint param ma NON come trigger di needsPlot —
        // altrimenti l'intro del personaggio ("a Bar where you can rest") lo forza sempre a true.
        needsPlot: contextEntities.length > 0 ||
            /\b(andiamo|siamo stati|ieri|prima|quando|accad|succ|visit|event|happen|went|been|was there)\b/.test(lower),
        // Pura conversazione breve senza entità nel MESSAGGIO UTENTE → non serve lore enciclopedica.
        // [H1] Fix: usa _rawQueryEntities (prima del filter activeCharacterName).
        // "Character Name, stai bene?" → rawEntities=['Character Name'] → NON è pure chat → RAG si attiva.
        // Solo messaggi senza NESSUNA entità (nemmeno il nome del personaggio) sono isPureChat.
        // NOTA: roomHint continua ad essere escluso (l'intro del personaggio contiene location
        // che NON devono invalidare isPureChat — fix critico v2.4).
        isPureChat: queryBase.length < 60 && _rawQueryEntities.length === 0
    };

    // Limiti adattativi per fase — se l'intent non richiede una fase, limit=0 → skip call API
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
        const phaseBParams = { wing: wingId, query: narrativeQuery, limit: activePlotLim };
        if (roomHint) phaseBParams.room_hint = roomHint;
        // Esclude il room "lore" da Phase B: quello è responsabilità di Phase A.
        // Phase B deve pescare memorie episodiche (conversazioni, eventi), non encyclopedie.
        // Se il backend non supporta room_exclude, il parametro è ignorato silenziosamente.
        phaseBParams.room_exclude = "lore";

        const [lorePulse, plotPulse, echoPulse, neighborsPulse, ...kgPulseArr] = await Promise.all([
            // FASE A: Lore — query sul nucleo semantico (non sul messaggio grezzo); SKIP se chat pura
            activeLoreLim > 0
                ? callMemPalace('mempalace_search', { wing: wingId, room: "lore", query: semanticCore, limit: activeLoreLim }).catch(e => { console.warn('[MemPalace] Phase A failed:', e); return null; })
                : Promise.resolve(null),
            // FASE B: Plot/Eventi — SKIP se isPureChat
            activePlotLim > 0
                ? callMemPalace('mempalace_search', phaseBParams).catch(e => { console.warn('[MemPalace] Phase B failed:', e); return null; })
                : Promise.resolve(null),
            // FASE C: Echo personale — usa semanticCore (rumore rimosso; fallback a queryBase impossibile per design)
            activeEchoLim > 0
                ? callMemPalace('mempalace_search', { wing: wingId, query: semanticCore, limit: activeEchoLim, room_exclude: "lore" }).catch(e => { console.warn('[MemPalace] Phase C failed:', e); return null; })
                : Promise.resolve(null),
            // FASE E: Rete sociale — solo se ci sono entità da esplorare
            // [FIX-WINGNAME] entity usa wingId canonico invece di activeCharacterName stale
            needsNeighbors
                ? callMemPalace('mempalace_kg_neighbors', { entity: wingId, depth: 2 }).catch(e => { console.warn('[MemPalace] Phase E failed:', e); return null; })
                : Promise.resolve(null),
            // FASE D: Knowledge Graph multi-entità — [FIX-PHASE-D] filtra entità null/undefined
            ...kgEntities.filter(Boolean).map(entity => callMemPalace('mempalace_kg_query', { wing: wingId, entity }).catch(e => { console.warn(`[MemPalace] Phase D failed (${entity}):`, e); return null; }))
        ]);

        // [DBG] Phase-level raw results — helps diagnose why RAG returns 0 despite backend having data
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

        // [C10] isSecret and sanitizeContent moved to module level — no local redefinition needed.
        // 3. PROMPT CONSTRUCTION — usa header tradotto per evitare echo di meta-istruzioni in chat
        const ragHeader = t('rag_header');
        const ragInstruction = t('rag_instruction');
        let sharedHeader = `${ragHeader}\n${ragInstruction}\n\n`;

        // Integration of AAAK Dialect Protocol if enabled (con cache per wing — evita N+1 calls)
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
                    // il filtro è inerte — meglio che far passare lore che non dovrebbe.
                    const isLoreOrigin = res.room === 'lore' ||
                                          res.source_file?.startsWith('lorebook:') ||
                                          res.source?.startsWith('lorebook:') ||
                                          res.type === 'lore';
                    // Room secret: frammenti marcati come segreti non entrano mai nel prompt.
                    // Il personaggio "sa" ma non può dirlo — il KG li tratta normalmente.
                    if (res.room === 'secret' || res.source_file?.startsWith('secret:')) return;
                    // Filtro room: se skipLoreRoom=true, salta le entry lorebook
                    if (skipLoreRoom && isLoreOrigin) return;
                    // Filtro soglia: supporta sia score (similarity, alto=buono) che distance (basso=buono)
                    if (relevanceThreshold > 0) {
                        const sim = res.score !== undefined ? res.score
                                  : res.similarity !== undefined ? res.similarity
                                  : res.distance !== undefined ? (1 - res.distance)
                                  : 1;
                        if (sim < relevanceThreshold) return;
                    }

                    let rawContent = res.text || res.content || res.body || '';
                    if (!rawContent || typeof rawContent !== 'string') return;
                    // Self-echo filter: scarta frammenti che riformulano il messaggio corrente dell'utente
                    // [R15] Lore-origin fragments are encyclopedic background — exempt from self-echo filter.
                    // A user intro using the character's title vocabulary must not block lore retrieval.
                    if (!isLoreOrigin && isTooSimilarToQuery(String(rawContent))) return;

                    // Pulizia profonda del frammento per renderlo narrativo
                    // NOTA: va prima del cooldown check così usiamo la chiave sanitizzata (coerente con
                    // post-injection tracking che setta _loreInjectionHistory con la chiave sanitizzata).
                    let content = sanitizeContent(rawContent);
                    if (!content || content.length < 10) return; // Scarta frammenti troppo brevi o svuotati

                    // [R9] dedupeKey calcolato da `content` (post-sanitization), non da rawContent.
                    // Prima: rawContent "**Titolo**: testo" → key "**titolo**: testo..."
                    //        content "Titolo: testo"       → cooldown key "titolo: testo..."
                    // Le due chiavi divergevano → stesso frammento bypassava seenTexts E cooldown.
                    // Ora entrambe le chiavi usano la stessa stringa sanitizzata.
                    const dedupeKey = content.toLowerCase().trim().substring(0, 80);
                    // [R17] isLoreOrigin exempt from isAlreadyInRecentMind — same reasoning as R15.
                    // Lore fragments whose first 80 chars appear in recent messages (e.g., char card
                    // quoting the lorebook, or AI response that cited lore verbatim) must not be blocked.
                    if (seenTexts.has(dedupeKey) || (!isLoreOrigin && isAlreadyInRecentMind(content))) return;

                    // AUTO-RECLASSIFICAZIONE LORE (universale — tutte le fasi, inclusa Phase C isEcho=true):
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
                        // Pattern 1: "Sector 4 Slums: The Shadow District…" — Titolo: Sottotitolo Maiuscolo
                        const colonPattern   = /^[A-ZÀÁÂÃÄÅÆ][A-Za-zÀ-ÿ0-9\s'']{3,60}:\s+[A-ZÀÁÂÃÄÅÆ]/.test(content);
                        // Pattern 2: "Seventh Heaven Seventh Heaven is a bar…" — Titolo ripetuto (lorebook title + content concatenati)
                        // Cattura: titolo 3-50 chars ripetuto esattamente all'inizio
                        const repeatPattern  = /^([A-ZÀÁÂÃÄÅÆ][A-Za-zÀ-ÿ0-9\s''-]{3,50})\s+\1\b/.test(content);
                        if (colonPattern || repeatPattern) effectiveTag = '[Common-Vibe]';
                    }

                    // LORE COOLDOWN: si applica a tutti i [Common-Vibe] inclusi quelli reclassificati
                    // da qualsiasi fase — NON limitato a !isEcho come prima.
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

        // FASE D — INTEGRAZIONE KNOWLEDGE GRAPH (Fatti Strutturati)
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
            const sortedFacts = [...kgPulse.facts].sort((a, b) => kgConfidence(b) - kgConfidence(a));
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
                }
            });
        }

        // FASE E — RETE SOCIALE DEL PROTAGONISTA (Neighbors depth 2, fatti non ancora visti)
        if (neighborsPulse && neighborsPulse.facts && neighborsPulse.facts.length > 0) {
            neighborsPulse.facts.slice(0, 4).forEach(f => {
                const key = `${f.subject}|${f.predicate}|${f.object}`;
                if (seenFactKeys.has(key)) return;
                seenFactKeys.add(key);
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

        // === FASE F — KG-SEMANTIC BRIDGE (Associazione a catena) ===
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
        // GATING: disabilitato per isPureChat — la query bridge su fatti geografici/locazione
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
        memoryMap.fragments.sort((a, b) => {
            const keyA = a.replace(/^\[(?:Soul-Echo|Common-Vibe|Forbidden-Void)\]\s*/, '').toLowerCase().substring(0, 80);
            const keyB = b.replace(/^\[(?:Soul-Echo|Common-Vibe|Forbidden-Void)\]\s*/, '').toLowerCase().substring(0, 80);
            const memA = _fragmentSessionMemory.get(keyA);
            const memB = _fragmentSessionMemory.get(keyB);
            // Mai visto = freschezza massima (Infinity) → ordina per primo
            const freshnessA = memA ? (_interceptorGenCount - memA.lastGen) : Infinity;
            const freshnessB = memB ? (_interceptorGenCount - memB.lastGen) : Infinity;
            // Pareggio: preferisci frammenti visti meno volte in assoluto
            if (freshnessA === freshnessB) {
                const countA = memA ? memA.count : 0;
                const countB = memB ? memB.count : 0;
                return countA - countB;
            }
            return freshnessB - freshnessA; // descending: più fresco = prima
        });

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
        });

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
            const cleanFragments = memoryMap.fragments.map(f =>
                f.replace(/^\[(Soul-Echo|Common-Vibe|Forbidden-Void)\]\s*/, '')
            );
            const promptOutput = sharedHeader + "\n- " + cleanFragments.join('\n- ');

            setExtensionPrompt('MemPalace RAG', `\n${promptOutput}\n`, extension_prompt_types.BEFORE_PROMPT, 100);
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
async function onMessageReceived(messageId) {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const lastMessage = context.chat[context.chat.length - 1];
    if (lastMessage.is_system) return;
    
    const wingId = getWingId();
    if (!wingId) return;
    
    // Save to room_history
    await callMemPalace('mempalace_add_drawer', {
        wing: wingId,
        room: "char",
        content: lastMessage.mes
    });

    // Auto-scan for facts if enabled
    if (localStorage.getItem('mempalace_autoscan') === 'true') {
        callMemPalace('mempalace_extract_facts', { 
            text: lastMessage.mes, 
            character: wingId, 
            save: true 
        }).catch(e => console.error("[MemPalace] Auto-scan error (Char):", e));
    }
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

// F4 — Auto-diary: ogni AUTO_DIARY_INTERVAL generazioni, riassume i fatti KG recenti nel diary
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
        const entry = `[Auto-Memo — Gen ${_interceptorGenCount}]\n${topFacts}`;
        await callMemPalace('mempalace_diary_write', { agent_name: wingId, entry });
        console.log(`[MemPalace] Auto-diary written at gen ${_interceptorGenCount}`);
    } catch (e) {
        console.warn('[MemPalace] Auto-diary failed (non-critical):', e);
    }
}

/**
 * --- KNOWLEDGE BROWSER LOGIC ---
 */

async function showKGTimeline() {
    const wingId = getWingId();
    if (!wingId) return toastr.warning(t('toast_no_char'));

    console.log('[MemPalace] Fetching Timeline for wing:', wingId);
    
    // Fetch all events for the current wing context
    const result = await callMemPalace('mempalace_kg_timeline', { entity: null, wing: wingId });
    console.log('[MemPalace] Timeline result:', result);
    
    let html = '<div class="mempalace-lore-list" style="max-height: 60vh; overflow-y: auto; padding-right: 10px;">';
    if (!result || !result.timeline || result.timeline.length === 0) {
        html += `
            <div style="text-align:center; opacity:0.6; padding:40px;">
                <i class="fa-solid fa-hourglass-empty" style="font-size: 3em; margin-bottom: 15px; display: block; color: var(--mp-void);"></i>
                <p>${t('kg_no_timeline', { default: 'No temporal facts recorded for this timeline yet.' })}</p>
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

async function showKGRegistry() {
    const wingId = getWingId();
    if (!wingId) return toastr.warning(t('toast_no_char'));

    const result = await callMemPalace('mempalace_kg_query', { entity: null, wing: wingId });
    
    let html = '<div class="mempalace-lore-list" style="max-height: 50vh; overflow-y: auto; padding-right: 10px;">';
    
    if (!result || !result.facts || result.facts.length === 0) {
        html += `<p style="text-align:center; opacity:0.6; padding:20px;">No established facts found.</p>`;
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
                html += `<div style="font-size: 0.9em; margin-bottom: 4px; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.05);">`;
                html += `<b style="color: #c084fc;">${escHtml((f.predicate || '').replace(/_/g, ' '))}:</b> ${escHtml(f.object || '')}`;
                html += `</div>`;
            });
            html += `</div></div>`;
        }
    }
    html += '</div>';

    showMemPalaceModal('Entity Registry', html, 'fa-users-rectangle', 'var(--mp-void)');
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
        
        // [FIX-WINGNAME] usa canonicalCharKey per coerenza con getWingId() — trim() da solo non basta
        let charName = canonicalCharKey(activeCharacterName || getActiveCharacterName() || '');
        // Fetch all nodes and edges belonging to the current wing
        const data = await callMemPalace('mempalace_get_graph', { character: charName, wing: wingId });
        $('#mempalace-graph-loading').hide();

        const container = document.getElementById('mempalace-graph-container');
        const legendContainer = $('#mempalace-graph-legend');
        
        if (!data || !data.nodes || data.nodes.length === 0) {
            $(container).html('<div style="display:flex; flex-direction: column; align-items:center; justify-content:center; height:100%; color:#aaa; font-style:italic; gap: 15px;"><i class="fa-solid fa-circle-nodes" style="font-size: 3em; opacity: 0.2;"></i><span>Graph is empty for this character context.</span></div>');
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
                const nID = (n.id || '').toString().toLowerCase();
                // [FIX-WINGNAME] wingId è già canonico (canonicalCharKey); qui basta lowercase
                // per il confronto coi nodi del grafo, senza ri-normalizzazioni divergenti.
                const cID = (wingId || '').toString().toLowerCase().replace(/'/g, '');
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

const DEEP_SCAN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minuti — su chat >1000 messaggi il loop è l'unico rischio di blocco

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

        toastr.info(`Synaptic Resonance: Deep Scan initiated. Scanning up to ${scanLimit} narrative shards…`, null, { timeOut: 5000 });

        const result = await callMemPalace('mempalace_list_drawers', { wing: wingId, limit: scanLimit });
        if (!result || !result.drawers || result.drawers.length === 0) {
            toastr.warning('No memories found in the palace to scan.');
            return;
        }

        // Pulizia preliminare del rumore nel grafo
        await callMemPalace('mempalace_kg_purge_noise', {});

        let scanned = 0;
        let totalFacts = 0;

        const SCAN_BATCH = 8;
        const PROGRESS_EVERY = 40;
        for (let i = 0; i < result.drawers.length; i += SCAN_BATCH) {
            if (Date.now() - scanStart > DEEP_SCAN_TIMEOUT_MS) {
                timedOut = true;
                console.warn(`[MemPalace] Deep Scan timed out after ${Math.round(DEEP_SCAN_TIMEOUT_MS / 60000)} min at shard ${scanned}/${result.drawers.length}`);
                break;
            }
            const batch = result.drawers.slice(i, i + SCAN_BATCH);
            const prevScanned = scanned;
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
            if (Math.floor(scanned / PROGRESS_EVERY) > Math.floor(prevScanned / PROGRESS_EVERY) && scanned < result.drawers.length) {
                const pct = Math.round(scanned / result.drawers.length * 100);
                toastr.info(`Deep Scan: ${pct}% (${scanned}/${result.drawers.length} shards…)`, null, { timeOut: 2000 });
            }
        }

        if (timedOut) {
            toastr.warning(`Deep Scan stopped after 5 min: ${scanned}/${result.drawers.length} shards processed, ${totalFacts} facts extracted.`);
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
        console.warn('[MemPalace] setupUI called more than once — skipping to prevent duplicate handlers.');
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
    
    const savedIsolation = localStorage.getItem('mempalace_isolation') || 'character';
    isolationMode.val(savedIsolation);
    
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
        localStorage.setItem('mempalace_isolation', newMode);

        // [FIX-ISOLATION-ORPHAN] Su cambio modalità, rimuovi le chiavi last_sync_idx
        // dell'altra modalità per il personaggio corrente: evita che al ritorno alla
        // vecchia modalità venga letto un indice stale e si salti la re-sync.
        const charBase = canonicalCharKey(activeCharacterName || getActiveCharacterName() || '');
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
            console.log(`[MemPalace] Isolation mode changed to '${newMode}' — cleared stale sync key for ${charBase}`);
        }

        // Se si cambia l'isolamento in diretta, facciamo un giro di status
        const currentWing = getWingId();
        if (currentWing) {
            const status = await callMemPalace('mempalace_status', { wing: currentWing });
            updateUIStatus(activeCharacterName || getActiveCharacterName(), status);
            await updateDiaryContext(currentWing);
        }
    });

    // [C2] isSyncing is now module-level (_isSyncing) — alias for readability inside setupUI.
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
                nucleusPreviewText.text('—');
                return;
            }
            nucleusPreviewText.text('...');
            const diaryData = await callMemPalace('mempalace_diary_read', { agent_name: wingId });
            if (diaryData && diaryData.entries && diaryData.entries.length > 0) {
                const fullText = [...new Set(diaryData.entries.map(e => (e.content ?? '').trim()).filter(s => s.length > 0))].join('\n');
                const preview = fullText.length > 300 ? fullText.substring(0, 300) + '…' : fullText;
                nucleusPreviewText.text(preview || '—');
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
            const diaryData = await callMemPalace('mempalace_diary_read', { agent_name: wingId });
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
            const block = `[KG — ${wingId}]\n` + lines.join('\n');

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
        const res = await callMemPalace('mempalace_diary_write', { agent_name: wingId, entry: rawText });
        
        if (res && res.success) {
            toastr.success(t('diary_save'), 'MemPalace Nucleus');
            diarySave.text(t('diary_save'));
            diaryTextarea.val('');
            diaryEditor.slideUp(200);
            nucleusPreviewLoaded = false; // Forza reload del preview al prossimo open
            nucleusPreview.removeClass('open');
            await updateDiaryContext(wingId);
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
        console.warn('[MemPalace] .inline-drawer-toggle not found — auto-refresh on open disabled.');
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
            // Parallelizziamo in batch da 8 (come il Deep Scan) — riduce drasticamente i tempi
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
                await Promise.all(batch.map(msg =>
                    callMemPalace('mempalace_add_drawer', {
                        wing: wingName,
                        room: msg.is_user ? "user" : "char",
                        content: msg.mes
                    })
                ));
                sentCount += batch.length;
                // Breve respiro ogni 4 batch (32 messaggi) per non bloccare il browser
                if (sentCount % 32 === 0) await new Promise(r => setTimeout(r, 80));
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
        // indefinitely if the user has no lorebooks — memory leak on long sessions.
        if (worlds.length === 0) {
            if (_loreListRetries < 10) {
                _loreListRetries++;
                console.log(`[MemPalace] world_names is empty, retrying in 1s… (${_loreListRetries}/10)`);
                setTimeout(updateLoreList, 1000);
            } else {
                console.log('[MemPalace] world_names still empty after 10 retries — no lorebooks found.');
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
            // [FIX-CHAR-EXPAND] expand {{char}}/{{character}} → nome canonico prima del filtro,
            // così entry come "{{char}} è gentile" vengono ingestate come "Character_Name è gentile".
            // Skip solo se rimangono macro dinamiche ({{user}}, {{persona}}, {{original}}).
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
                if (charRef) expanded = expanded.replace(/\{\{(?:char|character)\}\}/gi, charRef);
                expanded = expanded.replace(/\{\{(?:user|persona)\}\}/gi, 'you');
                expanded = expanded.replace(/\{\{[^}]+\}\}/g, '').trim(); // rimuovi macro residue
                if (!expanded) { count++; skipped++; continue; } // salta solo se rimane vuota
                const keys = Array.isArray(entry.key) ? entry.key.join(', ') : '';
                validEntries.push(keys ? `[Key: ${keys}]\n${expanded}` : expanded);
            }

            // [B12] Batch-8 ingestion: was sequential ~30ms/entry → same batching as sync/auto-scan.
            const INGEST_BATCH = 8;
            for (let i = 0; i < validEntries.length; i += INGEST_BATCH) {
                const batch = validEntries.slice(i, i + INGEST_BATCH);
                const batchResults = await Promise.all(batch.map(fullText =>
                    callMemPalace('mempalace_add_drawer', {
                        wing: wingId,
                        room: "lore",
                        content: fullText,
                        source_file: `lorebook:${bookName}`
                    })
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

            const skippedNote = skipped > 0 ? ` (+${skipped} saltati: [NO-RAG])` : '';
            if (errors > 0) {
                toastr.warning(t('toast_ingest_warn', {saved, duplicates, errors}) + skippedNote);
            } else if (duplicates > 0 || skipped > 0) {
                toastr.success(t('toast_ingest_success', {saved, duplicates}) + skippedNote);
            } else {
                toastr.success(t('toast_ingest_done', {saved, bookName}));
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
            const result = await callMemPalace('mempalace_list_drawers', { wing: wingId, room: "lore", limit: 1000 });
            $list.empty();

            if (!result || !result.drawers || result.drawers.length === 0) {
                $list.append('<div style="text-align:center; padding:20px; opacity:0.6;">No ingested lore found for this character.</div>');
            } else {
                result.drawers.forEach(item => {
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
            
            if (confirm('Permanently delete this lore entry from MemPalace?')) {
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
    // Notifica SQ (o chiunque ascolti) che MP è pronto — utile se SQ ha caricato prima
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
                    await Promise.all(batch.map(msg =>
                        callMemPalace('mempalace_add_drawer', {
                            wing: wingId,
                            room: msg.is_user ? "user" : "char",
                            content: msg.mes
                        })
                    ));
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
                callMemPalace('mempalace_diary_read', { agent_name: wingId }).catch(() => null)
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
                    callMemPalace('mempalace_add_drawer', {
                        wing: targetWing,
                        room: d.room,
                        content: d.content,
                        source_file: d.source_file || 'backup_restore',
                        added_by: 'restore'
                    })
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
                setExtensionPrompt('MemPalace RAG', '', extension_prompt_types.BEFORE_PROMPT, 0);
                setExtensionPrompt('MemPalace Diary', '', extension_prompt_types.IN_PROMPT, extension_prompt_roles.SYSTEM);
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
    
    $(document).off('click.mempalaceKb').on('click.mempalaceKb', '#mempalace-kg-timeline-btn, #mempalace-kg-entities-btn, #mempalace-deepscan-btn, #mempalace-graph-btn', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const id = this.id;
        console.log('[MemPalace KB] routed', id);
        if (id === 'mempalace-kg-timeline-btn') return showKGTimeline();
        if (id === 'mempalace-kg-entities-btn') return showKGRegistry();
        if (id === 'mempalace-deepscan-btn') return performDeepKnowledgeScan();
        if (id === 'mempalace-graph-btn') return openSynapticMap();
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
                const result = await callMemPalace('mempalace_diary_write', { agent_name: wingId, entry: value });

                if (result) {
                    await updateDiaryContext(wingId);
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
jQuery(async () => {
    try {
        if (typeof eventSource !== 'undefined') {
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
