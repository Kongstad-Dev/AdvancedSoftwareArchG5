const { Pool } = require('pg');
const logger = require('../utils/logger');

// PostgreSQL connection pool
const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT) || 5432,
    user: process.env.POSTGRES_USER || 'pms_user',
    password: process.env.POSTGRES_PASSWORD || 'pms_password',
    database: process.env.POSTGRES_DB || 'production_db',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
    logger.info('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    logger.error('Unexpected error on idle PostgreSQL client', err);
});

/**
 * Execute a query with retry logic
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @param {number} maxRetries - Maximum number of retries
 * @returns {Promise} Query result
 */
async function query(text, params, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const start = Date.now();
            const result = await pool.query(text, params);
            const duration = Date.now() - start;
            logger.debug(`Query executed in ${duration}ms`, { query: text.substring(0, 100) });
            return result;
        } catch (error) {
            lastError = error;
            logger.warn(`Query attempt ${attempt}/${maxRetries} failed`, { error: error.message });
            if (attempt < maxRetries) {
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
            }
        }
    }
    throw lastError;
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise} PostgreSQL client
 */
async function getClient() {
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    const release = client.release.bind(client);

    // Override release to handle errors
    client.release = () => {
        client.release = release;
        return release();
    };

    // Add transaction helpers
    client.beginTransaction = async () => {
        await originalQuery('BEGIN');
    };

    client.commitTransaction = async () => {
        await originalQuery('COMMIT');
    };

    client.rollbackTransaction = async () => {
        await originalQuery('ROLLBACK');
    };

    return client;
}

/**
 * Execute a function within a transaction
 * @param {Function} fn - Function to execute within transaction
 * @returns {Promise} Result of the function
 */
async function withTransaction(fn) {
    const client = await getClient();
    try {
        await client.beginTransaction();
        const result = await fn(client);
        await client.commitTransaction();
        return result;
    } catch (error) {
        await client.rollbackTransaction();
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Check database health
 * @returns {Promise<boolean>} True if healthy
 */
async function healthCheck() {
    try {
        const result = await query('SELECT 1');
        return result.rowCount === 1;
    } catch (error) {
        logger.error('Database health check failed', { error: error.message });
        return false;
    }
}

/**
 * Close the connection pool
 */
async function close() {
    await pool.end();
    logger.info('PostgreSQL connection pool closed');
}

module.exports = {
    query,
    getClient,
    withTransaction,
    healthCheck,
    close,
    pool
};
