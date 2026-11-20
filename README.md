# Trivia Duel

A simple two-player, real-time online trivia game for web and mobile. Questions
come from the free [Open Trivia DB](https://opentdb.com/) API (no key required),
with a built-in fallback bank so a match still works if the API is unreachable.

Part of the **play.jadon.me** collection — deployed at `play.jadon.me/trivia/`.
See [`../play/`](../play/) for the hub and deploy runbook.

## How it works

- **Quick Match** — pair with a random waiting player.
- **Create Room / Join Room** — share a 4-letter code to play a friend.
- 8 multiple-choice questions per match. Both players see the same question at the
  same time.
- Tap an option to pick it; tap it again (or press its A/B/C/D key again) to
  deselect, or tap another to switch — nothing is locked until the round ends.
- Once both players have an answer the round reveals after a short grace window
  (re-armed if either player changes their mind), with a 20-second hard cap shown
  as a live countdown.
- Scoring: a correct answer is worth **500 points + up to 500 speed bonus** based
  on how fast your final selection was made. Wrong or no answer scores 0.
- After the last round the higher score wins. Either player can hit **Rematch**.

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:3005> in two browsers/devices (or two tabs) and pick
Quick Match on both.

Set `PORT` to change the port:

```bash
PORT=8080 npm start
```

## Stack

- **Server** — Node.js, [Express](https://expressjs.com/) for static files,
  [`ws`](https://github.com/websockets/ws) for real-time messaging. All game
  state (rooms, matchmaking, timers, scoring) lives in `server.js`.
- **Client** — plain HTML/CSS/JS in `public/`, no build step. Responsive down to
  small phones; supports A/B/C/D (or 1–4) keyboard shortcuts.
- **Questions** — fetched once per match from Open Trivia DB; `fallback-questions.js`
  is used only when that request fails.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | HTTP + WebSocket server, matchmaking, room/game state machine |
| `fallback-questions.js` | Offline question bank |
| `public/index.html` | Screen markup (home, waiting, countdown, game, game over) |
| `public/style.css` | Theme and layout |
| `public/app.js` | Client game logic and WebSocket handling |
