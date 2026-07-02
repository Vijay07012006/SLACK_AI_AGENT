import logger from './logger.js';

const joinDebounceMap = new Map();

export async function getUserInfo(webClient, userId) {
  const result = await webClient.users.info({ user: userId });
  const user = result.user;
  return {
    id: user.id,
    name: user.real_name || user.name,
    username: user.name,
    email: user.profile?.email || null,
    title: user.profile?.title || null,
    timezone: user.tz,
    profile: {
      firstName: user.profile?.first_name || null,
      lastName: user.profile?.last_name || null,
      statusText: user.profile?.status_text || null,
    },
  };
}

export async function getChannelInfo(webClient, channelId) {
  try {
    const result = await webClient.conversations.info({
      channel: channelId,
    });
    if (!result.ok || !result.channel) {
      throw new Error("Channel not found");
    }
    return {
      id: result.channel.id,
      name: result.channel.name || 'unknown-channel',
      isPrivate: result.channel.is_private,
      topic: result.channel.topic?.value || "",
    };
  } catch (error) {
    logger.error(`Failed to get channel info for ${channelId}: ${error.message}`);
    return { id: channelId, name: "unknown-channel", isPrivate: true };
  }
}

export async function analyzeChannelJoin(webClient, userInfo, channelInfo) {
  // Check env var or fallback
  let allowedChannels = [];
  if (process.env.NOTIFICATION_CHANNELS) {
    allowedChannels = process.env.NOTIFICATION_CHANNELS.split(',').map(c => c.trim().toLowerCase());
  } else {
    allowedChannels = ['general', 'introductions'];
  }

  const channelName = (channelInfo.name || '').toLowerCase();
  if (!allowedChannels.includes(channelName)) {
    logger.info(`Skipping channel-join notification: #${channelInfo.name} is not in allowed channels [${allowedChannels.join(', ')}]`);
    return;
  }

  // 10-second debounce
  const debounceKey = `${userInfo.id}:${channelInfo.id}`;
  const now = Date.now();
  if (joinDebounceMap.has(debounceKey)) {
    const lastTime = joinDebounceMap.get(debounceKey);
    if (now - lastTime < 10000) {
      logger.info(`Debouncing duplicate channel-join notification for ${userInfo.name} in #${channelInfo.name}`);
      return;
    }
  }
  joinDebounceMap.set(debounceKey, now);

  // Clean old debounce records
  for (const [key, val] of joinDebounceMap.entries()) {
    if (now - val > 60000) {
      joinDebounceMap.delete(key);
    }
  }

  logger.info(`Posting channel-join notification: ${userInfo.name} joined #${channelInfo.name}`);

  const message = {
    channel: process.env.SLACK_PRIVATE_CHANNEL_ID,
    text: `👋 *${userInfo.name}* joined channel \`#${channelInfo.name}\``,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${userInfo.name}* just joined channel *<#${channelInfo.id}>*`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Title: ${userInfo.title || "—"} | Email: ${userInfo.email || "—"}`,
          },
        ],
      },
    ],
  };

  try {
    await webClient.chat.postMessage(message);
    logger.info(`Posted channel-join notification for ${userInfo.name}`);
  } catch (error) {
    logger.error(`Failed to post channel-join message: ${error.message}`);
  }
}

export async function postAnalysisToChannel(webClient, memberInfo, analysis, researchData) {
  const channelId = process.env.SLACK_PRIVATE_CHANNEL_ID;
  if (!channelId) {
    logger.error("SLACK_PRIVATE_CHANNEL_ID is not defined");
    return;
  }

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `New Member Analysis: ${memberInfo.name}`,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Fit Score:* ${analysis.fitScore}/100`,
        },
        {
          type: "mrkdwn",
          text: `*Email:* ${memberInfo.email || "N/A"}`,
        },
        {
          type: "mrkdwn",
          text: `*Title:* ${memberInfo.title || "N/A"}`,
        },
      ],
    },
  ];

  if (analysis.insights && analysis.insights.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Insights:*\n${analysis.insights
          .map((insight) => `• ${insight}`)
          .join("\n")}`,
      },
    });
  }

  if (analysis.recommendations && analysis.recommendations.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recommendations:*\n${analysis.recommendations
          .map((rec) => `• ${rec}`)
          .join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `• Analyzed: ${new Date().toISOString()}`,
      },
    ],
  });

  try {
    await webClient.chat.postMessage({
      channel: channelId,
      text: `New Member Analysis: ${memberInfo.name} (${analysis.fitScore}/100)`,
      blocks: blocks,
    });
    logger.info(
      `Analysis posted to channel for ${memberInfo.name} with fit score ${analysis.fitScore}`
    );
  } catch (error) {
    logger.error(`Failed to post analysis to Slack: ${error.message}`);
  }
}
