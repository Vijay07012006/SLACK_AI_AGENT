import 'express-async-errors';
import pkg from "@slack/bolt";
const { App } = pkg;
import { WebClient } from "@slack/web-api";
import { ChatGroq } from "@langchain/groq";
import express from "express";
import dotenv from "dotenv";
import PQueue from 'p-queue';
import { google } from "googleapis";
import cron from "node-cron";
import pool, {
  initDatabase,
  saveMemberAnalysis,
  markAsSentToSlack,
  closeDatabase,
  getLastAnalysisTime,
  getMemberById,
  markAutomaticAction,
} from "./db.js";

import logger from "./src/services/logger.js";
import { doBasicResearch } from "./src/services/research.service.js";
import { analyzeWithAI } from "./src/services/ai.service.js";
import {
  getUserInfo,
  getChannelInfo,
  analyzeChannelJoin,
  postAnalysisToChannel,
  buildAnalysisBlocks,
} from "./src/services/slack.service.js";

dotenv.config();

// ---------- Environment validation ----------
const requiredEnvVars = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_APP_TOKEN",
  "GROQ_API_KEY",
  "DATABASE_URI",
  "SLACK_PRIVATE_CHANNEL_ID",
  "COMPANY_NAME",
  "COMPANY_PRODUCT"
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    if (envVar === "COMPANY_NAME" || envVar === "COMPANY_PRODUCT") {
      const defaultVal = envVar === "COMPANY_NAME" ? "Our Company" : "Our Product";
      process.env[envVar] = defaultVal;
      logger.warn(`Missing environment variable: ${envVar}. Falling back to default: "${defaultVal}"`);
    } else {
      logger.error(`Missing required environment variable: ${envVar}`);
      process.exit(1);
    }
  }
}

