const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const rooms = {};
const clients = new Map();

const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MAX_PLAYERS = 4;

const VALUE_MAP = {
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
  A: 14,
};

const HAND_TYPE_NAMES = [
  "高牌",
  "一对",
  "两对",
  "三条",
  "顺子",
  "同花",
  "葫芦",
  "四条",
  "同花顺",
];

function serveStaticFile(req, res) {
  let filePath = path.join(__dirname, "public", req.url === "/" ? "index.html" : req.url);

  // 简单防止路径穿越
  const publicDir = path.join(__dirname, "public");
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (req.url !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server Error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };

    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
    });
    res.end(data);
  });
}

const server = http.createServer(serveStaticFile);
const wss = new WebSocket.Server({ server });

function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const values = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];

  for (const suit of suits) {
    for (const value of values) {
      deck.push(value + suit);
    }
  }

  return shuffle(deck);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseCard(card) {
  const suit = card.slice(-1);
  const valueStr = card.slice(0, -1);
  return {
    raw: card,
    suit,
    value: VALUE_MAP[valueStr],
  };
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function getPlayerName(ws) {
  return clients.get(ws)?.name || "未知玩家";
}

function getPlayerInfo(room, ws) {
  return room.playerData.get(ws);
}

function getActivePlayers(room) {
  return room.players.filter((ws) => !room.foldedPlayers.has(ws));
}

function getActivePlayerCount(room) {
  return getActivePlayers(room).length;
}

function getNextOccupiedIndex(room, startIndex) {
  if (room.players.length === 0) return -1;

  let idx = startIndex;
  for (let i = 0; i < room.players.length; i += 1) {
    idx = (idx + 1) % room.players.length;
    if (room.players[idx]) return idx;
  }
  return -1;
}

function getFirstActiveIndex(room) {
  for (let i = 0; i < room.players.length; i += 1) {
    if (!room.foldedPlayers.has(room.players[i])) {
      return i;
    }
  }
  return -1;
}

function getNextActiveIndex(room, startIndex) {
  if (room.players.length === 0) return -1;

  let idx = startIndex;
  for (let i = 0; i < room.players.length; i += 1) {
    idx = (idx + 1) % room.players.length;
    if (!room.foldedPlayers.has(room.players[idx])) {
      return idx;
    }
  }
  return -1;
}

function broadcastPlayers(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const names = room.players.map((ws) => getPlayerName(ws));
  room.players.forEach((ws) => {
    send(ws, { type: "players", players: names });
  });
}

function broadcastStatus(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const status = room.players.map((ws) => {
    const info = getPlayerInfo(room, ws);
    return {
      name: getPlayerName(ws),
      folded: room.foldedPlayers.has(ws),
      chips: info ? info.chips : 0,
      bet: info ? info.bet : 0,
    };
  });

  room.players.forEach((ws) => {
    send(ws, { type: "status", players: status });
  });
}

function broadcastCommunity(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.players.forEach((ws) => {
    send(ws, {
      type: "community",
      cards: room.communityCards,
      stage: room.stage,
    });
  });
}

function broadcastSystem(roomId, msg) {
  const room = rooms[roomId];
  if (!room) return;

  room.players.forEach((ws) => {
    send(ws, { type: "system", msg });
  });
}

function broadcastTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  let currentPlayer = "（未开始）";
  if (room.stage === "finished" || room.stage === "showdown") {
    currentPlayer = "本局结束";
  } else if (room.turnIndex >= 0 && room.turnIndex < room.players.length) {
    currentPlayer = getPlayerName(room.players[room.turnIndex]);
  }

  room.players.forEach((ws) => {
    send(ws, { type: "turn", currentPlayer });
  });
}

function broadcastPot(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.players.forEach((ws) => {
    send(ws, {
      type: "pot",
      pot: room.pot,
      currentBet: room.currentBet,
    });
  });
}

function broadcastResult(roomId, text) {
  const room = rooms[roomId];
  if (!room) return;

  room.players.forEach((ws) => {
    send(ws, { type: "result", text });
  });
}

