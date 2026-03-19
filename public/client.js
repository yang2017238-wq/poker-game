const socket = io();

const playerNameInput = document.getElementById("playerName");
const createRoomBtn = document.getElementById("createRoomBtn");
const roomIdInput = document.getElementById("roomIdInput");
const joinRoomBtn = document.getElementById("joinRoomBtn");

const startGameBtn = document.getElementById("startGameBtn");
const restartGameBtn = document.getElementById("restartGameBtn");
const checkBtn = document.getElementById("checkBtn");
const callBtn = document.getElementById("callBtn");
const raiseBtn = document.getElementById("raiseBtn");
const foldBtn = document.getElementById("foldBtn");
const raiseAmountInput = document.getElementById("raiseAmount");

const statusEl = document.getElementById("status");
const errorBox = document.getElementById("errorBox");
const roomInfoEl = document.getElementById("roomInfo");
const playersEl = document.getElementById("players");
const communityCardsEl = document.getElementById("communityCards");
const myHandEl = document.getElementById("myHand");
const potEl = document.getElementById("pot");
const currentBetEl = document.getElementById("currentBet");
const winnerEl = document.getElementById("winner");
const logEl = document.getElementById("log");

let currentRoomState = null;
let myHand = [];

createRoomBtn.addEventListener("click", () => {
  const name = playerNameInput.value.trim();
  if (!name) {
    showError("请输入名字");
    return;
  }
  socket.emit("createRoom", { name });
});

joinRoomBtn.addEventListener("click", () => {
  const name = playerNameInput.value.trim();
  const roomId = roomIdInput.value.trim().toUpperCase();

  if (!name) {
    showError("请输入名字");
    return;
  }
  if (!roomId) {
    showError("请输入房间号");
    return;
  }

  socket.emit("joinRoom", { roomId, name });
});

startGameBtn.addEventListener("click", () => {
  socket.emit("startGame");
});

restartGameBtn.addEventListener("click", () => {
  socket.emit("restartGame");
});

checkBtn.addEventListener("click", () => {
  socket.emit("playerAction", { action: "check" });
});

callBtn.addEventListener("click", () => {
  socket.emit("playerAction", { action: "call" });
});

raiseBtn.addEventListener("click", () => {
  const amount = Number(raiseAmountInput.value);
  if (!amount || amount <= 0) {
    showError("请输入有效加注额");
    return;
  }
  socket.emit("playerAction", { action: "raise", amount });
});

foldBtn.addEventListener("click", () => {
  socket.emit("playerAction", { action: "fold" });
});

socket.on("connect", () => {
  statusEl.textContent = `已连接服务器`;
});

socket.on("disconnect", () => {
  statusEl.textContent = "已断开服务器连接";
});

socket.on("roomCreated", ({ roomId }) => {
  roomIdInput.value = roomId;
  statusEl.textContent = `房间创建成功：${roomId}`;
});

socket.on("roomState", roomState => {
  currentRoomState = roomState;
  renderRoomState();
});

socket.on("privateHand", hand => {
  myHand = hand;
  renderMyHand();
});

socket.on("errorMessage", msg => {
  showError(msg);
});

function renderRoomState() {
  if (!currentRoomState) return;

  roomInfoEl.textContent = `房间号：${currentRoomState.roomId} ｜ 阶段：${currentRoomState.stage}`;
  potEl.textContent = `底池：${currentRoomState.pot}`;
  currentBetEl.textContent = `当前最高下注：${currentRoomState.currentBet}`;
  winnerEl.textContent = currentRoomState.winnerText || "";

  playersEl.innerHTML = "";
  currentRoomState.players.forEach((p, index) => {
    const div = document.createElement("div");
    div.className = "player-card";
    div.innerHTML = `
      <div><strong>${index + 1}. ${escapeHtml(p.name)}</strong></div>
      <div>筹码：${p.chips}</div>
      <div>本轮下注：${p.currentBet}</div>
      <div>状态：${p.folded ? "已弃牌" : p.allIn ? "ALL IN" : "在局中"}</div>
      <div>${p.isCurrentTurn ? "当前行动玩家" : ""}</div>
    `;
    playersEl.appendChild(div);
  });

  communityCardsEl.innerHTML = currentRoomState.communityCards.length
    ? currentRoomState.communityCards.map(card => `<span class="card">${escapeHtml(card)}</span>`).join("")
    : "<span>暂无公共牌</span>";

  logEl.innerHTML = "";
  (currentRoomState.actionLog || []).forEach(item => {
    const li = document.createElement("li");
    li.textContent = item;
    logEl.appendChild(li);
  });
}

function renderMyHand() {
  myHandEl.innerHTML = myHand.length
    ? myHand.map(card => `<span class="card">${escapeHtml(card)}</span>`).join("")
    : "<span>暂无手牌</span>";
}

function showError(msg) {
  errorBox.textContent = msg;
  setTimeout(() => {
    if (errorBox.textContent === msg) {
      errorBox.textContent = "";
    }
  }, 2500);
}

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}