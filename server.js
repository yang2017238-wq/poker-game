const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_VALUE = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  "J": 11, "Q": 12, "K": 13, "A": 14
};

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  if (rooms[id]) return generateRoomId();
  return id;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, label: `${rank}${suit}` });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function createPlayer(socketId, name) {
  return {
    id: socketId,
    name: name || "玩家",
    chips: 1000,
    hand: [],
    folded: false,
    allIn: false,
    currentBet: 0,
    actedThisRound: false
  };
}

function createRoom(hostSocketId, hostName) {
  const roomId = generateRoomId();
  rooms[roomId] = {
    roomId,
    hostId: hostSocketId,
    players: [createPlayer(hostSocketId, hostName)],
    deck: [],
    communityCards: [],
    pot: 0,
    stage: "waiting", // waiting / preflop / flop / turn / river / showdown
    currentTurn: 0,
    currentBet: 0,
    minRaise: 20,
    gameStarted: false,
    winnerText: "",
    actionLog: []
  };
  return rooms[roomId];
}

function getRoomBySocketId(socketId) {
  return Object.values(rooms).find(room => room.players.some(p => p.id === socketId));
}

function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.folded && p.chips >= 0);
}

function getNotFoldedPlayers(room) {
  return room.players.filter(p => !p.folded);
}

function getNextActivePlayerIndex(room, startIndex) {
  const len = room.players.length;
  for (let i = 1; i <= len; i++) {
    const idx = (startIndex + i) % len;
    const p = room.players[idx];
    if (!p.folded && !p.allIn && p.chips > 0) {
      return idx;
    }
  }
  return -1;
}

function resetRoundActions(room) {
  room.players.forEach(p => {
    p.actedThisRound = false;
  });
}

function dealHoleCards(room) {
  room.players.forEach(player => {
    player.hand = [room.deck.pop(), room.deck.pop()];
    player.folded = false;
    player.allIn = false;
    player.currentBet = 0;
    player.actedThisRound = false;
  });
}

function startGame(room) {
  room.deck = shuffle(createDeck());
  room.communityCards = [];
  room.pot = 0;
  room.stage = "preflop";
  room.currentBet = 0;
  room.minRaise = 20;
  room.gameStarted = true;
  room.winnerText = "";
  room.actionLog = [];

  dealHoleCards(room);

  room.currentTurn = 0;
  while (
    room.currentTurn < room.players.length &&
    (room.players[room.currentTurn].folded ||
      room.players[room.currentTurn].allIn ||
      room.players[room.currentTurn].chips <= 0)
  ) {
    room.currentTurn++;
  }

  if (room.currentTurn >= room.players.length) {
    room.currentTurn = 0;
  }

  room.actionLog.push("游戏开始，已发手牌");
}

function advanceStage(room) {
  room.players.forEach(p => {
    p.currentBet = 0;
    p.actedThisRound = false;
  });
  room.currentBet = 0;

  if (room.stage === "preflop") {
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    room.stage = "flop";
    room.actionLog.push("进入 Flop");
  } else if (room.stage === "flop") {
    room.communityCards.push(room.deck.pop());
    room.stage = "turn";
    room.actionLog.push("进入 Turn");
  } else if (room.stage === "turn") {
    room.communityCards.push(room.deck.pop());
    room.stage = "river";
    room.actionLog.push("进入 River");
  } else if (room.stage === "river") {
    room.stage = "showdown";
    room.actionLog.push("进入 Showdown");
    settleShowdown(room);
    return;
  }

  const firstIdx = room.players.findIndex(p => !p.folded && !p.allIn && p.chips > 0);
  room.currentTurn = firstIdx === -1 ? 0 : firstIdx;
}

function everyoneMatchedBet(room) {
  const eligible = room.players.filter(p => !p.folded && !p.allIn);
  if (eligible.length <= 1) return true;
  return eligible.every(p => p.currentBet === room.currentBet && p.actedThisRound);
}

