---
name: expert
description: Drive the user's Expert cloud computer at hello.expert via hub Seat RPCs after they are signed in. Use when the user mentions Expert, hello.expert, their cloud computer, the desk, or taking the seat. Never invent a setup code. Never book Cal.com calls or marketplace experts.
---

# Expert

The user has a standing Linux **cloud computer** at [https://hello.expert](https://hello.expert).

Humans install by signing in there. That is install. Agents install this skill.

## What this is

- Product site: `https://hello.expert` (Vercel).
- Computer: Fly hub `https://mblode-computer.fly.dev` (desk + Seat RPCs + pixels).
- After the user signs in, the web server Pairs with the hub using a **server-only** setup code and puts a seat token on the session.
- You drive the box with **Seat RPCs**, never RFB input.

## Rules

1. **Never invent a setup code.** Do not ask the user for `COMPUTER_SETUP_CODE`. Do not guess one. Do not call `Seat.Pair` as the human product path.
2. **Never book Cal.com calls.** This is not a booking marketplace. Do not open `/experts`, Stripe Connect, Recall, or "become an expert".
3. **The skill cannot drive the box without a signed-in session.** If the user is not signed in at hello.expert, tell them to open that URL and sign in. Then retry. Do not pretend you have a seat token.
4. Prefer the hub the session already knows (`NEXT_PUBLIC_HUB_URL` / `https://mblode-computer.fly.dev`).

## How to use the computer

Once the user is signed in:

- Watch the desk at hello.expert (noVNC iframe). Status polls reuse the pixel grant; do not rewrite `iframe.src` on every poll.
- Seat JSON: `POST {hub}/computer.v1.Seat/{Method}` with `Authorization: Bearer <seat token>` and `content-type: application/json`.
- Presence: `SetPresence` `{ present: true }` to take the seat, `{ present: false }` when done.
- Input (only while `WAITING` or `HUMAN`): `Pointer`, `Type`, clipboard get/set.
- The X server is view-only over VNC. Typing and clicking are Seat RPCs.

If Status returns `UNAUTHENTICATED`, the web app reconnects (`POST /api/computer/reconnect`). You cannot mint a seat token yourself.

## Persistence (tell the user the truth)

| Path | Survives rebuild / `fly deploy` |
|---|---|
| `/workspace` | yes |
| `~/.config` | yes |
| hub roster (`/data`) | yes |
| `apt` packages, `~/.local/state` | no |

Status and `GET /roster` do not wake a sleeping guest.

## When the user is stuck

Send them to sign in at https://hello.expert. That attaches the seat. Then continue with Seat RPCs.
