/**
 * PA-33 · máy chủ đồng bộ (/s/*): HLV, học viên, bản ghi, quyền.
 * Dữ liệu nằm trong SQLite của Durable Object (xem schema). Không WebSocket: máy HLV nhận tin
 * bằng Web Push (ctx.notify) và hỏi /s/doi định kỳ. Thiết kế: docs/epics/2026-10-22.md, hạng mục 4.
 *
 * Xác thực:  Authorization: Bearer h.<khoá HLV>        (băm SHA-256 phải khớp env.HLV_HASH)
 *            Authorization: Bearer v.<mã HV>.<khoá máy> (máy đã nối bằng QR, chưa bị đẩy/thu hồi/khoá)
 *
 * Không có lệnh tạo HLV: chỉ ai giữ QR HLV (khoá trong QR) mới là HLV.
 */

const enc = new TextEncoder();
export const MAX_DEV = 5, MAX_RECS = 200, PAGE = 500, MAX_BUOI = 256 * 1024, MAX_PLAN = 1024 * 1024;
const ID_RE = /^[a-z0-9-]{3,40}$/;

const b64u = buf => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const sha = async s => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rnd = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
const same = (a, b) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
const fail = (s, loi) => json({ ok: false, loi }, s);
const okSub = s => !!s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && !!s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
const one = (sql, q, ...b) => sql.exec(q, ...b).toArray()[0];
const all = (sql, q, ...b) => sql.exec(q, ...b).toArray();

export function schema(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS tv(id TEXT PRIMARY KEY, ten TEXT NOT NULL, kieu TEXT NOT NULL, skh TEXT NOT NULL, khoa INTEGER NOT NULL DEFAULT 0, cuoi INTEGER NOT NULL DEFAULT 0)');
  sql.exec('CREATE TABLE IF NOT EXISTS tb(hv TEXT NOT NULL, dkh TEXT NOT NULL, ten TEXT NOT NULL, cuoi INTEGER NOT NULL, PRIMARY KEY(hv, dkh))');
  sql.exec('CREATE TABLE IF NOT EXISTS rec(hv TEXT NOT NULL, k TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, t INTEGER NOT NULL, vai TEXT NOT NULL, xoa INTEGER NOT NULL DEFAULT 0, d TEXT NOT NULL, PRIMARY KEY(hv, k, id))');
  sql.exec('CREATE INDEX IF NOT EXISTS rec_hv_seq ON rec(hv, seq)');
  sql.exec('CREATE INDEX IF NOT EXISTS rec_seq ON rec(seq)');
  sql.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
}

export function seqNow(sql) { const r = one(sql, "SELECT v FROM meta WHERE k = 'seq'"); return r ? r.v : 0; }
function nextSeq(sql) { const s = seqNow(sql) + 1; sql.exec("INSERT INTO meta(k, v) VALUES('seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", s); return s; }

/* Xác định người gọi từ header Authorization. Trả null nếu sai, máy bị đẩy/thu hồi hoặc học viên bị khoá. */
export async function whoIs(sql, env, h) {
  const m = /^Bearer ([hv])\.(.+)$/.exec(h || ''); if (!m) return null;
  if (m[1] === 'h') return env.HLV_HASH && same(await sha(m[2]), env.HLV_HASH) ? { role: 'h' } : null;
  const parts = m[2].split('.'); if (parts.length !== 2) return null;
  const [hv, dk] = parts;
  const t = one(sql, 'SELECT khoa FROM tv WHERE id = ?', hv); if (!t || t.khoa) return null;
  return one(sql, 'SELECT 1 AS x FROM tb WHERE hv = ? AND dkh = ?', hv, await sha(dk)) ? { role: 'v', hv } : null;
}

/* Tìm học viên theo mã; hồ sơ sao lưu của HLV lưu với tiền tố "sl:" */
const resolve = (sql, id) => {
  const k = String(id || '');
  return one(sql, 'SELECT id, ten, kieu, skh, khoa FROM tv WHERE id = ?', k) || one(sql, 'SELECT id, ten, kieu, skh, khoa FROM tv WHERE id = ?', 'sl:' + k);
};

/* ---------- HLV ---------- */
function listHv(sql) {
  return all(sql, 'SELECT id, ten, kieu, khoa, cuoi FROM tv ORDER BY ten').map(t => ({
    id: t.kieu === 'sl' ? t.id.slice(3) : t.id, ten: t.ten, kieu: t.kieu, khoa: !!t.khoa, cuoi: t.cuoi,
    tb: all(sql, 'SELECT dkh, ten, cuoi FROM tb WHERE hv = ? ORDER BY cuoi, rowid', t.id)
  }));
}

