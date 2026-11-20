const $ = (id) => document.getElementById(id);
const screens = {
  home: $("screen-home"),
  wait: $("screen-wait"),
  count: $("screen-count"),
  game: $("screen-game"),
  over: $("screen-over"),
};
function show(name) {
  for (const s of Object.values(screens)) s.classList.remove("active");
  screens[name].classList.add("active");
}

let ws = null;
let myName = "Player";
let oppName = "Opponent";
let myAnswer = null;      // index I've currently selected, or null
let oppAnswered = false;  // opponent has a selection
let bothPending = false;  // server is in the grace window before revealing
let roundOver = false;    // reveal has happened; selections are locked
let timerRAF = null;
let countdownTimer = null;

/* ---------------- connection ---------------- */

function connect(onOpen) {
  // Connect at the path this page was served from, so it works both at the
  // domain root (local dev) and mounted under a subpath (e.g. /trivia/ on
  // play.jadon.me, where the reverse proxy strips the prefix).
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const base = location.pathname.replace(/[^/]*$/, "");
  ws = new WebSocket(`${proto}://${location.host}${base}`);
  ws.addEventListener("open", onOpen);
  ws.addEventListener("message", (e) => handle(JSON.parse(e.data)));
  ws.addEventListener("close", () => {
    if (screens.game.classList.contains("active") || screens.count.classList.contains("active")) {
      $("over-msg").textContent = "Connection lost.";
      show("over");
    }
  });
}

function sendJoin(payload) {
  myName = ($("name-input").value.trim() || "Player").slice(0, 16);
  const go = () => ws.send(JSON.stringify({ type: "join", name: myName, ...payload }));
  if (ws && ws.readyState === WebSocket.OPEN) go();
  else connect(go);
}

/* ---------------- message handling ---------------- */

function handle(msg) {
  switch (msg.type) {
    case "waiting": {
      show("wait");
      if (msg.mode === "create" && msg.code) {
        $("wait-title").textContent = "Waiting for a friend…";
        $("room-code").textContent = msg.code;
        $("code-display").classList.remove("hidden");
        $("wait-hint").textContent = "Share this code. The game starts when they join.";
        $("btn-copy").onclick = () => {
          navigator.clipboard?.writeText(msg.code);
          $("btn-copy").textContent = "Copied!";
          setTimeout(() => ($("btn-copy").textContent = "Copy"), 1500);
        };
      } else {
        $("wait-title").textContent = "Finding an opponent…";
        $("code-display").classList.add("hidden");
        $("wait-hint").textContent = "Hang tight — matching you with another player.";
      }
      break;
    }

    case "error":
      $("home-msg").textContent = msg.message;
      $("home-msg").classList.add("error");
      show("home");
      break;

    case "start": {
      myName = msg.you;
      oppName = msg.opponent === msg.you ? msg.opponent + " (2)" : msg.opponent;
      $("cd-you").textContent = myName;
      $("cd-opp").textContent = oppName;
      $("g-you-name").textContent = myName;
      $("g-opp-name").textContent = oppName;
      $("f-you-name").textContent = myName;
      $("f-opp-name").textContent = oppName;
      $("g-you-score").textContent = "0";
      $("g-opp-score").textContent = "0";
      $("g-total").textContent = msg.totalRounds;
      runCountdown(Math.round(msg.countdownMs / 1000));
      break;
    }

    case "question":
      renderQuestion(msg);
      break;

    case "opponentAnswered":
      oppAnswered = !!msg.answered;
      refreshStatus();
      break;

    case "bothAnswered":
      bothPending = !!msg.pending;
      refreshStatus();
      break;

    case "reveal":
      revealAnswer(msg);
      break;

    case "gameover":
      clearInterval(countdownTimer);
      renderGameOver(msg);
      break;

    case "opponentLeft":
      renderGameOver({ walkover: true });
      break;

    case "opponentWantsRematch":
      $("over-msg").textContent = `${oppName} wants a rematch!`;
      break;
  }
}

