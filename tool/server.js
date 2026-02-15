"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { WebSocketServer } = require("ws");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 5273);
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
const wsClientsByClientId = new Map();

function wsSend(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function unbindSocket(socket) {
  const prevClientId = String(socket._boundClientId || "").trim();
  if (!prevClientId) return;

  const set = wsClientsByClientId.get(prevClientId);
  if (set) {
    set.delete(socket);
    if (!set.size) wsClientsByClientId.delete(prevClientId);
  }
  socket._boundClientId = "";
}

function bindSocket(clientId, socket) {
  const cid = String(clientId || "").trim();
  if (!cid) return false;
  unbindSocket(socket);

  let set = wsClientsByClientId.get(cid);
  if (!set) {
    set = new Set();
    wsClientsByClientId.set(cid, set);
  }
  set.add(socket);
  socket._boundClientId = cid;
  return true;
}

function broadcastToRoom(room, payload) {
  if (!room || !payload) return 0;
  const targets = new Set();
  room.players.forEach((p) => {
    if (p.owner) targets.add(String(p.owner).trim());
  });

  let count = 0;
  targets.forEach((clientId) => {
    const sockets = wsClientsByClientId.get(clientId);
    if (!sockets || !sockets.size) return;
    sockets.forEach((socket) => {
      if (wsSend(socket, payload)) count += 1;
    });
  });
  return count;
}

function pushRoomUpdated(room) {
  broadcastToRoom(room, {
    type: "room_updated",
    roomId: room.id,
    ts: now()
  });
}

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
  if (out.length < 2) return ["玩家1", "玩家2"];
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

function sanitizeGameMode(rawMode) {
  return rawMode === "manual" ? "manual" : "cards";
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
  const gameMode = sanitizeGameMode(payload.gameMode);
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
    gameMode,
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

  if (room.gameMode === "manual") {
    const manualDrafts = {};
    room.players.forEach((p) => {
      const prev = previousRound && previousRound.manualDrafts ? previousRound.manualDrafts[p.id] : null;
      manualDrafts[p.id] = {
        delta: prev ? round2(num(prev.delta, 0)) : 0,
        submitted: false,
        updatedAt: 0
      };
    });
    room.round = {
      seq: room.seq,
      manualDrafts,
      manualCheck: null
    };
    room.updatedAt = now();
    return;
  }

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

  if (room.gameMode === "manual") {
    room.bankerId = bankerId;
    if (!room.round) initRound(room, null);
    if (room.round) room.round.manualCheck = null;
    room.updatedAt = now();
    return;
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

function changeGameMode(room, clientId, rawMode) {
  assertHost(room, clientId, "切换模式");
  const nextMode = sanitizeGameMode(rawMode);
  if (room.gameMode === nextMode) {
    startNewRound(room, clientId);
    return;
  }
  room.gameMode = nextMode;
  initRound(room, null);
}

function applySubmit(room, clientId, data) {
  const me = ownedPlayer(room, clientId);
  if (!me) {
    const error = new Error("请先认领你的玩家身份。");
    error.code = 403;
    throw error;
  }

  if (room.gameMode === "manual") {
    const cur = room.round && room.round.manualDrafts ? room.round.manualDrafts[me.id] : null;
    if (!cur) {
      const error = new Error("当前回合未找到你的录入位。");
      error.code = 400;
      throw error;
    }
    cur.delta = round2(num(data.delta, 0));
    cur.submitted = true;
    cur.updatedAt = now();
    room.round.manualCheck = null;
    room.updatedAt = now();
    return;
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
  if (room.gameMode === "manual") {
    return room.players.every((p) => room.round.manualDrafts[p.id] && room.round.manualDrafts[p.id].submitted);
  }

  if (!room.round.bankerDraft.submitted) return false;
  return room.players
    .filter((p) => p.id !== room.bankerId)
    .every((p) => room.round.idleDrafts[p.id] && room.round.idleDrafts[p.id].submitted);
}

function checkManualConsistency(room, bankerId) {
  const targetBankerId = bankerId || room.bankerId;
  let bankerDelta = 0;
  let idleSum = 0;

  room.players.forEach((p) => {
    const draft = room.round.manualDrafts[p.id];
    const delta = round2(num(draft ? draft.delta : 0, 0));
    if (p.id === targetBankerId) {
      bankerDelta = delta;
    } else {
      idleSum = round2(idleSum + delta);
    }
  });

  const expectedBanker = round2(-idleSum);
  const diff = round2(bankerDelta - expectedBanker);
  return {
    ok: diff === 0,
    bankerDelta,
    idleSum,
    expectedBanker,
    diff
  };
}

function settleIfReady(room) {
  if (!allSubmitted(room)) return null;

  if (room.gameMode === "manual") {
    const banker = room.players.find((p) => p.id === room.bankerId) || room.players[0];
    const manualCheck = checkManualConsistency(room, banker.id);
    if (!manualCheck.ok) {
      room.round.manualCheck = manualCheck;
      room.updatedAt = now();
      return null;
    }

    room.round.manualCheck = null;
    const details = [];
    let bankerDelta = 0;

    room.players.forEach((p) => {
      const d = room.round.manualDrafts[p.id];
      const delta = round2(num(d ? d.delta : 0, 0));
      room.scores[p.id] = round2(num(room.scores[p.id], 0) + delta);
      if (p.id === banker.id) bankerDelta = delta;
      details.push({
        playerId: p.id,
        playerName: p.name,
        delta,
        manualDelta: true
      });
    });

    const record = {
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: now(),
      mode: "manual",
      roundSeq: room.round.seq,
      bankerId: banker.id,
      bankerName: banker.name,
      bankerDelta,
      details
    };

    room.history.unshift(record);
    initRound(room, null);
    return record;
  }

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
    mode: "cards",
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
  const manualCheck = room.gameMode === "manual" && room.round && room.round.manualCheck
    ? {
        ok: !!room.round.manualCheck.ok,
        bankerDelta: round2(num(room.round.manualCheck.bankerDelta, 0)),
        idleSum: round2(num(room.round.manualCheck.idleSum, 0)),
        expectedBanker: round2(num(room.round.manualCheck.expectedBanker, 0)),
        diff: round2(num(room.round.manualCheck.diff, 0))
      }
    : null;
  let submittedCount = 0;
  const waitingFor = [];
  if (room.gameMode === "manual") {
    room.players.forEach((p) => {
      const d = room.round.manualDrafts[p.id];
      if (d && d.submitted) {
        submittedCount += 1;
      } else {
        waitingFor.push(p.name);
      }
    });
  } else {
    submittedCount = room.round.bankerDraft.submitted ? 1 : 0;
    submittedCount += room.players.filter((p) => p.id !== room.bankerId).reduce((acc, p) => {
      return acc + (room.round.idleDrafts[p.id] && room.round.idleDrafts[p.id].submitted ? 1 : 0);
    }, 0);

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
  }

  let myDraft = null;
  let myRole = null;
  if (me) {
    if (room.gameMode === "manual") {
      const d = room.round.manualDrafts[me.id];
      myRole = me.id === room.bankerId ? "banker" : "idle";
      myDraft = {
        delta: d ? round2(num(d.delta, 0)) : 0,
        submitted: !!(d && d.submitted)
      };
    } else {
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
  }

  const scores = room.players
    .map((p) => ({ playerId: p.id, name: p.name, score: num(room.scores[p.id], 0) }))
    .sort((a, b) => b.score - a.score);

  return {
    roomId: room.id,
    isHost: room.hostClientId === clientId,
    hostHasBound: !!room.hostClientId,
    gameMode: room.gameMode,
    bankerId: room.bankerId,
    rules: room.rules,
    types: room.types.filter((t) => t.on),
    players: room.players.map((p) => {
      const submitted = room.gameMode === "manual"
        ? !!(room.round.manualDrafts[p.id] && room.round.manualDrafts[p.id].submitted)
        : (p.id === room.bankerId
            ? room.round.bankerDraft.submitted
            : !!(room.round.idleDrafts[p.id] && room.round.idleDrafts[p.id].submitted));
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
      waitingFor,
      manualCheck
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
      pushRoomUpdated(room);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/release") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      releaseSeat(room, clientId);
      pushRoomUpdated(room);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/player/add") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      addPlayer(room, clientId, body.name);
      pushRoomUpdated(room);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/player/rename") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      renamePlayer(room, clientId, String(body.playerId || ""), body.name);
      pushRoomUpdated(room);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/player/remove") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      if (!clientId) throw Object.assign(new Error("clientId 缺失"), { code: 400 });
      removePlayer(room, clientId, String(body.playerId || ""));
      pushRoomUpdated(room);
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
      if (settled) {
        broadcastToRoom(room, {
          type: "settled",
          roomId: room.id,
          roundSeq: settled.roundSeq,
          recordId: settled.id,
          ts: settled.ts
        });
      } else {
        pushRoomUpdated(room);
      }
      sendJson(res, 200, { ok: true, settled: settled || null, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/change-banker") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      setBanker(room, clientId, String(body.bankerId || ""));
      pushRoomUpdated(room);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/change-game-mode") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      changeGameMode(room, clientId, body.gameMode);
      pushRoomUpdated(room);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/new-round") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      startNewRound(room, clientId);
      pushRoomUpdated(room);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/undo") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      undoLast(room, clientId);
      pushRoomUpdated(room);
      sendJson(res, 200, { ok: true, state: project(room, clientId) });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/api/room/reset") {
      const body = await parseJson(req);
      const room = ensureRoom(body.roomId);
      const clientId = String(body.clientId || "").trim();
      resetRoom(room, clientId);
      pushRoomUpdated(room);
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

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  socket._boundClientId = "";
  socket._alive = true;

  socket.on("pong", () => {
    socket._alive = true;
  });

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw || ""));
    } catch {
      wsSend(socket, { type: "error", error: "WS JSON 解析失败" });
      return;
    }

    if (!msg || typeof msg !== "object") return;
    if (msg.type === "bind") {
      const ok = bindSocket(msg.clientId, socket);
      if (!ok) {
        wsSend(socket, { type: "error", error: "clientId 无效" });
        return;
      }
      wsSend(socket, { type: "bound", clientId: socket._boundClientId, now: now() });
      return;
    }

    if (msg.type === "ping") {
      wsSend(socket, { type: "pong", now: now() });
    }
  });

  socket.on("close", () => {
    unbindSocket(socket);
  });

  socket.on("error", () => {
    unbindSocket(socket);
  });
});

const wsHeartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket._alive === false) {
      try {
        socket.terminate();
      } catch {}
      return;
    }
    socket._alive = false;
    try {
      socket.ping();
    } catch {}
  });
}, 30000);
wsHeartbeat.unref();

server.listen(PORT, HOST, () => {
  const msg = [
    `牛牛联机服务已启动`,
    `本机访问: http://localhost:${PORT}`,
    `手机访问: http://<你的电脑局域网IP>:${PORT}`
  ].join(" | ");
  console.log(msg);
});
