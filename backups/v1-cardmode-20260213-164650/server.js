"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;

const SUITS = [
  { id: "spade", label: "黑桃", w: 4 },
  { id: "heart", label: "红桃", w: 3 },
  { id: "club", label: "梅花", w: 2 },
  { id: "diamond", label: "方块", w: 1 }
];

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const TYPE_TEMPLATE = [
  ["no_niu", "没牛", 0, 1, true],
  ["niu_1", "牛1", 1, 1, true],
  ["niu_2", "牛2", 2, 1, true],
  ["niu_3", "牛3", 3, 1, true],
  ["niu_4", "牛4", 4, 1, true],
  ["niu_5", "牛5", 5, 1, true],
  ["niu_6", "牛6", 6, 1, true],
  ["niu_7", "牛7", 7, 2, true],
  ["niu_8", "牛8", 8, 2, true],
  ["niu_9", "牛9", 9, 3, true],
  ["niu_niu", "牛牛", 10, 4, true],
  ["wu_hua", "五花牛", 11, 5, false],
  ["zha_dan", "炸弹牛", 12, 6, false],
  ["wu_xiao", "五小牛", 13, 8, false]
];

const rooms = new Map();

function makeTypes() {
  return TYPE_TEMPLATE.map((x) => ({ id: x[0], name: x[1], rank: x[2], mul: x[3], on: x[4] }));
}

function now() {
  return Date.now();
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function positive(v, d) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return d;
  return round2(n);
}

function nonNegative(v, d) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return d;
  return round2(n);
}

function sanitizeRoomId(raw) {
  const txt = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (txt.length >= 4 && txt.length <= 8) return txt;
  return "";
}

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 20; i++) {
    let out = "";
    for (let j = 0; j < 6; j++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(out)) return out;
  }
  return String(Date.now()).slice(-6);
}

function safeName(name, i) {
  const raw = String(name || "").trim();
  if (raw) return raw.slice(0, 18);
  return i > 0 ? `玩家${i}` : "玩家";
}

function rankWeight(rankId) {
  const i = RANKS.indexOf(rankId);
  return i < 0 ? 0 : i + 1;
}

function suitWeight(suitId) {
  const suit = SUITS.find((s) => s.id === suitId);
  return suit ? suit.w : 0;
}

function typeById(room, typeId) {
  return room.types.find((t) => t.id === typeId);
}

function firstEnabledTypeId(room) {
  const t = room.types.find((x) => x.on);
  return t ? t.id : room.types[0].id;
}

function sanitizeRank(rank) {
  return RANKS.includes(rank) ? rank : "K";
}

function sanitizeSuit(suit) {
  return SUITS.some((x) => x.id === suit) ? suit : "spade";
}

function compareHands(room, idleHand, bankerHand) {
  const idleType = typeById(room, idleHand.typeId);
  const bankerType = typeById(room, bankerHand.typeId);
  if (!idleType || !bankerType) return 0;
  if (idleType.rank !== bankerType.rank) return idleType.rank > bankerType.rank ? 1 : -1;

  const rw = rankWeight(idleHand.rank) - rankWeight(bankerHand.rank);
  if (rw !== 0) return rw > 0 ? 1 : -1;

  const sw = suitWeight(idleHand.suit) - suitWeight(bankerHand.suit);
  if (sw !== 0) return sw > 0 ? 1 : -1;

  return 0;
}

function resolveMul(room, mode, idleTypeId, bankerTypeId, idleWin) {
  const idleType = typeById(room, idleTypeId);
  const bankerType = typeById(room, bankerTypeId);

  if (mode === "banker") return nonNegative(bankerType ? bankerType.mul : 1, 1);
  if (mode === "idle") return nonNegative(idleType ? idleType.mul : 1, 1);

  const winnerType = idleWin ? idleType : bankerType;
  return nonNegative(winnerType ? winnerType.mul : 1, 1);
}

function parsePlayers(rawPlayers) {
  const arr = Array.isArray(rawPlayers) ? rawPlayers : [];
  const out = arr.map((name, i) => safeName(name, i + 1)).filter(Boolean);
  if (out.length < 2) return ["玩家1", "玩家2", "玩家3", "玩家4"];
  return out.slice(0, 10);
}

function sanitizeRules(raw) {
  const rules = raw && typeof raw === "object" ? raw : {};
  return {
    base: positive(rules.base, 1),
    bankerMul: positive(rules.bankerMul, 1),
    mode: ["winner", "banker", "idle"].includes(rules.mode) ? rules.mode : "winner"
  };
}

