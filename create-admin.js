const readline = require('readline');
const crypto = require('crypto');
const db = require('./db');
const { hashPassword } = require('./auth');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Choose a username: ', username => {
  rl.question('Choose a password (at least 8 characters): ', password => {
    username = username.trim();
    if (!username || password.length < 8) {
      console.log('Username is required and the password needs at least 8 characters.');
      rl.close();
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    db.prepare(`
      INSERT INTO admins (username, salt, hash) VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash
    `).run(username, salt, hash);
    console.log('Admin saved: ' + username);
    rl.close();
  });
});