const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const memory = new Map();
let pool = null;
let storageMode = 'database';

function id() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function validProfileId(value) { return typeof value === 'string' && UUID_RE.test(value); }
function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80); }
function cleanTitle(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160); }
function corsHeaders() { return { 'access-control-allow-origin': CORS_ORIGIN, 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' }; }
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...corsHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function error(res, status, message, code = 'bad_request') { json(res, status, { error: { code, message } }); }
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 10000) reject(new Error('payload_too_large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid_json')); } });
    req.on('error', reject);
  });
}

async function initStorage() {
  if (!process.env.DATABASE_URL) {
    storageMode = 'memory';
    console.warn('DATABASE_URL is not available; running temporary in-memory storage for local development.');
    return;
  }
  pool = mysql.createPool(process.env.DATABASE_URL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id CHAR(36) PRIMARY KEY,
      profile_id CHAR(36) NOT NULL,
      title VARCHAR(160) NOT NULL,
      completed TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      completed_at DATETIME(3) NULL,
      INDEX tasks_profile_idx (profile_id),
      CONSTRAINT tasks_profile_fk FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS achievements (
      id CHAR(36) PRIMARY KEY,
      profile_id CHAR(36) NOT NULL,
      task_id CHAR(36) NOT NULL,
      points INT NOT NULL DEFAULT 10,
      message VARCHAR(255) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX achievements_profile_idx (profile_id),
      INDEX achievements_task_idx (task_id),
      CONSTRAINT achievements_profile_fk FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function memoryProfile(profileId) { return memory.get(profileId) || null; }
function newMemoryProfile(profileId, name) { const profile = { id: profileId, name, createdAt: now(), tasks: [], achievements: [] }; memory.set(profileId, profile); return profile; }
function memoryState(profileId) {
  const profile = memoryProfile(profileId);
  if (!profile) return null;
  const today = new Date().toISOString().slice(0, 10);
  const completedTasks = profile.tasks.filter(task => task.completed).length;
  const todayTasks = profile.tasks.filter(task => task.createdAt.slice(0, 10) === today);
  const todayCompleted = todayTasks.filter(task => task.completed).length;
  const activeDays = new Set(profile.tasks.map(task => (task.completedAt || task.createdAt).slice(0, 10))).size;
  return { profile: { id: profile.id, name: profile.name }, tasks: profile.tasks, achievements: profile.achievements, stats: { totalTasks: profile.tasks.length, completedTasks, completionRate: profile.tasks.length ? Math.round(completedTasks / profile.tasks.length * 100) : 0, points: profile.achievements.reduce((sum, item) => sum + item.points, 0), activeDays, todayTasks: todayTasks.length, todayCompleted }, storageMode };
}

async function state(profileId) {
  if (!validProfileId(profileId)) return null;
  if (!pool) return memoryState(profileId);
  const [profiles] = await pool.query('SELECT id, name FROM profiles WHERE id = ?', [profileId]);
  if (!profiles.length) return null;
  const [tasks] = await pool.query('SELECT id, title, completed, created_at, completed_at FROM tasks WHERE profile_id = ? ORDER BY completed ASC, created_at DESC', [profileId]);
  const [achievements] = await pool.query('SELECT id, task_id, points, message, created_at FROM achievements WHERE profile_id = ? ORDER BY created_at DESC LIMIT 30', [profileId]);
  const [totals] = await pool.query(`SELECT COUNT(*) AS totalTasks, COALESCE(SUM(completed = 1), 0) AS completedTasks, COALESCE(SUM(DATE(created_at) = CURRENT_DATE()), 0) AS todayTasks, COALESCE(SUM(completed = 1 AND DATE(completed_at) = CURRENT_DATE()), 0) AS todayCompleted, COUNT(DISTINCT DATE(COALESCE(completed_at, created_at))) AS activeDays FROM tasks WHERE profile_id = ?`, [profileId]);
  const total = Number(totals[0].totalTasks);
  const completed = Number(totals[0].completedTasks);
  return { profile: profiles[0], tasks: tasks.map(item => ({ id: item.id, title: item.title, completed: Boolean(item.completed), createdAt: item.created_at, completedAt: item.completed_at })), achievements: achievements.map(item => ({ id: item.id, taskId: item.task_id, points: Number(item.points), message: item.message, createdAt: item.created_at })), stats: { totalTasks: total, completedTasks: completed, completionRate: total ? Math.round(completed / total * 100) : 0, points: achievements.reduce((sum, item) => sum + Number(item.points), 0), activeDays: Number(totals[0].activeDays), todayTasks: Number(totals[0].todayTasks), todayCompleted: Number(totals[0].todayCompleted) }, storageMode };
}

async function createOrUpdateProfile(profileId, name) {
  if (!validProfileId(profileId) || !name) return null;
  if (!pool) { const existing = memoryProfile(profileId) || newMemoryProfile(profileId, name); existing.name = name; return memoryState(profileId); }
  await pool.query('INSERT INTO profiles (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [profileId, name]);
  return state(profileId);
}

async function addTask(profileId, title) {
  if (!validProfileId(profileId) || !title) return null;
  if (!pool) { const profile = memoryProfile(profileId); if (!profile) return null; profile.tasks.unshift({ id: id(), title, completed: false, createdAt: now(), completedAt: null }); return memoryState(profileId); }
  await pool.query('INSERT INTO tasks (id, profile_id, title) VALUES (?, ?, ?)', [id(), profileId, title]);
  return state(profileId);
}

async function updateTask(profileId, taskId, completed) {
  if (!validProfileId(profileId) || !validProfileId(taskId)) return null;
  if (!pool) {
    const profile = memoryProfile(profileId); if (!profile) return null;
    const task = profile.tasks.find(item => item.id === taskId); if (!task) return null;
    let reward = null;
    if (completed && !task.completed) {
      task.completed = true; task.completedAt = now();
      if (!profile.achievements.some(item => item.taskId === taskId)) { reward = { id: id(), taskId, points: 10, message: `أكملت: ${task.title}` , createdAt: now() }; profile.achievements.unshift(reward); }
    } else if (!completed) { task.completed = false; task.completedAt = null; }
    return { ...(memoryState(profileId)), reward };
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query('SELECT id, title, completed FROM tasks WHERE id = ? AND profile_id = ? FOR UPDATE', [taskId, profileId]);
    if (!rows.length) { await connection.rollback(); return null; }
    let reward = null;
    if (completed && !rows[0].completed) {
      await connection.query('UPDATE tasks SET completed = 1, completed_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND profile_id = ?', [taskId, profileId]);
      const [earned] = await connection.query('SELECT id FROM achievements WHERE task_id = ? LIMIT 1', [taskId]);
      if (!earned.length) {
        const rewardId = id();
        reward = { id: rewardId, taskId, points: 10, message: `أكملت: ${rows[0].title}`, createdAt: now() };
        await connection.query('INSERT INTO achievements (id, profile_id, task_id, points, message) VALUES (?, ?, ?, ?, ?)', [rewardId, profileId, taskId, reward.points, reward.message]);
      }
    } else if (!completed) {
      await connection.query('UPDATE tasks SET completed = 0, completed_at = NULL WHERE id = ? AND profile_id = ?', [taskId, profileId]);
    }
    await connection.commit();
    return { ...(await state(profileId)), reward };
  } catch (err) { await connection.rollback(); throw err; } finally { connection.release(); }
}

async function deleteTask(profileId, taskId) {
  if (!validProfileId(profileId) || !validProfileId(taskId)) return null;
  if (!pool) { const profile = memoryProfile(profileId); if (!profile) return null; profile.tasks = profile.tasks.filter(item => item.id !== taskId); profile.achievements = profile.achievements.filter(item => item.taskId !== taskId); return memoryState(profileId); }
  await pool.query('DELETE FROM tasks WHERE id = ? AND profile_id = ?', [taskId, profileId]);
  return state(profileId);
}

function staticFile(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return error(res, 404, 'الصفحة غير موجودة', 'not_found');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, storage: storageMode, time: now() });
  if (url.pathname === '/api/state' && req.method === 'GET') { const result = await state(url.searchParams.get('profileId')); return result ? json(res, 200, result) : error(res, 404, 'الملف الشخصي غير موجود', 'profile_not_found'); }
  if (url.pathname === '/api/profile' && req.method === 'POST') { const body = await parseBody(req); const result = await createOrUpdateProfile(body.profileId, cleanName(body.name)); return result ? json(res, 200, result) : error(res, 400, 'أدخل اسمًا صالحًا للمتابعة'); }
  if (url.pathname === '/api/tasks' && req.method === 'POST') { const body = await parseBody(req); const result = await addTask(body.profileId, cleanTitle(body.title)); return result ? json(res, 201, result) : error(res, 400, 'تعذر إضافة المهمة. تحقق من الاسم والنص.'); }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'PATCH') { const body = await parseBody(req); const result = await updateTask(body.profileId, taskMatch[1], body.completed === true); return result ? json(res, 200, result) : error(res, 404, 'المهمة غير موجودة'); }
  if (taskMatch && req.method === 'DELETE') { const result = await deleteTask(url.searchParams.get('profileId'), taskMatch[1]); return result ? json(res, 200, result) : error(res, 404, 'المهمة غير موجودة'); }
  if (req.method === 'GET') return staticFile(req, res, url.pathname);
  return error(res, 405, 'الطريقة غير مدعومة', 'method_not_allowed');
}

initStorage().then(() => {
  const server = http.createServer((req, res) => handler(req, res).catch(err => { console.error(err); error(res, 500, 'حدث خطأ مؤقت في الخادم', 'server_error'); }));
  server.listen(PORT, '0.0.0.0', () => console.log(`Bin Shihab server listening on 0.0.0.0:${PORT} (${storageMode})`));
}).catch(err => { console.error('Storage initialization failed:', err); process.exit(1); });
