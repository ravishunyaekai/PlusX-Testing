import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import logger from "../logger.js";
dotenv.config();

const pool = mysql.createPool({
    host               : process.env.DB_HOST,
    user               : process.env.DB_USER,
    password           : process.env.DB_PASSWORD,
    database           : process.env.DB_NAME,
    port               : 3306,
    waitForConnections : true,
    connectionLimit    : 20,
    queueLimit         : 0
    // connectTimeout     : 10000,
});

const retryConnection = async (retries, delay) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const connection = await pool.getConnection();
      console.log("Connected to the MySQL database.");
      connection.release();
      return;
    } catch (err) {
      // console.error(`Error connecting to the database (attempt ${i + 1}):`, err);
      logger.error(`Error connecting to the database (attempt ${i + 1}):`, err);

      if (err.code === 'ECONNREFUSED') {
        // console.log('Connection refused, retrying...');
        logger.error(`Connection refused, retrying...`);
      }

      if (i < retries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        // console.error('All retry attempts failed.');
        logger.error(`All retry attempts failed.`);
        throw err;
      }
    }
  }
};

const testConnectionOld = async () => {
  const maxRetries = 5;
  const retryDelay = 2000;
  await retryConnection(maxRetries, retryDelay);
};

const testConnection = async () => {
    try {
        const connection = await pool.getConnection();
        console.log("Connected to the MySQL database.");
        connection.release();
    } catch (err) {
        console.error("Error connecting to the database:", err);
    }
};
testConnection();

export const startTransaction = async () => {
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  return connection;
};

export const commitTransaction = async (connection) => {
  await connection.commit();
  connection.release();
};

export const rollbackTransaction = async (connection) => {
  await connection.rollback();
  connection.release();
};

export default pool;
