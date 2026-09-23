"""
Embedding multilingue per MemPalace, con modello configurabile.

PERCHE' ESISTE
--------------
L'embedding di default di chromadb (all-MiniLM-L6-v2) e' addestrato sull'inglese e
su un archivio italiano rendeva malissimo. Misurato il 2026-08-08 su 16 domande
scritte come le farebbe l'utente, senza copiare le parole dei ricordi:

    modello                              recall@1   recall@5   MRR
    all-MiniLM (default)  + parafrasi      -          -        non trovava
    paraphrase-multilingual-MiniLM-L12    1/16       1/16      0.112
    multilingual-e5-small                 4/16       7/16      0.338
    multilingual-e5-base                  6/16      11/16      0.530   <-- scelto

Ri-spezzare i ricordi piu' fine (350 caratteri) aiutava il modello debole
(1/16 -> 6/16 su recall@5) ma PEGGIORA e5-base, che i passaggi lunghi li regge
bene da solo. Il collo di bottiglia era il modello, non la lunghezza dei pezzi.

Gira su onnxruntime + tokenizers, gia' dipendenze di chromadb: niente torch.

I PREFISSI NON SONO UN DETTAGLIO
--------------------------------
La famiglia E5 e' addestrata con "query: " davanti alle domande e "passage: "
davanti ai documenti. Senza, la qualita' crolla. Per questo __call__ (che chromadb
usa per i DOCUMENTI) e embed_query (che usa per le RICERCHE) mettono prefissi
diversi: e' l'unico punto in cui i due rami devono comportarsi in modo diverso.

CONFIGURAZIONE
--------------
<config_dir>/models/embedding.json descrive quale modello usare:

    {"dir": "e5-base", "query_prefix": "query: ", "doc_prefix": "passage: "}

Se il file manca si torna al default di chromadb. La configurazione sta nel config
del singolo palazzo, non nel codice, perche' lo stesso CODICE puo' servire piu' palazzi, ognuno col suo config e i suoi
dati: cosi' un palazzo senza embedding.json resta sul default coi suoi vettori
intatti, senza sapere nulla di tutto questo.

Cambiare modello RENDE INSERVIBILI i vettori gia' salvati: vanno rigenerati con
reindex_multilingual.py. Non cambiarlo senza re-indicizzare.
"""

import json
import os

import numpy as np
from chromadb.api.types import EmbeddingFunction

MAX_TOKENS = 512
_CONF = os.path.join("models", "embedding.json")


def _conf_path(config_dir: str) -> str:
    return os.path.join(config_dir, _CONF)


def leggi_config(config_dir: str):
    """La configurazione del modello, o None se questo palazzo non ne ha una."""
    p = _conf_path(config_dir)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            c = json.load(f)
    except Exception:
        return None
    base = os.path.join(config_dir, "models", c.get("dir", ""))
    if not os.path.isfile(os.path.join(base, "onnx", "model.onnx")):
        return None
    c["base"] = base
    return c


def is_available(config_dir: str) -> bool:
    return leggi_config(config_dir) is not None


# Soglia di rifiuto dei quasi-duplicati quando NON c'e' un modello configurato, cioe'
# per un palazzo che gira sul default di chromadb: la' 0.9 e'
# la taratura storica e va lasciata stare.
SOGLIA_DUPLICATI_DEFAULT = 0.9


def soglia_duplicati(config_dir: str) -> float:
    """
    Quanto due ricordi devono somigliarsi per considerarli lo stesso ricordo.

    MISURATO il 2026-08-08 su 285 ricordi, confronto passage-vs-passage con e5-base:
        coppie di stanze diverse   min 0.770  mediana 0.826  max 0.870
        coppie dello stesso tema   min 0.785  mediana 0.905  max 0.959
        stesso testo ritoccato     min 0.949  mediana 0.993  max 0.999
    Con e5 i punteggi stanno compressi in alto, quindi la vecchia soglia 0.9 rifiutava
    47 ricordi legittimi su 137: uno su tre buttato via in silenzio perche' parlava
    dello stesso tema di uno gia' salvato. A 0.965 non se ne perde nessuno e si
    riconoscono comunque 29 quasi-duplicati su 30.

    Il danno non e' simmetrico: un ricordo rifiutato per errore e' perso e non te ne
    accorgi, un duplicato in piu' e' solo un po' di disordine. La soglia pende dalla
    parte del conservare.
    """
    c = leggi_config(config_dir)
    if not c:
        return SOGLIA_DUPLICATI_DEFAULT
    return float(c.get("soglia_duplicati", 0.965))


