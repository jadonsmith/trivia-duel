import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { FALLBACK_QUESTIONS } from "./fallback-questions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3005;
const HOST = process.env.HOST || "0.0.0.0"; // set 127.0.0.1 when behind a reverse proxy
const HEARTBEAT_MS = 30000;

const TOTAL_ROUNDS = 8;
const QUESTION_MS = 20000;
const GRACE_MS = 2500; // after both players have an answer, wait this long (re-armed on any change) before revealing
const REVEAL_MS = 4500;
const START_COUNTDOWN_MS = 3000;

const app = express();
app.use(express.static(join(__dirname, "public")));
const server = createServer(app);
const wss = new WebSocketServer({ server });

/* ------------------------------------------------------------------ *
 * Trivia source
 * ------------------------------------------------------------------ */

function decodeEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&eacute;/g, "é")
    .replace(/&Eacute;/g, "É")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&uuml;/g, "ü")
    .replace(/&ouml;/g, "ö")
    .replace(/&auml;/g, "ä")
    .replace(/&hellip;/g, "…")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&deg;/g, "°")
    .replace(/&shy;/g, "");
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizeRaw(raw) {
  const correct = decodeEntities(raw.correct_answer);
  const incorrect = raw.incorrect_answers.map(decodeEntities);
  const options = shuffle([correct, ...incorrect]);
  return {
    category: decodeEntities(raw.category || "General Knowledge"),
    difficulty: raw.difficulty || "medium",
    question: decodeEntities(raw.question),
    options,
    correctIndex: options.indexOf(correct),
  };
}

async function fetchQuestions(amount) {
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    if (data.response_code !== 0 || !Array.isArray(data.results) || !data.results.length) {
      throw new Error(`opentdb response_code ${data.response_code}`);
    }
    return data.results.map(normalizeRaw);
  } finally {
    clearTimeout(timer);
  }
}

async function getQuestions(amount) {
  try {
    const q = await fetchQuestions(amount);
    console.log(`Loaded ${q.length} questions from Open Trivia DB`);
    return q;
  } catch (err) {
    console.warn(`Open Trivia DB unavailable (${err.message}); using fallback bank`);
    return shuffle(FALLBACK_QUESTIONS).slice(0, amount).map(normalizeRaw);
  }
}

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */

/** @type {Map<string, Room>} */
const rooms = new Map();
let quickWaiter = null; // { ws, name } waiting for a random match

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

class Room {
  constructor(code, isPrivate) {
    this.code = code;
    this.isPrivate = isPrivate;
    this.players = []; // { ws, name, score, answerIndex, answerAt }
    this.state = "waiting";
    this.round = 0;
    this.questions = [];
    this.timer = null;
    this.graceTimer = null;
    this.questionStart = 0;
    this.rematchVotes = new Set();
  }

  addPlayer(ws, name) {
    const player = { ws, name: name || "Player", score: 0, answerIndex: null, answerAt: 0 };
    this.players.push(player);
    ws._room = this;
    ws._player = player;
    return player;
  }

  broadcast(msg) {
    for (const p of this.players) send(p.ws, msg);
  }

  /** Send a personalized message to each player: fn(me, opp) => msg */
  sendEach(fn) {
    for (const p of this.players) {
      const opp = this.opponentOf(p);
      send(p.ws, fn(p, opp));
    }
  }

  opponentOf(player) {
    return this.players.find((p) => p !== player);
  }

  async begin() {
    this.state = "starting";
    this.round = 0;
    for (const p of this.players) p.score = 0;
    this.rematchVotes.clear();

    this.sendEach((me, opp) => ({
      type: "start",
      totalRounds: TOTAL_ROUNDS,
      you: me.name,
      opponent: opp.name,
      countdownMs: START_COUNTDOWN_MS,
    }));

    this.questions = await getQuestions(TOTAL_ROUNDS);
    this.timer = setTimeout(() => this.nextRound(), START_COUNTDOWN_MS);
  }

  nextRound() {
    clearTimeout(this.timer);
    clearTimeout(this.graceTimer);
    if (this.players.length < 2) return;

    if (this.round >= TOTAL_ROUNDS || this.round >= this.questions.length) {
      return this.finish();
    }

    const q = this.questions[this.round];
    this.round++;
    this.state = "question";
    this.questionStart = Date.now();
    for (const p of this.players) {
      p.answerIndex = null;
      p.answerAt = 0;
    }

    this.broadcast({
      type: "question",
      round: this.round,
      totalRounds: TOTAL_ROUNDS,
      category: q.category,
      difficulty: q.difficulty,
      question: q.question,
      options: q.options,
      durationMs: QUESTION_MS,
    });

    this.timer = setTimeout(() => this.reveal(), QUESTION_MS);
  }