function sanitizeTypes(rawTypes) {
  const map = new Map((Array.isArray(rawTypes) ? rawTypes : []).map((x) => [x.id, x]));
  const types = makeTypes().map((t) => {
    const src = map.get(t.id) || {};
    return {
      id: t.id,
      name: t.name,
      rank: num(src.rank, t.rank),
      mul: nonNegative(src.mul, t.mul),
      on: typeof src.on === "boolean" ? src.on : t.on
    };
  });

  if (!types.some((x) => x.on)) types[0].on = true;
  return types;
}

function createRoom(payload) {
  const roomId = sanitizeRoomId(payload.roomId) || randomRoomId();
  if (rooms.has(roomId)) {
    const error = new Error("房间号已存在，请换一个。");
    error.code = 409;
    throw error;
  }

  const players = parsePlayers(payload.players).map((name, i) => ({
    id: `p${i + 1}`,
    name,
    owner: null
  }));

  const types = sanitizeTypes(payload.types);
  const rules = sanitizeRules(payload.rules);
  const bankerId = players.some((p) => p.id === payload.bankerId) ? payload.bankerId : players[0].id;
  const scores = {};
  players.forEach((p) => {
    scores[p.id] = 0;
  });

  const room = {
    id: roomId,
    hostClientId: String(payload.clientId || "").trim(),
    createdAt: now(),
    updatedAt: now(),
    nextPlayerSeq: players.length + 1,
    players,
    bankerId,
    rules,
    types,
    scores,
    history: [],
    round: null,
    seq: 0
  };

  if (room.hostClientId) {
    const hostSeat = room.players.find((p) => p.id === room.bankerId);
    if (hostSeat) hostSeat.owner = room.hostClientId;
  }

  initRound(room, null);
  rooms.set(roomId, room);
  return room;
}

function assertHost(room, clientId, actionText) {
  if (room.hostClientId !== clientId) {
    const error = new Error(`只有房主可以${actionText}。`);
    error.code = 403;
    throw error;
  }
}

function nextPlayerId(room) {
  let seq = Math.max(2, num(room.nextPlayerSeq, room.players.length + 1));
  let candidate = `p${seq}`;
  const used = new Set(room.players.map((p) => p.id));
  while (used.has(candidate)) {
    seq += 1;
    candidate = `p${seq}`;
  }
  room.nextPlayerSeq = seq + 1;
  return candidate;
}

function addPlayer(room, clientId, rawName) {
  assertHost(room, clientId, "新增玩家");
  if (room.players.length >= 10) {
    const error = new Error("最多支持 10 名玩家。");
    error.code = 400;
    throw error;
  }

  const id = nextPlayerId(room);
  const name = safeName(rawName, room.players.length + 1);
  room.players.push({ id, name, owner: null });
  room.scores[id] = 0;

  const prev = room.round;
  initRound(room, prev);
}

function renamePlayer(room, clientId, playerId, rawName) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    const error = new Error("玩家不存在。");
    error.code = 400;
    throw error;
  }

  const isHost = room.hostClientId === clientId;
  const isSelf = player.owner === clientId;
  if (!isHost && !isSelf) {
    const error = new Error("只有房主或玩家本人可以修改名称。");
    error.code = 403;
    throw error;
  }

  player.name = safeName(rawName, 0);
  room.updatedAt = now();
}

function removePlayer(room, clientId, playerId) {
  assertHost(room, clientId, "删除玩家");
  if (room.players.length <= 2) {
    const error = new Error("至少保留 2 名玩家。");
    error.code = 400;
    throw error;
  }
  if (room.history.length > 0) {
    const error = new Error("已有战绩时不能删人，请先清空战绩。");
    error.code = 400;
    throw error;
  }

  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx < 0) {
    const error = new Error("玩家不存在。");
    error.code = 400;
    throw error;
  }

  room.players.splice(idx, 1);
  delete room.scores[playerId];

  if (!room.players.some((p) => p.id === room.bankerId)) {
    room.bankerId = room.players[0].id;
  }

  const prev = room.round;
  initRound(room, prev);
}

