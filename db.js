import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
import logger from './src/services/logger.js';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URI,
  ssl: process.env.DB_SSL_ENABLED === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('connect', () => {
  logger.info('Database connected');
});

pool.on('error', (err) => {
  logger.error(`Unexpected database error: ${err.message}`);
});

export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS member_analyses (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(255) UNIQUE,
        member_name VARCHAR(255) NOT NULL,
        member_email VARCHAR(255),
        member_title VARCHAR(255),
        member_timezone VARCHAR(100),
        fit_score INTEGER NOT NULL,
        insights JSONB,
        recommendations JSONB,
        research_data JSONB,
        analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sent_to_slack BOOLEAN DEFAULT FALSE,
        sent_to_slack_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_member_id ON member_analyses(member_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analyzed_at ON member_analyses(analyzed_at);
    `);

    // Migration for autonomous decision columns
    await client.query(`
      ALTER TABLE member_analyses ADD COLUMN IF NOT EXISTS auto_action VARCHAR(50);
    `);
    await client.query(`
      ALTER TABLE member_analyses ADD COLUMN IF NOT EXISTS auto_action_note TEXT;
    `);
    await client.query(`
      ALTER TABLE member_analyses ADD COLUMN IF NOT EXISTS auto_action_at TIMESTAMP;
    `);

    // Migration for follow up date and auto dm sent status
    await client.query(`
      ALTER TABLE member_analyses 
      ADD COLUMN IF NOT EXISTS follow_up_date TIMESTAMP,
      ADD COLUMN IF NOT EXISTS auto_dm_sent BOOLEAN DEFAULT FALSE
    `);

    logger.info('Database schema initialized and migrated');
  } catch (error) {
    logger.error(`Failed to initialize database: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

export async function getLastAnalysisTime(memberId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT analyzed_at FROM member_analyses WHERE member_id = $1`,
      [memberId]
    );
    if (result.rows.length > 0) {
      return result.rows[0].analyzed_at;
    }
    return null;
  } catch (error) {
    logger.error(`Failed to get last analysis time: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

export async function saveMemberAnalysis(memberInfo, analysis, researchData) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO member_analyses (
        member_id, member_name, member_email, member_title, member_timezone,
        fit_score, insights, recommendations, research_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (member_id) DO UPDATE SET
        member_name = EXCLUDED.member_name,
        member_email = EXCLUDED.member_email,
        member_title = EXCLUDED.member_title,
        member_timezone = EXCLUDED.member_timezone,
        fit_score = EXCLUDED.fit_score,
        insights = EXCLUDED.insights,
        recommendations = EXCLUDED.recommendations,
        research_data = EXCLUDED.research_data,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id`,
      [
        memberInfo.id || null,
        memberInfo.name,
        memberInfo.email || null,
        memberInfo.title || null,
        memberInfo.timezone || null,
        analysis.fitScore,
        JSON.stringify(analysis.insights),
        JSON.stringify(analysis.recommendations),
        JSON.stringify(researchData),
      ]
    );
    logger.info(`Saved analysis to database with ID: ${result.rows[0].id}`);
    return result.rows[0].id;
  } catch (error) {
    logger.error(`Failed to save analysis to database: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

export async function markAsSentToSlack(analysisId) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE member_analyses
       SET sent_to_slack = TRUE,
           sent_to_slack_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [analysisId]
    );
  } catch (error) {
    logger.error(`Failed to mark as sent to Slack: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

export async function getMemberById(memberId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM member_analyses WHERE member_id = $1`,
      [memberId]
    );
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    return null;
  } catch (error) {
    logger.error(`Failed to get member analysis by ID: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

export async function markAutomaticAction(analysisId, actionType, actionNote) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE member_analyses 
       SET auto_action = $1, auto_action_note = $2, auto_action_at = CURRENT_TIMESTAMP 
       WHERE id = $3`,
      [actionType, actionNote, analysisId]
    );
  } catch (error) {
    logger.error(`Failed to mark automatic action: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

export async function getAnalysisByMemberId(memberId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id, fit_score FROM member_analyses WHERE member_id = $1 ORDER BY analyzed_at DESC LIMIT 1',
      [memberId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error(`Failed to get analysis by member ID: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

export async function markAutoDMSent(analysisId) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE member_analyses SET auto_dm_sent = TRUE, follow_up_date = NOW() + INTERVAL '3 days' WHERE id = $1`,
      [analysisId]
    );
  } catch (error) {
    logger.error(`Failed to mark auto DM sent: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  await pool.end();
  logger.info('Database connection pool closed');
}

export default pool;