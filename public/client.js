const socket = io();

const playerNameInput = document.getElementById("playerName");
const roomIdInput = document.getElementById("roomIdInput");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const startGameBtn = document.getElementById("startGameBtn");
const foldBtn = document.getElementById("foldBtn");
const checkBtn = document.getElementById("checkBtn");
const callBtn = document.getElementById("callBtn");
const raiseBtn = document.getElementById("raiseBtn");
const allInBtn = document.getElementById("allInBtn");
const betAmountInput = document.getElementById("betAmountInput");
const dockFoldBtn = document.getElementById("dockFoldBtn");
const dockCheckBtn = document.getElementById("dockCheckBtn");
const dockCallBtn = document.getElementById("dockCallBtn");
const dockRaiseBtn = document.getElementById("dockRaiseBtn");
const dockAllInBtn = document.getElementById("dockAllInBtn");

const roomCodeEl = document.getElementById("roomCode");
const stageTextEl = document.getElementById("stageText");
const potTextEl = document.getElementById("potText");
const tablePotEl = document.getElementById("tablePot");
const blindsTextEl = document.getElementById("blindsText");
const handTextEl = document.getElementById("handText");
const playersEl = document.getElementById("players");
const communityCardsEl = document.getElementById("communityCards");
const myHandEl = document.getElementById("myHand");
const turnHintEl = document.getElementById("turnHint");
const winnerBannerEl = document.getElementById("winnerBanner");
const turnBannerEl = document.getElementById("turnBanner");
const shareLinkEl = document.getElementById("shareLink");
const actionSummaryEl = document.getElementById("actionSummary");
const logListEl = document.getElementById("logList");
const revealedHandsEl = document.getElementById("revealedHands");
const revealHintEl = document.getElementById("revealHint");
const dockStageEl = document.getElementById("dockStage");
const dockCallEl = document.getElementById("dockCall");
const dockRaiseEl = document.getElementById("dockRaise");

let currentRoomState = null;
let myPrivateHand = [];
let turnFlashTimer = null;

function getSavedName() {
  return window.localStorage.getItem("poker-player-name") || "";
}

function saveName(name) {
  window.localStorage.setItem("poker-player-name", name);
}

function getPlayerName() {
  const name = playerNameInput.value.trim();
  if (!name) {
    alert("请输入昵称");
    return null;
  }
  saveName(name);
  return name;
}

