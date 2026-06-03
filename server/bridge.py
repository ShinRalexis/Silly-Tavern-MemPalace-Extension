import sys
import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware # Nuova importazione
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

# --- CONFIGURAZIONE CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Permette chiamate da qualsiasi origine (Silly Tavern compresa)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
        result = handler(**args)
        
        if isinstance(result, dict):
            # Inietta "count" per compatibilità con la UI Javascript cachata
            if tool_name == "mempalace_status" and "total_drawers" in result:
                result["count"] = result["total_drawers"]
            return result
            
        return {"result": result}
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
