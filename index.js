import 'express-async-errors';
import pkg from "@slack/bolt";
const { App } = pkg;
import { WebClient } from "@slack/web-api";
import { ChatGroq } from "@langchain/groq";
import express from "express";
import dotenv from "dotenv";
import PQueue from 'p-queue';

import {
  initDatabase,
  saveMemberAnalysis,
  markAsSentToSlack,
  closeDatabase,
  getLastAnalysisTime,
  getMemberById,
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
        // 🔥 DEBUG: Yeh console.log Render logs mein dikhega, humein exact text pata chalega
        console.log('[DEBUG] Raw slash text received:', command.text);

        const text = command.text || "";
        let userId = null;

        // 1. Standard Slack mention format: <@U12345> ya <@U12345|DisplayName>
        let match = text.match(/<@(U[A-Z0-9]+)(?:\|.*?)?>/);
        if (match) {
          userId = match[1];
        }

        // 2. Agar upar se na mile, toh try @U12345 (bina brackets ke)
        if (!userId) {
          match = text.match(/@(U[A-Z0-9]+)/);
          if (match) {
            userId = match[1];
          }
        }

        // 3. Agar ab bhi na mile, toh sirf U12345 (bina @ ke) check karo
        if (!userId) {
          match = text.match(/^(U[A-Z0-9]+)$/);
          if (match) {
            userId = match[1];
          }
        }

        // 4. Agar kuch bhi match nahi hua, toh error message ke saath raw text bhi dikhao
        if (!userId) {
          await say(`❌ Please mention a user using @. I received: "${text}"`);
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
  }

  setupExpress() {
    this.app.use(express.json());

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({ status: "healthy", timestamp: new Date().toISOString() });
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

  // ---------- Start bot (Slack first, then Express) ----------
  async start() {
    try {
      logger.info("Initializing database...");
      await initDatabase();

      // Start Slack socket connection first
      await this.slackApp.start();
      logger.info("Slack bot successfully started");

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