function them(sql, q) {
  const id = String(q.id || ''), sl = q.kieu === 'sl';
  if (!ID_RE.test(id)) return fail(400, 'Mã học viên chỉ gồm chữ thường, số và dấu gạch, 3–40 ký tự');
  const skh = String(q.skh || ''); if (skh.length !== 43) return fail(400, 'Thiếu khoá QR của học viên');
  const key = sl ? 'sl:' + id : id;
  if (one(sql, 'SELECT 1 AS x FROM tv WHERE id = ?', key)) return fail(409, 'Mã này đã có');
  sql.exec('INSERT INTO tv(id, ten, kieu, skh, khoa, cuoi) VALUES(?, ?, ?, ?, 0, ?)', key, clip(q.ten, 60) || 'Người tập', sl ? 'sl' : 'hv', skh, Date.now());
  return json({ ok: true });
}

function doima(sql, q) {
  const t = resolve(sql, q.id); if (!t) return fail(404, 'Không có học viên này');
  const skh = String(q.skh || ''); if (skh.length !== 43) return fail(400, 'Thiếu khoá QR mới');
  sql.exec('UPDATE tv SET skh = ? WHERE id = ?', skh, t.id);
  sql.exec('DELETE FROM tb WHERE hv = ?', t.id);   // đổi mã: thu hồi mọi máy đã nối
  return json({ ok: true });
}

function khoa(sql, q) {
  const t = resolve(sql, q.id); if (!t) return fail(404, 'Không có học viên này');
  sql.exec('UPDATE tv SET khoa = ? WHERE id = ?', q.khoa ? 1 : 0, t.id);
  return json({ ok: true });
}

function xoa(sql, q) {
  const t = resolve(sql, q.id); if (!t) return fail(404, 'Không có học viên này');
  sql.exec('DELETE FROM rec WHERE hv = ?', t.id);
  sql.exec('DELETE FROM tb WHERE hv = ?', t.id);
  sql.exec('DELETE FROM tv WHERE id = ?', t.id);
  return json({ ok: true });
}

function thu(sql, q) {
  const t = resolve(sql, q.id); if (!t) return fail(404, 'Không có học viên này');
  sql.exec('DELETE FROM tb WHERE hv = ? AND dkh = ?', t.id, String(q.dkh || ''));
  return json({ ok: true });
}

/* ---------- Nối máy bằng QR học viên (không cần đăng nhập) ---------- */
async function noi(sql, q) {
  const i = String(q.i || ''), k = String(q.k || '');
  const t = one(sql, "SELECT id, ten, skh, khoa FROM tv WHERE id = ? AND kieu = 'hv'", i);
  if (!t || t.khoa || !same(await sha(k), t.skh)) return fail(403, 'Mã học viên hoặc mã QR không đúng');
  const n = one(sql, 'SELECT COUNT(*) AS n FROM tb WHERE hv = ?', i).n;
  if (n >= MAX_DEV) sql.exec('DELETE FROM tb WHERE hv = ? AND dkh IN (SELECT dkh FROM tb WHERE hv = ? ORDER BY cuoi, rowid LIMIT ?)', i, i, n - MAX_DEV + 1);
  const dk = rnd(32);
  sql.exec('INSERT INTO tb(hv, dkh, ten, cuoi) VALUES(?, ?, ?, ?)', i, await sha(dk), clip(q.tb, 40) || 'Thiết bị', Date.now());
  return json({ ok: true, id: i, ten: t.ten, dk });
}

