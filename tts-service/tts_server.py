import hashlib
import random
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

try:
  import edge_tts
except ImportError:
  edge_tts = None


app = FastAPI(title="Niuniu Vibe TTS Service")
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"]
)

CACHE_DIR = Path(__file__).resolve().parent / "audio_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

VOICE = "zh-CN-XiaoxiaoNeural"
RATE = "+8%"
VOLUME = "+0%"
PITCH = "+0Hz"

TEMPLATES = {
  "win": [
    "大杀四方，庄家{name}本局净赢{score}分。",
    "状态在线，庄家{name}稳稳收下{score}分。",
    "节奏拉满，庄家{name}这一局进账{score}分。"
  ],
  "lose": [
    "风水轮流转，庄家{name}本局净输{score}分。",
    "这局有点可惜，庄家{name}让出{score}分。",
    "暂时失利，庄家{name}本局掉了{score}分。"
  ],
  "tie": [
    "势均力敌，庄家{name}本局打平。",
    "双方握手言和，庄家{name}本局平局。"
  ]
}


def _safe_name(name: str) -> str:
  text = str(name or "").strip()
  if not text:
    return "庄家"
  return text[:18]


def _format_score(delta: float) -> str:
  value = round(abs(float(delta)), 2)
  if value.is_integer():
    return str(int(value))
  return f"{value:.2f}".rstrip("0").rstrip(".")


def _build_text(name: str, delta: float) -> str:
  safe_name = _safe_name(name)
  score = _format_score(delta)
  if delta > 0:
    template = random.choice(TEMPLATES["win"])
  elif delta < 0:
    template = random.choice(TEMPLATES["lose"])
  else:
    template = random.choice(TEMPLATES["tie"])
  return template.format(name=safe_name, score=score)


def _cache_path(text: str) -> Path:
  key = f"{VOICE}|{RATE}|{VOLUME}|{PITCH}|{text}"
  digest = hashlib.sha1(key.encode("utf-8")).hexdigest()
  return CACHE_DIR / f"{digest}.mp3"


@app.get("/health")
async def health():
  return {
    "ok": True,
    "edge_tts_available": edge_tts is not None,
    "cache_dir": str(CACHE_DIR)
  }


@app.get("/announce")
async def announce(
  name: str = Query(..., min_length=1, max_length=18),
  delta: float = Query(...)
):
  text = _build_text(name, delta)
  file_path = _cache_path(text)

  if not file_path.exists():
    if edge_tts is None:
      raise HTTPException(
        status_code=500,
        detail="edge-tts 未安装，请先执行: pip install -r requirements-tts.txt"
      )
    try:
      communicate = edge_tts.Communicate(
        text=text,
        voice=VOICE,
        rate=RATE,
        volume=VOLUME,
        pitch=PITCH
      )
      await communicate.save(str(file_path))
    except Exception as exc:
      raise HTTPException(status_code=500, detail=f"TTS 生成失败: {exc}") from exc

  return FileResponse(
    path=file_path,
    media_type="audio/mpeg",
    filename=file_path.name,
    headers={"Cache-Control": "no-store"}
  )


if __name__ == "__main__":
  import uvicorn

  print("TTS 服务启动中，默认端口 8000")
  uvicorn.run(app, host="0.0.0.0", port=8000)
