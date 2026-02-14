(() => {
  const CLIENT_KEY = "niuniu-client-id";
  const ROOM_KEY = "niuniu-last-room";
  const VOICE_ENABLED_KEY = "niuniu-voice-enabled";
  const TTS_BASE_KEY = "niuniu-tts-base-url";
  const ANNOUNCED_RECORD_KEY_PREFIX = "niuniu-last-announced-record";
  const POLL_FAST_MS = 1500;
  const POLL_WS_FALLBACK_MS = 10000;
  const WS_RETRY_BASE_MS = 1000;
  const WS_RETRY_MAX_MS = 10000;
  const RANK_DESC = ["K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2", "A"];
  const SUITS = [
    { id: "spade", label: "黑桃" },
    { id: "heart", label: "红桃" },
    { id: "club", label: "梅花" },
    { id: "diamond", label: "方块" }
  ];

  const $ = (id) => document.getElementById(id);
  const dom = {
    roomIdInput: $("roomIdInput"),
    joinBtn: $("joinBtn"),
    copyLinkBtn: $("copyLinkBtn"),
    leaveRoomBtn: $("leaveRoomBtn"),
    createSection: $("createSection"),
    createPlayers: $("createPlayers"),
    createBanker: $("createBanker"),
    createGameMode: $("createGameMode"),
    createBaseWrap: $("createBaseWrap"),
    createBase: $("createBase"),
    createBankerMulWrap: $("createBankerMulWrap"),
    createBankerMul: $("createBankerMul"),
    createMode: $("createMode"),
    createMultiplierWrap: $("createMultiplierWrap"),
    createBtn: $("createBtn"),
    roomMeta: $("roomMeta"),
    voiceToggleBtn: $("voiceToggleBtn"),
    voiceTestBtn: $("voiceTestBtn"),
    voiceHint: $("voiceHint"),
    seatRows: $("seatRows"),
    releaseBtn: $("releaseBtn"),
    myPanel: $("myPanel"),
    submitBtn: $("submitBtn"),
    myTip: $("myTip"),
    roundInfo: $("roundInfo"),
    hostPanel: $("hostPanel"),
    hostBankerSelect: $("hostBankerSelect"),
    startNewRoundBtn: $("startNewRoundBtn"),
    hostNewPlayerName: $("hostNewPlayerName"),
    addHostPlayerBtn: $("addHostPlayerBtn"),
    hostPlayerRows: $("hostPlayerRows"),
    changeBankerBtn: $("changeBankerBtn"),
    undoBtn: $("undoBtn"),
    resetBtn: $("resetBtn"),
    scoreRows: $("scoreRows"),
    historyRows: $("historyRows"),
    historyPrevBtn: $("historyPrevBtn"),
    historyNextBtn: $("historyNextBtn"),
    historyPageInfo: $("historyPageInfo")
  };

  const ctx = {
    clientId: getClientId(),
    roomId: "",
    state: null,
    poller: null,
    lastRoundSeq: 0,
    draftCache: null,
    historyPage: 1,
    lastAnnouncedHistoryId: "",
    voiceEnabled: loadVoiceEnabled(),
    voicePrimed: false,
    ttsBaseUrl: loadTtsBaseUrl(),
    ttsAudio: null,
    pendingBankerId: "",
    ws: null,
    wsRetryTimer: null,
    wsReconnectMs: WS_RETRY_BASE_MS,
    wsRefreshTimer: null
  };

  bind();
  initWebSocket();
  refreshCreateBankerOptions();
  refreshCreateModeUi();
  restoreRoomAndAutoJoin();

  function bind() {
    dom.createPlayers.addEventListener("input", refreshCreateBankerOptions);
    dom.createGameMode.addEventListener("change", refreshCreateModeUi);

    dom.createBtn.addEventListener("click", createRoom);
    dom.joinBtn.addEventListener("click", () => {
      if (ctx.state) {
        fetchState(false).catch((err) => setTip(err.message, true));
      } else {
        joinRoom();
      }
    });
    dom.copyLinkBtn.addEventListener("click", copyInviteLink);
    dom.leaveRoomBtn.addEventListener("click", leaveRoom);
    dom.voiceToggleBtn.addEventListener("click", toggleVoice);
    dom.voiceTestBtn.addEventListener("click", () => {
      testVoice(true);
    });

    dom.seatRows.addEventListener("click", async (e) => {
      const renameBtn = e.target.closest("button.self-rename-btn");
      if (renameBtn && ctx.roomId) {
        await selfRenamePlayer(renameBtn.dataset.playerId, renameBtn.dataset.playerName || "");
        return;
      }

      const btn = e.target.closest("button.claim-btn");
      if (!btn || !ctx.roomId) return;
      await claimSeat(btn.dataset.playerId);
    });

    dom.releaseBtn.addEventListener("click", releaseSeat);
    dom.submitBtn.addEventListener("click", submitMine);

    dom.hostBankerSelect.addEventListener("change", () => {
      ctx.pendingBankerId = dom.hostBankerSelect.value || "";
    });
    dom.changeBankerBtn.addEventListener("click", hostChangeBanker);
    dom.startNewRoundBtn.addEventListener("click", hostStartNewRound);
    dom.addHostPlayerBtn.addEventListener("click", hostAddPlayer);
    dom.hostPlayerRows.addEventListener("click", hostPlayerTableClick);
    dom.undoBtn.addEventListener("click", hostUndo);
    dom.resetBtn.addEventListener("click", hostReset);
    dom.historyPrevBtn.addEventListener("click", () => changeHistoryPage(-1));
    dom.historyNextBtn.addEventListener("click", () => changeHistoryPage(1));

    dom.myPanel.addEventListener("input", captureDraftCache);
    dom.myPanel.addEventListener("change", captureDraftCache);
    dom.myPanel.addEventListener("click", onMyPanelClick);

    document.addEventListener("visibilitychange", () => {
      if (!ctx.roomId) return;
      if (!document.hidden) fetchState(true);
    });
  }

  function onMyPanelClick(e) {
    const signBtn = e.target.closest("button.manual-sign-btn");
    if (!signBtn) return;
    const sign = Number(signBtn.dataset.sign) === -1 ? -1 : 1;
    const signInput = dom.myPanel.querySelector("#mySign");
    if (signInput) signInput.value = String(sign);
    updateManualSignButtons(sign);
    captureDraftCache();
  }

  function getClientId() {
    const saved = localStorage.getItem(CLIENT_KEY);
    if (saved) return saved;
    const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CLIENT_KEY, id);
    return id;
  }

  function parsePlayerNames(txt) {
    const source = String(txt || "").split(/[\n,，]/g).map((x) => x.trim()).filter(Boolean);
    if (source.length < 2) return ["玩家1", "玩家2", "玩家3", "玩家4"];
    return source.slice(0, 10);
  }

  function normalizeRoomId(txt) {
    return String(txt || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  }

  function normalizeTtsBaseUrl(txt) {
    const raw = String(txt || "").trim();
    if (!raw) return "";
    return raw.replace(/\/+$/, "");
  }

  function isLoopbackHost(host) {
    const h = String(host || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  }

  function isUnsafeLoopbackTts(baseUrl) {
    const txt = normalizeTtsBaseUrl(baseUrl);
    if (!txt) return false;

    try {
      const parsed = new URL(txt);
      return isLoopbackHost(parsed.hostname) && !isLoopbackHost(window.location.hostname);
    } catch {
      return false;
    }
  }

  function defaultTtsBaseUrl() {
    const proto = window.location.protocol === "https:" ? "https:" : "http:";
    return `${proto}//${window.location.hostname}:8000`;
  }

  function loadTtsBaseUrl() {
    const urlObj = new URL(window.location.href);
    const fromQuery = normalizeTtsBaseUrl(urlObj.searchParams.get("tts"));
    if (fromQuery && !isUnsafeLoopbackTts(fromQuery)) {
      localStorage.setItem(TTS_BASE_KEY, fromQuery);
      return fromQuery;
    }

    const fromStorage = normalizeTtsBaseUrl(localStorage.getItem(TTS_BASE_KEY));
    if (fromStorage && !isUnsafeLoopbackTts(fromStorage)) return fromStorage;

    const fallback = defaultTtsBaseUrl();
    localStorage.setItem(TTS_BASE_KEY, fallback);
    return fallback;
  }

  function refreshCreateBankerOptions() {
    const names = parsePlayerNames(dom.createPlayers.value);
    const current = dom.createBanker.value;
    dom.createBanker.innerHTML = names.map((name, idx) => `<option value="p${idx + 1}">${esc(name)}</option>`).join("");
    if ([...dom.createBanker.options].some((x) => x.value === current)) {
      dom.createBanker.value = current;
    }
  }

  async function api(path, method, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (method !== "GET") opts.body = JSON.stringify(body || {});

    const res = await fetch(path, opts);
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok || data.error) {
      throw new Error(data.error || `请求失败（${res.status}）`);
    }
    return data;
  }

  function wsConnected() {
    return !!ctx.ws && ctx.ws.readyState === WebSocket.OPEN;
  }

  function currentPollMs() {
    return wsConnected() ? POLL_WS_FALLBACK_MS : POLL_FAST_MS;
  }

  function websocketUrl() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }

  function sendWsBind() {
    if (!wsConnected()) return false;
    try {
      ctx.ws.send(JSON.stringify({
        type: "bind",
        clientId: ctx.clientId
      }));
      return true;
    } catch {
      return false;
    }
  }

  function scheduleWsRefresh(delayMs) {
    if (!ctx.roomId) return;
    if (ctx.wsRefreshTimer) return;
    ctx.wsRefreshTimer = setTimeout(() => {
      ctx.wsRefreshTimer = null;
      fetchState(true).catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
  }

  function clearWsRetry() {
    if (!ctx.wsRetryTimer) return;
    clearTimeout(ctx.wsRetryTimer);
    ctx.wsRetryTimer = null;
  }

  function scheduleWsReconnect() {
    if (ctx.wsRetryTimer) return;
    const delay = Math.min(WS_RETRY_MAX_MS, Math.max(WS_RETRY_BASE_MS, ctx.wsReconnectMs || WS_RETRY_BASE_MS));
    ctx.wsRetryTimer = setTimeout(() => {
      ctx.wsRetryTimer = null;
      initWebSocket();
    }, delay);
    ctx.wsReconnectMs = Math.min(WS_RETRY_MAX_MS, delay * 2);
  }

  function restartPollingForTransport() {
    if (!ctx.roomId) return;
    startPolling();
  }

  function initWebSocket() {
    if (typeof window === "undefined" || typeof window.WebSocket !== "function") return;
    if (ctx.ws && (ctx.ws.readyState === WebSocket.OPEN || ctx.ws.readyState === WebSocket.CONNECTING)) return;

    let ws;
    try {
      ws = new WebSocket(websocketUrl());
    } catch {
      scheduleWsReconnect();
      return;
    }

    ctx.ws = ws;

    ws.addEventListener("open", () => {
      if (ctx.ws !== ws) return;
      ctx.wsReconnectMs = WS_RETRY_BASE_MS;
      clearWsRetry();
      sendWsBind();
      restartPollingForTransport();
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data || ""));
      } catch {
        return;
      }

      if (!msg || typeof msg !== "object") return;
      if (msg.type === "settled") {
        if (msg.roomId && ctx.roomId && msg.roomId === ctx.roomId) {
          scheduleWsRefresh(0);
        }
        return;
      }
      if (msg.type === "room_updated") {
        if (msg.roomId && ctx.roomId && msg.roomId === ctx.roomId) {
          scheduleWsRefresh(60);
        }
      }
    });

    ws.addEventListener("close", () => {
      if (ctx.ws !== ws) return;
      ctx.ws = null;
      restartPollingForTransport();
      scheduleWsReconnect();
    });

    ws.addEventListener("error", () => {
      if (ctx.ws !== ws) return;
      try {
        ws.close();
      } catch {}
    });
  }

  function startPolling() {
    stopPolling();
    const pollMs = currentPollMs();
    ctx.poller = setInterval(() => {
      fetchState(true).catch(() => {});
    }, pollMs);
  }

  function stopPolling() {
    if (ctx.poller) clearInterval(ctx.poller);
    ctx.poller = null;
  }

  function restoreRoomAndAutoJoin() {
    const url = new URL(window.location.href);
    const roomFromUrl = normalizeRoomId(url.searchParams.get("room") || "");
    const roomFromStorage = normalizeRoomId(localStorage.getItem(ROOM_KEY) || "");
    const room = roomFromUrl || roomFromStorage;
    if (!room) {
      render();
      return;
    }

    dom.roomIdInput.value = room;
    joinRoom(true);
  }

  async function createRoom() {
    try {
      const roomId = normalizeRoomId(dom.roomIdInput.value);
      const players = parsePlayerNames(dom.createPlayers.value);
      const payload = {
        roomId,
        clientId: ctx.clientId,
        players,
        gameMode: dom.createGameMode.value || "manual",
        bankerId: dom.createBanker.value || "p1",
        rules: {
          base: Number(dom.createBase.value || 1),
          bankerMul: Number(dom.createBankerMul.value || 1),
          mode: dom.createMode.value || "winner"
        }
      };

      const data = await api("/api/room/create", "POST", payload);
      applyState(data.state, true, true);
      setTip(`已创建房间 ${data.state.roomId}。你是房主。`);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function joinRoom(silent) {
    const roomId = normalizeRoomId(dom.roomIdInput.value);
    if (!roomId) {
      if (!silent) setTip("请先输入房间号。", true);
      return;
    }

    try {
      const data = await api(`/api/room/state?room=${encodeURIComponent(roomId)}&client=${encodeURIComponent(ctx.clientId)}`, "GET");
      applyState(data.state, true, false);
      if (!silent) setTip(`已进入房间 ${roomId}。`);
    } catch (err) {
      if (!silent) setTip(err.message, true);
    }
  }

  async function fetchState(silent) {
    if (!ctx.roomId) return;
    const data = await api(`/api/room/state?room=${encodeURIComponent(ctx.roomId)}&client=${encodeURIComponent(ctx.clientId)}`, "GET");
    applyState(data.state, false, false);
    if (!silent) setTip("状态已刷新。");
  }

  function applyState(state, restartPolling, fromCreate) {
    const prevState = ctx.state;
    const oldSeq = ctx.lastRoundSeq;
    const keepMyPanel = shouldKeepMyPanel(prevState, state, fromCreate);
    const settledRecord = detectNewSettlement(prevState, state, fromCreate);
    if (fromCreate || !prevState || prevState.roomId !== state.roomId) {
      ctx.historyPage = 1;
      ctx.lastAnnouncedHistoryId = "";
    }

    ctx.state = state;
    ctx.roomId = state.roomId;
    ctx.lastRoundSeq = state.round.seq;

    dom.roomIdInput.value = state.roomId;
    localStorage.setItem(ROOM_KEY, state.roomId);

    const url = new URL(window.location.href);
    url.searchParams.set("room", state.roomId);
    history.replaceState({}, "", url.toString());

    if (restartPolling) startPolling();

    if (settledRecord) {
      setTip(`第 ${settledRecord.roundSeq} 局已自动结算，当前是第 ${state.round.seq} 局。`);
      ctx.draftCache = null;
      ctx.historyPage = 1;
      announceSettlement(settledRecord);
    }

    render({ skipMyPanel: keepMyPanel });
  }

  function loadVoiceEnabled() {
    const raw = localStorage.getItem(VOICE_ENABLED_KEY);
    if (raw === "0") return false;
    return true;
  }

  function stopTtsPlayback() {
    if (ctx.ttsAudio) {
      try {
        ctx.ttsAudio.pause();
        ctx.ttsAudio.currentTime = 0;
        ctx.ttsAudio.removeAttribute("src");
        ctx.ttsAudio.load();
      } catch {}
    }
  }

  function saveVoiceEnabled() {
    localStorage.setItem(VOICE_ENABLED_KEY, ctx.voiceEnabled ? "1" : "0");
  }

  function toggleVoice() {
    ctx.voiceEnabled = !ctx.voiceEnabled;
    saveVoiceEnabled();

    if (!ctx.voiceEnabled) {
      stopTtsPlayback();
      setTip("已关闭语音播报。");
    } else if (ctx.voiceEnabled) {
      ctx.voicePrimed = false;
      testVoice(false);
    }

    updateVoiceUi();
  }

  async function testVoice(fromButton) {
    if (!ctx.voiceEnabled) {
      setTip("语音播报已关闭，请先开启。", true);
      updateVoiceUi();
      return;
    }

    const ok = await speakByTts("测试", 8, true);
    if (ok) {
      ctx.voicePrimed = true;
      if (fromButton) {
        setTip("语音已激活，后续会自动播报。");
      }
    } else if (fromButton) {
      setTip("TTS 服务不可用，请检查服务是否已启动。", true);
    }
    updateVoiceUi();
  }

  async function claimSeat(playerId) {
    try {
      const data = await api("/api/room/claim", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId,
        playerId
      });
      applyState(data.state, false, false);
      setTip("身份认领成功。");
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function releaseSeat() {
    if (!ctx.roomId) return;
    try {
      const data = await api("/api/room/release", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId
      });
      applyState(data.state, false, false);
      setTip("已释放你的身份。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  function readManualSign() {
    const raw = Number(dom.myPanel.querySelector("#mySign")?.value || 1);
    return raw === -1 ? -1 : 1;
  }

  function updateManualSignButtons(sign) {
    const plusBtn = dom.myPanel.querySelector("#mySignPlus");
    const minusBtn = dom.myPanel.querySelector("#mySignMinus");
    if (!plusBtn || !minusBtn) return;

    const positive = sign !== -1;
    plusBtn.classList.toggle("primary", positive);
    plusBtn.classList.toggle("muted", !positive);
    plusBtn.setAttribute("aria-pressed", positive ? "true" : "false");

    minusBtn.classList.toggle("primary", !positive);
    minusBtn.classList.toggle("muted", positive);
    minusBtn.setAttribute("aria-pressed", !positive ? "true" : "false");
  }

  function captureDraftCache() {
    if (!ctx.state || !ctx.state.myPlayerId) return;
    if (ctx.state.gameMode === "manual") {
      const rawValue = Number(dom.myPanel.querySelector("#myDelta")?.value || 0);
      const absValue = Number.isFinite(rawValue) ? Math.abs(rawValue) : 0;
      const sign = readManualSign();
      ctx.draftCache = {
        seq: ctx.state.round.seq,
        sign,
        delta: sign * absValue
      };
      return;
    }

    const typeId = dom.myPanel.querySelector("#myType")?.value;
    const rank = dom.myPanel.querySelector("#myRank")?.value;
    const suit = dom.myPanel.querySelector("#mySuit")?.value;
    const bet = dom.myPanel.querySelector("#myBet")?.value;

    const cache = {
      seq: ctx.state.round.seq,
      typeId,
      rank,
      suit
    };
    if (ctx.state.myRole === "idle") {
      cache.bet = Number(bet || 1);
    }
    ctx.draftCache = cache;
  }

  function readMySubmitData() {
    if (ctx.state.gameMode === "manual") {
      const rawValue = Number(dom.myPanel.querySelector("#myDelta")?.value || 0);
      if (!Number.isFinite(rawValue)) {
        throw new Error("本局积分必须是数字。");
      }
      if (rawValue < 0) {
        throw new Error("请只输入数字，正负请用上方按钮选择。");
      }
      const sign = readManualSign();
      const delta = sign * Math.abs(rawValue);
      return { delta };
    }

    const typeId = dom.myPanel.querySelector("#myType")?.value;
    const rank = dom.myPanel.querySelector("#myRank")?.value;
    const suit = dom.myPanel.querySelector("#mySuit")?.value;

    if (!typeId || !rank || !suit) {
      throw new Error("请先完成本局录入。");
    }

    if (ctx.state.myRole === "banker") {
      return { typeId, rank, suit };
    }

    const bet = Number(dom.myPanel.querySelector("#myBet")?.value || 0);
    if (!Number.isFinite(bet) || bet <= 0) {
      throw new Error("下注倍数必须大于 0。");
    }
    return { bet, typeId, rank, suit };
  }

  async function submitMine() {
    if (!ctx.state) {
      setTip("请先加入房间。", true);
      return;
    }
    if (!ctx.state.myPlayerId) {
      setTip("请先认领你的身份。", true);
      return;
    }

    try {
      const data = await readMySubmitData();
      const res = await api("/api/room/submit", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId,
        data
      });
      applyState(res.state, false, false);
      if (res.settled) {
        setTip(`全员已提交，第 ${res.settled.roundSeq} 局已自动结算。`);
      } else if (ctx.state.gameMode === "manual" && ctx.state.round && ctx.state.round.manualCheck && !ctx.state.round.manualCheck.ok) {
        setTip(manualMismatchText(ctx.state.round.manualCheck), true);
      } else {
        setTip("已提交，等待其他玩家。", false);
      }
      ctx.draftCache = null;
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function hostChangeBanker() {
    if (!ctx.state || !ctx.state.isHost) {
      setTip("只有房主可以切庄。", true);
      return;
    }

    try {
      const bankerId = ctx.pendingBankerId || dom.hostBankerSelect.value;
      const data = await api("/api/room/change-banker", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId,
        bankerId
      });
      ctx.pendingBankerId = "";
      applyState(data.state, false, false);
      setTip("已切换庄家（当前局不重开）。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function hostStartNewRound() {
    if (!ctx.state || !ctx.state.isHost) {
      setTip("只有房主可以开新局。", true);
      return;
    }

    try {
      const data = await api("/api/room/new-round", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId
      });
      applyState(data.state, false, false);
      setTip("已手动开新局。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function hostAddPlayer() {
    if (!ctx.state || !ctx.state.isHost) {
      setTip("只有房主可以添加玩家。", true);
      return;
    }

    const name = String(dom.hostNewPlayerName.value || "").trim();
    try {
      const data = await api("/api/room/player/add", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId,
        name
      });
      dom.hostNewPlayerName.value = "";
      applyState(data.state, false, false);
      setTip("玩家已添加，已开启新一局。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  function hostPlayerTableClick(e) {
    const renameBtn = e.target.closest("button.host-rename-btn");
    if (renameBtn) {
      const playerId = renameBtn.dataset.playerId;
      const oldName = renameBtn.dataset.playerName || "";
      hostRenamePlayer(playerId, oldName);
      return;
    }

    const removeBtn = e.target.closest("button.host-remove-btn");
    if (removeBtn) {
      const playerId = removeBtn.dataset.playerId;
      const playerName = removeBtn.dataset.playerName || "";
      hostRemovePlayer(playerId, playerName);
    }
  }

  async function hostRenamePlayer(playerId, oldName) {
    if (!ctx.state || !ctx.state.isHost) {
      setTip("只有房主可以改名。", true);
      return;
    }

    const name = window.prompt("输入新的玩家名称", oldName || "");
    if (name === null) return;

    try {
      const data = await api("/api/room/player/rename", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId,
        playerId,
        name
      });
      applyState(data.state, false, false);
      setTip("名称已更新。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function selfRenamePlayer(playerId, oldName) {
    if (!ctx.state || !ctx.state.myPlayerId) {
      setTip("请先认领你的身份。", true);
      return;
    }
    if (ctx.state.myPlayerId !== playerId) {
      setTip("只能修改你自己的名称。", true);
      return;
    }

    const name = window.prompt("输入你的新名称", oldName || "");
    if (name === null) return;

    try {
      const data = await api("/api/room/player/rename", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId,
        playerId,
        name
      });
      applyState(data.state, false, false);
      setTip("你的名称已更新。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function hostRemovePlayer(playerId, playerName) {
    if (!ctx.state || !ctx.state.isHost) {
      setTip("只有房主可以删除玩家。", true);
      return;
    }

    const ok = window.confirm(`确认删除 ${playerName || "该玩家"} 吗？`);
    if (!ok) return;

    try {
      const data = await api("/api/room/player/remove", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId,
        playerId
      });
      applyState(data.state, false, false);
      setTip("玩家已删除，已开启新一局。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function hostUndo() {
    if (!ctx.state || !ctx.state.isHost) {
      setTip("只有房主可以撤销。", true);
      return;
    }

    try {
      const data = await api("/api/room/undo", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId
      });
      applyState(data.state, false, false);
      setTip("已撤销上一局。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function hostReset() {
    if (!ctx.state || !ctx.state.isHost) {
      setTip("只有房主可以清空战绩。", true);
      return;
    }
    if (!window.confirm("确认清空整个房间的积分和历史吗？")) return;

    try {
      const data = await api("/api/room/reset", "POST", {
        roomId: ctx.roomId,
        clientId: ctx.clientId
      });
      applyState(data.state, false, false);
      setTip("已清空战绩与总分。", false);
    } catch (err) {
      setTip(err.message, true);
    }
  }

  async function copyInviteLink() {
    const roomId = normalizeRoomId(dom.roomIdInput.value || ctx.roomId);
    if (!roomId) {
      setTip("请先输入或创建房间号。", true);
      return;
    }
    const linkUrl = new URL(`${window.location.origin}${window.location.pathname}`);
    linkUrl.searchParams.set("room", roomId);
    const link = linkUrl.toString();

    try {
      await navigator.clipboard.writeText(link);
      setTip("邀请链接已复制。", false);
    } catch {
      window.prompt("复制这个链接给其他玩家", link);
    }
  }

  function leaveRoom() {
    stopPolling();
    stopTtsPlayback();
    ctx.roomId = "";
    ctx.state = null;
    ctx.lastRoundSeq = 0;
    ctx.draftCache = null;
    ctx.historyPage = 1;
    ctx.lastAnnouncedHistoryId = "";
    ctx.pendingBankerId = "";
    localStorage.removeItem(ROOM_KEY);

    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    history.replaceState({}, "", url.toString());

    dom.roomIdInput.value = "";
    render();
    setTip("已退出房间，可重新加入或新建房间。");
  }

  function render(opts) {
    const options = opts || {};
    renderRoomEntryMode();
    updateVoiceUi();
    renderRoomMeta();
    renderSeats();
    if (!options.skipMyPanel) {
      renderMyPanel();
    }
    renderRoundInfo();
    renderHostPanel();
    renderScores();
    renderHistory();
  }

  function renderRoomEntryMode() {
    const joined = !!ctx.state;
    dom.createSection.classList.toggle("hidden", joined);
    dom.leaveRoomBtn.classList.toggle("hidden", !joined);
    dom.roomIdInput.readOnly = joined;
    dom.joinBtn.textContent = joined ? "刷新房间" : "加入房间";
    dom.roomIdInput.placeholder = joined ? "" : "例如 A8K2D9";
    refreshCreateModeUi();
  }

  function refreshCreateModeUi() {
    if (!dom.createGameMode || !dom.createMultiplierWrap) return;
    const gameMode = dom.createGameMode.value || "manual";
    const isCards = gameMode === "cards";
    if (dom.createBaseWrap) dom.createBaseWrap.classList.toggle("hidden", !isCards);
    if (dom.createBankerMulWrap) dom.createBankerMulWrap.classList.toggle("hidden", !isCards);
    dom.createMultiplierWrap.classList.toggle("hidden", !isCards);
  }

  function shouldKeepMyPanel(prevState, nextState, fromCreate) {
    if (fromCreate) return false;
    if (!prevState || !nextState) return false;
    if (!isMyPanelFocused()) return false;
    if (prevState.roomId !== nextState.roomId) return false;
    if (prevState.round?.seq !== nextState.round?.seq) return false;
    if (prevState.myPlayerId !== nextState.myPlayerId) return false;
    if (prevState.myRole !== nextState.myRole) return false;
    return true;
  }

  function detectNewSettlement(prevState, nextState, fromCreate) {
    if (fromCreate || !prevState || !nextState) return null;
    if (prevState.roomId !== nextState.roomId) return null;

    const prevHistory = Array.isArray(prevState.history) ? prevState.history : [];
    const nextHistory = Array.isArray(nextState.history) ? nextState.history : [];
    if (nextHistory.length <= prevHistory.length) return null;

    const prevTopId = prevHistory[0] ? prevHistory[0].id : "";
    const nextTop = nextHistory[0] || null;
    if (!nextTop || !nextTop.id || nextTop.id === prevTopId) return null;

    return nextTop;
  }

  function announceSettlement(record) {
    if (!record || !record.id) return;
    if (ctx.lastAnnouncedHistoryId === record.id) return;
    if (alreadyAnnouncedInOtherTab(record.id)) {
      ctx.lastAnnouncedHistoryId = record.id;
      return;
    }
    ctx.lastAnnouncedHistoryId = record.id;

    const isBankerDevice = !!ctx.state && ctx.state.myRole === "banker" && ctx.state.myPlayerId === ctx.state.bankerId;
    if (!isBankerDevice) {
      return;
    }

    const bankerName = record.bankerName || "庄家";
    const bankerDelta = Number(record.bankerDelta || 0);
    speakByTts(bankerName, bankerDelta, false).then((ok) => {
      if (ok) return;
      if (!ctx.voiceEnabled) return;
      if (!ctx.voicePrimed) {
        dom.voiceHint.textContent = "该设备需先点一次“测试语音”以激活自动播报。";
      } else {
        dom.voiceHint.textContent = `TTS 服务不可用，请检查：${ctx.ttsBaseUrl}`;
      }
    });
  }

  function alreadyAnnouncedInOtherTab(recordId) {
    if (!recordId || !ctx.roomId) return false;
    const key = `${ANNOUNCED_RECORD_KEY_PREFIX}:${ctx.roomId}`;
    try {
      const last = String(localStorage.getItem(key) || "");
      if (last && last === recordId) return true;
      localStorage.setItem(key, recordId);
      return false;
    } catch {
      return false;
    }
  }

  function ttsAnnounceUrl(name, delta) {
    const base = normalizeTtsBaseUrl(ctx.ttsBaseUrl) || defaultTtsBaseUrl();
    const qp = new URLSearchParams({
      name: String(name || "庄家"),
      delta: String(Number(delta || 0))
    });
    return `${base}/announce?${qp.toString()}`;
  }

  async function speakByTts(name, delta, forcePrime) {
    if (!ctx.voiceEnabled) return false;
    if (typeof window === "undefined" || typeof window.Audio !== "function") return false;
    if (!ctx.voicePrimed && !forcePrime) return false;

    try {
      const url = ttsAnnounceUrl(name, delta);
      if (!ctx.ttsAudio) {
        ctx.ttsAudio = new Audio();
        ctx.ttsAudio.preload = "auto";
      }
      const audio = ctx.ttsAudio;
      audio.pause();
      audio.currentTime = 0;
      audio.src = url;
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === "function") {
        await playPromise;
      }
      return true;
    } catch {
      return false;
    }
  }

  function updateVoiceUi() {
    if (!dom.voiceToggleBtn || !dom.voiceHint) return;
    const supported = typeof window !== "undefined" && typeof window.fetch === "function" && typeof window.Audio === "function";
    if (!supported) {
      dom.voiceToggleBtn.textContent = "语音：不可用";
      dom.voiceToggleBtn.disabled = true;
      dom.voiceTestBtn.disabled = true;
      dom.voiceHint.textContent = "当前浏览器不支持音频播放。";
      return;
    }

    dom.voiceToggleBtn.disabled = false;
    dom.voiceTestBtn.disabled = !ctx.voiceEnabled;
    dom.voiceToggleBtn.textContent = `语音：${ctx.voiceEnabled ? "开" : "关"}`;
    if (!ctx.voiceEnabled) {
      dom.voiceHint.textContent = "语音播报已关闭。";
      return;
    }
    dom.voiceHint.textContent = ctx.voicePrimed
      ? `语音已激活（仅庄家设备会自动播报）。TTS：${ctx.ttsBaseUrl}`
      : `请先点一次“测试语音”激活自动播报（仅庄家设备生效）。TTS：${ctx.ttsBaseUrl}`;
  }

  function isMyPanelFocused() {
    const active = document.activeElement;
    if (!active) return false;
    return !!active.closest("#myPanel");
  }

  function renderRoomMeta() {
    if (!ctx.state) {
      dom.roomMeta.textContent = `当前客户端ID：${ctx.clientId.slice(-8)}（用于识别你认领的身份）`;
      return;
    }

    const role = ctx.state.myRole === "banker" ? "庄家" : ctx.state.myRole === "idle" ? "闲家" : "未认领";
    const myPlayer = ctx.state.players.find((p) => p.id === ctx.state.myPlayerId);
    const userName = myPlayer ? myPlayer.name : "未设置";
    dom.roomMeta.textContent = `房间 ${ctx.state.roomId} | 模式：${gameModeLabel(ctx.state.gameMode)} | 用户名：${userName} | 第 ${ctx.state.round.seq} 局 | 你的身份：${role} | ${ctx.state.isHost ? "你是房主" : ""}`;
  }

  function renderSeats() {
    if (!ctx.state) {
      dom.seatRows.innerHTML = '<tr><td colspan="4">未连接房间。</td></tr>';
      return;
    }

    dom.seatRows.innerHTML = ctx.state.players
      .map((p) => {
        const role = p.isBanker ? '<span class="badge">庄家</span>' : "闲家";
        const submitted = p.submitted ? "已提交" : "待提交";

        let action = "";
        if (p.ownerState === "self") {
          action = `<span class="badge">已认领</span> <button class="muted self-rename-btn" type="button" data-player-id="${p.id}" data-player-name="${esc(p.name)}">改名</button>`;
        } else if (p.ownerState === "free") {
          action = `<button class="secondary claim-btn" type="button" data-player-id="${p.id}">认领</button>`;
        } else {
          action = '<span class="small">被占用</span>';
        }

        return `<tr><td>${esc(p.name)}</td><td>${role}</td><td>${submitted}</td><td>${action}</td></tr>`;
      })
      .join("");
  }

  function renderMyPanel() {
    if (!ctx.state || !ctx.state.myPlayerId || !ctx.state.myDraft) {
      dom.myPanel.innerHTML = '先加入房间并认领身份。';
      dom.submitBtn.disabled = true;
      return;
    }

    if (ctx.state.gameMode === "manual") {
      const draft = pickDraftView();
      const draftDelta = Number(draft.delta || 0);
      const draftSign = Number(draft.sign) === -1 ? -1 : (draftDelta < 0 ? -1 : 1);
      const draftAbs = Math.abs(draftDelta);
      dom.myPanel.innerHTML = `
        <div class="small">本局积分正负</div>
        <div class="actions" style="margin-top:6px">
          <button id="mySignPlus" class="muted manual-sign-btn" type="button" data-sign="1">正</button>
          <button id="mySignMinus" class="muted manual-sign-btn" type="button" data-sign="-1">负</button>
        </div>
        <input id="mySign" type="hidden" value="${draftSign}">
        <label style="margin-top:8px">本局积分（仅输入数字，可小数）<input id="myDelta" type="number" min="0" step="0.1" value="${fmt(draftAbs)}"></label>
        <div class="small" style="margin-top:8px">你当前状态：${ctx.state.myDraft.submitted ? "已提交（可再次提交覆盖）" : "未提交"}</div>
      `;
      updateManualSignButtons(draftSign);
      dom.submitBtn.disabled = false;
      return;
    }

    const draft = pickDraftView();
    const typeOptions = ctx.state.types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    const rankOptions = RANK_DESC.map((r) => `<option value="${r}">${r}</option>`).join("");
    const suitOptions = SUITS.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");

    const betRow = ctx.state.myRole === "idle"
      ? `<label>下注倍数<input id="myBet" type="number" min="0.1" step="0.1" value="${draft.bet}"></label>`
      : "";

    dom.myPanel.innerHTML = `
      ${betRow}
      <div class="row3" style="margin-top:8px">
        <label>牌型<select id="myType">${typeOptions}</select></label>
        <label>关键牌点数<select id="myRank">${rankOptions}</select></label>
        <label>关键牌花色<select id="mySuit">${suitOptions}</select></label>
      </div>
      <div class="small" style="margin-top:8px">你当前状态：${ctx.state.myDraft.submitted ? "已提交（可再次提交覆盖）" : "未提交"}</div>
    `;

    const typeEl = dom.myPanel.querySelector("#myType");
    const rankEl = dom.myPanel.querySelector("#myRank");
    const suitEl = dom.myPanel.querySelector("#mySuit");
    if (typeEl) typeEl.value = draft.typeId;
    if (rankEl) rankEl.value = draft.rank;
    if (suitEl) suitEl.value = draft.suit;

    dom.submitBtn.disabled = false;
  }

  function pickDraftView() {
    if (!ctx.state || !ctx.state.myDraft) return null;
    const base = { ...ctx.state.myDraft };
    const cache = ctx.draftCache;
    if (!cache || cache.seq !== ctx.state.round.seq) return base;

    if (ctx.state.gameMode === "manual") {
      base.sign = Number(base.delta) < 0 ? -1 : 1;
      if (cache.sign === -1 || cache.sign === 1) {
        base.sign = cache.sign;
      }
      if (Number.isFinite(Number(cache.delta))) {
        base.delta = Number(cache.delta);
        if (!(cache.sign === -1 || cache.sign === 1)) {
          base.sign = Number(base.delta) < 0 ? -1 : 1;
        }
      }
      return base;
    }

    if (cache.typeId) base.typeId = cache.typeId;
    if (cache.rank) base.rank = cache.rank;
    if (cache.suit) base.suit = cache.suit;
    if (ctx.state.myRole === "idle" && Number.isFinite(Number(cache.bet))) {
      base.bet = Number(cache.bet);
    }
    return base;
  }

  function renderRoundInfo() {
    if (!ctx.state) {
      dom.roundInfo.textContent = "未连接房间。";
      return;
    }

    const myPlayer = ctx.state.players.find((p) => p.id === ctx.state.myPlayerId);
    const userName = myPlayer ? myPlayer.name : "未设置";
    const waiting = ctx.state.round.waitingFor.length ? ctx.state.round.waitingFor.join("、") : "无";
    const modeText = gameModeLabel(ctx.state.gameMode);
    const settlementText = ctx.state.gameMode === "manual"
      ? "结算规则：每人提交本局积分，全部提交且庄闲分数一致时自动累计。"
      : `结算配置：底分 ${fmt(ctx.state.rules.base)} × 庄倍 ${fmt(ctx.state.rules.bankerMul)} × 牌型倍率（${modeLabel(ctx.state.rules.mode)}）`;
    const lines = [
      `房间：${esc(ctx.state.roomId)}`,
      `模式：${esc(modeText)}`,
      `用户名：${esc(userName)}`,
      `当前局：第 ${ctx.state.round.seq} 局`,
      `提交进度：${ctx.state.round.submittedCount}/${ctx.state.round.total}`,
      `待提交：${esc(waiting)}`,
      settlementText
    ];
    const mismatchText = ctx.state.gameMode === "manual" ? manualMismatchText(ctx.state.round.manualCheck) : "";
    if (mismatchText) {
      lines.push(`<span class="lose">${esc(mismatchText)}</span>`);
    }
    dom.roundInfo.innerHTML = lines.join("<br>");
  }

  function renderHostPanel() {
    if (!ctx.state || !ctx.state.isHost) {
      dom.hostPanel.classList.add("hidden");
      ctx.pendingBankerId = "";
      return;
    }

    dom.hostPanel.classList.remove("hidden");
    dom.hostBankerSelect.innerHTML = ctx.state.players
      .map((p) => `<option value="${p.id}">${esc(p.name)}${p.isBanker ? "（当前庄）" : ""}</option>`)
      .join("");
    const validPending = ctx.state.players.some((p) => p.id === ctx.pendingBankerId);
    if (validPending) {
      dom.hostBankerSelect.value = ctx.pendingBankerId;
    } else {
      ctx.pendingBankerId = "";
      dom.hostBankerSelect.value = ctx.state.bankerId;
    }

    dom.hostPlayerRows.innerHTML = ctx.state.players
      .map((p) => {
        const role = p.isBanker ? "庄家" : "闲家";
        const claim = p.ownerState === "self" ? "我" : p.ownerState === "taken" ? "已占用" : "空闲";
        return `<tr>
          <td>${esc(p.name)}</td>
          <td>${role}</td>
          <td>${claim}</td>
          <td>
            <button class="muted host-rename-btn" type="button" data-player-id="${p.id}" data-player-name="${esc(p.name)}">改名</button>
            <button class="warn host-remove-btn" type="button" data-player-id="${p.id}" data-player-name="${esc(p.name)}">删除</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderScores() {
    if (!ctx.state) {
      dom.scoreRows.innerHTML = '<tr><td colspan="3">未连接房间。</td></tr>';
      return;
    }

    const myId = ctx.state.myPlayerId || "";
    dom.scoreRows.innerHTML = ctx.state.scores
      .map((x, i) => {
        const cls = x.score > 0 ? "win" : x.score < 0 ? "lose" : "";
        const nameClass = x.playerId === myId ? "self-name" : "";
        const myTag = x.playerId === myId ? "（我）" : "";
        return `<tr><td>${i + 1}</td><td class="${nameClass}">${esc(x.name)}${myTag}</td><td class="${cls}">${signed(x.score)}</td></tr>`;
      })
      .join("");
  }

  function renderHistory() {
    if (!ctx.state || !ctx.state.history.length) {
      dom.historyRows.innerHTML = '<tr><td colspan="5">暂无对局记录。</td></tr>';
      dom.historyPageInfo.textContent = "第 1 / 1 页";
      dom.historyPrevBtn.disabled = true;
      dom.historyNextBtn.disabled = true;
      return;
    }

    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(ctx.state.history.length / pageSize));
    if (ctx.historyPage > totalPages) ctx.historyPage = totalPages;
    if (ctx.historyPage < 1) ctx.historyPage = 1;
    const start = (ctx.historyPage - 1) * pageSize;
    const pageRows = ctx.state.history.slice(start, start + pageSize);

    dom.historyRows.innerHTML = pageRows
      .map((r) => {
        const details = (r.details || [])
          .map((d) => {
            if (r.mode === "manual" || d.manualDelta) {
              return esc(`${d.playerName} 本局积分 ${signed(d.delta)}`);
            }
            const action = d.delta > 0 ? "赢" : d.delta < 0 ? "输" : "平";
            const idleType = d.idleTypeName || d.idleTypeId || "未知牌型";
            const bankerType = d.bankerTypeName || (r.bankerHand && r.bankerHand.typeName) || "未知牌型";
            return esc(`${d.playerName}[${idleType}] vs 庄[${bankerType}] ${action} ${fmt(Math.abs(d.delta))}（下注${fmt(d.bet)}x/倍率${fmt(d.tm)}x）`);
          })
          .join("<br>");
        const cls = r.bankerDelta > 0 ? "win" : r.bankerDelta < 0 ? "lose" : "";
        return `<tr><td>${esc(timeText(r.ts))}</td><td>${r.roundSeq}</td><td>${esc(r.bankerName)}</td><td>${details || "-"}</td><td class="${cls}">${signed(r.bankerDelta)}</td></tr>`;
      })
      .join("");

    dom.historyPageInfo.textContent = `第 ${ctx.historyPage} / ${totalPages} 页`;
    dom.historyPrevBtn.disabled = ctx.historyPage <= 1;
    dom.historyNextBtn.disabled = ctx.historyPage >= totalPages;
  }

  function changeHistoryPage(delta) {
    if (!ctx.state || !ctx.state.history.length) return;
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(ctx.state.history.length / pageSize));
    const next = Math.max(1, Math.min(totalPages, ctx.historyPage + delta));
    if (next === ctx.historyPage) return;
    ctx.historyPage = next;
    renderHistory();
  }

  function setTip(text, bad) {
    dom.myTip.textContent = text;
    dom.myTip.style.color = bad ? "#a42f18" : "#663711";
  }

  function fmt(v) {
    const n = Math.round((Number(v) + Number.EPSILON) * 100) / 100;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  function manualMismatchText(check) {
    if (!check || check.ok) return "";
    const bankerText = signed(check.bankerDelta);
    const idleText = signed(check.idleSum);
    const expectedBankerText = signed(check.expectedBanker);
    const diffText = signed(check.diff);
    return `分数不一致：庄家填 ${bankerText}，闲家合计 ${idleText}，庄家应为 ${expectedBankerText}（差值 ${diffText}）。请修改后再提交。`;
  }

  function signed(v) {
    const n = Math.round((Number(v) + Number.EPSILON) * 100) / 100;
    if (n > 0) return `+${fmt(n)}`;
    if (n < 0) return `-${fmt(Math.abs(n))}`;
    return "0";
  }

  function timeText(ts) {
    return new Date(Number(ts) || Date.now()).toLocaleString("zh-CN", { hour12: false });
  }

  function modeLabel(mode) {
    if (mode === "banker") return "按庄家牌型";
    if (mode === "idle") return "按闲家牌型";
    return "按赢家牌型";
  }

  function gameModeLabel(mode) {
    return mode === "manual" ? "自主积分模式" : "牌型对战模式";
  }

  function esc(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
