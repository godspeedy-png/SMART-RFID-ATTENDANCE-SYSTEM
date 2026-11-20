try { process.loadEnvFile(); } catch (e) {}
const SCAN_KEY = process.env.SCAN_KEY || '';
const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const { requireAdmin, login, logout, me } = require('./auth');

// These routes work without logging in
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', me);

// ESP32 connection test
app.get('/api/device/ping', (req, res) => {
  res.json({
    success: true,
    message: "UENR Attendance System connected!",
    device: "ESP32"
  });
});

// Everything under /api needs a login, except scans that carry the secret reader key.
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/scan' &&
      SCAN_KEY && req.headers['x-scan-key'] === SCAN_KEY) {
    return next();
  }
  requireAdmin(req, res, next);
});

// Route 1: send back the list of students
app.get('/api/students', (req, res) => {
  const students = db
    .prepare('SELECT pk, name, student_id AS id, uid, course, photo FROM students ORDER BY name')
    .all();
  res.json(students);
});
// Route 2: add a new student
app.post('/api/students', (req, res) => {
  const { name, id, uid, course, photo } = req.body;

  if (!name || !id || !uid) {
    return res.status(400).json({ error: 'name, id and uid are required' });
  }

  try {
    const result = db
      .prepare('INSERT INTO students (name, student_id, uid, course, photo) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), id.trim(), uid.trim().toUpperCase(), course || 'N/A', photo || null);
    res.status(201).json({ pk: Number(result.lastInsertRowid) });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Student ID or RFID UID already exists' });
    }
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Route 3: an RFID card is scanned
app.post('/api/scan', (req, res) => {
  const uid = (req.body.uid || '').trim().toUpperCase();
  const device = req.body.device || 'RFID Reader #1';

  if (!uid) {
    return res.status(400).json({ error: 'uid is required' });
  }

  // Remember that the reader is alive
  db.prepare(`
    INSERT INTO devices (name, status, last_seen)
    VALUES (?, 'online', datetime('now', 'localtime'))
    ON CONFLICT(name) DO UPDATE SET status = 'online', last_seen = datetime('now', 'localtime')
  `).run(device);

  // Who owns this card?
  const student = db.prepare('SELECT pk, name FROM students WHERE uid = ?').get(uid);
  if (!student) {
    return res.status(404).json({ error: 'Unknown card', uid });
  }

  // Does this student already have a record today?
  const existing = db.prepare(`
    SELECT id, status FROM attendance
    WHERE student_pk = ? AND date = date('now', 'localtime')
  `).get(student.pk);

  if (existing && existing.status === 'Present') {
    return res.status(409).json({ error: student.name + ' already marked present today' });
  }

  if (existing) {
    // Was marked Absent earlier, now arrived: switch to Present
    db.prepare(`
      UPDATE attendance SET status = 'Present', time = time('now', 'localtime')
      WHERE id = ?
    `).run(existing.id);
  } else {
    db.prepare(`
      INSERT INTO attendance (student_pk, date, time, status)
      VALUES (?, date('now', 'localtime'), time('now', 'localtime'), 'Present')
    `).run(student.pk);
  }

  res.status(201).json({ ok: true, name: student.name });
});

// Route 4: list attendance records, newest first
app.get('/api/attendance', (req, res) => {
  const records = db.prepare(`
    SELECT a.id, s.name, s.uid, a.date, a.time, a.status
    FROM attendance a
    JOIN students s ON s.pk = a.student_pk
    ORDER BY a.date DESC, a.time DESC
  `).all();
  res.json(records);
});

// Route 5: edit a student
app.put('/api/students/:pk', (req, res) => {
  const { name, id, uid, course, photo } = req.body;

  if (!name || !id || !uid) {
    return res.status(400).json({ error: 'name, id and uid are required' });
  }

  try {
    const result = db
      .prepare('UPDATE students SET name = ?, student_id = ?, uid = ?, course = ?, photo = ? WHERE pk = ?')
      .run(name.trim(), id.trim(), uid.trim().toUpperCase(), course || 'N/A', photo || null, req.params.pk);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Student ID or RFID UID already exists' });
    }
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Route 6: delete a student
app.delete('/api/students/:pk', (req, res) => {
  const result = db.prepare('DELETE FROM students WHERE pk = ?').run(req.params.pk);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Student not found' });
  }
  res.json({ ok: true });
});

// Route 7: numbers for the dashboard
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  const present = db.prepare(`
    SELECT COUNT(*) AS n FROM attendance
    WHERE date = date('now', 'localtime') AND status = 'Present'
  `).get().n;

  res.json({
    total: total,
    present: present,
    absent: Math.max(0, total - present),
    rate: total ? Math.round((present / total) * 100) : 0
  });
});

// Route 8: device status
app.get('/api/devices', (req, res) => {
  const devices = db
    .prepare('SELECT name AS device, status, last_seen AS last FROM devices')
    .all();
  res.json(devices);
});

// Route 9: mark everyone who didn't scan today as Absent
app.post('/api/close-day', (req, res) => {
  const result = db.prepare(`
    INSERT INTO attendance (student_pk, date, time, status)
    SELECT pk, date('now', 'localtime'), time('now', 'localtime'), 'Absent'
    FROM students
    WHERE pk NOT IN (
      SELECT student_pk FROM attendance WHERE date = date('now', 'localtime')
    )
  `).run();

  res.json({ ok: true, markedAbsent: Number(result.changes) });
});

// Route 10: download attendance as a CSV file
app.get('/api/export.csv', (req, res) => {
  const date = req.query.date || '';
  const status = req.query.status || 'all';

  const rows = db.prepare(`
    SELECT s.name, s.student_id, s.uid, s.course, a.date, a.time, a.status
    FROM attendance a
    JOIN students s ON s.pk = a.student_pk
    WHERE (? = '' OR a.date = ?)
      AND (? = 'all' OR a.status = ?)
    ORDER BY a.date DESC, a.time DESC
  `).all(date, date, status, status);

  // Wrap each value in quotes so commas in names don't break the columns.
  // A leading = + - @ is neutralised so Excel never runs it as a formula.
  function cell(value) {
    let text = String(value == null ? '' : value);
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  const lines = [];
  lines.push(['Name', 'Student ID', 'RFID UID', 'Course', 'Date', 'Time', 'Status'].map(cell).join(','));
  rows.forEach(r => {
    lines.push([r.name, r.student_id, r.uid, r.course, r.date, r.time, r.status].map(cell).join(','));
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
  res.send('\uFEFF' + lines.join('\r\n'));
});



app.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000");
  console.log("Ready for ESP32 connections");
});