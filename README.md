<div align="center">

![Pinball banner](https://raw.githubusercontent.com/noguerol/pinball/main/docs/banner.jpeg)

</div>

# Pinball — Automatic Provider Failover for pi

**Pinball keeps the ball in play.** When your active model hits a rate limit, runs out of quota/credits, or a provider has a persistent outage, pinball transparently **bounces the task to the next model** in your bounce list and retries — mid-conversation, without you lifting a finger.

It works in interactive sessions **and** in headless spawned processes (`pi -p`, `pi --mode json -p`), which makes it the failover layer for multi-agent setups: a sub-agent that burns its quota at 2 AM no longer kills the run — pinball flips it to the next provider and the task finishes.

---

## Features

- **Automatic failover** on rate limits (429), payment/quota errors (402/403), billing/credit exhaustion, and persistent server errors (5xx)
- **Three detection points** — catches failures before pi even creates the error message, mid-stream errors that arrive with HTTP 200, and runs that die with no auto-retry left
- **Transparent retry** — the agent continues the same task with the next model; the conversation just keeps going
- **Bounce list with priorities** — an ordered model list (same registry as `/model`); order defines the bounce chain
- **Per-model cooldowns** — a failed model is skipped for a configurable window, then given another chance
- **Retry budget** — `maxRetries` attempts per model before pinball gives up cleanly instead of looping forever
- **Smart error classification** — bounce-worthy errors vs. context overflow (pi handles that with compaction, not switching)
- **Provider tester** — one keystroke to check connectivity/latency of every configured model
- **Interactive everything** — native pi menus for every setting; no config file editing required
- **Status bar widget** — a compact `🎯 (on)` footer indicator with live cooldown count; hidden entirely while pinball is off

## Install

Pinball is a [pi package](https://pi.dev/packages): one extension (`src/index.ts`) declared in `package.json`.

```bash
# From GitHub
pi install git:github.com/noguerol/pinball

# Pin a tag/commit (refs are never moved by `pi update`)
pi install git:github.com/noguerol/pinball@v1.0.0

# Local checkout (development)
pi install /path/to/pinball

# Try it for one run only, without installing
pi -e git:github.com/noguerol/pinball
```

```bash
pi list                    # show installed packages
pi remove git:github.com/noguerol/pinball
```

> **Security:** pi packages run with full system access — extensions execute arbitrary code. Install only packages you trust and review the source.

**Requirements:** a working pi installation with at least one configured provider. Pinball reads its bounce candidates from pi's own model registry — the same models you see in `/model`.

## Quick Start

```
/pinball add        # pick provider → model from pi's registry (repeat for each fallback)
/pinball status     # verify: ENABLED, bounce list, retry budget
```

That's it. The next time a provider returns `429 Too Many Requests` mid-task:

```
🔄 provider/x → provider/y; retrying…
```

… and the task continues on `provider/y`. A `🎯 (on 1)` marker in the footer shows one model in cooldown (plain `🎯 (on)` when everything is healthy; the indicator disappears when pinball is disabled).

## How It Works

### Detection points

Pinball watches the failure at three stages, all feeding the same bounce core:

| Stage | Event | Catches |
|-------|-------|---------|
| 1. HTTP hook | `after_provider_response` | HTTP 429/402/403 — *before* pi creates the error message, so pi's own retries already use the new model |
| 2. Message end | `message_end` with `stopReason: "error"` | Providers that fail **mid-stream with HTTP 200** — e.g. SSE `error` events like *"usage limit has been reached"* |
| 3. Settled | `agent_settled` | The run died on a bounce-worthy error and pi will not auto-retry: pinball bounces and **awaits** a re-trigger via `sendUserMessage`, so the task resumes with the next model even in headless print mode (a fire-and-forget retry would die with the process) |

Repeated reports of the same failing model within a short dedupe window (10s) are collapsed, so the bounce list is never thrashed by redundant signals.

### What counts as bounce-worthy

| Bounces ✅ | Does NOT bounce ❌ |
|-----------|-------------------|
| HTTP 429 / 402 / 403 / 5xx | Context overflow — pi handles it with compaction |
| `rate limit`, `too many requests` | Normal completion (`stop`, `toolUse`, `length`) |
| `quota`, `usage limit`, `limit reached` | User aborts |
| `insufficient`, `out of budget`, `available balance` | Bounce-unrelated errors |
| `billing`, `credit`, `payment required` | |
| `resource exhausted`, `overloaded`, `service unavailable` | |

### The bounce chain

Models bounce in list order: `M1 → M2 → M3 → …`. When the chain is exhausted, pinball stops cleanly (`se agotaron N intentos consecutivos`) instead of looping — reset with `/pinball reset` when you've topped up.

A bounced model enters **cooldown** (default 60s): it's skipped during that window, then becomes eligible again. The original model is remembered and shown in `/pinball status`.

## Commands

All management lives under one command with subcommands:

| Command | Description |
|---------|-------------|
| `/pinball` | Toggle pinball on/off |
| `/pinball enable` / `disable` | Enable/disable |
| `/pinball status` | State, active model, retries, cooldowns, last bounce |
| `/pinball config` | Interactive config menu |
| `/pinball add` | Add a model to the bounce list (provider → model picker from pi's registry) |
| `/pinball list` | Manage the bounce list: reorder, replace, remove |
| `/pinball remove` | Quick-remove a model |
| `/pinball test` | Test connectivity of every configured model |
| `/pinball reset` | Clear all cooldowns and the retry budget |
| `/pinball log` | Show the bounce history of this session |

(There is no `/pinball` daemon, service or background process — it's a pure in-process extension.)

### `/pinball config`

The menu exposes every setting with live values:

- 🟢 **Enable/disable** pinball
- 📋 **List models** — jump to the bounce list manager
- ➕ **Add model** / ➖ **Remove model**
- 🧪 **Test all providers** — pings each model, shows ✅/🔑/❌ + latency
- ⏱️ **Cooldown** — how long a failed model is skipped
- 🔁 **Max retries** — bounce attempts per model before giving up
- 🔔 **Notifications** — on/off for bounce notifications
- 🔃 **Reset cooldowns**

### `/pinball list` — the bounce list manager

The list order **is** the bounce priority. Selecting a model opens an action menu:

- ⬆️⬇️ Move up/down · ⏫⏬ Move to top/bottom
- 🔁 **Replace** with another model from pi's registry (duplicate-checked)
- 🗑️ Remove

The list re-renders after every action until you exit. Models in cooldown show ⏳; the original model shows ⭐.

### `/pinball status`

```
State: ✅ on
Model: provider/x
List: 3
Retries: 1/9
Streak: 0
Cooldowns: 1
Cooldown: 60s
Original: provider/x
Last: provider/x → provider/y (rate-limit/quota, 2m ago)
```

## Configuration

Everything is configurable through the UI, but the persisted file is simple — `~/.pi/agent/pinball.json`:

```json
{
  "enabled": true,
  "maxRetries": 3,
  "cooldownMs": 60000,
  "notifyOnBounce": true,
  "models": [
    { "provider": "anthropic", "id": "claude-sonnet-4" },
    { "provider": "openai", "id": "gpt-4.1", "name": "GPT-4.1" },
    { "provider": "local-models", "id": "127.0.0.1:8080/Qwen3.6-35B-A3B" }
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch |
| `maxRetries` | `3` | Bounce attempts per model before giving up |
| `cooldownMs` | `60000` | How long a failed model is skipped |
| `notifyOnBounce` | `true` | Show a notification on every bounce |
| `models` | `[]` | The bounce list, in priority order |

> **Coming from model-bouncer?** Pinball is the renamed successor. On first run it migrates an existing `~/.pi/agent/model-bouncer.json` into `pinball.json` automatically — no action needed.

## Headless & Multi-Agent Notes

Pinball is designed to be the failover layer for spawned agents (`pi -p`, `pi --mode json -p`, multi-agent runtimes):

- In print mode the process exits as soon as the prompt settles. Pinball's `agent_settled` handler therefore bounces **and awaits** a re-trigger through `sendUserMessage` — the retry is delivered before the process is allowed to die.
- The bounce list is per-machine (`~/.pi/agent/pinball.json`), so every spawned agent inherits the same failover chain with zero per-agent setup.
- Combined with a multi-agent orchestrator, a whole fleet of agents can survive a provider outage with no code changes.

## Architecture

```
pinball/
├── package.json        # pi package manifest (pi-package)
├── LICENSE             # MIT
├── README.md
└── src/
    ├── index.ts        # Extension entry point: hooks, state, config, command registration
    └── commands.ts     # Lazy-loaded /pinball UI and command handlers
```

Zero-dependency extension (only pi's bundled `@earendil-works/pi-coding-agent` + Node built-ins):

- **Small startup path** — `src/index.ts` registers hooks and `/pinball`; interactive command UI loads on demand via dynamic `import()`
- **Error classification** — regex sets for bounce-worthy vs. context-overflow errors, defensive `stopReason` normalization
- **Bounce core** — target selection (skipping cooldowns), budget accounting, bounce log
- **Detection hooks** — `after_provider_response`, `message_end`, `agent_settled`
- **Persistence** — `~/.pi/agent/pinball.json` with one-time migration from the legacy `model-bouncer.json`
- **UI** — native pi menus, status bar widget, bounce log viewer

## License

[MIT](LICENSE) © pinball contributors
