const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('attendance.db');

db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    pk         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    student_id TEXT NOT NULL UNIQUE,
    uid        TEXT NOT NULL UNIQUE,
    course     TEXT DEFAULT 'N/A',
    photo      TEXT
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    student_pk INTEGER NOT NULL REFERENCES students(pk) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    time       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'Present',
    UNIQUE (student_pk, date)
  );

  CREATE TABLE IF NOT EXISTS devices (
    name      TEXT PRIMARY KEY,
    status    TEXT NOT NULL DEFAULT 'online',
    last_seen TEXT
  );

  CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY,
    salt     TEXT NOT NULL,
    hash     TEXT NOT NULL
  );
`);

module.exports = db;