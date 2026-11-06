# Rutuja WhatsApp Bot Setup & Execution Guide

This bot connects Rutuja's persona (`Qwen 3.8 Max` via Xkiro/OpenRouter) to a live WhatsApp number using `whatsapp-web.js`.

---

## 1. Prerequisites & Installation

Open your terminal in this directory and run:

```bash
npm install
```

This installs:
- `whatsapp-web.js`: WhatsApp Web protocol client
- `qrcode-terminal`: Prints the login QR code directly in the terminal
- `openai`: Client for Xkiro / OpenRouter API
- `dotenv`: Loads configuration from `.env`

---

## 2. Configuration (`.env`)

Check your [.env](file:///.env) file and configure your target number:

```env
XKIRO_API_KEY=your_xkiro_key_here
XKIRO_BASE_URL=https://api.xkiro.com/v1
MODEL_NAME=qwen/qwen3.8-max:free

# Format: CountryCode + PhoneNumber + @c.us (e.g. 919876543210@c.us)
TARGET_PHONE_NUMBER=919876543210@c.us

# Proactive inactivity nudge (daytime hours between 07:00 and 00:00)
INACTIVITY_HOURS_THRESHOLD=8

# Timezone (required on Render: the process runs in UTC otherwise)
TZ=Asia/Kolkata

# Proactive anti-spam budget (IST): max msgs/day, min gap between them, max nudges/day
PROACTIVE_MAX_PER_DAY=3
PROACTIVE_MIN_GAP_HOURS=4
NUDGE_MAX_PER_DAY=1

# One-time reset of overdue scheduled reminders (set true, redeploy, then remove)
# RESET_PROACTIVE_STATE=true
```

---

## 3. How to Run the Bot

```bash
node bot.js
```

### What Happens:
1. **One-Time QR Scan:** A QR code appears in the terminal. Open WhatsApp on your phone $\rightarrow$ **Linked Devices** $\rightarrow$ **Link a device** $\rightarrow$ Scan the QR code.
2. **Session Persistence:** Login session is saved locally in `.wwebjs_auth/`. You will not need to scan again on future restarts.
3. **Live Chat & Natural Typing:**
   - Listens exclusively to `TARGET_PHONE_NUMBER`.
   - Sends real-time **typing indicator** (`chat.sendStateTyping()`).
   - Adds a randomized natural human delay (2.5s to 5.5s).
   - Automatically logs turns with `score_1_to_10: null` into `chat_sessions/session_master.jsonl`.
4. **Daytime 8-Hour Inactivity Checker:**
   - Tracks active daytime hours (07:00 to 00:00).
   - Night hours (00:00 to 07:00) are paused and excluded.
   - If no message has arrived after 8 active daytime hours, Rutuja proactively initiates a context-aware greeting/check-in.