/* ---------- Bản ghi ---------- */
async function ghi(ctx, q, auth) {
  const { sql } = ctx, H = auth.role === 'h', hv = String(q.hv || '');
  if (!H && hv !== auth.hv) return fail(403, 'Chỉ được ghi dữ liệu của chính mình');
  if (!one(sql, 'SELECT 1 AS x FROM tv WHERE id = ?', hv)) return fail(404, 'Không có học viên này');
  const recs = Array.isArray(q.recs) ? q.recs : [];
  if (recs.length > MAX_RECS) return fail(413, 'Quá nhiều bản ghi trong một lần gửi');

  const rows = [];   // kiểm tra hết trước khi ghi
  for (const r of recs) {
    const k = String(r.k || ''), id = String(r.id || ''), t = Number(r.t), d = String(r.d ?? '');
    if (!id || id.length > 80 || !Number.isFinite(t)) return fail(400, 'Bản ghi không hợp lệ');
    if ((k === 'plan@hlv' && !H) || (k === 'plan@hv' && H)) return fail(403, 'Bản ghi này thuộc phía khác');
    if (!(k === 'plan@hlv' || k === 'plan@hv' || k === 'buoi:' + id)) return fail(400, 'Loại bản ghi không hợp lệ');
    if (d.length > (k.startsWith('plan@') ? MAX_PLAN : MAX_BUOI)) return fail(413, 'Bản ghi quá lớn');
    rows.push({ k, id, t, d, xoa: r.xoa ? 1 : 0 });
  }

  const role = H ? 'hlv' : 'hv', tuChoi = [], acc = [];
  for (const r of rows) {
    const cur = one(sql, 'SELECT k, id, t, d, xoa, vai FROM rec WHERE hv = ? AND k = ? AND id = ?', hv, r.k, r.id);
    if (cur && cur.t > r.t) { tuChoi.push({ k: r.k, id: r.id, cu: cur }); continue; }     // bản cũ hơn: trả bản hiện có để gộp
    if (cur && cur.t === r.t && cur.d === r.d && cur.xoa === r.xoa) continue;             // gửi lại đúng bản đã có
    const seq = nextSeq(sql);
    sql.exec(`INSERT INTO rec(hv, k, id, seq, t, vai, xoa, d) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hv, k, id) DO UPDATE SET seq = excluded.seq, t = excluded.t, vai = excluded.vai, xoa = excluded.xoa, d = excluded.d`,
      hv, r.k, r.id, seq, r.t, role, r.xoa, r.d);
    acc.push(r);
  }

  // Báo đúng một phía, chỉ với bản ghi mới thật; lô lịch sử (backfill) và hồ sơ sao lưu không báo.
  const ev = q.ev && typeof q.ev === 'object' ? q.ev : null;
  if (ev && !q.backfill && !hv.startsWith('sl:')) {
    if (H && acc.some(r => r.k === 'plan@hlv')) await ctx.notify('hv:' + hv, ev);
    if (!H && acc.some(r => r.k.startsWith('buoi:'))) await ctx.notify('hlv', ev);
  }
  return json({ ok: true, seq: seqNow(sql), tuChoi });
}

function doi(ctx, u, auth) {
  const { sql } = ctx, H = auth.role === 'h';
  const hv = u.searchParams.get('hv') || '', since = Number(u.searchParams.get('since')) || 0;
  if (!H && hv !== auth.hv) return fail(403, 'Chỉ được đọc dữ liệu của chính mình');
  let text = 'SELECT hv, k, id, seq, t, vai, xoa, d FROM rec WHERE seq > ?';
  const b = [since];
  if (hv) { text += ' AND hv = ?'; b.push(hv); } else text += " AND hv NOT LIKE 'sl:%'";   // HLV đọc mọi HV, không lẫn hồ sơ sao lưu
  text += ' ORDER BY seq LIMIT ?'; b.push(PAGE + 1);
  const rows = all(sql, text, ...b);
  return json({ ok: true, recs: rows.slice(0, PAGE), seq: seqNow(sql), con: rows.length > PAGE });
}

async function dkSub(ctx, q, auth) {
  if (!okSub(q.sub)) return fail(400, 'Thiếu đăng ký thông báo');
  await ctx.saveSub(q.sub, { who: auth.role === 'h' ? 'hlv' : 'hv:' + auth.hv });
  return json({ ok: true });
}

/* ---------- Điều hướng ---------- */
export async function handle(ctx, req, p, u) {
  const { sql, env } = ctx, m = req.method;
  if (p === '/s/noi' && m === 'POST') return noi(sql, await req.json().catch(() => ({})));

  const auth = await whoIs(sql, env, req.headers.get('Authorization'));
  if (!auth) return fail(401, 'Chưa đăng nhập hoặc máy đã bị thu hồi');
  const key = m + ' ' + p;
  if (key === 'GET /s/tt') return json({ ok: true, seq: seqNow(sql) });
  if (key === 'GET /s/doi') return doi(ctx, u, auth);
  if (key === 'POST /s/ghi') return ghi(ctx, await req.json().catch(() => ({})), auth);
  if (key === 'POST /s/dk') return dkSub(ctx, await req.json().catch(() => ({})), auth);

  if (auth.role !== 'h') return fail(403, 'Chỉ HLV được dùng chức năng này');
  const q = m === 'POST' ? await req.json().catch(() => ({})) : {};
  if (key === 'GET /s/tv') return json({ ok: true, hv: listHv(sql) });
  if (key === 'POST /s/tv/them') return them(sql, q);
  if (key === 'POST /s/tv/doima') return doima(sql, q);
  if (key === 'POST /s/tv/khoa') return khoa(sql, q);
  if (key === 'POST /s/tv/xoa') return xoa(sql, q);
  if (key === 'POST /s/tv/tb/thu') return thu(sql, q);
  return fail(404, 'Không có đường dẫn này');
}