function checkRoundProgress(room) {
  const notFolded = getNotFoldedPlayers(room);

  if (notFolded.length === 1) {
    const winner = notFolded[0];
    winner.chips += room.pot;
    room.winnerText = `${winner.name} 因其他玩家弃牌而获胜，赢得底池 ${room.pot}`;
    room.actionLog.push(room.winnerText);
    room.pot = 0;
    room.gameStarted = false;
    room.stage = "waiting";
    return;
  }

  if (everyoneMatchedBet(room)) {
    advanceStage(room);
    return;
  }

  const nextIdx = getNextActivePlayerIndex(room, room.currentTurn);
  if (nextIdx !== -1) {
    room.currentTurn = nextIdx;
  }
}

function settleShowdown(room) {
  const candidates = room.players.filter(p => !p.folded);
  if (candidates.length === 0) {
    room.gameStarted = false;
    room.stage = "waiting";
    return;
  }

  // 简化判定：七张牌中最高点数大的赢
  let winner = candidates[0];
  let bestScore = bestHighCardScore(candidates[0], room.communityCards);

  for (let i = 1; i < candidates.length; i++) {
    const score = bestHighCardScore(candidates[i], room.communityCards);
    if (score > bestScore) {
      bestScore = score;
      winner = candidates[i];
    }
  }

  winner.chips += room.pot;
  room.winnerText = `${winner.name} 摊牌获胜，赢得底池 ${room.pot}`;
  room.actionLog.push(room.winnerText);
  room.pot = 0;
  room.gameStarted = false;
  room.stage = "waiting";
}

function bestHighCardScore(player, communityCards) {
  const allCards = [...player.hand, ...communityCards];
  return Math.max(...allCards.map(card => RANK_VALUE[card.rank]));
}

function emitRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("roomState", {
    roomId: room.roomId,
    hostId: room.hostId,
    players: room.players.map((p, index) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      folded: p.folded,
      allIn: p.allIn,
      currentBet: p.currentBet,
      handCount: p.hand.length,
      isCurrentTurn: index === room.currentTurn
    })),
    communityCards: room.communityCards.map(c => c.label),
    pot: room.pot,
    stage: room.stage,
    currentBet: room.currentBet,
    currentTurn: room.currentTurn,
    gameStarted: room.gameStarted,
    winnerText: room.winnerText,
    actionLog: room.actionLog.slice(-8)
  });

  room.players.forEach(player => {
    io.to(player.id).emit("privateHand", player.hand.map(c => c.label));
  });
}

function removePlayerFromRoom(socketId) {
  const room = getRoomBySocketId(socketId);
  if (!room) return;

  const idx = room.players.findIndex(p => p.id === socketId);
  if (idx === -1) return;

  const leavingPlayer = room.players[idx];
  room.actionLog.push(`${leavingPlayer.name} 离开了房间`);

  room.players.splice(idx, 1);

  if (room.players.length === 0) {
    delete rooms[room.roomId];
    return;
  }

  if (room.hostId === socketId) {
    room.hostId = room.players[0].id;
    room.actionLog.push(`${room.players[0].name} 成为新房主`);
  }

  if (room.currentTurn >= room.players.length) {
    room.currentTurn = 0;
  }

  emitRoomState(room.roomId);
}

