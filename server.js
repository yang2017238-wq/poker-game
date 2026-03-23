const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 9;
const STARTING_CHIPS = 2000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_VALUE = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14
};

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms[id] ? generateRoomId() : id;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        suit,
        rank,
        value: RANK_VALUE[rank],
        label: `${rank}${suit}`
      });
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
    connected: true,
    chips: STARTING_CHIPS,
    hand: [],
    folded: false,
    allIn: false,
    currentBet: 0,
    totalContribution: 0,
    actedThisRound: false,
    sittingOut: false,
    lastAction: "等待"
  };
}

function createRoom(hostSocketId, hostName) {
  const roomId = generateRoomId();
  const room = {
    roomId,
    hostId: hostSocketId,
    players: [createPlayer(hostSocketId, hostName)],
    deck: [],
    communityCards: [],
    stage: "waiting",
    currentTurn: -1,
    currentBet: 0,
    minRaise: BIG_BLIND,
    gameStarted: false,
    winnerText: "",
    actionLog: [],
    dealerIndex: -1,
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    handNumber: 0,
    showdown: []
  };
  rooms[roomId] = room;
  return room;
}

function getRoomBySocketId(socketId) {
  return Object.values(rooms).find(room => room.players.some(player => player.id === socketId));
}

function getPlayer(room, socketId) {
  return room.players.find(player => player.id === socketId);
}

function getActiveSeatIndexes(room) {
  return room.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => player.chips > 0 && player.connected)
    .map(({ index }) => index);
}

function getPlayersStillInHand(room) {
  return room.players.filter(player => !player.sittingOut && !player.folded);
}

function getNextEligibleIndex(room, startIndex, options = {}) {
  const { includeAllIn = false, includeFolded = false, requireChips = false } = options;
  const total = room.players.length;

  if (!total) {
    return -1;
  }

  for (let offset = 1; offset <= total; offset++) {
    const index = (startIndex + offset + total) % total;
    const player = room.players[index];
    if (!player) {
      continue;
    }
    if (!includeFolded && player.folded) {
      continue;
    }
    if (player.sittingOut) {
      continue;
    }
    if (!includeAllIn && player.allIn) {
      continue;
    }
    if (requireChips && player.chips <= 0) {
      continue;
    }
    return index;
  }

  return -1;
}

function addLog(room, message) {
  room.actionLog.push(message);
  if (room.actionLog.length > 40) {
    room.actionLog = room.actionLog.slice(-40);
  }
}

function stageLabel(stage) {
  return {
    waiting: "等待开局",
    preflop: "翻牌前",
    flop: "翻牌圈",
    turn: "转牌圈",
    river: "河牌圈",
    showdown: "摊牌"
  }[stage] || stage;
}

function pruneDisconnectedPlayers(room) {
  room.players = room.players.filter(player => player.connected);
  if (!room.players.length) {
    delete rooms[room.roomId];
    return false;
  }
  if (!room.players.some(player => player.id === room.hostId)) {
    room.hostId = room.players[0].id;
  }
  if (room.dealerIndex >= room.players.length) {
    room.dealerIndex = room.players.length - 1;
  }
  return true;
}

function resetPlayerForNewHand(player) {
  player.hand = [];
  player.folded = false;
  player.allIn = false;
  player.currentBet = 0;
  player.totalContribution = 0;
  player.actedThisRound = false;
  player.sittingOut = player.chips <= 0 || !player.connected;
  player.lastAction = !player.connected ? "离线" : player.sittingOut ? "筹码用尽" : "等待";
}

function dealHoleCards(room) {
  room.players.forEach(player => {
    if (!player.sittingOut) {
      player.hand = [room.deck.pop(), room.deck.pop()];
    }
  });
}

function collectBet(room, player, amount, actionText) {
  const paid = Math.max(0, Math.min(amount, player.chips));
  player.chips -= paid;
  player.currentBet += paid;
  player.totalContribution += paid;
  if (player.chips === 0 && !player.folded) {
    player.allIn = true;
  }
  player.lastAction = actionText;
  return paid;
}