/* ---------------- countdown ---------------- */

function runCountdown(secs) {
  show("count");
  let n = secs;
  $("countdown").textContent = n;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(countdownTimer);
      $("countdown").textContent = "GO";
    } else {
      $("countdown").textContent = n;
    }
  }, 1000);
}

/* ---------------- question ---------------- */

function renderQuestion(msg) {
  clearInterval(countdownTimer);
  show("game");
  roundOver = false;
  myAnswer = null;
  oppAnswered = false;
  bothPending = false;
  $("g-round").textContent = msg.round;
  $("q-cat").textContent = msg.category;
  $("q-diff").textContent = msg.difficulty;
  $("q-text").textContent = msg.question;

  const box = $("options");
  box.innerHTML = "";
  const keys = ["A", "B", "C", "D"];
  msg.options.forEach((opt, i) => {
    const b = document.createElement("button");
    b.className = "opt";
    b.innerHTML = `<span class="key">${keys[i]}</span><span class="txt"></span>`;
    b.querySelector(".txt").textContent = opt;
    b.onclick = () => pick(i, b);
    box.appendChild(b);
  });

  refreshStatus();
  startTimer(msg.durationMs);
}

function pick(index, btn) {
  if (roundOver) return;

  if (myAnswer === index) {
    // tap the current selection again to clear it
    myAnswer = null;
    btn.classList.remove("picked");
    ws.send(JSON.stringify({ type: "answer", index: null }));
  } else {
    myAnswer = index;
    [...$("options").children].forEach((el) => el.classList.remove("picked"));
    btn.classList.add("picked");
    ws.send(JSON.stringify({ type: "answer", index }));
  }
  refreshStatus();
}

function startTimer(ms) {
  const fill = $("timer-fill");
  const secs = $("timer-secs");
  cancelAnimationFrame(timerRAF);
  fill.classList.remove("run", "low");
  secs.classList.remove("low");
  fill.style.width = "100%";
  secs.textContent = Math.ceil(ms / 1000);
  // force reflow then animate
  void fill.offsetWidth;
  fill.classList.add("run");
  fill.style.transitionDuration = ms + "ms";
  fill.style.width = "0%";
  const end = Date.now() + ms;
  const tick = () => {
    const left = end - Date.now();
    secs.textContent = Math.max(0, Math.ceil(left / 1000));
    if (left <= ms * 0.3) {
      fill.classList.add("low");
      secs.classList.add("low");
    }
    if (left > 0) timerRAF = requestAnimationFrame(tick);
  };
  timerRAF = requestAnimationFrame(tick);
}

function setStatus(text, cls) {
  const el = $("answer-status");
  el.textContent = text;
  el.className = "answer-status" + (cls ? " " + cls : "");
}

// Recompute the status line from current round state.
function refreshStatus() {
  if (roundOver) return;
  const letter = myAnswer === null ? null : "ABCD"[myAnswer];
  if (bothPending) {
    setStatus("Both answered — revealing…", "good");
  } else if (letter) {
    setStatus(`Your pick: ${letter} · tap it again to deselect, or choose another`, "");
  } else if (oppAnswered) {
    setStatus(`${oppName} has answered — you can still pick`, "");
  } else {
    setStatus("Tap an answer before the timer runs out", "");
  }
}

/* ---------------- reveal ---------------- */

function revealAnswer(msg) {
  cancelAnimationFrame(timerRAF);
  roundOver = true;
  bothPending = false;
  $("timer-secs").textContent = "0";
  const opts = [...$("options").children];
  const myIdx = msg.yourAnswer;

  opts.forEach((el, i) => {
    el.disabled = true;
    el.classList.remove("picked");
    if (i === msg.correctIndex) el.classList.add("correct");
    if (i === myIdx && myIdx !== msg.correctIndex) el.classList.add("wrong");
    if (i === msg.opponentAnswer && i !== msg.correctIndex && i !== myIdx) el.classList.add("wrong");
  });

  if (myIdx === msg.correctIndex) setStatus(`Correct!  +${msg.yourGain}`, "good");
  else if (myIdx === null || myIdx === undefined) setStatus("No answer locked in", "bad");
  else setStatus(`Wrong — answer was “${msg.correctAnswer}”`, "bad");

  bumpScore("g-you-score", msg.yourTotal);
  bumpScore("g-opp-score", msg.opponentTotal);
}

