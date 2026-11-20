try {
  process.loadEnvFile();
} catch (e) {}

const SCAN_KEY = process.env.SCAN_KEY || '';

const express = require('express');
const db = require('./db');

const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const {
  requireAdmin,
  login,
  logout,
  me
} = require('./auth');

// ==========================================
// PUBLIC AUTHENTICATION ROUTES
// ==========================================

app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', me);

// ==========================================
// ESP32 CONNECTION TEST
// ==========================================

app.get('/api/device/ping', (req, res) => {
  res.json({
    success: true,
    message: 'UENR Attendance System connected!',
    device: 'ESP32'
  });
});

// ==========================================
// API AUTHENTICATION
// ESP32 scans require the device scan key.
// Other API routes require admin login.
// ==========================================

app.use('/api', (req, res, next) => {
  if (
    req.method === 'POST' &&
    req.path === '/scan' &&
    SCAN_KEY &&
    req.headers['x-scan-key'] === SCAN_KEY
  ) {
    return next();
  }

  requireAdmin(req, res, next);
});

// ==========================================
// ROUTE 1: GET ALL STUDENTS
// ==========================================

app.get('/api/students', (req, res) => {
  try {
    const students = db.prepare(`
      SELECT
        pk,
        name,
        student_id AS id,
        uid,
        course,
        photo
      FROM students
      ORDER BY name
    `).all();

    res.json(students);

  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ error: 'Could not retrieve students' });
  }
});

// ==========================================
// ROUTE 2: REGISTER A NEW STUDENT
// ==========================================

