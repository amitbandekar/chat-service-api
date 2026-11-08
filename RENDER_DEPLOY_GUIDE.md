# Deploying Rutuja Bot Backend to Render & Connecting WhatsApp Clone

This guide explains how to deploy the Rutuja Persona API to **Render** and connect it to your mobile/web frontend ([Thiomark/whatsapp-clone](https://github.com/Thiomark/whatsapp-clone)).

---

## 1. Features Included in this Backend

- **Lightweight & Fast:** Runs on standard Express.js (< 50MB RAM), fits Render's free tier.
- **Timestamp Awareness:** Injects real-time context (`[HH:MM] Amit: ...`) into each turn.
- **Topic Cooldowns (3–4 Days):** Automatically suppresses repetitive questions (*"Jevan zala ka?"*, daily greetings) if used recently.
- **Indian Cricket Tracker:** Automatically checks for completed India matches and triggers Marathi banter highlighting **Rohit Sharma**, **Virat Kohli**, **Jasprit Bumrah**, or **Mohammed Siraj**.
- **Scheduled Routine Reminders:**
  - Interview prep check: Every **4 days**
  - Affection / Love you: Every **5 days**
  - Workout / Exercise check: Every **10 days**
- **Mobile Push Notifications:** Natively integrated with **Expo Push Service**. When Rutuja sends a reminder or cricket highlight, a notification is sent directly to your phone.
- **Reply Queue (no message unread):** If the model errors (429/503), the user's message is stored in `reply_queue` and retried (1m → 5m → 15m → 30m → 1h) until answered; boot-up resurrects any unanswered chat from the last 7 days. Monitor at `GET /api/status` → `reply_queue`.

---

## 2. Deploying on Render

### Step 1: Push Code to GitHub
Ensure this project folder is committed and pushed to your GitHub repository:
```bash
git init
git add .
git commit -m "Rutuja Persona Backend for Render & WhatsApp Clone"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

### Step 2: Create Web Service on Render
1. Go to [dashboard.render.com](https://dashboard.render.com/) and click **New +** $\rightarrow$ **Web Service**.
2. Connect your GitHub repository.
3. Configure the service settings:
   - **Name:** `chat-service-api`
   - **Environment:** `Node`
   - **Region:** Singapore / Frankfurt / Oregon (closest to you)
   - **Branch:** `main`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** `Free`

### Step 3: Add Environment Variables on Render
Under **Environment Variables** in Render, add:
| Variable | Value | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://...` | Render PostgreSQL internal/external connection string |
| `XKIRO_API_KEY` | `sk-apx-...` | Your **APInex** API key (env name kept for compatibility) |
| `XKIRO_BASE_URL` | `https://api.apinex.bond/v1` | **APInex** OpenAI-compatible base URL |
| `MODEL_NAME` | `free/gemini-3.8-flash` | APInex free model (validated best for the persona; `free/qwen-3.8-max` also fine) |
| `CRICKET_API_KEY` | *(Optional)* | CricAPI key for live Indian cricket scores |
| `INACTIVITY_HOURS_THRESHOLD` | `8` | Daytime (IST) hours before proactive nudge |
| `TZ` | `Asia/Kolkata` | Pins the Node process to IST — required for correct time-of-day behaviour |
| `PROACTIVE_MAX_PER_DAY` | `3` | Max bot-initiated messages per IST day (nudges + reminders + cricket combined) |
| `PROACTIVE_MIN_GAP_HOURS` | `4` | Minimum hours between any two proactive messages |
| `NUDGE_MAX_PER_DAY` | `1` | Max "you awake?" nudges per IST day |
| `RESET_PROACTIVE_STATE` | *(one-time)* `true` | Staggers overdue scheduled reminders once — set, deploy, then remove |
| `REPAIR_BAD_REPLIES` | *(one-time)* `true` | Strips echoed `[HH:MM]` junk from last-4-days assistant turns — set, deploy, then remove |

Click **Deploy Web Service**. Once deployed, Render will provide a public URL like:
`https://chat-service-api.onrender.com`

---

## 3. Connecting to `Thiomark/whatsapp-clone`

In your `whatsapp-clone` mobile project (React Native / Expo):

### A. Set API Base URL
In `constants/Config.ts`, point to your Render URL:
```javascript
export const API_BASE_URL = 'https://chat-service-api.onrender.com';
```

### B. Fetch Messages
```javascript
const response = await fetch(`${API_BASE_URL}/api/messages`);
const data = await response.json();
// data.messages contains: [{ turn_id, role: 'user'|'assistant', content, timestamp }]
```

### C. Send a Message
```javascript
const response = await fetch(`${API_BASE_URL}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: "Kay kartey?" })
});
const result = await response.json();
// result.reply contains Rutuja's short Marathi response
```

### D. Receive Mobile Push Notifications
In your Expo app (`App.js` or notifications hook):
```javascript
import * as Notifications from 'expo-notifications';

async function registerForPushNotifications() {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return;

    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData.data;

    // Register token with Rutuja backend
    await fetch(`${API_BASE_URL}/api/push-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
    });
}
```

Whenever Rutuja sends a proactive reminder, cricket highlight, or 8-hour daytime nudge, your phone will receive a push notification from **Rutuja 🦋**.