function broadcastRoles(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const dealer =
    room.dealerIndex >= 0 && room.dealerIndex < room.players.length
      ? getPlayerName(room.players[room.dealerIndex])
      : "";
  const smallBlind =
    room.smallBlindIndex >= 0 && room.smallBlindIndex < room.players.length
      ? getPlayerName(room.players[room.smallBlindIndex])
      : "";
  const bigBlind =
    room.bigBlindIndex >= 0 && room.bigBlindIndex < room.players.length
      ? getPlayerName(room.players[room.bigBlindIndex])
      : "";

  room.players.forEach((ws) => {
    send(ws, {
      type: "roles",
      dealer,
      smallBlind,
      bigBlind,
    });
  });
}

function moveToNextPlayer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (getActivePlayerCount(room) <= 1) return;

  room.turnIndex = getNextActiveIndex(room, room.turnIndex);
  broadcastTurn(roomId);
}

function resetRoundBets(room) {
  room.currentBet = 0;
  room.actedPlayers = new Set();

  room.players.forEach((ws) => {
    const info = getPlayerInfo(room, ws);
    if (info) info.bet = 0;
  });
}

function setupPostflopBettingRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  resetRoundBets(room);

  const firstToAct =
    room.players.length === 2 ? room.bigBlindIndex : getFirstActiveIndex(room);

  room.turnIndex = firstToAct;
  broadcastStatus(roomId);
  broadcastPot(roomId);
  broadcastTurn(roomId);
}

function allActivePlayersMatched(room) {
  return getActivePlayers(room).every((ws) => {
    const info = getPlayerInfo(room, ws);
    return info && info.bet === room.currentBet;
  });
}

function allActivePlayersActed(room) {
  return getActivePlayers(room).every((ws) => room.actedPlayers.has(ws));
}

function getStraightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);

  if (unique.includes(14)) unique.push(1);

  let count = 1;
  for (let i = 0; i < unique.length - 1; i += 1) {
    if (unique[i] - 1 === unique[i + 1]) {
      count += 1;
      if (count >= 5) return unique[i - 3];
    } else {
      count = 1;
    }
  }

  return null;
}