function bumpScore(id, val) {
  if (val == null) return;
  const el = $(id);
  if (el.textContent !== String(val)) {
    el.textContent = val;
    const chip = el.closest(".score-chip");
    chip.classList.remove("bump");
    void chip.offsetWidth;
    chip.classList.add("bump");
  }
}

/* ---------------- game over ---------------- */

function renderGameOver(msg) {
  cancelAnimationFrame(timerRAF);
  clearInterval(countdownTimer);
  show("over");
  $("btn-rematch").textContent = "Rematch";
  $("btn-rematch").disabled = false;

  const myScore = msg.yourTotal ?? Number($("g-you-score").textContent);
  const oppScore = msg.opponentTotal ?? Number($("g-opp-score").textContent);
  $("f-you-score").textContent = myScore;
  $("f-opp-score").textContent = oppScore;

  const title = $("result-title");
  title.classList.remove("lose");
  if (msg.walkover) {
    title.textContent = "Opponent left";
    $("over-msg").textContent = `${oppName} left the game — you take the win.`;
    $("btn-rematch").disabled = true;
  } else if (msg.outcome === "win") {
    title.textContent = "🏆 You win!";
  } else if (msg.outcome === "tie") {
    title.textContent = "It's a tie!";
  } else {
    title.textContent = "You lost";
    title.classList.add("lose");
  }
}

/* ---------------- controls ---------------- */

$("btn-quick").onclick = () => { clearHomeMsg(); sendJoin({ mode: "quick" }); };
$("btn-create").onclick = () => { clearHomeMsg(); sendJoin({ mode: "create" }); };
$("btn-join-open").onclick = () => $("join-box").classList.toggle("hidden");
$("btn-join").onclick = () => {
  const code = $("code-input").value.trim().toUpperCase();
  if (code.length < 3) { $("home-msg").textContent = "Enter a room code."; $("home-msg").classList.add("error"); return; }
  clearHomeMsg();
  sendJoin({ mode: "join", code });
};
$("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-join").click(); });
$("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-quick").click(); });

$("btn-cancel").onclick = () => {
  if (ws) ws.send(JSON.stringify({ type: "leave" }));
  show("home");
};
$("btn-rematch").onclick = () => {
  ws.send(JSON.stringify({ type: "rematch" }));
  $("btn-rematch").textContent = "Waiting…";
  $("btn-rematch").disabled = true;
};
$("btn-home").onclick = () => {
  if (ws) { ws.send(JSON.stringify({ type: "leave" })); ws.close(); ws = null; }
  $("btn-rematch").textContent = "Rematch";
  $("btn-rematch").disabled = false;
  show("home");
};

function clearHomeMsg() {
  $("home-msg").textContent = "";
  $("home-msg").classList.remove("error");
}

// keyboard A/B/C/D (or 1-4) during a question; press the same key again to deselect
document.addEventListener("keydown", (e) => {
  if (!screens.game.classList.contains("active") || roundOver) return;
  const idx = { a: 0, b: 1, c: 2, d: 3, 1: 0, 2: 1, 3: 2, 4: 3 }[e.key.toLowerCase()];
  if (idx != null) $("options").children[idx]?.click();
});

// restore last used name
try {
  const saved = localStorage.getItem("triviaduel_name");
  if (saved) $("name-input").value = saved;
} catch {}
$("name-input").addEventListener("change", () => {
  try { localStorage.setItem("triviaduel_name", $("name-input").value.trim()); } catch {}
});