function resetRoundActions(room) {
  room.players.forEach(player => {
    if (!player.sittingOut && !player.folded && !player.allIn) {
      player.actedThisRound = false;
    }
  });
}

function postBlind(room, index, blindAmount, label) {
  const player = room.players[index];
  if (!player) {
    return 0;
  }
  const paid = collectBet(room, player, blindAmount, `${label} ${Math.min(blindAmount, player.currentBet + blindAmount)}`);
  player.actedThisRound = false;
  addLog(room, `${player.name} 下 ${label} ${paid}`);
  return paid;
}

function firstSeatForStage(room) {
  if (room.stage === "preflop") {
    const bigBlindIndex = room.players.findIndex(player => player.lastAction.startsWith("大盲"));
    return getNextEligibleIndex(room, bigBlindIndex, { requireChips: false });
  }
  return getNextEligibleIndex(room, room.dealerIndex, { requireChips: false });
}

function beginBettingRound(room) {
  room.players.forEach(player => {
    player.currentBet = 0;
    if (!player.sittingOut && !player.folded && !player.allIn) {
      player.actedThisRound = false;
      player.lastAction = "等待操作";
    }
  });
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.currentTurn = firstSeatForStage(room);
}

function prepareHand(room) {
  if (!pruneDisconnectedPlayers(room)) {
    return false;
  }

  const activeIndexes = getActiveSeatIndexes(room);
  if (activeIndexes.length < 2) {
    room.gameStarted = false;
    room.stage = "waiting";
    room.currentTurn = -1;
    room.winnerText = "至少需要两名仍有筹码的玩家";
    addLog(room, room.winnerText);
    return false;
  }

  room.handNumber += 1;
  room.deck = shuffle(createDeck());
  room.communityCards = [];
  room.stage = "preflop";
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.gameStarted = true;
  room.winnerText = "";
  room.showdown = [];

  room.players.forEach(resetPlayerForNewHand);
  dealHoleCards(room);

  room.dealerIndex = room.dealerIndex === -1
    ? activeIndexes[0]
    : getNextEligibleIndex(room, room.dealerIndex, { requireChips: true });

  const headsUp = activeIndexes.length === 2;
  const smallBlindIndex = headsUp
    ? room.dealerIndex
    : getNextEligibleIndex(room, room.dealerIndex, { requireChips: true });
  const bigBlindIndex = getNextEligibleIndex(room, smallBlindIndex, { requireChips: true });

  const smallBlindPaid = postBlind(room, smallBlindIndex, room.smallBlind, "小盲");
  const bigBlindPaid = postBlind(room, bigBlindIndex, room.bigBlind, "大盲");

  room.currentBet = Math.max(smallBlindPaid, bigBlindPaid);
  room.currentTurn = getNextEligibleIndex(room, bigBlindIndex, { requireChips: false });

  addLog(room, `第 ${room.handNumber} 局开始，当前阶段：${stageLabel(room.stage)}`);
  return true;
}

function everyoneMatchedBet(room) {
  const eligible = room.players.filter(player => !player.sittingOut && !player.folded && !player.allIn);
  if (eligible.length === 0) {
    return true;
  }
  return eligible.every(player => player.actedThisRound && player.currentBet === room.currentBet);
}

function getPotTotal(room) {
  return room.players.reduce((sum, player) => sum + player.totalContribution, 0);
}

function advanceStage(room) {
  room.players.forEach(player => {
    player.currentBet = 0;
  });
  room.currentBet = 0;
  room.minRaise = room.bigBlind;

  if (room.stage === "preflop") {
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    room.stage = "flop";
    addLog(room, "进入翻牌圈");
  } else if (room.stage === "flop") {
    room.communityCards.push(room.deck.pop());
    room.stage = "turn";
    addLog(room, "进入转牌圈");
  } else if (room.stage === "turn") {
    room.communityCards.push(room.deck.pop());
    room.stage = "river";
    addLog(room, "进入河牌圈");
  } else {
    room.stage = "showdown";
    settleShowdown(room);
    return;
  }

  room.currentTurn = firstSeatForStage(room);
  room.players.forEach(player => {
    if (!player.sittingOut && !player.folded && !player.allIn) {
      player.actedThisRound = false;
      player.lastAction = "等待操作";
    }
  });
}