function evaluateFiveCards(cards) {
  const parsed = cards.map(parseCard);
  const values = parsed.map((c) => c.value).sort((a, b) => b - a);
  const suits = parsed.map((c) => c.suit);

  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;

  const countEntries = Object.entries(counts)
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.value - a.value;
    });

  const isFlush = suits.every((s) => s === suits[0]);
  const straightHigh = getStraightHigh(values);
  const isStraight = straightHigh !== null;

  if (isFlush && isStraight) {
    return { rank: 8, tiebreak: [straightHigh], name: HAND_TYPE_NAMES[8] };
  }
  if (countEntries[0].count === 4) {
    return {
      rank: 7,
      tiebreak: [countEntries[0].value, countEntries[1].value],
      name: HAND_TYPE_NAMES[7],
    };
  }
  if (countEntries[0].count === 3 && countEntries[1].count === 2) {
    return {
      rank: 6,
      tiebreak: [countEntries[0].value, countEntries[1].value],
      name: HAND_TYPE_NAMES[6],
    };
  }
  if (isFlush) {
    return { rank: 5, tiebreak: [...values], name: HAND_TYPE_NAMES[5] };
  }
  if (isStraight) {
    return { rank: 4, tiebreak: [straightHigh], name: HAND_TYPE_NAMES[4] };
  }
  if (countEntries[0].count === 3) {
    const trips = countEntries[0].value;
    const kickers = countEntries
      .slice(1)
      .map((x) => x.value)
      .sort((a, b) => b - a);

    return { rank: 3, tiebreak: [trips, ...kickers], name: HAND_TYPE_NAMES[3] };
  }
  if (countEntries[0].count === 2 && countEntries[1].count === 2) {
    const highPair = Math.max(countEntries[0].value, countEntries[1].value);
    const lowPair = Math.min(countEntries[0].value, countEntries[1].value);
    return {
      rank: 2,
      tiebreak: [highPair, lowPair, countEntries[2].value],
      name: HAND_TYPE_NAMES[2],
    };
  }
  if (countEntries[0].count === 2) {
    const pair = countEntries[0].value;
    const kickers = countEntries
      .slice(1)
      .map((x) => x.value)
      .sort((a, b) => b - a);

    return { rank: 1, tiebreak: [pair, ...kickers], name: HAND_TYPE_NAMES[1] };
  }

  return { rank: 0, tiebreak: [...values], name: HAND_TYPE_NAMES[0] };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;

  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i += 1) {
    const av = a.tiebreak[i] || 0;
    const bv = b.tiebreak[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function getCombinations(cards, choose) {
  const result = [];

  function backtrack(start, path) {
    if (path.length === choose) {
      result.push([...path]);
      return;
    }

    for (let i = start; i < cards.length; i += 1) {
      path.push(cards[i]);
      backtrack(i + 1, path);
      path.pop();
    }
  }

  backtrack(0, []);
  return result;
}

function evaluateSevenCards(cards) {
  const combos = getCombinations(cards, 5);
  let best = null;

  for (const combo of combos) {
    const current = evaluateFiveCards(combo);
    if (!best || compareHands(current, best) > 0) {
      best = current;
    }
  }
  return best;
}

function rotateDealer(room) {
  if (room.players.length === 0) {
    room.dealerIndex = -1;
    return;
  }

  if (room.dealerIndex === -1 || room.dealerIndex === undefined) {
    room.dealerIndex = 0;
    return;
  }

  room.dealerIndex = getNextOccupiedIndex(room, room.dealerIndex);
}

function finishHand(roomId, resultText) {
  const room = rooms[roomId];
  if (!room) return;

  room.stage = "finished";
  room.turnIndex = -1;

  if (resultText) {
    broadcastResult(roomId, resultText);
    broadcastSystem(roomId, resultText);
  }

  room.pot = 0;
  room.currentBet = 0;
  room.actedPlayers = new Set();

  room.players.forEach((ws) => {
    const info = getPlayerInfo(room, ws);
    if (info) info.bet = 0;
  });

  broadcastStatus(roomId);
  broadcastPot(roomId);
  broadcastCommunity(roomId);
  broadcastTurn(roomId);

  rotateDealer(room);
  broadcastRoles(roomId);
}

function finishShowdown(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const alivePlayers = getActivePlayers(room);
  if (alivePlayers.length === 0) {
    finishHand(roomId, "没有可结算的玩家");
    return;
  }

  let bestHand = null;
  let winners = [];

  for (const ws of alivePlayers) {
    const info = getPlayerInfo(room, ws);
    if (!info || !info.hand) continue;

    const allCards = [...info.hand, ...room.communityCards];
    const evaluated = evaluateSevenCards(allCards);
    info.bestHand = evaluated;

    if (!bestHand || compareHands(evaluated, bestHand) > 0) {
      bestHand = evaluated;
      winners = [ws];
    } else if (compareHands(evaluated, bestHand) === 0) {
      winners.push(ws);
    }
  }

  if (!bestHand || winners.length === 0) {
    finishHand(roomId, "摊牌失败：没有可比较的手牌");
    return;
  }

  const totalPot = room.pot;
  const share = Math.floor(totalPot / winners.length);
  const remainder = totalPot % winners.length;

  winners.forEach((ws, index) => {
    const info = getPlayerInfo(room, ws);
    if (info) {
      info.chips += share + (index === 0 ? remainder : 0);
    }
  });

  const winnerNames = winners.map((ws) => getPlayerName(ws)).join("、");
  const resultText = `摊牌结束：${winnerNames} 获胜，牌型是 ${bestHand.name}，获得底池 ${totalPot}`;

  finishHand(roomId, resultText);
}

function dealNextStage(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.stage === "preflop") {
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    room.stage = "flop";
    broadcastCommunity(roomId);
    broadcastSystem(roomId, "自动进入翻牌阶段");
    setupPostflopBettingRound(roomId);
    return;
  }

  if (room.stage === "flop") {
    room.communityCards.push(room.deck.pop());
    room.stage = "turn";
    broadcastCommunity(roomId);
    broadcastSystem(roomId, "自动进入转牌阶段");
    setupPostflopBettingRound(roomId);
    return;
  }

  if (room.stage === "turn") {
    room.communityCards.push(room.deck.pop());
    room.stage = "river";
    broadcastCommunity(roomId);
    broadcastSystem(roomId, "自动进入河牌阶段");
    setupPostflopBettingRound(roomId);
    return;
  }

  if (room.stage === "river") {
    room.stage = "showdown";
    broadcastCommunity(roomId);
    broadcastSystem(roomId, "所有下注轮结束，进入摊牌阶段");
    finishShowdown(roomId);
  }
}

function maybeAdvanceStage(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (getActivePlayerCount(room) <= 1) return;

  if (allActivePlayersActed(room) && allActivePlayersMatched(room)) {
    dealNextStage(roomId);
  }
}

function setupPreflopBlinds(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;

  if (room.dealerIndex === -1 || room.dealerIndex === undefined) {
    room.dealerIndex = 0;
  } else {
    room.dealerIndex = room.dealerIndex % room.players.length;
  }

  if (room.players.length === 2) {
    room.smallBlindIndex = room.dealerIndex;
    room.bigBlindIndex = getNextOccupiedIndex(room, room.dealerIndex);
  } else {
    room.smallBlindIndex = getNextOccupiedIndex(room, room.dealerIndex);
    room.bigBlindIndex = getNextOccupiedIndex(room, room.smallBlindIndex);
  }

  const sbPlayer = room.players[room.smallBlindIndex];
  const bbPlayer = room.players[room.bigBlindIndex];
  const sbInfo = getPlayerInfo(room, sbPlayer);
  const bbInfo = getPlayerInfo(room, bbPlayer);

  const actualSB = Math.min(SMALL_BLIND, sbInfo.chips);
  const actualBB = Math.min(BIG_BLIND, bbInfo.chips);

  sbInfo.chips -= actualSB;
  sbInfo.bet = actualSB;

  bbInfo.chips -= actualBB;
  bbInfo.bet = actualBB;

  room.pot = actualSB + actualBB;
  room.currentBet = actualBB;
  room.actedPlayers = new Set();

  if (room.players.length === 2) {
    room.turnIndex = room.smallBlindIndex;
  } else {
    room.turnIndex = getNextOccupiedIndex(room, room.bigBlindIndex);
  }
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.players.length < 2) {
    broadcastSystem(roomId, "至少需要 2 名玩家才能开始");
    return;
  }

  room.deck = createDeck();
  room.communityCards = [];
  room.stage = "preflop";
  room.foldedPlayers = new Set();
  room.turnIndex = 0;

  room.players.forEach((ws) => {
    const info = getPlayerInfo(room, ws);
    if (info) {
      info.bet = 0;
      info.hand = [];
      info.bestHand = null;
    }
  });

  setupPreflopBlinds(roomId);

  room.players.forEach((player) => {
    const info = getPlayerInfo(room, player);
    info.hand = [room.deck.pop(), room.deck.pop()];
    send(player, { type: "hand", cards: info.hand });
  });

  broadcastRoles(roomId);
  broadcastCommunity(roomId);
  broadcastStatus(roomId);
  broadcastPot(roomId);
  broadcastTurn(roomId);

  const dealerName = getPlayerName(room.players[room.dealerIndex]);
  const sbName = getPlayerName(room.players[room.smallBlindIndex]);
  const bbName = getPlayerName(room.players[room.bigBlindIndex]);

  broadcastSystem(
    roomId,
    `新的一局开始：庄家 ${dealerName}，小盲 ${sbName} (${SMALL_BLIND})，大盲 ${bbName} (${BIG_BLIND})`
  );
}

