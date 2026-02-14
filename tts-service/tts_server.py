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
    "节奏拉满，庄家{name}这一局进账{score}分。",
    "手气爆棚，庄家{name}直接带走{score}分。",
    "气势如虹，庄家{name}笑纳{score}分。",
    "操作丝滑，庄家{name}轻松斩获{score}分。",
    "牌面安排得明明白白，庄家{name}拿下{score}分。",
    "财神站台，庄家{name}又进账{score}分。",
    "对手一脸问号，庄家{name}顺走{score}分。",
    "稳中带秀，庄家{name}把{score}分收入囊中。",
    "这一波操作直接封神，庄家{name}狂揽{score}分。",
    "局势尽在掌握，庄家{name}优雅收割{score}分。"
  ],
  "lose": [
    "风水轮流转，庄家{name}本局净输{score}分。",
    "这局有点可惜，庄家{name}让出{score}分。",
    "暂时失利，庄家{name}本局掉了{score}分。",
    "手气打了个盹，庄家{name}送出{score}分。",
    "差那么一点点，庄家{name}惜败{score}分。",
    "运气请假中，庄家{name}让出了{score}分。",
    "对手火力全开，庄家{name}本局退让{score}分。",
    "节奏没踩稳，庄家{name}掉了{score}分。",
    "翻车现场，庄家{name}遗憾失去{score}分。",
    "小风波而已，庄家{name}暂失{score}分。",
    "这局被安排得明明白白，庄家{name}吐出{score}分。",
    "笑着流泪，庄家{name}本局交出{score}分。"
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