class MultilingualONNXEmbedding(EmbeddingFunction):
    """
    Funzione di embedding compatibile con chromadb.

    Estende EmbeddingFunction e non e' una classe qualunque con __call__: chromadb
    chiama embed_query() sul ramo di ricerca, e senza la classe base si ottiene
    "object has no attribute 'embed_query'" solo in lettura, non in scrittura.

    Il modello si carica alla prima chiamata: importare il modulo non deve costare
    un gigabyte di RAM a un palazzo che poi non lo usa.
    """

    def __init__(self, base_dir: str, query_prefix: str = "", doc_prefix: str = ""):
        self._base = base_dir
        self._pq = query_prefix
        self._pd = doc_prefix
        self._session = None
        self._tokenizer = None

    @staticmethod
    def name() -> str:
        return "multilingual-onnx"

    def get_config(self):
        return {"base_dir": self._base, "query_prefix": self._pq, "doc_prefix": self._pd}

    @staticmethod
    def build_from_config(config):
        return MultilingualONNXEmbedding(
            config["base_dir"], config.get("query_prefix", ""), config.get("doc_prefix", "")
        )

    def _load(self):
        if self._session is not None:
            return
        import onnxruntime as ort
        from tokenizers import Tokenizer

        tok = Tokenizer.from_file(os.path.join(self._base, "tokenizer.json"))
        tok.enable_truncation(max_length=MAX_TOKENS)
        tok.enable_padding()
        self._tokenizer = tok

        opts = ort.SessionOptions()
        opts.log_severity_level = 3  # silenzia gli avvisi di device discovery
        self._session = ort.InferenceSession(
            os.path.join(self._base, "onnx", "model.onnx"),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        self._inputs = {i.name for i in self._session.get_inputs()}

    def _embed(self, testi, prefisso):
        if isinstance(testi, str):
            testi = [testi]
        testi = [prefisso + (t if isinstance(t, str) else str(t)) for t in testi]
        if not testi:
            return []
        self._load()

        fuori = []
        for p in range(0, len(testi), 32):  # a lotti: tiene la RAM bassa
            encs = self._tokenizer.encode_batch(testi[p : p + 32])
            ids = np.array([e.ids for e in encs], dtype=np.int64)
            mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self._inputs:
                feed["token_type_ids"] = np.zeros_like(ids)

            # Un vettore per token: la frase e' la media dei token VERI. Il padding
            # va escluso, altrimenti diluisce le frasi corte.
            hidden = self._session.run(None, feed)[0]
            m = mask[..., None].astype(np.float32)
            vecs = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
            norme = np.clip(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-9, None)
            fuori.append(vecs / norme)  # normalizzati: la collection usa lo spazio coseno

        return np.vstack(fuori).astype(np.float32).tolist()

    def __call__(self, input):
        """Ramo DOCUMENTI."""
        return self._embed(input, self._pd)

    def embed_query(self, input):
        """Ramo RICERCA: prefisso diverso, vedi nota sui prefissi in testa al modulo."""
        return self._embed(input, self._pq)


# Una sola istanza per palazzo, tenuta viva per tutta la vita del processo.
# Senza questa cache searcher.py ne creava una NUOVA a ogni ricerca, e siccome il
# modello si carica alla prima chiamata ogni ricerca rileggeva 1,1 GB di ONNX dal
# disco: 11 secondi a ricerca invece di poche centinaia di millisecondi. Misurato.
_CACHE = {}


def embedding_for(config_dir: str):
    """
    La funzione di embedding di questo palazzo.

    DA USARE OVUNQUE si apra la collection. Chi apre con get_collection() senza
    passarla si ritrova chromadb che vettorizza con il modello di default: le query
    finiscono in uno spazio diverso da quello dei documenti e i risultati diventano
    rumore con punteggi tutti negativi. E' successo davvero, in searcher.py.
    """
    if config_dir in _CACHE:
        return _CACHE[config_dir]

    c = leggi_config(config_dir)
    if c:
        fn = MultilingualONNXEmbedding(
            c["base"], c.get("query_prefix", ""), c.get("doc_prefix", "")
        )
    else:
        from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

        fn = DefaultEmbeddingFunction()

    _CACHE[config_dir] = fn
    return fn


# Compatibilita' con il codice che importava model_dir()
def model_dir(config_dir: str) -> str:
    c = leggi_config(config_dir)
    return c["base"] if c else ""