app.post('/api/students', (req, res) => {
  const { name, id, uid, course, photo } = req.body;

  if (!name || !id || !uid) {
    return res.status(400).json({
      error: 'Name, student ID and RFID UID are required'
    });
  }

  try {
    const result = db.prepare(`
      INSERT INTO students
      (name, student_id, uid, course, photo)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      id.trim(),
      uid.replace(/[^0-9a-f]/gi, '').toUpperCase(),
      course || 'N/A',
      photo || null
    );

    res.status(201).json({
      ok: true,
      message: 'Student registered successfully',
      pk: Number(result.lastInsertRowid)
    });

  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({
        error: 'Student ID or RFID UID already exists'
      });
    }

    console.error('Register student error:', error);
    res.status(500).json({ error: 'Could not register student' });
  }
});

// ==========================================
// ROUTE 3: ESP32 RFID ATTENDANCE SCAN
// ==========================================

app.post('/api/scan', (req, res) => {
  try {
    // Normalize the RFID UID
    const uid = String(req.body.uid || '')
      .replace(/[^0-9a-f]/gi, '')
      .toUpperCase();

    const device = String(
      req.body.device || 'RFID Reader #1'
    ).trim();

    if (!uid) {
      return res.status(400).json({
        ok: false,
        status: 'error',
        message: 'RFID UID is required'
      });
    }

    // Update device connection information
    db.prepare(`
      INSERT INTO devices (name, status, last_seen)
      VALUES (?, 'online', datetime('now', 'localtime'))
      ON CONFLICT(name) DO UPDATE SET
        status = 'online',
        last_seen = datetime('now', 'localtime')
    `).run(device);

    // Find the student
    const student = db.prepare(`
      SELECT pk, name, student_id, uid
      FROM students
      WHERE UPPER(REPLACE(uid, ' ', '')) = ?
    `).get(uid);

    if (!student) {
      return res.status(404).json({
        ok: false,
        status: 'unknown_card',
        message: 'This RFID card is not registered',
        uid: uid
      });
    }

    // Check today's attendance
    const existing = db.prepare(`
      SELECT id, status
      FROM attendance
      WHERE student_pk = ?
      AND date = date('now', 'localtime')
    `).get(student.pk);

    let scanStatus;

    if (existing && existing.status === 'Present') {

      // Already present: do not create another record
      scanStatus = 'already_present';

    } else if (existing) {

      // Change an earlier Absent record to Present
      db.prepare(`
        UPDATE attendance
        SET status = 'Present',
            time = time('now', 'localtime')
        WHERE id = ?
      `).run(existing.id);

      scanStatus = 'recorded';

    } else {

      // Insert new attendance
      db.prepare(`
        INSERT INTO attendance
        (student_pk, date, time, status)
        VALUES (
          ?,
          date('now', 'localtime'),
          time('now', 'localtime'),
          'Present'
        )
      `).run(student.pk);

      scanStatus = 'recorded';
    }

    // Retrieve the saved attendance
    const attendance = db.prepare(`
      SELECT date, time, status
      FROM attendance
      WHERE student_pk = ?
      AND date = date('now', 'localtime')
    `).get(student.pk);

    // Send complete information to ESP32
    return res.status(200).json({
      ok: true,

      status: scanStatus,

      message: scanStatus === 'recorded'
        ? 'Attendance recorded successfully'
        : 'Student already marked present today',

      student: {
        name: student.name,
        student_id: student.student_id,
        uid: student.uid
      },

      attendance: {
        date: attendance.date,
        time: attendance.time,
        status: attendance.status
      },

      device: device
    });

  } catch (error) {
    console.error('RFID scan error:', error);

    return res.status(500).json({
      ok: false,
      status: 'server_error',
      message: 'Could not process attendance scan'
    });
  }
});

// ==========================================
// ROUTE 4: GET ATTENDANCE RECORDS
// ==========================================

app.get('/api/attendance', (req, res) => {
  try {
    const records = db.prepare(`
      SELECT
        a.id,
        s.name,
        s.student_id,
        s.uid,
        a.date,
        a.time,
        a.status
      FROM attendance a
      JOIN students s ON s.pk = a.student_pk
      ORDER BY a.date DESC, a.time DESC
    `).all();

    res.json(records);

  } catch (error) {
    console.error('Attendance retrieval error:', error);
    res.status(500).json({
      error: 'Could not retrieve attendance records'
    });
  }
});

// ==========================================
// ROUTE 5: EDIT A STUDENT
// ==========================================

app.put('/api/students/:pk', (req, res) => {
  const { name, id, uid, course, photo } = req.body;

  if (!name || !id || !uid) {
    return res.status(400).json({
      error: 'Name, student ID and RFID UID are required'
    });
  }

  try {
    const result = db.prepare(`
      UPDATE students
      SET name = ?,
          student_id = ?,
          uid = ?,
          course = ?,
          photo = ?
      WHERE pk = ?
    `).run(
      name.trim(),
      id.trim(),
      uid.replace(/[^0-9a-f]/gi, '').toUpperCase(),
      course || 'N/A',
      photo || null,
      req.params.pk
    );

    if (result.changes === 0) {
      return res.status(404).json({
        error: 'Student not found'
      });
    }

    res.json({
      ok: true,
      message: 'Student updated successfully'
    });

  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({
        error: 'Student ID or RFID UID already exists'
      });
    }

    console.error('Update student error:', error);
    res.status(500).json({ error: 'Could not update student' });
  }
});

// ==========================================
// ROUTE 6: DELETE A STUDENT
// ==========================================

app.delete('/api/students/:pk', (req, res) => {
  try {
    const result = db.prepare(
      'DELETE FROM students WHERE pk = ?'
    ).run(req.params.pk);

    if (result.changes === 0) {
      return res.status(404).json({
        error: 'Student not found'
      });
    }

    res.json({ ok: true });

  } catch (error) {
    console.error('Delete student error:', error);
    res.status(500).json({
      error: 'Could not delete student'
    });
  }
});

// ==========================================
// ROUTE 7: DASHBOARD STATISTICS
// ==========================================

app.get('/api/stats', (req, res) => {
  try {
    const total = db.prepare(
      'SELECT COUNT(*) AS n FROM students'
    ).get().n;

    const present = db.prepare(`
      SELECT COUNT(*) AS n
      FROM attendance
      WHERE date = date('now', 'localtime')
      AND status = 'Present'
    `).get().n;

    res.json({
      total: total,
      present: present,
      absent: Math.max(0, total - present),
      rate: total
        ? Math.round((present / total) * 100)
        : 0
    });

  } catch (error) {
    console.error('Statistics error:', error);
    res.status(500).json({ error: 'Could not retrieve statistics' });
  }
});

// ==========================================
// ROUTE 8: DEVICE STATUS
// ==========================================

app.get('/api/devices', (req, res) => {
  try {
    const devices = db.prepare(`
      SELECT
        name AS device,
        status,
        last_seen AS last
      FROM devices
    `).all();

    res.json(devices);

  } catch (error) {
    console.error('Device status error:', error);
    res.status(500).json({ error: 'Could not retrieve devices' });
  }
});

// ==========================================
// ROUTE 9: CLOSE DAY AND MARK ABSENT
// ==========================================

app.post('/api/close-day', (req, res) => {
  try {
    const result = db.prepare(`
      INSERT INTO attendance
      (student_pk, date, time, status)
      SELECT
        pk,
        date('now', 'localtime'),
        time('now', 'localtime'),
        'Absent'
      FROM students
      WHERE pk NOT IN (
        SELECT student_pk
        FROM attendance
        WHERE date = date('now', 'localtime')
      )
    `).run();

    res.json({
      ok: true,
      markedAbsent: Number(result.changes)
    });

  } catch (error) {
    console.error('Close day error:', error);
    res.status(500).json({ error: 'Could not close attendance day' });
  }
});

// ==========================================
// ROUTE 10: EXPORT ATTENDANCE TO CSV
// ==========================================

app.get('/api/export.csv', (req, res) => {
  try {
    const date = req.query.date || '';
    const status = req.query.status || 'all';

    const rows = db.prepare(`
      SELECT
        s.name,
        s.student_id,
        s.uid,
        s.course,
        a.date,
        a.time,
        a.status
      FROM attendance a
      JOIN students s ON s.pk = a.student_pk
      WHERE (? = '' OR a.date = ?)
        AND (? = 'all' OR a.status = ?)
      ORDER BY a.date DESC, a.time DESC
    `).all(date, date, status, status);

    function cell(value) {
      let text = String(value == null ? '' : value);

      if (/^[=+\-@]/.test(text)) {
        text = "'" + text;
      }

      return '"' + text.replace(/"/g, '""') + '"';
    }

    const lines = [];

    lines.push([
      'Name',
      'Student ID',
      'RFID UID',
      'Course',
      'Date',
      'Time',
      'Status'
    ].map(cell).join(','));

    rows.forEach(row => {
      lines.push([
        row.name,
        row.student_id,
        row.uid,
        row.course,
        row.date,
        row.time,
        row.status
      ].map(cell).join(','));
    });

    res.setHeader(
      'Content-Type',
      'text/csv; charset=utf-8'
    );

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="attendance.csv"'
    );

    res.send('\uFEFF' + lines.join('\r\n'));

  } catch (error) {
    console.error('CSV export error:', error);
    res.status(500).json({ error: 'Could not export attendance' });
  }
});

// ==========================================
// START SERVER
// ==========================================

app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on port 3000');
  console.log('Ready for ESP32 connections');

  if (!SCAN_KEY) {
    console.warn('WARNING: SCAN_KEY is not configured!');
  }
});