class SlackAIAgent {
  constructor() {
    this.app = express();
    this.slackApp = new App({
      token: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      socketMode: true,
      appToken: process.env.SLACK_APP_TOKEN,
    });
    this.webClient = new WebClient(process.env.SLACK_BOT_TOKEN);
    
    // Configurable Groq Model
    const modelName = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
    logger.info(`Initializing Groq chat client with model: ${modelName}`);
    this.groq = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: modelName,
      temperature: 0.3,
    });

    // P-Queue for Slack Events (Bug 11)
    this.queue = new PQueue({ concurrency: 1 });
    logger.info("Initializing PQueue with concurrency 1");

    // Google Sheets Auth Setup
    if (process.env.GOOGLE_CREDENTIALS) {
      try {
        this.sheetsAuth = new google.auth.GoogleAuth({
          credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        logger.info("Initialized Google Sheets Auth client");
      } catch (error) {
        logger.error(`Failed to initialize Google Sheets Auth: ${error.message}`);
      }
    } else {
      logger.warn("GOOGLE_CREDENTIALS is not defined in environment variables");
    }

    this.autonomousEnabled = process.env.AUTO_ENABLED !== 'false';
    logger.info(`Autonomous Decision Engine enabled: ${this.autonomousEnabled}`);

    this.setupSlackEvents();
    this.setupExpress();
  }

  setupSlackEvents() {
    // Event: new member joins workspace (team_join)
    this.slackApp.event("team_join", async ({ event }) => {
      this.queue.add(async () => {
        try {
          const name = event.user.real_name || event.user.name;
          logger.info(`New member joined workspace: ${name} (${event.user.id})`);
          const userInfo = await getUserInfo(this.webClient, event.user.id);
          await this.analyzeAndPostMember(userInfo);
        } catch (error) {
          logger.error(`Error processing team_join: ${error.message}`);
        }
      });
    });

    // Event: member joins a channel (member_joined_channel)
    this.slackApp.event("member_joined_channel", async ({ event }) => {
      this.queue.add(async () => {
        try {
          // BUG 4: Fix Channel Type Filter (remove the event.channel_type === "C" condition)
          logger.info(`Member ${event.user} joined channel ${event.channel}`);
          const userInfo = await getUserInfo(this.webClient, event.user);
          const channelInfo = await getChannelInfo(this.webClient, event.channel);
          await analyzeChannelJoin(this.webClient, userInfo, channelInfo);
        } catch (error) {
          logger.error(`Error processing member_joined_channel: ${error.message}`);
        }
      });
    });

    this.slackApp.error(async (error) => {
      logger.error(`Slack error: ${error.message}`);
    });

    // Slash Command: /analyze
    this.slackApp.command("/analyze", async ({ command, ack, say, client }) => {
      await ack();
      try {
        // 🔥 DEBUG: Exact text log karo
        console.log('[DEBUG] Raw slash text received:', command.text);

        const text = (command.text || "").trim();
        let userId = null;
        let username = null;

        // 1. Try to find User ID format: <@U12345> or @U12345 or U12345
        let match = text.match(/<@(U[A-Z0-9]+)(?:\|.*?)?>/);
        if (!match) match = text.match(/@?(U[A-Z0-9]+)/);
        if (match) {
          userId = match[1];
        }

        // 2. Agar User ID nahi mili, toh maan lo username hai (e.g., @vkc80905)
        if (!userId) {
          match = text.match(/^@?([a-zA-Z0-9_.-]+)$/);
          if (match) {
            username = match[1];
          }
        }

        // 3. Agar username mila hai, toh Slack users.list se User ID dhundho
        if (!userId && username) {
          try {
            const result = await client.users.list({ limit: 200 });
            const foundUser = result.members.find(u => 
              u.name === username || 
              u.profile?.display_name === username ||
              u.real_name === username
            );
            if (foundUser) {
              userId = foundUser.id;
              console.log('[DEBUG] Found user by username:', username, '-> ID:', userId);
            } else {
              console.log('[DEBUG] No user found for username:', username);
            }
          } catch (error) {
            console.error('Error finding user by username:', error);
          }
        }

        // 4. Agar ab bhi userId nahi mila, toh error do
        if (!userId) {
          await say(`❌ Could not find user. I received: "${text}". Please mention a valid user.`);
          return;
        }

        logger.info(`Slash command /analyze triggered for user: ${userId}`);

        // Fetch existing analysis from db
        const existing = await getMemberById(userId);
        if (existing) {
          logger.info(`Found existing analysis for user ${userId} in database`);
          
          const analysis = {
            fitScore: existing.fit_score,
            insights: existing.insights,
            recommendations: existing.recommendations,
          };
          
          const memberInfo = {
            name: existing.member_name,
            email: existing.member_email,
            title: existing.member_title,
          };
          
          const blocks = buildAnalysisBlocks(memberInfo, analysis);
          
          blocks.unshift({
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Existing analysis from database*"
            }
          });

          await say({
            text: `Existing analysis for ${memberInfo.name}`,
            blocks: blocks,
          });
          return;
        }

        // Fetch user info from Slack since not in DB
        const userInfo = await getUserInfo(client, userId);
        
        // Run full analysis
        const analysis = await this.analyzeAndPostMember(userInfo);
        if (!analysis) {
          await say(`Analysis for ${userInfo.name} skipped (duplicate/recent).`);
          return;
        }

        const blocks = buildAnalysisBlocks(userInfo, analysis);
        await say({
          text: `New Member Analysis for ${userInfo.name}`,
          blocks: blocks,
        });

      } catch (error) {
        logger.error(`Error in /analyze command: ${error.message}`);
        await say(`Error running analysis: ${error.message}`);
      }
    });

    this.slackApp.action('crm_add', async ({ ack, body, say }) => {
      await ack();
      const user = body.user?.name || 'Someone';
      const sheetId = process.env.GOOGLE_SHEET_ID;

      if (!this.sheetsAuth) {
        logger.error("sheetsAuth is not configured");
        await say(`❌ Google Sheets CRM is not configured. Please check environment variables.`);
        return;
      }

      // Parse blocks or fallback to message text to extract member info
      const blocks = body.message?.blocks || [];
      let memberName = 'N/A';
      let fitScore = 'N/A';
      let email = 'N/A';
      let title = 'N/A';

      // 1. Extract from header block: "New Member Analysis: <Name>"
      if (blocks[0]?.text?.text) {
        const nameMatch = blocks[0].text.text.match(/New Member Analysis:\s*(.*)/i);
        if (nameMatch) {
          memberName = nameMatch[1].trim();
        }
      }

      // 2. Extract from fields in section block: "*Fit Score:* ...", "*Email:* ...", "*Title:* ..."
      const sectionBlock = blocks.find(b => b.type === 'section' && b.fields);
      if (sectionBlock) {
        for (const field of sectionBlock.fields) {
          if (field.text) {
            const fitMatch = field.text.match(/\*Fit Score:\*\s*(\d+)/i);
            if (fitMatch) fitScore = fitMatch[1];
            
            const emailMatch = field.text.match(/\*Email:\*\s*(.*)/i);
            if (emailMatch) email = emailMatch[1].trim();

            const titleMatch = field.text.match(/\*Title:\*\s*(.*)/i);
            if (titleMatch) title = titleMatch[1].trim();
          }
        }
      }

      // Fallbacks using regex from command text / message text as defined in prompt
      if (memberName === 'N/A') {
        memberName = body.message?.text?.match(/\*Member Name:\*\s(.*?)\n/)?.[1] || 
                     body.message?.text?.match(/New Member Analysis:\s*(.*?)\s*\(\d+\/100\)/i)?.[1] ||
                     body.message?.text?.match(/New Member Analysis:\s*(.*)/i)?.[1] ||
                     'N/A';
      }
      if (fitScore === 'N/A') {
        fitScore = body.message?.text?.match(/\*Fit Score:\*\s(\d+)/)?.[1] || 
                   body.message?.text?.match(/\((\d+)\/100\)/)?.[1] ||
                   'N/A';
      }

      try {
        const auth = await this.sheetsAuth.getClient();
        const sheets = google.sheets({ version: 'v4', auth });
        
        const response = await sheets.spreadsheets.values.append({
          spreadsheetId: sheetId,
          range: 'Sheet1!A:F',
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[
              new Date().toISOString(),
              memberName,
              email,
              title,
              isNaN(parseInt(fitScore)) ? 0 : parseInt(fitScore),
              body.user.id
            ]]
          }
        });
        
        await say(`✅ <@${body.user.id}> added *${memberName}* (Fit: ${fitScore}) to Google Sheets CRM!`);
      } catch (error) {
        console.error('Google Sheets Error:', error);
        await say(`❌ Could not add to CRM. Error: ${error.message}`);
      }
    });

    this.slackApp.action('email_send', async ({ ack, body, say }) => {
      await ack();
      await say(`📧 <@${body.user.id}> requested to send an email! (Email sending logic can be added here later.)`);
    });

    this.slackApp.action('ignore', async ({ ack, body, say }) => {
      await ack();
      await say(`👌 Noted! <@${body.user.id}> ignored this lead.`);
    });
  }

  setupExpress() {
    this.app.use(express.json());

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({ status: "healthy", timestamp: new Date().toISOString() });
    });

    // Web Dashboard
    this.app.get("/dashboard", async (req, res) => {
      let client = null;
      try {
        client = await pool.connect();
        
        const total = await client.query('SELECT COUNT(*) FROM member_analyses');
        const avg = await client.query('SELECT AVG(fit_score) FROM member_analyses');
        const high = await client.query('SELECT COUNT(*) FROM member_analyses WHERE fit_score >= 80');
        const today = await client.query("SELECT COUNT(*) FROM member_analyses WHERE DATE(analyzed_at) = CURRENT_DATE");
        const trend = await client.query(`
          SELECT DATE(analyzed_at) as date, COUNT(*) as count 
          FROM member_analyses 
          WHERE analyzed_at >= NOW() - INTERVAL '7 days' 
          GROUP BY DATE(analyzed_at) 
          ORDER BY date
        `);
        const recent = await client.query('SELECT member_name, fit_score, analyzed_at, member_email, member_title FROM member_analyses ORDER BY analyzed_at DESC LIMIT 10');
        const distribution = await client.query(`
          SELECT 
            CASE 
              WHEN fit_score <= 20 THEN '0-20'
              WHEN fit_score <= 40 THEN '21-40'
              WHEN fit_score <= 60 THEN '41-60'
              WHEN fit_score <= 80 THEN '61-80'
              ELSE '81-100'
            END as range,
            COUNT(*) as count
          FROM member_analyses 
          GROUP BY range
          ORDER BY range
        `);

        const totalCount = parseInt(total.rows[0].count) || 0;
        const avgScore = Math.round(parseFloat(avg.rows[0].avg)) || 0;
        const highFitCount = parseInt(high.rows[0].count) || 0;
        const todayCount = parseInt(today.rows[0].count) || 0;

        // Last Updated timestamp converted to Asia/Kolkata (IST)
        const lastUpdated = new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'medium',
          timeStyle: 'short'
        });

        // Format trend labels and values
        const trendLabels = trend.rows.map(r => {
          const d = new Date(r.date);
          return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });
        });
        const trendValues = trend.rows.map(r => parseInt(r.count));

        // Format distribution labels and values
        const distBuckets = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
        distribution.rows.forEach(r => {
          if (distBuckets[r.range] !== undefined) {
            distBuckets[r.range] = parseInt(r.count);
          }
        });
        const distLabels = Object.keys(distBuckets);
        const distValues = Object.values(distBuckets);

        // Format recent members table rows with Asia/Kolkata timestamps
        const recentRowsHTML = recent.rows.map(r => {
          const dateStr = new Date(r.analyzed_at).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          });
          
          let scoreBadgeClass = "bg-[#FFF5F5] text-[#C53030] border-[#C53030]/20";
          if (r.fit_score >= 80) {
            scoreBadgeClass = "bg-[#E6F4EA] text-[#0A7E3C] border-[#0A7E3C]/20";
          } else if (r.fit_score >= 50) {
            scoreBadgeClass = "bg-[#EBF8FF] text-[#2B6CB0] border-[#2B6CB0]/20";
          } else if (r.fit_score >= 30) {
            scoreBadgeClass = "bg-[#FEFCBF] text-[#B7791F] border-[#B7791F]/20";
          }

          return `
            <tr class="hover:bg-slate-50 transition-colors duration-200 even:bg-slate-50/50">
              <td class="px-6 py-4 font-medium text-slate-900">${r.member_name}</td>
              <td class="px-6 py-4 text-slate-600">${r.member_title || 'N/A'}</td>
              <td class="px-6 py-4 text-slate-600">${r.member_email || 'N/A'}</td>
              <td class="px-6 py-4">
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${scoreBadgeClass}">
                  ${r.fit_score}/100
                </span>
              </td>
              <td class="px-6 py-4 text-slate-600">${dateStr}</td>
            </tr>
          `;
        }).join('\n');

        res.send(`
          <!DOCTYPE html>
          <html lang="en" class="h-full">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>📊 Slack AI Dashboard</title>
              <script src="https://cdn.tailwindcss.com"></script>
              <link rel="preconnect" href="https://fonts.googleapis.com">
              <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
              <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
              <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
              <script>
                tailwind.config = {
                  theme: {
                    extend: {
                      colors: {
                        brand: {
                          maroon: '#800020',
                          maroonLight: '#F3E8EB',
                          green: '#0A7E3C',
                          greenLight: '#E6F4EA',
                          bg: '#F8F9FA',
                          darkText: '#1A1A1A',
                          mutedText: '#4A4A4A',
                        }
                      },
                      fontFamily: {
                        sans: ['Inter', 'sans-serif'],
                      },
                    },
                  },
                }
              </script>
              <style>
                body {
                  font-family: 'Inter', sans-serif;
                }
                .dashboard-card {
                  background: #FFFFFF;
                  border: 1px solid #E2E8F0;
                  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
                  transition: all 0.2s ease-in-out;
                }
                .dashboard-card:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
                }
              </style>
            </head>
            <body class="bg-brand-bg min-h-full text-brand-darkText p-4 md:p-8">
              <div class="max-w-7xl mx-auto space-y-8">
                
                <!-- Top Header -->
                <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b-2 border-brand-maroon pb-6">
                  <div>
                    <h1 class="text-3xl font-extrabold tracking-tight text-brand-maroon flex items-center gap-2">
                      📊 Slack AI Dashboard
                    </h1>
                    <p class="text-sm text-brand-mutedText mt-1">Real-time workspace insights and community lead analysis (IST Timezone)</p>
                  </div>
                  <div class="text-xs md:text-sm text-brand-mutedText bg-white px-4 py-2 rounded-full border border-slate-200 shadow-sm">
                    🕒 Last Updated (IST): <span class="text-brand-maroon font-semibold">${lastUpdated}</span>
                  </div>
                </div>

                <!-- Stats Row -->
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                  <!-- Card 1 -->
                  <div class="dashboard-card p-6 rounded-2xl border-l-4 border-l-brand-maroon">
                    <div class="flex justify-between items-start">
                      <div>
                        <p class="text-xs font-semibold text-brand-mutedText uppercase tracking-wider">Total Members</p>
                        <h3 class="text-3xl font-bold text-brand-maroon mt-2 counter" data-target="${totalCount}">${totalCount}</h3>
                      </div>
                      <div class="p-3 bg-brand-maroonLight text-brand-maroon rounded-xl">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
                      </div>
                    </div>
                  </div>
                  <!-- Card 2 -->
                  <div class="dashboard-card p-6 rounded-2xl border-l-4 border-l-brand-maroon">
                    <div class="flex justify-between items-start">
                      <div>
                        <p class="text-xs font-semibold text-brand-mutedText uppercase tracking-wider">Average Fit Score</p>
                        <h3 class="text-3xl font-bold text-brand-maroon mt-2"><span class="counter" data-target="${avgScore}">${avgScore}</span><span class="text-lg text-brand-mutedText">/100</span></h3>
                      </div>
                      <div class="p-3 bg-brand-maroonLight text-brand-maroon rounded-xl">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
                      </div>
                    </div>
                  </div>
                  <!-- Card 3 -->
                  <div class="dashboard-card p-6 rounded-2xl border-l-4 border-l-brand-green">
                    <div class="flex justify-between items-start">
                      <div>
                        <p class="text-xs font-semibold text-brand-mutedText uppercase tracking-wider">High Fit Leads (≥80)</p>
                        <h3 class="text-3xl font-bold text-brand-green mt-2 counter" data-target="${highFitCount}">${highFitCount}</h3>
                      </div>
                      <div class="p-3 bg-brand-greenLight text-brand-green rounded-xl">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                      </div>
                    </div>
                  </div>
                  <!-- Card 4 -->
                  <div class="dashboard-card p-6 rounded-2xl border-l-4 border-l-brand-maroon">
                    <div class="flex justify-between items-start">
                      <div>
                        <p class="text-xs font-semibold text-brand-mutedText uppercase tracking-wider">New Leads Today</p>
                        <h3 class="text-3xl font-bold text-brand-maroon mt-2 counter" data-target="${todayCount}">${todayCount}</h3>
                      </div>
                      <div class="p-3 bg-brand-maroonLight text-brand-maroon rounded-xl">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Charts Row -->
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <!-- Line Chart Container -->
                  <div class="dashboard-card p-6 rounded-2xl lg:col-span-2">
                    <h4 class="text-sm font-semibold text-brand-mutedText mb-4 uppercase tracking-wider">7-Day Growth Trend</h4>
                    <div class="h-64 relative">
                      <canvas id="growthChart"></canvas>
                    </div>
                  </div>
                  <!-- Doughnut Chart Container -->
                  <div class="dashboard-card p-6 rounded-2xl">
                    <h4 class="text-sm font-semibold text-brand-mutedText mb-4 uppercase tracking-wider">Fit Score Distribution</h4>
                    <div class="h-64 relative">
                      <canvas id="distributionChart"></canvas>
                    </div>
                  </div>
                </div>

                <!-- Recent Members Table -->
                <div class="dashboard-card rounded-2xl overflow-hidden shadow-md">
                  <div class="p-6 border-b border-slate-200 bg-white">
                    <h4 class="text-sm font-semibold text-brand-maroon uppercase tracking-wider">Recent Analyzed Members</h4>
                  </div>
                  <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                      <thead>
                        <tr class="bg-brand-maroon text-xs font-semibold uppercase tracking-wider text-white">
                          <th class="px-6 py-4">Member Name</th>
                          <th class="px-6 py-4">Title</th>
                          <th class="px-6 py-4">Email</th>
                          <th class="px-6 py-4">Fit Score</th>
                          <th class="px-6 py-4">Date & Time (IST)</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-slate-200 text-sm bg-white">
                        ${recentRowsHTML || '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500 bg-white">No member analysis records found in the database.</td></tr>'}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>

              <script>
                // Animated Counters
                document.addEventListener('DOMContentLoaded', () => {
                  const counters = document.querySelectorAll('.counter');
                  counters.forEach(counter => {
                    const target = parseInt(counter.getAttribute('data-target')) || 0;
                    let count = 0;
                    const speed = 2000 / (target || 1); 
                    const increment = Math.max(1, Math.ceil(target / 100));

                    const updateCount = () => {
                      if (count < target) {
                        count += increment;
                        if (count > target) count = target;
                        counter.innerText = count;
                        setTimeout(updateCount, Math.min(30, speed * increment));
                      } else {
                        counter.innerText = target;
                      }
                    };
                    updateCount();
                  });

                  // Growth Chart (Line)
                  const growthCtx = document.getElementById('growthChart').getContext('2d');
                  new Chart(growthCtx, {
                    type: 'line',
                    data: {
                      labels: ${JSON.stringify(trendLabels)},
                      datasets: [{
                        label: 'New Members',
                        data: ${JSON.stringify(trendValues)},
                        borderColor: '#800020',
                        backgroundColor: 'rgba(128, 0, 32, 0.05)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.4,
                        pointBackgroundColor: '#800020',
                        pointHoverRadius: 7
                      }]
                    },
                    options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                        legend: { display: false }
                      },
                      scales: {
                        x: {
                          grid: { color: 'rgba(0, 0, 0, 0.05)' },
                          ticks: { color: '#4A4A4A' }
                        },
                        y: {
                          grid: { color: 'rgba(0, 0, 0, 0.05)' },
                          ticks: { color: '#4A4A4A', stepSize: 1 },
                          beginAtZero: true
                        }
                      }
                    }
                  });

                  // Distribution Chart (Doughnut)
                  const distCtx = document.getElementById('distributionChart').getContext('2d');
                  new Chart(distCtx, {
                    type: 'doughnut',
                    data: {
                      labels: ${JSON.stringify(distLabels)},
                      datasets: [{
                        data: ${JSON.stringify(distValues)},
                        backgroundColor: [
                          '#E53E3E',   
                          '#DD6B20',   
                          '#ECC94B',   
                          '#3182CE',   
                          '#0A7E3C'    
                        ],
                        borderColor: '#FFFFFF',
                        borderWidth: 2
                      }]
                    },
                    options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                        legend: {
                          position: 'bottom',
                          labels: { color: '#4A4A4A', padding: 15 }
                        }
                      },
                      cutout: '65%'
                    }
                  });

                });
              </script>
            </body>
          </html>
        `);
      } catch (error) {
        res.status(500).send('Dashboard Error: ' + error.message);
      } finally {
        if (client) {
          client.release();
        }
      }
    });

    // Test endpoint (only in development)
    if (process.env.NODE_ENV === "development") {
      this.app.post("/test/analyze-member", async (req, res, next) => {
        try {
          const { memberInfo } = req.body;
          if (!memberInfo) {
            return res
              .status(400)
              .json({ error: "Missing memberInfo is required" });
          }
          const analysis = await this.analyzeAndPostMember(memberInfo);
          res.json({
            success: true,
            analysis,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          logger.error(`Test analysis error: ${error.message}`);
          next(error);
        }
      });
    }

    // Global error handler
    this.app.use((err, req, res, next) => {
      logger.error(`Express error: ${err.message}`);
      res.status(500).json({ error: "Internal Server Error" });
    });
  }

  // ---------- Full member analysis (for team_join) ----------
  async analyzeAndPostMember(memberInfo) {
    let analysisId = null;
    try {
      logger.info(`Processing member: ${memberInfo.name} (${memberInfo.id})`);
      
      // BUG 8: Deduplication / Rate Limiting
      const lastAnalysisTime = await getLastAnalysisTime(memberInfo.id);
      if (lastAnalysisTime) {
        const lastAnalyzedDate = new Date(lastAnalysisTime);
        const diffMs = Date.now() - lastAnalyzedDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        if (diffHours < 24) {
          logger.info(`Skipping duplicate analysis for user ${memberInfo.name} (${memberInfo.id}) - last analyzed ${diffHours.toFixed(2)} hours ago`);
          return null;
        }
      }

      const researchData = await doBasicResearch(memberInfo);
      const analysis = await analyzeWithAI(this.groq, memberInfo, researchData);
      analysisId = await saveMemberAnalysis(memberInfo, analysis, researchData);

      await postAnalysisToChannel(this.webClient, memberInfo, analysis, researchData);
      if (analysisId) {
        await markAsSentToSlack(analysisId);
      }

      // 🔥 DEBUG: Force autonomous decision
      console.log('[AUTO] 🔥 Entering autonomous decision block');
      if (this.autonomousEnabled) {
        console.log('[AUTO] ✅ Autonomous is enabled, calling makeAutonomousDecision...');
        try {
          await this.makeAutonomousDecision(memberInfo, analysis.fitScore, analysisId);
          console.log('[AUTO] ✅ makeAutonomousDecision completed');
        } catch (err) {
          console.error('[AUTO] ❌ makeAutonomousDecision error:', err.message);
        }
      } else {
        console.log('[AUTO] ❌ Autonomous is disabled');
      }
      return analysis;
    } catch (error) {
      logger.error(`Error processing ${memberInfo.name}: ${error.message}`);
      if (analysisId) {
        logger.info(
          `Analysis ${analysisId} saved but not sent to Slack due to error`
        );
      }
      throw error;
    }
  }

  // Tool 1: Send Direct Message
  async sendAutoDM(userId, memberName, fitScore) {
    if (!userId) {
      console.log('[AUTO] ⚠️ No userId, skipping DM');
      return false;
    }
    try {
      const message = `Hi ${memberName}! 👋\n\nThanks for joining Code with Vijay community. Based on your profile (Fit Score: ${fitScore}/100), we think you'd love our premium coding course.\n\n🎁 Here's your **exclusive free trial**: [Insert Link Here]\n\nLet me know if you have any questions!`;
      await this.webClient.chat.postMessage({
        channel: userId,
        text: message
      });
      console.log(`[AUTO] DM sent to ${memberName}`);
      return true;
    } catch (error) {
      console.error('[AUTO] DM failed:', error.message);
      return false;
    }
  }

  // Tool 2: Tag Sales Team
  async tagSalesTeam(memberName, fitScore, email) {
    console.log(`[AUTO] 📢 Tagging sales team for ${memberName}, Score: ${fitScore}`);
    try {
      const channelId = process.env.SLACK_PRIVATE_CHANNEL_ID;
      const message = {
        channel: channelId,
        text: `🔔 *High-Fit Lead Alert!*\n\n👤 *Name:* ${memberName}\n📊 *Fit Score:* ${fitScore}/100\n📧 *Email:* ${email || 'N/A'}\n\n@channel Please follow up ASAP! 🚀`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🔔 *High-Fit Lead Alert!*\n\n👤 *Name:* ${memberName}\n📊 *Fit Score:* ${fitScore}/100\n📧 *Email:* ${email || 'N/A'}`
            }
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '🚨 Please follow up ASAP!' }]
          }
        ]
      };
      await this.webClient.chat.postMessage(message);
      console.log(`[AUTO] Sales team tagged for ${memberName}`);
      return true;
    } catch (error) {
      console.error('[AUTO] Sales tag failed:', error.message);
      return false;
    }
  }

  // Decision Engine
  async makeAutonomousDecision(memberInfo, fitScore, analysisId) {
    console.log(`[AUTO] 🔥 makeAutonomousDecision called for ${memberInfo.name}, fitScore: ${fitScore}`);
    const thresholdDM = parseInt(process.env.AUTO_DM_THRESHOLD) || 85;
    const thresholdSales = parseInt(process.env.SALES_TAG_THRESHOLD) || 60;
    
    console.log(`[AUTO] Decision for ${memberInfo.name}: Fit=${fitScore}, DM=${thresholdDM}, Sales=${thresholdSales}`);
    
    try {
      // 1. High Fit -> Auto DM
      if (fitScore >= thresholdDM) {
        if (memberInfo.id) {
          await this.sendAutoDM(memberInfo.id, memberInfo.name, fitScore);
          await markAutomaticAction(analysisId, 'auto_dm', 'DM sent to member');
          console.log(`[AUTO] Decision: AUTO_DM for ${memberInfo.name}`);
        } else {
          console.log('[AUTO] No user ID, skipping DM');
          await markAutomaticAction(analysisId, 'ignored_no_id', 'High fit but no user ID to send DM');
        }
        return 'auto_dm';
      }
      
      // 2. Medium Fit -> Tag Sales
      else if (fitScore >= thresholdSales) {
        await this.tagSalesTeam(memberInfo.name, fitScore, memberInfo.email);
        await markAutomaticAction(analysisId, 'tag_sales', 'Sales team notified');
        console.log(`[AUTO] Decision: TAG_SALES for ${memberInfo.name}`);
        return 'tag_sales';
      }
      
      // 3. Low Fit -> Do Nothing (just save in DB)
      else {
        await markAutomaticAction(analysisId, 'ignored', 'Low fit score, no action taken');
        console.log(`[AUTO] Decision: IGNORE for ${memberInfo.name}`);
        return 'ignored';
      }
    } catch (error) {
      console.error('[AUTO] Decision engine error:', error.message);
      return 'error';
    }
  }

  // ---------- Daily Digest Feature ----------
  async sendDailyDigest() {
    let client = null;
    try {
      client = await pool.connect();
      const yesterday = new Date(Date.now() - 24*60*60*1000).toISOString();
      
      // Past 24 hours ke members fetch karo
      const result = await client.query(
        `SELECT member_name, fit_score, analyzed_at FROM member_analyses 
         WHERE analyzed_at > $1 ORDER BY fit_score DESC`,
        [yesterday]
      );
      
      if (result.rows.length === 0) {
        await this.webClient.chat.postMessage({
          channel: process.env.SLACK_PRIVATE_CHANNEL_ID,
          text: '📊 *Daily Digest*: No new members joined in the last 24 hours.'
        });
        return;
      }
      
      const total = result.rows.length;
      const avgScore = Math.round(result.rows.reduce((a,b) => a + b.fit_score, 0) / total);
      const highFit = result.rows.filter(r => r.fit_score >= 80);
      
      let text = `📊 *Daily Member Analysis Report*\n`;
      text += `---------------------------------------------------\n`;
      text += `🔹 Total New Members: ${total}\n`;
      text += `🔹 Average Fit Score: ${avgScore}\n`;
      text += `🔹 High Fit (>80): ${highFit.length} members\n`;
      
      if (highFit.length > 0) {
        text += `  • ${highFit.map(r => `${r.member_name} (${r.fit_score}) ⭐`).join('\n  • ')}\n`;
      }
      
      const totalCount = await client.query(`SELECT COUNT(*) FROM member_analyses`);
      text += `---------------------------------------------------\n`;
      text += `Total members in system: ${totalCount.rows[0].count}`;
      
      await this.webClient.chat.postMessage({
        channel: process.env.SLACK_PRIVATE_CHANNEL_ID,
        text: text,
        unfurl_links: false
      });
      
      logger.info('Daily digest sent successfully.');
    } catch (error) {
      logger.error(`Daily digest failed: ${error.message}`);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  // ---------- Start bot (Slack first, then Express) ----------
  async start() {
    try {
      logger.info("Initializing database...");
      await initDatabase();

      // Start Slack socket connection first
      await this.slackApp.start();
      logger.info("Slack bot successfully started");

      // Daily digest cron schedule (3:30 AM UTC = 9:00 AM IST)
      cron.schedule('30 3 * * *', async () => {
        logger.info('[CRON] Running daily digest...');
        await this.sendDailyDigest();
      });

      // Then start Express server
      const port = process.env.PORT || 3000;
      this.server = this.app.listen(port, () => {
        logger.info(`Express server listening on port ${port}`);
      });

      logger.info("Slack AI Agent is running and ready to process events.");

      if (process.env.NODE_ENV === "development") {
        logger.info(
          `Test endpoint: POST http://localhost:${port}/test/analyze-member`
        );
      }
    } catch (error) {
      logger.error(`Failed to start: ${error.message}`);
      process.exit(1);
    }
  }

  // ---------- Graceful shutdown ----------
  async stop() {
    logger.info("Shutting down Slack AI Agent...");
    try {
      await this.slackApp.stop();
      if (this.server) {
        await new Promise((resolve, reject) => {
          this.server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
      await closeDatabase();
      logger.info("Shutdown complete.");
    } catch (error) {
      logger.error(`Error during shutdown: ${error.message}`);
    }
    process.exit(0);
  }
}

// ---------- Instantiate and run ----------
const agent = new SlackAIAgent();

process.on("SIGINT", () => agent.stop());
process.on("SIGTERM", () => agent.stop());

agent.start().catch((error) => {
  logger.error(`Startup failed: ${error.message}`);
  process.exit(1);
});

export default agent;