function handlePlayerFold(roomId, ws) {
  const room = rooms[roomId];
  if (!room) return;

  const playerName = getPlayerName(ws);
  room.foldedPlayers.add(ws);
  room.actedPlayers.add(ws);

  broadcastSystem(roomId, `${playerName} 弃牌了`);
  broadcastStatus(roomId);

  if (getActivePlayerCount(room) === 1) {
    const winner = getActivePlayers(room)[0];
    const winnerName = winner ? getPlayerName(winner) : "无人";
    const winnerInfo = winner ? getPlayerInfo(room, winner) : null;
    const totalPot = room.pot;

    if (winnerInfo) {
      winnerInfo.chips += totalPot;
    }

    finishHand(roomId, `本轮结束：${winnerName} 获得底池 ${totalPot}`);
    return;
  }

  maybeAdvanceStage(roomId);

  if (room.stage !== "finished" && room.stage !== "showdown" && getActivePlayerCount(room) > 1) {
    moveToNextPlayer(roomId);
  }
}

function handleDisconnect(ws) {
  const info = clients.get(ws);
  if (!info) return;

  const { roomId } = info;
  const room = rooms[roomId];
  clients.delete(ws);

  if (!room) return;

  const removedIndex = room.players.indexOf(ws);
  room.players = room.players.filter((p) => p !== ws);
  room.foldedPlayers.delete(ws);
  room.actedPlayers.delete(ws);
  room.playerData.delete(ws);

  if (room.players.length === 0) {
    delete rooms[roomId];
    return;
  }

  if (room.dealerIndex > removedIndex) room.dealerIndex -= 1;
  if (room.smallBlindIndex > removedIndex) room.smallBlindIndex -= 1;
  if (room.bigBlindIndex > removedIndex) room.bigBlindIndex -= 1;

  if (room.turnIndex > removedIndex) {
    room.turnIndex -= 1;
  } else if (room.turnIndex === removedIndex) {
    room.turnIndex = room.players.length ? room.turnIndex % room.players.length : -1;
  }

  if (room.dealerIndex >= room.players.length) room.dealerIndex = room.players.length - 1;
  if (room.smallBlindIndex >= room.players.length) room.smallBlindIndex = room.players.length - 1;
  if (room.bigBlindIndex >= room.players.length) room.bigBlindIndex = room.players.length - 1;

  broadcastPlayers(roomId);
  broadcastStatus(roomId);
  broadcastPot(roomId);
  broadcastTurn(roomId);
  broadcastRoles(roomId);
}