function checkRoundProgress(room) {
  const stillInHand = getPlayersStillInHand(room);
  if (stillInHand.length === 1) {
    const winner = stillInHand[0];
    const potTotal = getPotTotal(room);
    winner.chips += potTotal;
    room.winnerText = `${winner.name} 因其他玩家弃牌赢得 ${potTotal}`;
    addLog(room, room.winnerText);
    room.stage = "waiting";
    room.gameStarted = false;
    room.currentTurn = -1;
    room.showdown = [
      {
        playerId: winner.id,
        name: winner.name,
        handName: "未摊牌"
      }
    ];
    pruneDisconnectedPlayers(room);
    return;
  }

  const playersAbleToAct = room.players.filter(player => !player.sittingOut && !player.folded && !player.allIn);
  if (playersAbleToAct.length === 0 || everyoneMatchedBet(room)) {
    advanceStage(room);
    return;
  }

  room.currentTurn = getNextEligibleIndex(room, room.currentTurn, { requireChips: false });
}

function getSortedValuesDesc(cards) {
  return cards.map(card => card.value).sort((a, b) => b - a);
}

function countByValue(cards) {
  const map = new Map();
  for (const card of cards) {
    map.set(card.value, (map.get(card.value) || 0) + 1);
  }
  return map;
}

function countBySuit(cards) {
  const map = new Map();
  for (const card of cards) {
    if (!map.has(card.suit)) {
      map.set(card.suit, []);
    }
    map.get(card.suit).push(card);
  }
  return map;
}

function getStraightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) {
    unique.push(1);
  }

  let run = 1;
  for (let i = 0; i < unique.length - 1; i++) {
    if (unique[i] - 1 === unique[i + 1]) {
      run += 1;
      if (run >= 5) {
        return unique[i - 3];
      }
    } else if (unique[i] !== unique[i + 1]) {
      run = 1;
    }
  }

  return null;
}

function evaluateSevenCards(cards) {
  const valuesDesc = getSortedValuesDesc(cards);
  const valueCount = countByValue(cards);
  const suitCount = countBySuit(cards);
  const entries = [...valueCount.entries()].sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return b[0] - a[0];
  });

  let flushCards = null;
  for (const suitCards of suitCount.values()) {
    if (suitCards.length >= 5) {
      flushCards = [...suitCards].sort((a, b) => b.value - a.value);
      break;
    }
  }

  if (flushCards) {
    const straightFlushHigh = getStraightHigh(flushCards.map(card => card.value));
    if (straightFlushHigh) {
      return {
        category: 8,
        tiebreakers: [straightFlushHigh],
        name: straightFlushHigh === 14 ? "皇家同花顺" : "同花顺"
      };
    }
  }

  const four = entries.find(([, count]) => count === 4);
  if (four) {
    const fourValue = four[0];
    const kicker = entries.find(([value]) => value !== fourValue)[0];
    return {
      category: 7,
      tiebreakers: [fourValue, kicker],
      name: "四条"
    };
  }

  const triples = entries.filter(([, count]) => count >= 3).map(([value]) => value);
  const pairs = entries.filter(([, count]) => count >= 2).map(([value]) => value);
  if (triples.length >= 1) {
    const triple = triples[0];
    const pair = pairs.find(value => value !== triple) || triples[1];
    if (pair) {
      return {
        category: 6,
        tiebreakers: [triple, pair],
        name: "葫芦"
      };
    }
  }

  if (flushCards) {
    return {
      category: 5,
      tiebreakers: flushCards.slice(0, 5).map(card => card.value),
      name: "同花"
    };
  }

  const straightHigh = getStraightHigh(valuesDesc);
  if (straightHigh) {
    return {
      category: 4,
      tiebreakers: [straightHigh],
      name: "顺子"
    };
  }

  if (triples.length >= 1) {
    const triple = triples[0];
    const kickers = entries
      .filter(([value]) => value !== triple)
      .map(([value]) => value)
      .slice(0, 2);
    return {
      category: 3,
      tiebreakers: [triple, ...kickers],
      name: "三条"
    };
  }

  if (pairs.length >= 2) {
    const highPair = pairs[0];
    const lowPair = pairs[1];
    const kicker = entries.find(([value]) => value !== highPair && value !== lowPair)[0];
    return {
      category: 2,
      tiebreakers: [highPair, lowPair, kicker],
      name: "两对"
    };
  }

  if (pairs.length === 1) {
    const pair = pairs[0];
    const kickers = entries
      .filter(([value]) => value !== pair)
      .map(([value]) => value)
      .slice(0, 3);
    return {
      category: 1,
      tiebreakers: [pair, ...kickers],
      name: "一对"
    };
  }

  return {
    category: 0,
    tiebreakers: [...new Set(valuesDesc)].slice(0, 5),
    name: "高牌"
  };
}