function initRound(room, previousRound) {
  room.seq += 1;
  const fallbackType = firstEnabledTypeId(room);

  const prevBanker = previousRound ? previousRound.bankerDraft : null;
  const bankerDraft = {
    typeId: prevBanker && typeById(room, prevBanker.typeId) && typeById(room, prevBanker.typeId).on ? prevBanker.typeId : fallbackType,
    rank: prevBanker ? sanitizeRank(prevBanker.rank) : "K",
    suit: prevBanker ? sanitizeSuit(prevBanker.suit) : "spade",
    submitted: false,
    updatedAt: 0
  };

  const idleDrafts = {};
  room.players.forEach((p) => {
    if (p.id === room.bankerId) return;
    const prev = previousRound && previousRound.idleDrafts ? previousRound.idleDrafts[p.id] : null;
    idleDrafts[p.id] = {
      bet: prev ? positive(prev.bet, 1) : 1,
      typeId: prev && typeById(room, prev.typeId) && typeById(room, prev.typeId).on ? prev.typeId : fallbackType,
      rank: prev ? sanitizeRank(prev.rank) : "K",
      suit: prev ? sanitizeSuit(prev.suit) : "spade",
      submitted: false,
      updatedAt: 0
    };
  });

  room.round = {
    seq: room.seq,
    bankerDraft,
    idleDrafts
  };
  room.updatedAt = now();
}

function ownedPlayer(room, clientId) {
  return room.players.find((p) => p.owner === clientId) || null;
}

function ensureRoom(roomId) {
  const id = sanitizeRoomId(roomId);
  const room = rooms.get(id);
  if (!room) {
    const error = new Error("房间不存在。");
    error.code = 404;
    throw error;
  }
  return room;
}

function claimSeat(room, playerId, clientId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    const error = new Error("玩家不存在。");
    error.code = 400;
    throw error;
  }

  if (player.owner && player.owner !== clientId) {
    const error = new Error("这个身份已被占用。");
    error.code = 409;
    throw error;
  }

  room.players.forEach((p) => {
    if (p.owner === clientId && p.id !== playerId) p.owner = null;
  });

  player.owner = clientId;
  room.updatedAt = now();
}

function releaseSeat(room, clientId) {
  room.players.forEach((p) => {
    if (p.owner === clientId) p.owner = null;
  });
  room.updatedAt = now();
}

function setBanker(room, clientId, bankerId) {
  assertHost(room, clientId, "切换庄家");

  if (!room.players.some((p) => p.id === bankerId)) {
    const error = new Error("庄家身份无效。");
    error.code = 400;
    throw error;
  }

  if (!room.round) {
    room.bankerId = bankerId;
    initRound(room, null);
    return;
  }

  if (room.bankerId === bankerId) {
    room.updatedAt = now();
    return;
  }

  const oldBankerId = room.bankerId;
  const oldRound = room.round;
  const fallbackType = firstEnabledTypeId(room);

  const sourceForNewBanker = oldRound.idleDrafts[bankerId] || oldRound.bankerDraft || {};
  const nextBankerDraft = {
    typeId: typeById(room, sourceForNewBanker.typeId) && typeById(room, sourceForNewBanker.typeId).on
      ? sourceForNewBanker.typeId
      : fallbackType,
    rank: sanitizeRank(sourceForNewBanker.rank),
    suit: sanitizeSuit(sourceForNewBanker.suit),
    submitted: !!sourceForNewBanker.submitted,
    updatedAt: num(sourceForNewBanker.updatedAt, 0)
  };

  const nextIdleDrafts = {};
  room.players.forEach((p) => {
    if (p.id === bankerId) return;
    const source = p.id === oldBankerId ? oldRound.bankerDraft : oldRound.idleDrafts[p.id];
    const draft = source || {};
    nextIdleDrafts[p.id] = {
      bet: positive(draft.bet, 1),
      typeId: typeById(room, draft.typeId) && typeById(room, draft.typeId).on ? draft.typeId : fallbackType,
      rank: sanitizeRank(draft.rank),
      suit: sanitizeSuit(draft.suit),
      submitted: !!draft.submitted,
      updatedAt: num(draft.updatedAt, 0)
    };
  });

  room.bankerId = bankerId;
  room.round = {
    seq: oldRound.seq,
    bankerDraft: nextBankerDraft,
    idleDrafts: nextIdleDrafts
  };
  room.updatedAt = now();
}

function startNewRound(room, clientId) {
  assertHost(room, clientId, "开新局");
  const prev = room.round || null;
  initRound(room, prev);
}

function applySubmit(room, clientId, data) {
  const me = ownedPlayer(room, clientId);
  if (!me) {
    const error = new Error("请先认领你的玩家身份。");
    error.code = 403;
    throw error;
  }

  const fallbackType = firstEnabledTypeId(room);

  if (me.id === room.bankerId) {
    room.round.bankerDraft.typeId = typeById(room, data.typeId) && typeById(room, data.typeId).on ? data.typeId : fallbackType;
    room.round.bankerDraft.rank = sanitizeRank(data.rank);
    room.round.bankerDraft.suit = sanitizeSuit(data.suit);
    room.round.bankerDraft.submitted = true;
    room.round.bankerDraft.updatedAt = now();
  } else {
    const cur = room.round.idleDrafts[me.id];
    if (!cur) {
      const error = new Error("当前回合未找到你的录入位。");
      error.code = 400;
      throw error;
    }
    cur.bet = positive(data.bet, 1);
    cur.typeId = typeById(room, data.typeId) && typeById(room, data.typeId).on ? data.typeId : fallbackType;
    cur.rank = sanitizeRank(data.rank);
    cur.suit = sanitizeSuit(data.suit);
    cur.submitted = true;
    cur.updatedAt = now();
  }

  room.updatedAt = now();
}

