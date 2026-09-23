"""
Ri-indicizza l'archivio con il modello di embedding multilingue.

Cambiare modello rende inservibili i vettori gia' salvati: sono coordinate di uno
spazio diverso. Il TESTO pero' e' salvato in chiaro, quindi si rigenerano i vettori
rileggendo i documenti. Nessun contenuto viene riscritto o interpretato.

COME SI USA (il bridge deve essere fermo, altrimenti due processi scrivono sullo
stesso sqlite). Dalla cartella server/, con gli stessi volumi di docker-compose.yml:

    docker compose stop mempalace
    docker compose run --rm mempalace python reindex_multilingual.py
    docker compose start mempalace

Con --dry-run non scrive nulla e si limita a dire quanti ricordi troverebbe.

La collection nuova viene costruita a parte e rinominata solo alla fine: se qualcosa
va storto a meta' strada, l'originale e' ancora li' intatta.
"""

import sys
import chromadb

from config import MempalaceConfig
from embed_multilingual import embedding_for, is_available, leggi_config

LOTTO = 64  # documenti per passata: tiene la RAM bassa e da' un avanzamento leggibile


def main():
    secco = "--dry-run" in sys.argv
    cfg = MempalaceConfig()

    conf = leggi_config(cfg.config_dir)
    if not conf:
        print(f"ERRORE: nessun modello configurato in {cfg.config_dir}/models/embedding.json")
        print("Scrivilo prima, oppure stai lanciando lo script sul palazzo sbagliato.")
        return 1
    print(f"Modello: {conf['base']}")

    client = chromadb.PersistentClient(path=cfg.palace_path)
    nome = cfg.collection_name

    try:
        vecchia = client.get_collection(nome)
    except Exception as e:
        print(f"ERRORE: collection '{nome}' non apribile: {e}")
        return 1

    dati = vecchia.get(include=["documents", "metadatas"])
    ids = dati.get("ids") or []
    docs = dati.get("documents") or []
    metas = dati.get("metadatas") or []
    print(f"Trovati {len(ids)} ricordi nella collection '{nome}'.")

    # Un documento vuoto non e' rappresentabile come vettore: si salta e lo si dice,
    # invece di far fallire l'intero lotto in cui capita.
    tenuti = [(i, d, m) for i, d, m in zip(ids, docs, metas) if d and str(d).strip()]
    saltati = len(ids) - len(tenuti)
    if saltati:
        print(f"{saltati} ricordi senza testo: verranno saltati (non erano ricercabili comunque).")

    if secco:
        print(f"[dry-run] Ne re-indicizzerei {len(tenuti)}. Nessuna modifica fatta.")
        return 0

    tmp = f"{nome}__multilingual_tmp"
    try:
        client.delete_collection(tmp)  # resto di un tentativo precedente interrotto
    except Exception:
        pass

    # Spazio COSENO, non L2. I vettori sono normalizzati, quindi con lo spazio l2
    # chroma restituisce la distanza euclidea al quadrato e il punteggio 1-distanza
    # finisce compresso in una banda illeggibile, con veri positivi negativi. Con il
    # coseno la distanza e' 1-cos, quindi 1-distanza E' il coseno: da 0 a 1, stabile
    # e confrontabile fra ricerche diverse.
    nuova = client.create_collection(
        tmp,
        embedding_function=embedding_for(cfg.config_dir),
        metadata={"hnsw:space": "cosine"},
    )

    for p in range(0, len(tenuti), LOTTO):
        pezzo = tenuti[p : p + LOTTO]
        nuova.add(
            ids=[x[0] for x in pezzo],
            documents=[x[1] for x in pezzo],
            metadatas=[x[2] or {} for x in pezzo],
        )
        print(f"  {min(p + LOTTO, len(tenuti))}/{len(tenuti)}", flush=True)

    scritti = nuova.count()
    if scritti != len(tenuti):
        print(f"ERRORE: attesi {len(tenuti)} documenti, scritti {scritti}. Non tocco l'originale.")
        return 1

    # Scambio: l'originale diventa un backup dentro chroma, la nuova prende il suo nome.
    # Il nome del backup porta la data: al secondo giro un nome fisso collide con il
    # backup del primo e lo scambio fallisce a lavoro gia' fatto (successo davvero).
    from datetime import datetime

    backup = f"{nome}__prima_del_{datetime.now():%Y%m%d_%H%M}"
    vecchia.modify(name=backup)
    nuova.modify(name=nome)
    print(f"Fatto: {scritti} ricordi re-indicizzati.")
    print(f"La collection precedente resta come '{backup}' (cancellabile a mano).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
