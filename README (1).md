# Antinuke Bot — Setup Guide

## Requirements
- Node.js v18 or higher
- A Discord bot application

## Installation

```bash
npm install
```

## Configuration
Open `index.js` and fill in the two values at the top of the CONFIG block:

| Field | What to put |
|---|---|
| `TOKEN` | Your bot token from the Discord Developer Portal |
| `CLIENT_ID` | Your bot's Application ID (also from the Dev Portal) |

Everything else (role IDs, log channel) is already pre-filled from your request.

## Running
```bash
node index.js
```

Or with an env file:
```bash
TOKEN=your_token CLIENT_ID=your_client_id node index.js
```

---

## Bot Permissions Required
When inviting the bot, make sure it has:
- **Manage Roles** — to apply/remove the quar role
- **Read Messages / View Channels**
- **Read Message History**
- **View Audit Log** — to detect who invited a bot
- **Manage Messages** — to delete flagged messages
- **Send Messages + Embed Links** — for logs and command replies

> ⚠️ The bot's role must be **above** the quar role in the role hierarchy, or it won't be able to assign it.

---

## Features

### 🔴 Ping Flood
- If a user sends **10+ pings** (user or role mentions) within **25 seconds**, they get the quar role.
- Immune if: whitelisted OR has the immune role OR is an Administrator.

### 🔴 Bot Invite
- If someone invites a bot **without** being whitelisted or having the immune role, they get quarred.
- Detected via Audit Logs (`BOT_ADD` event).

### 🔴 Discord Invite Links
- If a message contains a `discord.gg/...` or similar invite link, the message is deleted and the sender is quarred.
- Immune if: whitelisted OR has the immune role.

---

## Commands

| Command | Description |
|---|---|
| `/removequar @user` | Removes the quar role from a user |
| `/whitelist add @user` | Adds a user to the antinuke whitelist (full immunity) |
| `/whitelist remove @user` | Removes a user from the whitelist |

Commands require **Administrator** permission or the immune role (`1506430627501703249`).

---

## Notes
- The whitelist is **in-memory** — it resets when the bot restarts. For persistence, swap the `Set` for a JSON file or a database.
- Slash commands register **globally**, which can take up to 1 hour to propagate. For instant testing, use guild-specific registration (`Routes.applicationGuildCommands`).