wss.on("connection", (ws) => {
  console.log("一个玩家连接了");

  ws.on("message", (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage);
    } catch {
      send(ws, { type: "system", msg: "消息格式错误" });
      return;
    }

    const { type, roomId, name } = data;

    if (type === "create") {
      if (!roomId || !name) {
        send(ws, { type: "system", msg: "名字和房间号不能为空" });
        return;
      }

      if (rooms[roomId]) {
        send(ws, { type: "system", msg: "房间已存在，请换一个房间号" });
        return;
      }

      rooms[roomId] = {
        players: [ws],
        deck: [],
        communityCards: [],
        stage: "waiting",
        turnIndex: -1,
        foldedPlayers: new Set(),
        playerData: new Map(),
        pot: 0,
        currentBet: 0,
        actedPlayers: new Set(),
        dealerIndex: 0,
        smallBlindIndex: -1,
        bigBlindIndex: -1,
      };

      rooms[roomId].playerData.set(ws, {
        chips: STARTING_CHIPS,
        bet: 0,
        hand: [],
        bestHand: null,
      });

      clients.set(ws, { roomId, name });

      send(ws, { type: "system", msg: "房间创建成功" });
      broadcastPlayers(roomId);
      broadcastStatus(roomId);
      broadcastPot(roomId);
      broadcastCommunity(roomId);
      broadcastTurn(roomId);
      broadcastRoles(roomId);
      return;
    }

    if (type === "join") {
      const room = rooms[roomId];
      if (!room) {
        send(ws, { type: "system", msg: "房间不存在" });
        return;
      }

      if (!name) {
        send(ws, { type: "system", msg: "名字不能为空" });
        return;
      }

      if (room.players.length >= MAX_PLAYERS) {
        send(ws, { type: "system", msg: `当前最多支持 ${MAX_PLAYERS} 人` });
        return;
      }

      room.players.push(ws);
      room.playerData.set(ws, {
        chips: STARTING_CHIPS,
        bet: 0,
        hand: [],
        bestHand: null,
      });

      clients.set(ws, { roomId, name });

      send(ws, { type: "system", msg: "加入房间成功" });
      broadcastPlayers(roomId);
      broadcastStatus(roomId);
      broadcastPot(roomId);
      broadcastCommunity(roomId);
      broadcastTurn(roomId);
      broadcastRoles(roomId);
      return;
    }

    if (type === "start") {
      startGame(roomId);
      return;
    }

    if (type === "action") {
      const room = rooms[roomId];
      if (!room) return;

      if (room.stage === "finished" || room.stage === "showdown" || room.stage === "waiting") {
        send(ws, { type: "system", msg: "当前不能操作，请先开始新的一局" });
        return;
      }

      const currentPlayer = room.players[room.turnIndex];
      if (currentPlayer !== ws) {
        send(ws, { type: "system", msg: "还没轮到你操作" });
        return;
      }

      if (room.foldedPlayers.has(ws)) {
        send(ws, { type: "system", msg: "你已经弃牌了" });
        return;
      }

      const playerName = getPlayerName(ws);
      const info = getPlayerInfo(room, ws);
      if (!info) return;

      if (data.action === "check") {
        if (info.bet !== room.currentBet) {
          send(ws, { type: "system", msg: "当前不能 check，请选择 call、raise 或 fold" });
          return;
        }

        room.actedPlayers.add(ws);
        broadcastSystem(roomId, `${playerName} 选择了 check`);
        maybeAdvanceStage(roomId);

        if (room.stage !== "finished" && room.stage !== "showdown" && getActivePlayerCount(room) > 1) {
          moveToNextPlayer(roomId);
        }
        return;
      }

      if (data.action === "call") {
        const need = room.currentBet - info.bet;
        const actual = Math.max(0, Math.min(need, info.chips));

        info.chips -= actual;
        info.bet += actual;
        room.pot += actual;
        room.actedPlayers.add(ws);

        broadcastSystem(roomId, `${playerName} 跟注了 ${actual}`);
        broadcastStatus(roomId);
        broadcastPot(roomId);

        maybeAdvanceStage(roomId);

        if (room.stage !== "finished" && room.stage !== "showdown" && getActivePlayerCount(room) > 1) {
          moveToNextPlayer(roomId);
        }
        return;
      }

      if (data.action === "raise") {
        const raiseAmount = Number(data.amount);

        if (!Number.isInteger(raiseAmount) || raiseAmount <= 0) {
          send(ws, { type: "system", msg: "加注金额必须是正整数" });
          return;
        }

        const targetBet = room.currentBet + raiseAmount;
        const need = targetBet - info.bet;

        if (need <= 0) {
          send(ws, { type: "system", msg: "加注金额无效" });
          return;
        }

        if (info.chips < need) {
          send(ws, { type: "system", msg: "筹码不足，无法 raise" });
          return;
        }

        info.chips -= need;
        info.bet = targetBet;
        room.currentBet = targetBet;
        room.pot += need;
        room.actedPlayers = new Set([ws]);

        broadcastSystem(roomId, `${playerName} 加注了 ${raiseAmount}，当前最高下注变为 ${targetBet}`);
        broadcastStatus(roomId);
        broadcastPot(roomId);

        if (getActivePlayerCount(room) > 1) {
          moveToNextPlayer(roomId);
        }
        return;
      }

      if (data.action === "fold") {
        handlePlayerFold(roomId, ws);
      }
    }
  });

  ws.on("close", () => {
    handleDisconnect(ws);
  });
});

server.listen(PORT, () => {
  console.log(`服务器已启动：http://localhost:${PORT}`);
});