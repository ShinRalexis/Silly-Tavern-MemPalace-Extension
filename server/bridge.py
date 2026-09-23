import sys
import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware # Nuova importazione
from starlette.concurrency import run_in_threadpool
import uvicorn
import json

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from mcp_server import TOOLS
    print("✅ MemPalace Tools caricati!")
except ImportError as e:
    print(f"❌ Errore moduli: {e}")
    sys.exit(1)

app = FastAPI(title="MemPalace SillyTavern Bridge")

# --- CORS: localhost only, no credentials ---
# SillyTavern runs on localhost; wildcard origin + credentials is a CSRF risk.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost",
        "http://localhost:8000",
        "http://localhost:8080",
        "http://localhost:8081",
        "http://127.0.0.1",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:8081",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-MemPalace-Version"],
)

@app.get("/")
async def root():
    return {"status": "MemPalace is online", "mode": "SillyTavern Bridge"}

@app.post("/call/{tool_name}")
async def call_tool(tool_name: str, request: Request):
    try:
        body = await request.body()
        try:
            args = json.loads(body.decode('utf-8'))
        except UnicodeDecodeError:
            # Fallback to latin-1 if utf-8 fails (handles Italian accents)
            args = json.loads(body.decode('latin-1'))
        if tool_name not in TOOLS:
            return {"error": f"Tool '{tool_name}' non trovato"}
        handler = TOOLS[tool_name]["handler"]
        # I tool sono funzioni SINCRONE: chiamarle direttamente qui dentro, in un
        # endpoint `async`, blocca l'event loop per tutta la loro durata. Le
        # richieste finiscono in fila una dietro l'altra anche quando il client le
        # manda insieme, e il `Promise.all` delle sei fasi del RAG sembrava
        # parallelo senza esserlo. Misurato: le fasi costano 141+140+140+60+93+48 ms
        # una alla volta, e "in parallelo" ne costavano 580-637, cioe' esattamente
        # la somma. run_in_threadpool le sposta su thread: sei fasi costano quanto
        # la piu' lenta, non quanto tutte insieme.
        result = await run_in_threadpool(handler, **args)
        
        if isinstance(result, dict):
            # Inietta "count" per compatibilità con la UI Javascript cachata
            if tool_name == "mempalace_status" and "total_drawers" in result:
                result["count"] = result["total_drawers"]
            return result
            
        return {"result": result}
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    # Loopback by default when run directly. Inside Docker the container must listen
    # on 0.0.0.0 for the port mapping to reach it: docker-compose sets HOST=0.0.0.0
    # and publishes the port on 127.0.0.1 only, so it stays local to the machine.
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")))