function compareHands(a, b) {
  if (a.category !== b.category) {
    return a.category - b.category;
  }
  const length = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < length; i++) {
    const aValue = a.tiebreakers[i] || 0;
    const bValue = b.tiebreakers[i] || 0;
    if (aValue !== bValue) {
      return aValue - bValue;
    }
  }
  return 0;
}

function settleShowdown(room) {
  const contenders = room.players
    .filter(player => !player.sittingOut && !player.folded && player.totalContribution > 0)
    .map(player => ({
      player,
      result: evaluateSevenCards([...player.hand, ...room.communityCards])
    }));

  if (!contenders.length) {
    room.stage = "waiting";
    room.gameStarted = false;
    room.currentTurn = -1;
    room.winnerText = "本局无人参与到底";
    addLog(room, room.winnerText);
    return;
  }

  const levels = [...new Set(
    room.players
      .filter(player => player.totalContribution > 0)
      .map(player => player.totalContribution)
  )].sort((a, b) => a - b);

  let previous = 0;
  const payouts = new Map();

  for (const level of levels) {
    const contributors = room.players.filter(player => player.totalContribution >= level);
    const potSize = (level - previous) * contributors.length;
    const eligible = contenders.filter(item => item.player.totalContribution >= level);

    if (potSize > 0 && eligible.length > 0) {
      let best = eligible[0];
      for (let i = 1; i < eligible.length; i++) {
        if (compareHands(eligible[i].result, best.result) > 0) {
          best = eligible[i];
        }
      }

      const winners = eligible.filter(item => compareHands(item.result, best.result) === 0);
      const share = Math.floor(potSize / winners.length);
      const remainder = potSize % winners.length;

      winners.forEach((winner, index) => {
        const amount = share + (index < remainder ? 1 : 0);
        payouts.set(winner.player.id, (payouts.get(winner.player.id) || 0) + amount);
      });
    }

    previous = level;
  }

  room.showdown = contenders.map(item => ({
    playerId: item.player.id,
    name: item.player.name,
    handName: item.result.name
  }));

  for (const contender of contenders) {
    contender.player.lastAction = contender.result.name;
  }

  let bestOverall = contenders[0];
  for (let i = 1; i < contenders.length; i++) {
    if (compareHands(contenders[i].result, bestOverall.result) > 0) {
      bestOverall = contenders[i];
    }
  }

  const headlineWinners = contenders.filter(item => compareHands(item.result, bestOverall.result) === 0);
  const totalPot = getPotTotal(room);

  payouts.forEach((amount, playerId) => {
    const player = room.players.find(entry => entry.id === playerId);
    if (player) {
      player.chips += amount;
    }
  });

  addLog(
    room,
    `摊牌：${contenders.map(item => `${item.player.name}(${item.result.name})`).join("，")}`
  );

  if (headlineWinners.length === 1) {
    room.winnerText = `${headlineWinners[0].player.name} 以 ${headlineWinners[0].result.name} 赢下 ${totalPot}`;
  } else {
    room.winnerText = `${headlineWinners.map(item => item.player.name).join("、")} 以 ${headlineWinners[0].result.name} 平分主池/边池`;
  }

  addLog(room, room.winnerText);
  room.stage = "waiting";
  room.gameStarted = false;
  room.currentTurn = -1;
  pruneDisconnectedPlayers(room);
}