function getInviteLink(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

function formatCard(card) {
  const isRed = card.includes("♥") || card.includes("♦");
  return `<span class="poker-card ${isRed ? "red" : ""}">${card}</span>`;
}

function renderMiniCard(card) {
  const isRed = card.includes("♥") || card.includes("♦");
  return `<span class="mini-card ${isRed ? "red" : ""}">${card}</span>`;
}

function renderCardList(cards) {
  if (!cards || !cards.length) {
    return `<div class="empty-state">等待发牌</div>`;
  }
  return cards.map(formatCard).join("");
}

function renderCommunityCards() {
  communityCardsEl.innerHTML = renderCardList(currentRoomState?.communityCards || []);
}

function getSeatPositionClass(index, total) {
  const compact = total <= 6 ? index : Math.min(index, 8);
  return `seat-pos-${compact}`;
}

function renderPlayers() {
  playersEl.innerHTML = "";
  if (!currentRoomState?.players?.length) {
    playersEl.innerHTML = `<div class="empty-state seat-empty">创建房间后，座位会显示在这里</div>`;
    return;
  }

  const total = currentRoomState.players.length;
  currentRoomState.players.forEach((player, index) => {
    const seat = document.createElement("article");
    const isMe = player.id === socket.id;
    const hiddenCards = Array.from({ length: player.handCount || 2 }, () => "🂠");
    const cards = isMe ? myPrivateHand : hiddenCards;

    seat.className = [
      "seat",
      getSeatPositionClass(index, total),
      player.isCurrentTurn ? "seat-active" : "",
      player.folded ? "seat-folded" : "",
      player.allIn ? "seat-allin" : "",
      isMe ? "seat-me" : ""
    ].filter(Boolean).join(" ");

    seat.innerHTML = `
      <div class="seat-topline">
        <strong>${player.name}${isMe ? " · 你" : ""}</strong>
        <span>${player.chips}</span>
      </div>
      <div class="seat-badges">
        ${player.isDealer ? `<span class="badge">D</span>` : ""}
        ${player.isHost ? `<span class="badge">房主</span>` : ""}
        ${player.allIn ? `<span class="badge badge-warn">All-in</span>` : ""}
        ${player.folded ? `<span class="badge badge-muted">弃牌</span>` : ""}
        ${player.sittingOut ? `<span class="badge badge-muted">坐出</span>` : ""}
        ${player.connected === false ? `<span class="badge badge-muted">离线</span>` : ""}
      </div>
      <div class="seat-cards">${cards.map(renderMiniCard).join("")}</div>
      <div class="seat-meta">
        <span>本轮下注 ${player.currentBet}</span>
        <span>${player.lastAction || "等待"}</span>
      </div>
    `;
    playersEl.appendChild(seat);
  });
}

function renderMyHand() {
  myHandEl.innerHTML = renderCardList(myPrivateHand);
}

function renderLogs() {
  const logs = currentRoomState?.actionLog || [];
  if (!logs.length) {
    logListEl.innerHTML = `<div class="empty-state">这里会显示行动日志</div>`;
    return;
  }
  logListEl.innerHTML = logs.slice().reverse().map(item => `<div class="log-item">${item}</div>`).join("");
}

function renderRevealedHands() {
  const hands = currentRoomState?.revealedHands || [];
  if (!hands.length) {
    revealHintEl.textContent = "牌局结束后显示";
    revealedHandsEl.innerHTML = `<div class="empty-state">本局结束后，这里会公开所有玩家底牌和牌型</div>`;
    return;
  }

  revealHintEl.textContent = `已公开 ${hands.length} 位玩家底牌`;
  revealedHandsEl.innerHTML = hands.map(item => `
    <article class="revealed-card">
      <div class="revealed-top">
        <strong>${item.name}</strong>
        <span>${item.handName}</span>
      </div>
      <div class="cards-row revealed-row">${item.cards.map(formatCard).join("")}</div>
    </article>
  `).join("");
}

function updateTurnBanner(me, myTurn) {
  if (!currentRoomState) {
    turnBannerEl.classList.remove("visible", "mine");
    turnBannerEl.textContent = "";
    document.title = "公网德州扑克牌桌";
    return;
  }

  const activePlayer = currentRoomState.players?.find(player => player.isCurrentTurn);
  const bannerText = myTurn
    ? "轮到你操作"
    : activePlayer && currentRoomState.gameStarted
      ? `轮到 ${activePlayer.name} 操作`
      : currentRoomState.winnerText || "等待下一局";

  turnBannerEl.textContent = bannerText;
  turnBannerEl.classList.toggle("visible", Boolean(bannerText));
  turnBannerEl.classList.toggle("mine", Boolean(myTurn));

  if (turnFlashTimer) {
    window.clearInterval(turnFlashTimer);
    turnFlashTimer = null;
  }

  if (myTurn) {
    let highlighted = true;
    document.title = "轮到你操作";
    turnFlashTimer = window.setInterval(() => {
      document.title = highlighted ? "轮到你操作" : "公网德州扑克牌桌";
      highlighted = !highlighted;
    }, 1000);
  } else {
    document.title = activePlayer && currentRoomState.gameStarted
      ? `${activePlayer.name} 操作中`
      : "公网德州扑克牌桌";
  }
}

function updateHeaderInfo() {
  roomCodeEl.textContent = currentRoomState?.roomId || "未加入";
  stageTextEl.textContent = currentRoomState?.stageLabel || "等待开局";
  potTextEl.textContent = currentRoomState?.pot ?? 0;
  tablePotEl.textContent = currentRoomState?.pot ?? 0;
  blindsTextEl.textContent = currentRoomState ? `盲注 ${currentRoomState.blinds.small} / ${currentRoomState.blinds.big}` : "盲注 10 / 20";
  handTextEl.textContent = `第 ${currentRoomState?.handNumber || 0} 局`;
  winnerBannerEl.textContent = currentRoomState?.winnerText || "";
  winnerBannerEl.classList.toggle("visible", Boolean(currentRoomState?.winnerText));

  if (currentRoomState?.roomId) {
    shareLinkEl.textContent = getInviteLink(currentRoomState.roomId);
  } else {
    shareLinkEl.textContent = "邀请链接会显示在这里";
  }
}

function updateActionPanel() {
  const me = currentRoomState?.players?.find(player => player.id === socket.id);
  if (!me || !currentRoomState) {
    actionSummaryEl.textContent = "等待加入房间。";
    turnHintEl.textContent = "等待加入房间";
    [foldBtn, checkBtn, callBtn, raiseBtn, allInBtn, dockFoldBtn, dockCheckBtn, dockCallBtn, dockRaiseBtn, dockAllInBtn, startGameBtn].forEach(button => {
      button.disabled = true;
    });
    dockStageEl.textContent = "等待开局";
    dockCallEl.textContent = "跟注 0";
    dockRaiseEl.textContent = "最小加注到 20";
    updateTurnBanner(null, false);
    return;
  }

  const isHost = me.id === currentRoomState.hostId;
  startGameBtn.disabled = !isHost || currentRoomState.gameStarted;
  startGameBtn.textContent = currentRoomState.gameStarted ? "牌局进行中" : "开始 / 下一局";

  const myTurn = me.isCurrentTurn && currentRoomState.gameStarted;
  const toCall = Math.max(0, currentRoomState.currentBet - me.currentBet);
  const minTarget = currentRoomState.currentBet === 0
    ? currentRoomState.blinds.big
    : currentRoomState.currentBet + currentRoomState.minRaise;

  turnHintEl.textContent = myTurn ? "轮到你操作" : currentRoomState.gameStarted ? "等待其他玩家" : "等待房主开始";
  actionSummaryEl.textContent = currentRoomState.gameStarted
    ? `当前阶段 ${currentRoomState.stageLabel}，你还需跟注 ${toCall}，最小加注到 ${minTarget}。`
    : "房主点击“开始 / 下一局”后发牌。";
  dockStageEl.textContent = currentRoomState.stageLabel;
  dockCallEl.textContent = `跟注 ${toCall}`;
  dockRaiseEl.textContent = `最小加注到 ${minTarget}`;

  betAmountInput.min = String(minTarget);
  if (Number(betAmountInput.value) < minTarget) {
    betAmountInput.value = String(minTarget);
  }

  const disableAction = !myTurn || me.folded || me.allIn || me.sittingOut;
  foldBtn.disabled = disableAction;
  checkBtn.disabled = disableAction || me.currentBet !== currentRoomState.currentBet;
  callBtn.disabled = disableAction || toCall <= 0;
  raiseBtn.disabled = disableAction || me.chips + me.currentBet <= currentRoomState.currentBet;
  allInBtn.disabled = disableAction || me.chips <= 0;
  dockFoldBtn.disabled = foldBtn.disabled;
  dockCheckBtn.disabled = checkBtn.disabled;
  dockCallBtn.disabled = callBtn.disabled;
  dockRaiseBtn.disabled = raiseBtn.disabled;
  dockAllInBtn.disabled = allInBtn.disabled;

  updateTurnBanner(me, myTurn);
}

function renderRoom() {
  updateHeaderInfo();
  renderCommunityCards();
  renderPlayers();
  renderMyHand();
  renderLogs();
  renderRevealedHands();
  updateActionPanel();
}

function sendAction(action, amount) {
  socket.emit("playerAction", { action, amount });
}

createRoomBtn.onclick = () => {
  const name = getPlayerName();
  if (!name) {
    return;
  }
  socket.emit("createRoom", { name });
};

joinRoomBtn.onclick = () => {
  const name = getPlayerName();
  if (!name) {
    return;
  }
  const roomId = roomIdInput.value.trim().toUpperCase();
  if (!roomId) {
    alert("请输入房间号");
    return;
  }
  socket.emit("joinRoom", { roomId, name });
};

copyLinkBtn.onclick = async () => {
  if (!currentRoomState?.roomId) {
    alert("请先创建或加入房间");
    return;
  }
  const inviteLink = getInviteLink(currentRoomState.roomId);
  try {
    await navigator.clipboard.writeText(inviteLink);
    copyLinkBtn.textContent = "已复制";
    window.setTimeout(() => {
      copyLinkBtn.textContent = "复制邀请链接";
    }, 1200);
  } catch (error) {
    alert(`复制失败，请手动复制：\n${inviteLink}`);
  }
};

startGameBtn.onclick = () => {
  if (!currentRoomState) {
    return;
  }
  socket.emit("startGame");
};

foldBtn.onclick = () => sendAction("fold");
checkBtn.onclick = () => sendAction("check");
callBtn.onclick = () => sendAction("call");
raiseBtn.onclick = () => sendAction("betRaise", Number(betAmountInput.value));
allInBtn.onclick = () => sendAction("allIn");
dockFoldBtn.onclick = () => sendAction("fold");
dockCheckBtn.onclick = () => sendAction("check");
dockCallBtn.onclick = () => sendAction("call");
dockRaiseBtn.onclick = () => sendAction("betRaise", Number(betAmountInput.value));
dockAllInBtn.onclick = () => sendAction("allIn");

socket.on("roomCreated", ({ roomId }) => {
  roomIdInput.value = roomId;
});

socket.on("roomState", state => {
  currentRoomState = state;
  renderRoom();
});

socket.on("privateHand", hand => {
  myPrivateHand = hand || [];
  renderMyHand();
  renderPlayers();
});

socket.on("errorMessage", message => {
  alert(message);
});

function bootstrapFromUrl() {
  playerNameInput.value = getSavedName();
  const url = new URL(window.location.href);
  const room = url.searchParams.get("room");
  if (room) {
    roomIdInput.value = room.toUpperCase();
  }
  renderRoom();
}

bootstrapFromUrl();