function allSubmitted(room) {
  if (!room.round.bankerDraft.submitted) return false;
  return room.players
    .filter((p) => p.id !== room.bankerId)
    .every((p) => room.round.idleDrafts[p.id] && room.round.idleDrafts[p.id].submitted);
}

function settleIfReady(room) {
  if (!allSubmitted(room)) return null;

  const banker = room.players.find((p) => p.id === room.bankerId);
  const bankerDraft = room.round.bankerDraft;
  const bankerType = typeById(room, bankerDraft.typeId);
  const bankerTypeName = bankerType ? bankerType.name : "未知牌型";
  const details = [];
  let bankerDelta = 0;

  room.players
    .filter((p) => p.id !== room.bankerId)
    .forEach((idle) => {
      const idleDraft = room.round.idleDrafts[idle.id];
      const idleType = typeById(room, idleDraft.typeId);
      const idleTypeName = idleType ? idleType.name : "未知牌型";
      const cmp = compareHands(room, idleDraft, bankerDraft);
      if (cmp === 0) {
        details.push({
          playerId: idle.id,
          playerName: idle.name,
          idleTypeId: idleDraft.typeId,
          idleTypeName,
          idleRank: idleDraft.rank,
          idleSuit: idleDraft.suit,
          bankerTypeId: bankerDraft.typeId,
          bankerTypeName,
          bankerRank: bankerDraft.rank,
          bankerSuit: bankerDraft.suit,
          bet: idleDraft.bet,
          tm: 0,
          delta: 0,
          compare: 0
        });
        return;
      }

      const idleWin = cmp > 0;
      const tm = resolveMul(room, room.rules.mode, idleDraft.typeId, bankerDraft.typeId, idleWin);
      const amount = round2(room.rules.base * room.rules.bankerMul * idleDraft.bet * tm);
      const delta = idleWin ? amount : -amount;

      room.scores[idle.id] = round2(num(room.scores[idle.id], 0) + delta);
      bankerDelta = round2(bankerDelta - delta);

      details.push({
        playerId: idle.id,
        playerName: idle.name,
        idleTypeId: idleDraft.typeId,
        idleTypeName,
        idleRank: idleDraft.rank,
        idleSuit: idleDraft.suit,
        bankerTypeId: bankerDraft.typeId,
        bankerTypeName,
        bankerRank: bankerDraft.rank,
        bankerSuit: bankerDraft.suit,
        bet: idleDraft.bet,
        tm,
        delta,
        compare: cmp
      });
    });

  room.scores[banker.id] = round2(num(room.scores[banker.id], 0) + bankerDelta);

  const record = {
    id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: now(),
    roundSeq: room.round.seq,
    bankerId: banker.id,
    bankerName: banker.name,
    bankerHand: {
      typeId: bankerDraft.typeId,
      typeName: bankerTypeName,
      rank: bankerDraft.rank,
      suit: bankerDraft.suit
    },
    bankerDelta,
    details
  };

  room.history.unshift(record);
  const prev = room.round;
  initRound(room, prev);

  return record;
}

function undoLast(room, clientId) {
  if (room.hostClientId !== clientId) {
    const error = new Error("只有房主可以撤销。");
    error.code = 403;
    throw error;
  }

  if (!room.history.length) {
    const error = new Error("没有可撤销的局。");
    error.code = 400;
    throw error;
  }

  const r = room.history.shift();
  room.scores[r.bankerId] = round2(num(room.scores[r.bankerId], 0) - r.bankerDelta);
  r.details.forEach((d) => {
    room.scores[d.playerId] = round2(num(room.scores[d.playerId], 0) - d.delta);
  });
  initRound(room, null);
  room.updatedAt = now();
}

function resetRoom(room, clientId) {
  if (room.hostClientId !== clientId) {
    const error = new Error("只有房主可以清空战绩。");
    error.code = 403;
    throw error;
  }
  room.history = [];
  room.players.forEach((p) => {
    room.scores[p.id] = 0;
  });
  initRound(room, null);
  room.updatedAt = now();
}

