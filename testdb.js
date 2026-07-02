import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URI,
  ssl: process.env.DB_SSL_ENABLED === 'true' ? { rejectUnauthorized: false } : false,
});

try {
  const result = await pool.query("SELECT NOW()");
  console.log("Connection successful! Current time from DB:", result.rows[0]);
} catch (err) {
  console.error("Database connection query failed:", err);
} finally {
  await pool.end();
  console.log("Database connection pool closed.");
}