function getPlayerView(room, player, index) {
  return {
    id: player.id,
    name: player.name,
    connected: player.connected,
    chips: player.chips,
    folded: player.folded,
    allIn: player.allIn,
    sittingOut: player.sittingOut,
    currentBet: player.currentBet,
    totalContribution: player.totalContribution,
    handCount: player.hand.length,
    isCurrentTurn: index === room.currentTurn,
    isDealer: index === room.dealerIndex,
    isHost: player.id === room.hostId,
    lastAction: player.lastAction
  };
}

function emitRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) {
    return;
  }

  io.to(roomId).emit("roomState", {
    roomId: room.roomId,
    hostId: room.hostId,
    players: room.players.map((player, index) => getPlayerView(room, player, index)),
    communityCards: room.communityCards.map(card => card.label),
    pot: getPotTotal(room),
    stage: room.stage,
    stageLabel: stageLabel(room.stage),
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    currentTurn: room.currentTurn,
    gameStarted: room.gameStarted,
    winnerText: room.winnerText,
    actionLog: room.actionLog.slice(-12),
    showdown: room.showdown,
    blinds: {
      small: room.smallBlind,
      big: room.bigBlind
    },
    handNumber: room.handNumber
  });

  room.players.forEach(player => {
    io.to(player.id).emit("privateHand", player.hand.map(card => card.label));
  });
}

function removePlayerFromRoom(socketId) {
  const room = getRoomBySocketId(socketId);
  if (!room) {
    return;
  }

  const index = room.players.findIndex(player => player.id === socketId);
  if (index === -1) {
    return;
  }

  const leavingPlayer = room.players[index];
  leavingPlayer.connected = false;
  addLog(room, `${leavingPlayer.name} 离开了房间`);

  if (room.gameStarted) {
    leavingPlayer.folded = true;
    leavingPlayer.sittingOut = true;
    leavingPlayer.actedThisRound = true;
    leavingPlayer.lastAction = "掉线";
  } else {
    room.players.splice(index, 1);
  }

  if (!room.players.length) {
    delete rooms[room.roomId];
    return;
  }

  if (room.hostId === socketId) {
    const nextHost = room.players.find(player => player.connected) || room.players[0];
    room.hostId = nextHost.id;
    addLog(room, `${nextHost.name} 成为新房主`);
  }

  if (room.dealerIndex >= room.players.length) {
    room.dealerIndex = room.players.length - 1;
  }
  if (room.currentTurn >= room.players.length) {
    room.currentTurn = -1;
  }

  if (room.gameStarted) {
    checkRoundProgress(room);
  }

  emitRoomState(room.roomId);
}

function normalizeName(name) {
  return (name || "玩家").trim().slice(0, 12) || "玩家";
}