function project(room, clientId) {
  const me = ownedPlayer(room, clientId);
  let submittedCount = room.round.bankerDraft.submitted ? 1 : 0;
  submittedCount += room.players.filter((p) => p.id !== room.bankerId).reduce((acc, p) => {
    return acc + (room.round.idleDrafts[p.id] && room.round.idleDrafts[p.id].submitted ? 1 : 0);
  }, 0);

  const waitingFor = [];
  if (!room.round.bankerDraft.submitted) {
    const p = room.players.find((x) => x.id === room.bankerId);
    if (p) waitingFor.push(p.name);
  }
  room.players
    .filter((p) => p.id !== room.bankerId)
    .forEach((p) => {
      const d = room.round.idleDrafts[p.id];
      if (!d || !d.submitted) waitingFor.push(p.name);
    });

  let myDraft = null;
  let myRole = null;
  if (me) {
    if (me.id === room.bankerId) {
      myRole = "banker";
      myDraft = {
        typeId: room.round.bankerDraft.typeId,
        rank: room.round.bankerDraft.rank,
        suit: room.round.bankerDraft.suit,
        submitted: room.round.bankerDraft.submitted
      };
    } else {
      const d = room.round.idleDrafts[me.id];
      myRole = "idle";
      myDraft = {
        bet: d.bet,
        typeId: d.typeId,
        rank: d.rank,
        suit: d.suit,
        submitted: d.submitted
      };
    }
  }

  const scores = room.players
    .map((p) => ({ playerId: p.id, name: p.name, score: num(room.scores[p.id], 0) }))
    .sort((a, b) => b.score - a.score);

  return {
    roomId: room.id,
    isHost: room.hostClientId === clientId,
    hostHasBound: !!room.hostClientId,
    bankerId: room.bankerId,
    rules: room.rules,
    types: room.types.filter((t) => t.on),
    players: room.players.map((p) => {
      const submitted = p.id === room.bankerId
        ? room.round.bankerDraft.submitted
        : !!(room.round.idleDrafts[p.id] && room.round.idleDrafts[p.id].submitted);
      return {
        id: p.id,
        name: p.name,
        isBanker: p.id === room.bankerId,
        ownerState: p.owner ? (p.owner === clientId ? "self" : "taken") : "free",
        submitted
      };
    }),
    myPlayerId: me ? me.id : null,
    myRole,
    myDraft,
    round: {
      seq: room.round.seq,
      submittedCount,
      total: room.players.length,
      waitingFor
    },
    scores,
    history: room.history
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (safePath.includes("..")) {
    sendJson(res, 400, { error: "非法路径" });
    return;
  }

  const filePath = path.join(ROOT, safePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  const mime = mimeMap[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, urlObj) {
  try {
    if (req.method === "GET" && urlObj.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, now: new Date().toISOString(), roomCount: rooms.size });
      return;
    }

    if (req.method === "GET" && urlObj.pathname === "/api/room/state") {
      const roomId = urlObj.searchParams.get("room") || "";
      const clientId = String(urlObj.searchParams.get("client") || "").trim();
      const room = ensureRoom(roomId);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/create") {
      const body = await parseJson(req);
      const room = createRoom(body);
      sendJson(res, 200, { ok: true, state: project(room, String(body.clientId || "").trim()) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/claim") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      claimSeat(room, String(body.playerId || ""), clientId);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/release") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      releaseSeat(room, clientId);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/player/add") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      addPlayer(room, clientId, body.name);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/player/rename") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      renamePlayer(room, clientId, String(body.playerId || ""), body.name);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/player/remove") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      removePlayer(room, clientId, String(body.playerId || ""));
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/submit") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      applySubmit(room, clientId, body.data || {});
      const settled = settleIfReady(room);
      sendJson(res, 200, { ok: true, settled: settled || null, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/change-banker") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      setBanker(room, clientId, String(body.bankerId || ""));
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/new-round") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      startNewRound(room, clientId);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/undo") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      undoLast(room, clientId);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/reset") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      resetRoom(room, clientId);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    sendJson(res, 404, { error: "API Not Found" });
  } catch (err) {
    const code = Number(err.code) || 500;
    sendJson(res, code, { error: err.message || "服务器错误" });
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (urlObj.pathname.startsWith("/api/")) {
    await handleApi(req, res, urlObj);
    return;
  }
  serveStatic(urlObj.pathname, res);
});

server.listen(PORT, HOST, () => {
  const msg = [
    `牛牛联机服务已启动`,
    `本机访问: http://localhost:${PORT}`,
    `手机访问: http://<你的电脑局域网IP>:${PORT}`
  ].join(" | ");
  console.log(msg);
});
