# 📊 Slack AI Agent & Community CRM

An autonomous, enterprise-ready Slack Bot and Lead Scoring agent designed to monitor community joins, analyze profiles with Groq AI, log analytical metrics to PostgreSQL, sync leads to Google Sheets, and provide a light-theme analytics dashboard with interactive charts.

---

## 🔗 Live Deployments

- **Production API URL**: [https://slack-ai-agent-11gb.onrender.com](https://slack-ai-agent-11gb.onrender.com)
- **Live Web Dashboard**: [https://slack-ai-agent-11gb.onrender.com/dashboard](https://slack-ai-agent-11gb.onrender.com/dashboard) (Optimized in **Indian Standard Time (IST)** with professional light themes)

---

## 🚀 Key Features

- **Autonomous Member Profiling & Scoring**: Instantly monitors when a new member joins the workspace (or on `/analyze` slash commands), fetches profile details, scrapes company website metadata using Cheerio, and calculates a 0-100 fit score via Groq Llama 3.3.
- **Rule-Based Autonomous Action Engine**: Automatically makes actionable decisions without manual intervention:
  - **High Fit (≥ 85)**: Triggers direct messaging tool (`sendAutoDM`) sending exclusive trial offers and logs `auto_dm_sent` in PostgreSQL.
  - **Medium Fit (≥ 60)**: Tags the sales team in private channels (`tagSalesTeam`) for quick manual outreach.
  - **Low Fit (< 60)**: Silently logs `ignored` status.
- **Google Sheets CRM Sync**: Syncs lead details (date, name, email, title, fit score, trigger user/agent) automatically on autonomous matches or manual "Add to CRM" Slack action button clicks.
- **Live Analytics Web Dashboard**: Displays real-time counts, 7-day registration growth trends, score distribution metrics using Chart.js, and recent lead details in a clear striped table.
- **Daily Digest & Reminder Crons**: 
  - **Daily Digest (9:00 AM IST)**: Sends a private channel digest of total members joined and average fit scores.
  - **Follow-up Reminders (9:00 AM IST)**: Sends alerts of members who received DMs 3 days ago for follow-up checks.
- **Robustness**: Employs P-Queue for task serialization to comply with Slack rate limits, and uses memory/connection-safe PG pool release patterns.

---

## 📐 Technical Architecture

```
                                    +-------------------------------------+
                                    |            Slack Workspace          |
                                    +---+-----------------------------+---+
                                        |                             ^
                                        | 1. team_join                | 8. sendAutoDM (DM)
                                        |    or /analyze              |    or tagSalesTeam (alert)
                                        v                             |
                             +----------+-----------------------------+----------+
                             |                    Node App                       |
                             |  +---------------------------------------------+  |
                             |  |                 Bolt App                    |  |
                             |  +---------------------+-----------------------+  |
                             |                        |                          |
                             |                        | 2. Scrape website        |
                             |                        v                          |
                             |  +---------------------+-----------------------+  |
                             |  |              Cheerio Scraper                |  |
                             |  +---------------------+-----------------------+  |
                             |                        |                          |
                             |                        | 3. Scraped info          |
                             |                        v                          |
                             |  +---------------------+-----------------------+  |
                             |  |               LangChain AI                  |  |
                             |  |                 (Groq AI)                   |  |
                             |  +---------------------+-----------------------+  |
                             |                        |                          |
                             |                        | 4. Fit score & insights  |
                             |                        v                          |
                             |  +---------------------+-----------------------+  |
                             |  |              PostgreSQL Database            |  |
                             |  |                    (Neon)                   |  |
                             |  +---------------------+-----------------------+  |
                             |                        |                          |
                             |                        | 5. Saved analysis ID     |
                             |                        v                          |
                             |  +---------------------+-----------------------+  |
                             |  |         Autonomous Decision Engine          |  |
                             |  +----------+-----------------------+----------+  |
                             |             |                       |             |
                             |             | 6. Append Row         | 9. cron     |
                             |             v                       v             |
                             |    +--------+--------+    +---------+--------+    |
                             |    |  Google Sheets  |    |   Node Cron      |    |
                             |    |      CRM        |    |  Scheduler       |    |
                             |    +-----------------+    +---------+--------+    |
                             |                                     |             |
                             |                                     | 10. Digest  |
                             |                                     v             |
                             |                            +--------+--------+    |
                             |                            |  Web Dashboard  |    |
                             |                            |   (/dashboard)  |    |
                             |                            +-----------------+    |
                             +---------------------------------------------------+
```

---

## 📂 Project Directory Structure

```
SLACK_AI_AGENT/
├── src/
│   └── services/
│       ├── ai.service.js       # AI Prompts & Langchain Groq pipeline
│       ├── logger.js           # Winston logger configuration
│       ├── research.service.js # Cheerio scrapers and basic website lookup
│       └── slack.service.js    # Message block builder utilities
├── db.js                       # PostgreSQL client connection pooling & helpers
├── index.js                    # Core app controllers, routing, Bolt, & cron jobs
├── package.json                # Dependencies, watch scripts
├── .env.example                # Sample environment configurations
└── README.md                   # Project documentation
```

---

## 🛠️ Tech Stack

- **Runtime & Framework**: Node.js (ES Modules), Express
- **Slack SDK**: `@slack/bolt`, `@slack/web-api`
- **AI Infrastructure**: Langchain (`@langchain/groq`, `@langchain/core`)
- **Database**: PostgreSQL (`pg` connection pooling)
- **APIs & Scrapers**: Google APIs (`googleapis`), Cheerio, Axios
- **Cron Scheduling**: `node-cron`
- **Utility / Task Queue**: Winston Logger, `p-queue`
- **Dashboard UI**: Tailwind CSS via CDN, Chart.js via CDN, Inter Google Font

---

## 📋 Environment Variables

Set up a `.env` file in the root folder with the following variables:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `DATABASE_URI` | PostgreSQL/Neon connection string | `postgresql://user:pass@host:5432/db` |
| `DB_SSL_ENABLED` | Toggle SSL connection for Postgres | `true` |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token | `xoxb-...` |
| `SLACK_APP_TOKEN` | Slack App-Level Token (WebSocket/Socket Mode) | `xapp-...` |
| `SLACK_SIGNING_SECRET` | Slack Signing Secret for request verification | `abcdefg...` |
| `SLACK_PRIVATE_CHANNEL_ID` | Channel ID for sales alert notifications and crons | `C1234567890` |
| `GROQ_API_KEY` | Groq Console developer API Key | `gsk_...` |
| `GROQ_MODEL` | Langchain Groq LLM model name | `llama-3.3-70b-versatile` |
| `GOOGLE_CREDENTIALS` | Google Service Account credentials (single JSON string) | `{"type":"service_account",...}` |
| `GOOGLE_SHEET_ID` | ID of the target CRM Google Sheets spreadsheet | `1AbCdEfGhIjKlMnOpQrStUvWxYz...` |
| `AUTO_DM_THRESHOLD` | Score above which member is sent a direct message | `85` |
| `SALES_TAG_THRESHOLD` | Score above which the sales team is tagged | `60` |
| `AUTO_ENABLED` | Toggle flag for autonomous actions | `true` |
| `COMPANY_NAME` | Name of the workspace course/product company | `Code with Vijay` |
| `COMPANY_PRODUCT` | Name of the primary company product | `Premium Coding Course` |
| `PORT` | Local express webserver port | `3000` |
| `NODE_ENV` | Environment deployment tag | `production` |

---

## 🚀 Setup & Deployment Guide

### 1. Database Setup (Neon)
1. Sign up on [Neon Database Console](https://neon.tech).
2. Create a new project and copy the connection string.
3. Save it to `DATABASE_URI`. The agent automatically runs schema and column migrations (`auto_action`, `follow_up_date`, etc.) on start.

### 2. Slack App Configuration
1. Go to [Slack API Dashboard](https://api.slack.com/apps).
2. Create an App from scratch.
3. **Socket Mode**: Turn on Socket Mode and generate an App-Level token (`SLACK_APP_TOKEN`) with `connections:write` scopes.
4. **OAuth & Permissions**:
   - Add Bot Token Scopes: `commands`, `chat:write`, `im:write`, `users:read`, `channels:read`, `groups:read`, `mpim:read`.
   - Install App in Workspace to generate `SLACK_BOT_TOKEN`.
5. **Event Subscriptions**: Enable Event Subscriptions and subscribe to bot events: `team_join`.
6. **Slash Commands**: Create `/analyze` command.
7. **Interactivity & Shortcuts**: Turn on Interactivity (Render host endpoint: `https://your-domain.com/slack/events`).

### 3. Google Sheets Setup
1. Create a service account on the Google Cloud Console and generate a JSON Key.
2. Copy the entire contents of the key file into `GOOGLE_CREDENTIALS` in `.env`.
3. Create a Google Sheet and share edit permissions with the service account email.
4. Set the Sheet ID in `GOOGLE_SHEET_ID`. Ensure the sheet has a tab named `Sheet1`.

### 4. Deploying to Render
1. Create a Web Service on Render and point to your GitHub repository.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Set all Environment Variables in Render configuration dashboard.

---

## 📸 Recommended Screenshots

Place these screenshots inside a `docs/` folder in your project repository to illustrate the features:

1. **Member Analysis Block Alert**
   - *Description*: Capture the detailed analysis message posted in the private Slack channel, showing fit score, insights, recommendations, and action buttons.
   - *Placement*: Place below the **Autonomous Member Profiling & Scoring** description in the Features section.
   - *Placeholder*: `![Member Analysis Alert in Slack](docs/member_analysis_slack.png)`

2. **Autonomous DM Follow-up**
   - *Description*: Capture a user's Slack DM receiving the automated trial message from the Bot when their fit score is $\ge 85$.
   - *Placement*: Place below the **Rule-Based Autonomous Action Engine** details.
   - *Placeholder*: `![Auto-DM Message](docs/auto_dm_slack.png)`

3. **Google Sheets CRM Sync**
   - *Description*: Capture rows in your shared Google Sheet detailing columns: `Date`, `Name`, `Email`, `Title`, `Score`, and `Trigger User/Agent` (`autonomous_agent`).
   - *Placement*: Place below the **Google Sheets CRM Sync** feature bullet.
   - *Placeholder*: `![Synced Leads in Google Sheets CRM](docs/google_sheets_crm.png)`

4. **Analytics Web Dashboard**
   - *Description*: Capture the redesigned light-theme `/dashboard` interface showing responsive statistics cards (maroon left border), trend charts, and the zebra-striped recent leads list.
   - *Placement*: Place below the **Live Analytics Web Dashboard** description.
   - *Placeholder*: `![Light-Theme Analytics Web Dashboard](docs/web_dashboard.png)`

---

## 👨‍💻 Developer & License

- **Developer**: Vijay Kumar
- **License**: MIT License