io.on("connection", socket => {
  console.log("用户连接:", socket.id);

  socket.on("createRoom", ({ name }) => {
    const room = createRoom(socket.id, normalizeName(name));
    socket.join(room.roomId);
    addLog(room, `${room.players[0].name} 创建了房间 ${room.roomId}`);
    socket.emit("roomCreated", { roomId: room.roomId });
    emitRoomState(room.roomId);
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    const targetRoomId = (roomId || "").trim().toUpperCase();
    const room = rooms[targetRoomId];

    if (!room) {
      socket.emit("errorMessage", "房间不存在");
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("errorMessage", "房间已满");
      return;
    }
    if (room.gameStarted) {
      socket.emit("errorMessage", "本局进行中，请等待下一局加入");
      return;
    }
    if (room.players.some(player => player.id === socket.id)) {
      emitRoomState(room.roomId);
      return;
    }

    const player = createPlayer(socket.id, normalizeName(name));
    room.players.push(player);
    socket.join(room.roomId);
    addLog(room, `${player.name} 加入了房间`);
    emitRoomState(room.roomId);
  });

  socket.on("startGame", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) {
      return;
    }
    if (socket.id !== room.hostId) {
      socket.emit("errorMessage", "只有房主可以开始");
      return;
    }
    if (room.gameStarted) {
      socket.emit("errorMessage", "本局已经开始");
      return;
    }

    const hasStarted = prepareHand(room);
    if (hasStarted) {
      emitRoomState(room.roomId);
    } else {
      socket.emit("errorMessage", room.winnerText);
      emitRoomState(room.roomId);
    }
  });

  socket.on("restartGame", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) {
      return;
    }
    if (socket.id !== room.hostId) {
      socket.emit("errorMessage", "只有房主可以开始下一局");
      return;
    }
    if (room.gameStarted) {
      socket.emit("errorMessage", "请先完成当前对局");
      return;
    }

    const hasStarted = prepareHand(room);
    if (hasStarted) {
      emitRoomState(room.roomId);
    } else {
      socket.emit("errorMessage", room.winnerText);
      emitRoomState(room.roomId);
    }
  });

  socket.on("playerAction", ({ action, amount }) => {
    const room = getRoomBySocketId(socket.id);
    if (!room || !room.gameStarted) {
      return;
    }

    const player = getPlayer(room, socket.id);
    if (!player) {
      return;
    }
    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit("errorMessage", "还没轮到你");
      return;
    }
    if (player.folded || player.allIn || player.sittingOut) {
      socket.emit("errorMessage", "你当前不能操作");
      return;
    }

    if (action === "fold") {
      player.folded = true;
      player.actedThisRound = true;
      player.lastAction = "弃牌";
      addLog(room, `${player.name} 弃牌`);
    } else if (action === "check") {
      if (player.currentBet !== room.currentBet) {
        socket.emit("errorMessage", "当前不能过牌");
        return;
      }
      player.actedThisRound = true;
      player.lastAction = "过牌";
      addLog(room, `${player.name} 过牌`);
    } else if (action === "call") {
      const need = room.currentBet - player.currentBet;
      if (need <= 0) {
        player.actedThisRound = true;
        player.lastAction = "过牌";
        addLog(room, `${player.name} 过牌`);
      } else {
        const paid = collectBet(room, player, need, player.chips === need ? "跟注 all-in" : "跟注");
        player.actedThisRound = true;
        addLog(room, `${player.name} ${player.allIn ? "跟注并全下" : `跟注 ${paid}`}`);
      }
    } else if (action === "betRaise") {
      const targetBet = Number(amount);
      if (!Number.isFinite(targetBet)) {
        socket.emit("errorMessage", "下注金额无效");
        return;
      }
      if (targetBet <= room.currentBet) {
        socket.emit("errorMessage", "请输入高于当前下注的总额");
        return;
      }

      const minimumTarget = room.currentBet === 0 ? room.bigBlind : room.currentBet + room.minRaise;
      if (targetBet < minimumTarget) {
        socket.emit("errorMessage", `最小下注/加注到 ${minimumTarget}`);
        return;
      }

      const need = targetBet - player.currentBet;
      if (need > player.chips) {
        socket.emit("errorMessage", "筹码不足，请改用全下");
        return;
      }

      const previousBet = room.currentBet;
      collectBet(room, player, need, previousBet === 0 ? "下注" : "加注");
      room.currentBet = player.currentBet;
      room.minRaise = room.currentBet - previousBet;
      resetRoundActions(room);
      player.actedThisRound = true;
      addLog(room, `${player.name} ${previousBet === 0 ? `下注到 ${targetBet}` : `加注到 ${targetBet}`}`);
    } else if (action === "allIn") {
      if (player.chips <= 0) {
        socket.emit("errorMessage", "没有可全下的筹码");
        return;
      }

      const previousBet = room.currentBet;
      const totalTarget = player.currentBet + player.chips;
      const raiseSize = totalTarget - previousBet;
      collectBet(room, player, player.chips, "全下");

      if (player.currentBet > previousBet) {
        room.currentBet = player.currentBet;
        if (raiseSize >= room.minRaise) {
          room.minRaise = raiseSize;
          resetRoundActions(room);
        }
      }

      player.actedThisRound = true;
      addLog(room, `${player.name} 全下到 ${player.currentBet}`);
    } else {
      socket.emit("errorMessage", "未知操作");
      return;
    }

    checkRoundProgress(room);
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
