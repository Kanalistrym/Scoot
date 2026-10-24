const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'scootgoal.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) console.warn('WARNING: Set SESSION_SECRET in Render environment variables.');

// Schema and safe migrations for existing local databases.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 password_salt TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS goals (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id INTEGER,
 name TEXT NOT NULL,
 target_amount REAL NOT NULL CHECK(target_amount > 0),
 target_date TEXT,
 icon TEXT DEFAULT '🛴',
 color TEXT DEFAULT '#a78bfa',
 pace_enabled INTEGER NOT NULL DEFAULT 0,
 pace_period TEXT NOT NULL DEFAULT 'daily',
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 goal_id INTEGER NOT NULL,
 amount REAL NOT NULL CHECK(amount > 0),
 type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
 note TEXT DEFAULT '',
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS work_shifts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id INTEGER,
 shift_no INTEGER NOT NULL CHECK(shift_no > 0),
 work_date TEXT NOT NULL,
 rate REAL NOT NULL CHECK(rate > 0),
 hours REAL NOT NULL CHECK(hours > 0),
 note TEXT DEFAULT '',
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);
`);
const cols = table => db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);
if (!cols('goals').includes('owner_id')) db.exec('ALTER TABLE goals ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
if (!cols('goals').includes('pace_enabled')) db.exec("ALTER TABLE goals ADD COLUMN pace_enabled INTEGER NOT NULL DEFAULT 0");
if (!cols('goals').includes('pace_period')) db.exec("ALTER TABLE goals ADD COLUMN pace_period TEXT NOT NULL DEFAULT 'daily'");
if (!cols('work_shifts').includes('owner_id')) db.exec('ALTER TABLE work_shifts ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
// The first registered account adopts legacy local data, if this database had any.

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
function sign(payload) {
 const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
 const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
 return `${body}.${sig}`;
}
function verify(token) {
 try {
  const [body, sig] = String(token || '').split('.'); if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest();
  const actual = Buffer.from(sig, 'base64url'); if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  return data.exp > Date.now() ? data : null;
 } catch { return null; }
}
function setSession(res, user) {
 const value = sign({ uid: user.id, email: user.email, exp: Date.now() + 30*24*60*60*1000 });
 res.cookie('sg_session', value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30*24*60*60*1000, path: '/' });
}
function readSession(req) {
 const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(p=>p.trim()).filter(Boolean).map(p=>{const i=p.indexOf('=');return [p.slice(0,i),decodeURIComponent(p.slice(i+1))]}));
 return verify(cookies.sg_session);
}
function auth(req,res,next) {
 const session = readSession(req);
 if (!session) return res.status(401).json({ error: 'Войди в аккаунт, чтобы продолжить.' });
 const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(session.uid);
 if (!user) return res.status(401).json({ error: 'Аккаунт не найден. Войди снова.' });
 req.user = user; next();
}
function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function safeUser(user) { return { id:user.id, email:user.email }; }
app.get('/api/auth/me', (req,res)=>{ const s=readSession(req); if(!s) return res.json({user:null}); const u=db.prepare('SELECT id,email FROM users WHERE id=?').get(s.uid); res.json({user:u?safeUser(u):null}); });
app.post('/api/auth/register', (req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase(); const password=String(req.body?.password||'');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254) return res.status(400).json({error:'Укажи корректный email.'});
 if(password.length<8 || password.length>200) return res.status(400).json({error:'Пароль должен содержать минимум 8 символов.'});
 if(db.prepare('SELECT id FROM users LIMIT 1').get()) { /* users may register normally */ }
 const salt=crypto.randomBytes(16).toString('hex');
 try {
  const result=db.prepare('INSERT INTO users(email,password_hash,password_salt) VALUES(?,?,?)').run(email,passwordHash(password,salt),salt);
  const user={id:Number(result.lastInsertRowid),email};
  // Preserve a pre-existing personal database by assigning its data to the first new account.
  if(Number(result.lastInsertRowid)===1){db.prepare('UPDATE goals SET owner_id=? WHERE owner_id IS NULL').run(user.id);db.prepare('UPDATE work_shifts SET owner_id=? WHERE owner_id IS NULL').run(user.id);}
  setSession(res,user); res.status(201).json({user:safeUser(user)});
 } catch(e) { if(String(e.code).includes('CONSTRAINT')) return res.status(409).json({error:'Аккаунт с таким email уже существует.'}); throw e; }
});
app.post('/api/auth/login',(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase(), password=String(req.body?.password||'');
 const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
 if(!user || !crypto.timingSafeEqual(Buffer.from(passwordHash(password,user.password_salt),'hex'),Buffer.from(user.password_hash,'hex'))) return res.status(401).json({error:'Неверный email или пароль.'});
 setSession(res,user);res.json({user:safeUser(user)});
});
app.post('/api/auth/logout',(req,res)=>{res.setHeader('Set-Cookie','sg_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'+(process.env.NODE_ENV==='production'?'; Secure':''));res.json({ok:true});});
app.use('/api', (req,res,next)=> req.path.startsWith('/auth/') || req.path==='/auth/me' ? next() : auth(req,res,next));

function getGoalSummary(goal) {
 const transactions=db.prepare('SELECT * FROM transactions WHERE goal_id=? ORDER BY created_at DESC,id DESC').all(goal.id);
 const total=db.prepare("SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) balance FROM transactions WHERE goal_id=?").get(goal.id).balance;
 return {...goal,saved_amount:Math.max(0,Number(total.toFixed(2))),transactions};
}
app.get('/api/goals',(req,res)=>res.json(db.prepare('SELECT * FROM goals WHERE owner_id=? ORDER BY id DESC').all(req.user.id).map(getGoalSummary)));
app.post('/api/goals',(req,res)=>{
 const {name,target_amount,target_date,icon,color,pace_enabled,pace_period}=req.body||{};const amount=Number(target_amount);
 if(!String(name||'').trim()||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Укажи название цели и сумму больше нуля.'});
 const r=db.prepare('INSERT INTO goals(owner_id,name,target_amount,target_date,icon,color,pace_enabled,pace_period) VALUES(?,?,?,?,?,?,?,?)').run(req.user.id,String(name).trim().slice(0,80),amount,target_date||null,String(icon||'🎯').slice(0,8),String(color||'#a78bfa').slice(0,20),pace_enabled?1:0,['daily','weekly','monthly'].includes(pace_period)?pace_period:'daily');
 res.status(201).json(getGoalSummary(db.prepare('SELECT * FROM goals WHERE id=? AND owner_id=?').get(r.lastInsertRowid,req.user.id)));
});
app.patch('/api/goals/:id',(req,res)=>{
 const id=Number(req.params.id),goal=db.prepare('SELECT * FROM goals WHERE id=? AND owner_id=?').get(id,req.user.id);if(!goal)return res.status(404).json({error:'Цель не найдена.'});
 const {name,target_amount,target_date,icon,color,pace_enabled,pace_period}=req.body||{};const amount=target_amount===undefined?goal.target_amount:Number(target_amount);const newName=name===undefined?goal.name:String(name).trim().slice(0,80);
 if(!newName||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Проверь название и сумму цели.'});
 db.prepare('UPDATE goals SET name=?,target_amount=?,target_date=?,icon=?,color=?,pace_enabled=?,pace_period=? WHERE id=? AND owner_id=?').run(newName,amount,target_date===undefined?goal.target_date:(target_date||null),icon===undefined?goal.icon:String(icon).slice(0,8),color===undefined?goal.color:String(color).slice(0,20),pace_enabled===undefined?goal.pace_enabled:(pace_enabled?1:0),pace_period===undefined?goal.pace_period:(['daily','weekly','monthly'].includes(pace_period)?pace_period:'daily'),id,req.user.id);
 res.json(getGoalSummary(db.prepare('SELECT * FROM goals WHERE id=? AND owner_id=?').get(id,req.user.id)));
});
app.delete('/api/goals/:id',(req,res)=>{const r=db.prepare('DELETE FROM goals WHERE id=? AND owner_id=?').run(Number(req.params.id),req.user.id);if(!r.changes)return res.status(404).json({error:'Цель не найдена.'});res.json({ok:true});});
app.post('/api/goals/:id/transactions',(req,res)=>{
 const goalId=Number(req.params.id);if(!db.prepare('SELECT id FROM goals WHERE id=? AND owner_id=?').get(goalId,req.user.id))return res.status(404).json({error:'Цель не найдена.'});
 const {amount,type,note}=req.body||{},value=Number(amount);if(!Number.isFinite(value)||value<=0||!['deposit','withdrawal'].includes(type))return res.status(400).json({error:'Укажи корректную сумму и тип операции.'});
 const current=Number(db.prepare("SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) balance FROM transactions WHERE goal_id=?").get(goalId).balance);if(type==='withdrawal'&&value>current)return res.status(400).json({error:'Нельзя снять больше, чем накоплено.'});
 const r=db.prepare('INSERT INTO transactions(goal_id,amount,type,note) VALUES(?,?,?,?)').run(goalId,value,type,String(note||'').trim().slice(0,200));res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/api/transactions/:id',(req,res)=>{const r=db.prepare('DELETE FROM transactions WHERE id=? AND goal_id IN (SELECT id FROM goals WHERE owner_id=?)').run(Number(req.params.id),req.user.id);if(!r.changes)return res.status(404).json({error:'Операция не найдена.'});res.json({ok:true});});
app.get('/api/earnings',(req,res)=>{const shifts=db.prepare('SELECT * FROM work_shifts WHERE owner_id=? ORDER BY work_date DESC,shift_no DESC,id DESC').all(req.user.id);const totals=db.prepare('SELECT COALESCE(SUM(rate*hours),0) total,COALESCE(SUM(hours),0) hours,COUNT(*) shifts FROM work_shifts WHERE owner_id=?').get(req.user.id);res.json({shifts,totals});});
app.post('/api/earnings',(req,res)=>{const {shift_no,work_date,rate,hours,note}=req.body||{},n=Number(shift_no),r=Number(rate),h=Number(hours);if(!Number.isInteger(n)||n<1||!/^\d{4}-\d{2}-\d{2}$/.test(String(work_date||''))||!Number.isFinite(r)||r<=0||!Number.isFinite(h)||h<=0||h>24)return res.status(400).json({error:'Проверь номер смены, дату, ставку и часы.'});const result=db.prepare('INSERT INTO work_shifts(owner_id,shift_no,work_date,rate,hours,note) VALUES(?,?,?,?,?,?)').run(req.user.id,n,work_date,r,h,String(note||'').trim().slice(0,200));res.status(201).json(db.prepare('SELECT * FROM work_shifts WHERE id=?').get(result.lastInsertRowid));});
app.delete('/api/earnings/:id',(req,res)=>{const r=db.prepare('DELETE FROM work_shifts WHERE id=? AND owner_id=?').run(Number(req.params.id),req.user.id);if(!r.changes)return res.status(404).json({error:'Смена не найдена.'});res.json({ok:true});});
app.get('/api/export',(req,res)=>{const goals=db.prepare('SELECT * FROM goals WHERE owner_id=?').all(req.user.id).map(getGoalSummary);const earnings=db.prepare('SELECT * FROM work_shifts WHERE owner_id=? ORDER BY work_date,shift_no,id').all(req.user.id);res.setHeader('Content-Disposition','attachment; filename="scootgoal-backup.json"');res.json({exported_at:new Date().toISOString(),goals,earnings});});
app.post('/api/import',(req,res)=>{
 const data=req.body;if(!data||!Array.isArray(data.goals)||data.goals.length>100)return res.status(400).json({error:'Файл резервной копии повреждён или имеет неверный формат.'});
 for(const g of data.goals){if(!g||!String(g.name||'').trim()||!Number.isFinite(Number(g.target_amount))||Number(g.target_amount)<=0||!Array.isArray(g.transactions||[]))return res.status(400).json({error:'В резервной копии есть некорректная цель.'});for(const t of g.transactions||[])if(!Number.isFinite(Number(t.amount))||Number(t.amount)<=0||!['deposit','withdrawal'].includes(t.type))return res.status(400).json({error:'В резервной копии есть некорректная операция.'});}
 if(data.earnings!==undefined&&(!Array.isArray(data.earnings)||data.earnings.some(e=>!Number.isInteger(Number(e.shift_no))||Number(e.shift_no)<1||!/^\d{4}-\d{2}-\d{2}$/.test(String(e.work_date||''))||!Number.isFinite(Number(e.rate))||Number(e.rate)<=0||!Number.isFinite(Number(e.hours))||Number(e.hours)<=0||Number(e.hours)>24)))return res.status(400).json({error:'В резервной копии есть некорректная запись о смене.'});
 try{db.transaction(()=>{const old=db.prepare('SELECT id FROM goals WHERE owner_id=?').all(req.user.id);for(const g of old)db.prepare('DELETE FROM transactions WHERE goal_id=?').run(g.id);db.prepare('DELETE FROM goals WHERE owner_id=?').run(req.user.id);db.prepare('DELETE FROM work_shifts WHERE owner_id=?').run(req.user.id);const addGoal=db.prepare('INSERT INTO goals(owner_id,name,target_amount,target_date,icon,color,created_at,pace_enabled,pace_period) VALUES(?,?,?,?,?,?,?,?,?)'),addTx=db.prepare('INSERT INTO transactions(goal_id,amount,type,note,created_at) VALUES(?,?,?,?,?)');for(const g of data.goals){const result=addGoal.run(req.user.id,String(g.name).trim().slice(0,80),Number(g.target_amount),g.target_date||null,String(g.icon||'🎯').slice(0,8),String(g.color||'#a78bfa').slice(0,20),g.created_at||new Date().toISOString(),g.pace_enabled?1:0,['daily','weekly','monthly'].includes(g.pace_period)?g.pace_period:'daily');for(const t of g.transactions||[])addTx.run(result.lastInsertRowid,Number(t.amount),t.type,String(t.note||'').slice(0,200),t.created_at||new Date().toISOString());}const addShift=db.prepare('INSERT INTO work_shifts(owner_id,shift_no,work_date,rate,hours,note,created_at) VALUES(?,?,?,?,?,?,?)');for(const e of data.earnings||[])addShift.run(req.user.id,Number(e.shift_no),e.work_date,Number(e.rate),Number(e.hours),String(e.note||'').slice(0,200),e.created_at||new Date().toISOString());})() ;res.json({ok:true,goals:data.goals.length,shifts:(data.earnings||[]).length});}catch(e){console.error(e);res.status(400).json({error:'Не удалось восстановить резервную копию.'});}
});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`ScootGoal listening on port ${PORT}`));