  recordAnswer(player, index) {
    if (this.state !== "question") return;

    if (index === null) {
      // player deselected their answer
      player.answerIndex = null;
      player.answerAt = 0;
    } else {
      if (typeof index !== "number" || index < 0 || index > 3) return;
      player.answerIndex = index;
      player.answerAt = Date.now();
    }

    const opp = this.opponentOf(player);
    if (opp) send(opp.ws, { type: "opponentAnswered", answered: player.answerIndex !== null });

    // Both players have an answer -> start (or re-arm) a short grace window so a
    // misclick can still be corrected before the round is scored.
    clearTimeout(this.graceTimer);
    const bothIn = this.players.length === 2 && this.players.every((p) => p.answerIndex !== null);
    if (bothIn) {
      this.graceTimer = setTimeout(() => this.reveal(), GRACE_MS);
    }
    this.broadcast({ type: "bothAnswered", pending: bothIn, graceMs: bothIn ? GRACE_MS : 0 });
  }

  reveal() {
    clearTimeout(this.timer);
    clearTimeout(this.graceTimer);
    if (this.state !== "question") return;
    this.state = "reveal";

    const q = this.questions[this.round - 1];

    for (const p of this.players) {
      let gained = 0;
      if (p.answerIndex === q.correctIndex) {
        const elapsed = Math.min(p.answerAt - this.questionStart, QUESTION_MS);
        const speedBonus = Math.round(500 * (1 - elapsed / QUESTION_MS));
        gained = 500 + speedBonus;
      }
      p.roundGain = gained;
      p.score += gained;
    }

    this.sendEach((me, opp) => ({
      type: "reveal",
      correctIndex: q.correctIndex,
      correctAnswer: q.options[q.correctIndex],
      yourAnswer: me.answerIndex,
      opponentAnswer: opp.answerIndex,
      yourGain: me.roundGain,
      opponentGain: opp.roundGain,
      yourTotal: me.score,
      opponentTotal: opp.score,
    }));

    this.timer = setTimeout(() => this.nextRound(), REVEAL_MS);
  }

  finish() {
    clearTimeout(this.timer);
    this.state = "finished";
    this.rematchVotes.clear();

    this.sendEach((me, opp) => ({
      type: "gameover",
      yourTotal: me.score,
      opponentTotal: opp.score,
      outcome: me.score > opp.score ? "win" : me.score < opp.score ? "loss" : "tie",
    }));
  }

  voteRematch(player) {
    if (this.state !== "finished") return;
    this.rematchVotes.add(player);
    const opp = this.opponentOf(player);
    if (opp) send(opp.ws, { type: "opponentWantsRematch" });
    if (this.players.length === 2 && this.players.every((p) => this.rematchVotes.has(p))) {
      this.begin();
    }
  }

  removePlayer(ws) {
    clearTimeout(this.timer);
    clearTimeout(this.graceTimer);
    this.players = this.players.filter((p) => p.ws !== ws);
    if (this.players.length) {
      this.state = "finished";
      this.broadcast({ type: "opponentLeft" });
    }
    if (this.players.length === 0) rooms.delete(this.code);
  }
}

/* ------------------------------------------------------------------ *
 * Connection handling
 * ------------------------------------------------------------------ */

// Reap sockets that died without a close frame (mobile networks, proxies).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    handle(ws, msg);
  });

  ws.on("close", () => {
    if (quickWaiter && quickWaiter.ws === ws) quickWaiter = null;
    if (ws._room) ws._room.removePlayer(ws);
  });
});

function handle(ws, msg) {
  switch (msg.type) {
    case "join":
      return handleJoin(ws, msg);
    case "answer":
      if (ws._room && ws._player) ws._room.recordAnswer(ws._player, msg.index);
      return;
    case "rematch":
      if (ws._room && ws._player) ws._room.voteRematch(ws._player);
      return;
    case "leave":
      if (ws._room) {
        ws._room.removePlayer(ws);
        ws._room = null;
        ws._player = null;
      }
      if (quickWaiter && quickWaiter.ws === ws) quickWaiter = null;
      return;
  }
}

function handleJoin(ws, { name, mode, code }) {
  name = String(name || "").trim().slice(0, 16) || "Player";

  if (mode === "create") {
    const room = new Room(makeCode(), true);
    rooms.set(room.code, room);
    room.addPlayer(ws, name);
    send(ws, { type: "waiting", code: room.code, mode: "create" });
    return;
  }

  if (mode === "join") {
    const room = rooms.get(String(code || "").toUpperCase().trim());
    if (!room) return send(ws, { type: "error", message: "Room not found." });
    if (room.players.length >= 2) return send(ws, { type: "error", message: "That room is full." });
    room.addPlayer(ws, name);
    room.begin();
    return;
  }

  // quick match (default)
  if (quickWaiter && quickWaiter.ws.readyState === quickWaiter.ws.OPEN) {
    const room = new Room(makeCode(), false);
    rooms.set(room.code, room);
    room.addPlayer(quickWaiter.ws, quickWaiter.name);
    room.addPlayer(ws, name);
    quickWaiter = null;
    room.begin();
  } else {
    quickWaiter = { ws, name };
    send(ws, { type: "waiting", mode: "quick" });
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Trivia Duel listening on ${HOST}:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n${sig} received — shutting down`);
    for (const ws of wss.clients) {
      try { ws.close(1001, "server restarting"); } catch {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
