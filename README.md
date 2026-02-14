# niuniu

一个轻量的牛牛联机积分系统，包含：

- `tool/`：房间、身份认领、提交、结算、历史记录（Node.js 服务 + 前端页面）
- `tts-service/`：结算语音播报服务（FastAPI + edge-tts）

## 功能

- 多设备加入同一房间
- 玩家认领身份并提交本局结果
- 自动结算与积分榜
- 房主管理玩家、切庄、开新局、撤销、清空战绩
- 可选 TTS 自动播报（庄家设备触发）

## 项目结构

```text
.
├─ start_all.bat
├─ tool/
│  ├─ index.html
│  ├─ app.js
│  └─ server.js
└─ tts-service/
   ├─ requirements-tts.txt
   └─ tts_server.py
```

## 环境要求

- Node.js 18+
- Python 3.9+

## 快速启动（Windows）

在仓库根目录执行：

```bat
start_all.bat
```

脚本会：

- 检查 Node/Python
- 自动安装 TTS 依赖（若缺失）
- 启动 `tool`（`5173`）和 `tts-service`（`8000`）
- 自动打开浏览器

## 手动启动（跨平台）

1. 启动业务服务

```bash
cd tool
node server.js
```

2. 启动 TTS 服务（可选）

```bash
cd tts-service
python -m pip install -r requirements-tts.txt
python tts_server.py
```

3. 访问页面

- 无 TTS：`http://localhost:5173`
- 指定 TTS：`http://localhost:5173/?tts=http://127.0.0.1:8000`

## 常见问题

- `TTS 服务不可用`：确认 `tts-service` 已启动，且 `8000` 端口可访问。
- `edge-tts` 导入失败：在 `tts-service` 执行 `python -m pip install -r requirements-tts.txt`。
- 局域网访问：使用运行 `tool/server.js` 设备的局域网 IP 替换 `localhost`。

## 接口

- 工具服务健康检查：`GET /api/health`
- TTS 服务健康检查：`GET /health`

## License

[MIT](./LICENSE)
