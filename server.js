const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'music-db',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres123',
  database: process.env.DB_NAME || 'music_practice_db',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------------
// Lightweight In-Memory Rate Limiting (Protects PostgreSQL from spam/flooding)
// -----------------------------------------------------------------------------
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 200;   // 200 requests/min per IP

function rateLimiter(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown-ip';
  const now = Date.now();
  const clientData = rateLimitMap.get(ip);

  if (!clientData || now - clientData.startTime > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, startTime: now });
    return next();
  }

  clientData.count++;
  if (clientData.count > MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please wait a minute before sending more requests.',
      retryAfterSeconds: Math.ceil((clientData.startTime + RATE_LIMIT_WINDOW_MS - now) / 1000)
    });
  }

  next();
}

app.use('/api/', rateLimiter);

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now - data.startTime > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Helper to extract sanitized user profile from request headers or queries
function getUserProfile(req) {
  const userId = (req.headers['x-user-id'] || req.query.user_id || 'default_rocker')
    .toString().trim().slice(0, 80);
  const userName = (req.headers['x-user-name'] || req.query.user_name || 'Rocker')
    .toString().trim().slice(0, 100);
  return { userId, userName };
}

// Auto-initialize Database tables with retry logic & migrations
async function initDatabase(retries = 10, delay = 3000) {
  while (retries > 0) {
    try {
      console.log(`[Database] Attempting connection to PostgreSQL (${retries} attempts left)...`);
      const client = await pool.connect();

      // Create Songs table
      await client.query(`
        CREATE TABLE IF NOT EXISTS songs (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          artist VARCHAR(255),
          target_bpm INT NOT NULL DEFAULT 120,
          time_signature VARCHAR(10) DEFAULT '4/4',
          chords TEXT,
          notes TEXT,
          user_id VARCHAR(100) DEFAULT 'global',
          user_name VARCHAR(255) DEFAULT 'Public / Global',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Add columns if table already existed (schema migration)
      await client.query(`
        ALTER TABLE songs ADD COLUMN IF NOT EXISTS user_id VARCHAR(100) DEFAULT 'global';
        ALTER TABLE songs ADD COLUMN IF NOT EXISTS user_name VARCHAR(255) DEFAULT 'Public / Global';
      `);

      // Create Practice Logs table
      await client.query(`
        CREATE TABLE IF NOT EXISTS practice_logs (
          id SERIAL PRIMARY KEY,
          song_id INT REFERENCES songs(id) ON DELETE SET NULL,
          song_title VARCHAR(255) NOT NULL,
          bpm_practiced INT NOT NULL,
          duration_minutes INT NOT NULL,
          accuracy_rating INT DEFAULT 5,
          notes TEXT,
          user_id VARCHAR(100) DEFAULT 'default_rocker',
          user_name VARCHAR(255) DEFAULT 'Anonymous Rocker',
          practiced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Add columns if table already existed (schema migration)
      await client.query(`
        ALTER TABLE practice_logs ADD COLUMN IF NOT EXISTS user_id VARCHAR(100) DEFAULT 'default_rocker';
        ALTER TABLE practice_logs ADD COLUMN IF NOT EXISTS user_name VARCHAR(255) DEFAULT 'Anonymous Rocker';
      `);

      // Seed initial songs if table is empty
      const songCount = await client.query('SELECT COUNT(*) FROM songs');
      if (parseInt(songCount.rows[0].count, 10) === 0) {
        await client.query(`
          INSERT INTO songs (title, artist, target_bpm, time_signature, chords, notes, user_id, user_name)
          VALUES 
          ('Canon in D (Rock Version)', 'Johann Pachelbel', 110, '4/4', 'D - A - Bm - F#m - G - D - G - A', 'เน้นการดีด Alternate Picking และการเปลี่ยนคอร์ดให้ตรงจังหวะ 1', 'global', 'System Demo'),
          ('Hotel California (Acoustic Solo)', 'Eagles', 75, '4/4', 'Bm - F# - A - E - G - D - Em - F#', 'ฝึกฝึกซ้อม Hammer-on และ Pull-off ในช่วงท่อน Solo จังหวะ 75 BPM', 'global', 'System Demo'),
          ('Smells Like Teen Spirit', 'Nirvana', 116, '4/4', 'F5 - Bb5 - Ab5 - Db5', 'คอร์ด Power Chords ดีดเน้นจังหวะกระแทก (Strumming pattern)', 'global', 'System Demo')
        `);
        console.log('[Database] Seeded initial demo songs successfully.');
      }

      client.release();
      console.log('[Database] Tables initialized and database is ready!');
      return;
    } catch (err) {
      console.error(`[Database] Connection failed: ${err.message}`);
      retries -= 1;
      if (retries === 0) {
        console.error('[Database] Could not connect to database after all retries.');
      } else {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

// -----------------------------------------------------------------------------
// REST API ROUTES
// -----------------------------------------------------------------------------

// 1. Healthcheck Endpoint
app.get('/api/health', async (req, res) => {
  try {
    const dbRes = await pool.query('SELECT NOW() as current_time, version()');
    res.status(200).json({
      status: 'ok',
      service: 'RiffRig - Alt-Rock Metronome & Practice Workstation',
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: {
        status: 'connected',
        host: process.env.DB_HOST || 'music-db',
        database_name: process.env.DB_NAME || 'music_practice_db',
        server_time: dbRes.rows[0].current_time
      }
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      service: 'RiffRig - Alt-Rock Metronome & Practice Workstation',
      timestamp: new Date().toISOString(),
      database: {
        status: 'disconnected',
        error: err.message
      }
    });
  }
});

// 2. Songs API
// GET songs (User songs + Global system songs)
app.get('/api/songs', async (req, res) => {
  try {
    const { userId } = getUserProfile(req);
    const result = await pool.query(
      `SELECT * FROM songs 
       WHERE user_id = $1 OR user_id = 'global' 
       ORDER BY (user_id = 'global') ASC, id DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch songs', details: err.message });
  }
});

// GET single song
app.get('/api/songs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = getUserProfile(req);
    const result = await pool.query(
      `SELECT * FROM songs WHERE id = $1 AND (user_id = $2 OR user_id = 'global')`,
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Song not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch song', details: err.message });
  }
});

// POST create song
app.post('/api/songs', async (req, res) => {
  try {
    const { title, artist, target_bpm, time_signature, chords, notes } = req.body;
    const { userId, userName } = getUserProfile(req);

    if (!title || !target_bpm) {
      return res.status(400).json({ error: 'Title and target_bpm are required' });
    }
    const result = await pool.query(
      `INSERT INTO songs (title, artist, target_bpm, time_signature, chords, notes, user_id, user_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        title,
        artist || '',
        parseInt(target_bpm, 10),
        time_signature || '4/4',
        chords || '',
        notes || '',
        userId,
        userName
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create song', details: err.message });
  }
});

// DELETE song (Only author can delete; protects global demo songs)
app.delete('/api/songs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = getUserProfile(req);

    const check = await pool.query('SELECT user_id FROM songs WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Song not found' });
    }
    if (check.rows[0].user_id === 'global') {
      return res.status(403).json({ error: 'Default system tracks cannot be deleted' });
    }
    if (check.rows[0].user_id !== userId && userId !== 'admin') {
      return res.status(403).json({ error: 'You can only delete tracks created by your profile' });
    }

    const result = await pool.query('DELETE FROM songs WHERE id = $1 RETURNING id', [id]);
    res.json({ message: 'Song deleted successfully', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete song', details: err.message });
  }
});

// 3. Practice Logs API
// GET practice logs (Filtered by user)
app.get('/api/practice-logs', async (req, res) => {
  try {
    const { userId } = getUserProfile(req);
    const result = await pool.query(
      `SELECT p.*, s.artist, s.time_signature
       FROM practice_logs p
       LEFT JOIN songs s ON p.song_id = s.id
       WHERE p.user_id = $1
       ORDER BY p.practiced_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch practice logs', details: err.message });
  }
});

// POST create practice log
app.post('/api/practice-logs', async (req, res) => {
  try {
    const { song_id, song_title, bpm_practiced, duration_minutes, accuracy_rating, notes } = req.body;
    const { userId, userName } = getUserProfile(req);

    if (!song_title || !bpm_practiced || !duration_minutes) {
      return res.status(400).json({ error: 'song_title, bpm_practiced, and duration_minutes are required' });
    }
    const result = await pool.query(
      `INSERT INTO practice_logs (song_id, song_title, bpm_practiced, duration_minutes, accuracy_rating, notes, user_id, user_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        song_id ? parseInt(song_id, 10) : null,
        song_title,
        parseInt(bpm_practiced, 10),
        parseInt(duration_minutes, 10),
        accuracy_rating ? parseInt(accuracy_rating, 10) : 5,
        notes || '',
        userId,
        userName
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record practice log', details: err.message });
  }
});

// DELETE practice log (Filtered by user)
app.delete('/api/practice-logs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = getUserProfile(req);

    const result = await pool.query(
      'DELETE FROM practice_logs WHERE id = $1 AND (user_id = $2 OR $2 = \'admin\') RETURNING id',
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Practice log not found or unauthorized' });
    }
    res.json({ message: 'Practice log deleted successfully', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete practice log', details: err.message });
  }
});

// 4. Statistics API (Filtered by user)
app.get('/api/stats', async (req, res) => {
  try {
    const { userId } = getUserProfile(req);
    const statsQuery = await pool.query(
      `SELECT 
        COUNT(id) AS total_sessions,
        COALESCE(SUM(duration_minutes), 0) AS total_minutes,
        COALESCE(AVG(bpm_practiced), 0) AS avg_bpm,
        COALESCE(AVG(accuracy_rating), 0) AS avg_rating
      FROM practice_logs
      WHERE user_id = $1`,
      [userId]
    );

    const songCountQuery = await pool.query(
      `SELECT COUNT(id) AS total_songs FROM songs WHERE user_id = $1 OR user_id = 'global'`,
      [userId]
    );
    
    res.json({
      total_songs: parseInt(songCountQuery.rows[0].total_songs, 10),
      total_sessions: parseInt(statsQuery.rows[0].total_sessions, 10),
      total_minutes: parseInt(statsQuery.rows[0].total_minutes, 10),
      avg_bpm: Math.round(parseFloat(statsQuery.rows[0].avg_bpm)),
      avg_rating: parseFloat(statsQuery.rows[0].avg_rating).toFixed(1)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch statistics', details: err.message });
  }
});

// 5. CSV Export Endpoint
app.get('/api/export-logs', async (req, res) => {
  try {
    const { userId, userName } = getUserProfile(req);
    const result = await pool.query(
      `SELECT p.id, p.practiced_at, p.song_title, p.bpm_practiced, p.duration_minutes, p.accuracy_rating, p.notes, p.user_name
       FROM practice_logs p
       WHERE p.user_id = $1
       ORDER BY p.practiced_at DESC`,
      [userId]
    );

    let csvContent = '\uFEFF"Session ID","Date / Time","Song Title","BPM","Duration (Mins)","Rating (1-5)","Musician","Notes"\r\n';
    result.rows.forEach(row => {
      const dateStr = new Date(row.practiced_at).toISOString();
      const cleanTitle = `"${(row.song_title || '').replace(/"/g, '""')}"`;
      const cleanNotes = `"${(row.notes || '').replace(/"/g, '""')}"`;
      const cleanUser = `"${(row.user_name || userName).replace(/"/g, '""')}"`;
      csvContent += `${row.id},"${dateStr}",${cleanTitle},${row.bpm_practiced},${row.duration_minutes},${row.accuracy_rating},${cleanUser},${cleanNotes}\r\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="practice_logs_${userId}.csv"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export practice logs', details: err.message });
  }
});

// Fallback route for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(` 🎵 RiffRig - Alt-Rock Metronome & Practice Workstation`);
  console.log(` 🌐 Port: ${PORT}`);
  console.log(` 🌐 Healthcheck URL: http://localhost:${PORT}/api/health`);
  console.log(`=======================================================`);
  await initDatabase();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server and Database pool');
  await pool.end();
  process.exit(0);
});