io.on("connection", socket => {
  console.log("用户连接:", socket.id);

  socket.on("createRoom", ({ name }) => {
    const trimmedName = (name || "玩家").trim().slice(0, 12);
    const room = createRoom(socket.id, trimmedName);

    socket.join(room.roomId);
    emitRoomState(room.roomId);
    socket.emit("roomCreated", { roomId: room.roomId });
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    const targetRoomId = (roomId || "").trim().toUpperCase();
    const trimmedName = (name || "玩家").trim().slice(0, 12);

    const room = rooms[targetRoomId];
    if (!room) {
      socket.emit("errorMessage", "房间不存在");
      return;
    }

    if (room.players.length >= 9) {
      socket.emit("errorMessage", "房间已满");
      return;
    }

    if (room.gameStarted) {
      socket.emit("errorMessage", "本局已开始，请等待下一局");
      return;
    }

    room.players.push(createPlayer(socket.id, trimmedName));
    room.actionLog.push(`${trimmedName} 加入了房间`);

    socket.join(targetRoomId);
    emitRoomState(targetRoomId);
  });

  socket.on("startGame", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;

    if (socket.id !== room.hostId) {
      socket.emit("errorMessage", "只有房主可以开始游戏");
      return;
    }

    if (room.players.length < 2) {
      socket.emit("errorMessage", "至少需要 2 名玩家");
      return;
    }

    startGame(room);
    emitRoomState(room.roomId);
  });

  socket.on("playerAction", ({ action, amount }) => {
    const room = getRoomBySocketId(socket.id);
    if (!room || !room.gameStarted) return;

    const player = getPlayer(room, socket.id);
    if (!player) return;

    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit("errorMessage", "还没轮到你操作");
      return;
    }

    if (player.folded || player.allIn) {
      socket.emit("errorMessage", "你当前不能操作");
      return;
    }

    if (action === "fold") {
      player.folded = true;
      player.actedThisRound = true;
      room.actionLog.push(`${player.name} 选择弃牌`);
    }

    else if (action === "check") {
      if (player.currentBet !== room.currentBet) {
        socket.emit("errorMessage", "当前不能过牌，请跟注或加注");
        return;
      }
      player.actedThisRound = true;
      room.actionLog.push(`${player.name} 选择过牌`);
    }

    else if (action === "call") {
      const need = room.currentBet - player.currentBet;
      if (need <= 0) {
        player.actedThisRound = true;
        room.actionLog.push(`${player.name} 选择过牌`);
      } else {
        const pay = Math.min(need, player.chips);
        player.chips -= pay;
        player.currentBet += pay;
        room.pot += pay;
        player.actedThisRound = true;

        if (player.chips === 0) {
          player.allIn = true;
          room.actionLog.push(`${player.name} 跟注并 All-in`);
        } else {
          room.actionLog.push(`${player.name} 跟注 ${pay}`);
        }
      }
    }

    else if (action === "raise") {
      const raiseAmount = Number(amount);

      if (!Number.isFinite(raiseAmount) || raiseAmount <= 0) {
        socket.emit("errorMessage", "加注金额无效");
        return;
      }

      const needToCall = room.currentBet - player.currentBet;
      const totalNeed = needToCall + raiseAmount;

      if (player.chips < totalNeed) {
        socket.emit("errorMessage", "筹码不足，无法这样加注");
        return;
      }

      player.chips -= totalNeed;
      player.currentBet += totalNeed;
      room.pot += totalNeed;
      room.currentBet = player.currentBet;
      player.actedThisRound = true;

      resetRoundActions(room);
      player.actedThisRound = true;

      if (player.chips === 0) {
        player.allIn = true;
        room.actionLog.push(`${player.name} 加注 ${raiseAmount} 并 All-in`);
      } else {
        room.actionLog.push(`${player.name} 加注 ${raiseAmount}`);
      }
    }

    else {
      socket.emit("errorMessage", "未知操作");
      return;
    }

    checkRoundProgress(room);
    emitRoomState(room.roomId);
  });

  socket.on("restartGame", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;

    if (socket.id !== room.hostId) {
      socket.emit("errorMessage", "只有房主可以开始下一局");
      return;
    }

    if (room.players.length < 2) {
      socket.emit("errorMessage", "至少需要 2 名玩家");
      return;
    }

    startGame(room);
    emitRoomState(room.roomId);
  });

  socket.on("disconnect", () => {
    console.log("用户断开:", socket.id);
    removePlayerFromRoom(socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});