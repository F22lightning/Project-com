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

// Auto-initialize Database tables with retry logic
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
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
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
          practiced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Seed initial songs if table is empty
      const songCount = await client.query('SELECT COUNT(*) FROM songs');
      if (parseInt(songCount.rows[0].count, 10) === 0) {
        await client.query(`
          INSERT INTO songs (title, artist, target_bpm, time_signature, chords, notes)
          VALUES 
          ('Canon in D (Rock Version)', 'Johann Pachelbel', 110, '4/4', 'D - A - Bm - F#m - G - D - G - A', 'เน้นการดีด Alternate Picking และการเปลี่ยนคอร์ดให้ตรงจังหวะ 1'),
          ('Hotel California (Acoustic Solo)', 'Eagles', 75, '4/4', 'Bm - F# - A - E - G - D - Em - F#', 'ฝึกฝึกซ้อม Hammer-on และ Pull-off ในช่วงท่อน Solo จังหวะ 75 BPM')
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
      service: 'Music Practice & Metronome Web App',
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
      service: 'Music Practice & Metronome Web App',
      timestamp: new Date().toISOString(),
      database: {
        status: 'disconnected',
        error: err.message
      }
    });
  }
});

// 2. Songs API
// GET all songs
app.get('/api/songs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM songs ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch songs', details: err.message });
  }
});

// GET single song
app.get('/api/songs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM songs WHERE id = $1', [id]);
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
    if (!title || !target_bpm) {
      return res.status(400).json({ error: 'Title and target_bpm are required' });
    }
    const result = await pool.query(
      `INSERT INTO songs (title, artist, target_bpm, time_signature, chords, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, artist || '', parseInt(target_bpm, 10), time_signature || '4/4', chords || '', notes || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create song', details: err.message });
  }
});

// PUT update song
app.put('/api/songs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, artist, target_bpm, time_signature, chords, notes } = req.body;
    const result = await pool.query(
      `UPDATE songs 
       SET title = $1, artist = $2, target_bpm = $3, time_signature = $4, chords = $5, notes = $6
       WHERE id = $7 RETURNING *`,
      [title, artist, parseInt(target_bpm, 10), time_signature, chords, notes, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Song not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update song', details: err.message });
  }
});

// DELETE song
app.delete('/api/songs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM songs WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Song not found' });
    }
    res.json({ message: 'Song deleted successfully', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete song', details: err.message });
  }
});

// 3. Practice Logs API
// GET all practice logs
app.get('/api/practice-logs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, s.artist, s.time_signature
      FROM practice_logs p
      LEFT JOIN songs s ON p.song_id = s.id
      ORDER BY p.practiced_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch practice logs', details: err.message });
  }
});

// POST create practice log
app.post('/api/practice-logs', async (req, res) => {
  try {
    const { song_id, song_title, bpm_practiced, duration_minutes, accuracy_rating, notes } = req.body;
    if (!song_title || !bpm_practiced || !duration_minutes) {
      return res.status(400).json({ error: 'song_title, bpm_practiced, and duration_minutes are required' });
    }
    const result = await pool.query(
      `INSERT INTO practice_logs (song_id, song_title, bpm_practiced, duration_minutes, accuracy_rating, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        song_id ? parseInt(song_id, 10) : null,
        song_title,
        parseInt(bpm_practiced, 10),
        parseInt(duration_minutes, 10),
        accuracy_rating ? parseInt(accuracy_rating, 10) : 5,
        notes || ''
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record practice log', details: err.message });
  }
});

// DELETE practice log
app.delete('/api/practice-logs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM practice_logs WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Practice log not found' });
    }
    res.json({ message: 'Practice log deleted successfully', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete practice log', details: err.message });
  }
});

// 4. Statistics API
app.get('/api/stats', async (req, res) => {
  try {
    const statsQuery = await pool.query(`
      SELECT 
        COUNT(id) AS total_sessions,
        COALESCE(SUM(duration_minutes), 0) AS total_minutes,
        COALESCE(AVG(bpm_practiced), 0) AS avg_bpm,
        COALESCE(AVG(accuracy_rating), 0) AS avg_rating
      FROM practice_logs
    `);
    const songCountQuery = await pool.query('SELECT COUNT(id) AS total_songs FROM songs');
    
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

// Fallback route for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(` 🎵 Music Practice & Metronome Web App running on port ${PORT}`);
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
