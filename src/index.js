/**
 * GIÁO ÁN ĐỊA NGỤC · MÁY CHỦ THÔNG BÁO (Cloudflare Worker + Durable Object, gói miễn phí)
 * -----------------------------------------------------------------------------------------
 * Gửi Web Push tới app đã cài trên màn hình chính (iPhone iOS 16.4+, Android, máy tính).
 *  - Hết giờ nghỉ giữa set: app hẹn giờ, máy chủ gửi đúng lúc (kể cả khi khoá màn hình).
 *  - Nhắc lịch tập, nhắc nhập số đo / sao lưu: lặp lại hằng tuần.
 *  - Dữ liệu mới qua Google Drive: máy HLV / học viên báo cho nhau theo "chủ đề" bí mật.
 * Khoá VAPID tự tạo ở lần chạy đầu và lưu trong Durable Object, không cần cấu hình gì thêm.
 *
 * API (JSON, POST trừ /vapid):
 *   GET  /vapid                         → { publicKey }
 *   POST /sub     { sub, topics, tzOff } đăng ký máy + các chủ đề nhận tin
 *   POST /schedule{ sub, at, title, body, tag }  gửi 1 lần vào thời điểm at (ms)
 *   POST /cancel  { sub, tag }           huỷ lần gửi đang chờ
 *   POST /remind  { sub, rules, tzOff }  nhắc lặp hằng tuần: rules = [{ dow:0-6, hm:'17:30', title, body, tag }]
 *   POST /notify  { topic, title, body, tag, from }  gửi ngay tới mọi máy đăng ký chủ đề (trừ máy gửi)
 *   POST /test    { sub }                gửi thử ngay
 *   /s/*                                 đồng bộ HLV ⇄ học viên (src/sync.js, PA-33)
 */

import { handle, schema } from './sync.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const MAX_SUBS = 3000, MAX_RULES = 20, MAX_TOPICS = 200;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    if (u.pathname === '/' || u.pathname === '') return json({ ok: true, ten: 'Giáo Án Địa Ngục · máy chủ thông báo' });
    const hub = env.HUB.get(env.HUB.idFromName('main'));
    return hub.fetch(req);
  }
};

/* ---------- tiện ích mã hoá ---------- */
const enc = new TextEncoder();
const b64u = buf => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
async function sha(s) { return b64u(await crypto.subtle.digest('SHA-256', enc.encode(s))).slice(0, 32); }
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/* Mã hoá nội dung theo RFC 8291 (aes128gcm) */
export async function encryptPayload(sub, payload) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/* Chữ ký VAPID (JWT ES256) */
async function vapidAuth(endpoint, V) {
  const aud = new URL(endpoint).origin, now = Math.floor(Date.now() / 1000);
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))), c = b64u(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: 'mailto:giaoandianguc@example.com' })));
  const key = await crypto.subtle.importKey('jwk', V.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + c)));
  return `vapid t=${h}.${c}.${b64u(sig)}, k=${V.pub}`;
}

export async function makeVapid() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pub: b64u(await crypto.subtle.exportKey('raw', k.publicKey)), jwk: await crypto.subtle.exportKey('jwk', k.privateKey) };
}

/* thời điểm kế tiếp của lịch nhắc hằng tuần, theo múi giờ của máy (phút lệch so với UTC, như getTimezoneOffset) */
export function nextAt(rule, tzOff, from = Date.now()) {
  const [hh, mm] = String(rule.hm || '0:0').split(':').map(Number), off = -(Number(tzOff) || 0) * 60000;
  const local = new Date(from + off);
  for (let k = 0; k <= 7; k++) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + k, hh || 0, mm || 0));
    if (d.getUTCDay() !== Number(rule.dow)) continue;
    const at = d.getTime() - off; if (at > from + 1000) return at;
  }
  return from + 7 * 864e5;
}

const okSub = s => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const msg = o => JSON.stringify({ title: clip(o.title || 'Giáo Án Địa Ngục', 80), body: clip(o.body, 240), tag: clip(o.tag || 'gadn', 40), url: './' });

export class Hub {
  constructor(state, env) {
    this.state = state; this.st = state.storage; this.env = env; this.sql = state.storage.sql;
    if (this.sql) state.blockConcurrencyWhile(async () => schema(this.sql));
  }

  async vapid() { let V = await this.st.get('vapid'); if (!V) { V = await makeVapid(); await this.st.put('vapid', V); } return V; }

  async send(sub, payload, ttl = 120) {
    const V = await this.vapid(), body = await encryptPayload(sub, payload);
    const r = await fetch(sub.endpoint, { method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: 'high', Authorization: await vapidAuth(sub.endpoint, V) }, body });
    if (r.status === 404 || r.status === 410) { await this.dropSub(sub); return 'gone'; }
    return r.ok ? 'ok' : 'err' + r.status;
  }

  async dropSub(sub) {
    const k = await sha(sub.endpoint); await this.st.delete('sub:' + k); await this.st.delete('rem:' + k);
    const J = await this.st.list({ prefix: 'job:' + k + ':' }); await this.st.delete([...J.keys()]);
  }

  async putJob(id, job) { await this.st.put('job:' + id, job); await this.arm(); }

  async arm() {
    const J = await this.st.list({ prefix: 'job:' }); let min = Infinity;
    for (const j of J.values()) if (j.at < min) min = j.at;
    if (min === Infinity) await this.st.deleteAlarm(); else await this.st.setAlarm(Math.max(Date.now() + 50, min));
  }

  async alarm() {
    const now = Date.now(), J = await this.st.list({ prefix: 'job:' });
    for (const [key, j] of J) {
      if (j.at > now + 500) continue;
      const subRec = await this.st.get('sub:' + j.k);
      if (subRec && now - j.at < 30 * 60000) { try { await this.send(subRec.sub, j.payload, j.rule != null ? 3600 : 120); } catch (e) { /* bỏ qua lần lỗi */ } }
      if (j.rule != null) {
        const R = await this.st.get('rem:' + j.k), rule = R && R.rules[j.rule];
        if (rule && subRec) await this.st.put(key, { ...j, at: nextAt(rule, R.tzOff, now) }); else await this.st.delete(key);
      } else await this.st.delete(key);
    }
    await this.arm();
  }

  /* gửi một thông báo tới mọi máy có nhãn `who` ("hlv" hoặc "hv:<mã>") */
  async notifyWho(who, ev) {
    for (const [, rec] of await this.st.list({ prefix: 'sub:' })) if (rec.who === who) await this.send(rec.sub, msg(ev), 6 * 3600).catch(() => {});
  }

  async saveSub(sub, extra) {
    const k = await sha(sub.endpoint), cur = await this.st.get('sub:' + k);
    if (!cur) { const n = (await this.st.list({ prefix: 'sub:', limit: MAX_SUBS + 1 })).size; if (n >= MAX_SUBS) throw new Error('Máy chủ đã đầy'); }
    await this.st.put('sub:' + k, { ...(cur || {}), sub, at: Date.now(), ...extra }); return k;
  }

  async fetch(req) {
    const u = new URL(req.url), p = u.pathname;
    try {
      if (p.startsWith('/s/')) return await handle({ sql: this.sql, env: this.env, saveSub: (s, e) => this.saveSub(s, e), notify: (w, ev) => this.notifyWho(w, ev) }, req, p, u);
      if (p === '/vapid') return json({ publicKey: (await this.vapid()).pub });
      if (req.method !== 'POST') return json({ ok: false, loi: 'Sai phương thức' }, 405);
      const q = await req.json().catch(() => ({}));
      if (p === '/notify') {
        const topic = clip(q.topic, 64); if (topic.length < 16) return json({ ok: false, loi: 'Chủ đề không hợp lệ' }, 400);
        const from = q.from ? await sha(q.from) : '', S = await this.st.list({ prefix: 'sub:' }); let n = 0;
        for (const [key, rec] of S) if ((rec.topics || []).includes(topic) && key !== 'sub:' + from) { await this.send(rec.sub, msg(q), 6 * 3600).catch(() => {}); n++; }
        return json({ ok: true, n });
      }
      if (!okSub(q.sub)) return json({ ok: false, loi: 'Thiếu đăng ký thông báo' }, 400);
      if (p === '/sub') { const topics = (Array.isArray(q.topics) ? q.topics : []).map(t => clip(t, 64)).filter(t => t.length >= 16).slice(0, MAX_TOPICS); await this.saveSub(q.sub, { topics, tzOff: Number(q.tzOff) || 0 }); return json({ ok: true }); }
      if (p === '/test') { await this.saveSub(q.sub, {}); return json({ ok: true, r: await this.send(q.sub, msg({ title: 'Giáo Án Địa Ngục', body: 'Thông báo đã hoạt động 💪', tag: 'test' })) }); }
      if (p === '/schedule') {
        const k = await this.saveSub(q.sub, {}), at = Number(q.at) || 0; if (at < Date.now() - 5000 || at > Date.now() + 6 * 3600e3) return json({ ok: false, loi: 'Thời điểm không hợp lệ' }, 400);
        await this.putJob(k + ':' + clip(q.tag || 'rest', 40), { k, at, payload: msg(q) }); return json({ ok: true });
      }
      if (p === '/cancel') { const k = await sha(q.sub.endpoint); await this.st.delete('job:' + k + ':' + clip(q.tag || 'rest', 40)); await this.arm(); return json({ ok: true }); }
      if (p === '/remind') {
        const k = await this.saveSub(q.sub, {}), tzOff = Number(q.tzOff) || 0;
        const rules = (Array.isArray(q.rules) ? q.rules : []).slice(0, MAX_RULES).filter(r => r && r.dow >= 0 && r.dow <= 6 && /^\d{1,2}:\d{2}$/.test(r.hm || '')).map(r => ({ dow: +r.dow, hm: r.hm, title: clip(r.title, 80), body: clip(r.body, 240), tag: clip(r.tag || 'remind', 40) }));
        await this.st.put('rem:' + k, { rules, tzOff });
        const old = await this.st.list({ prefix: 'job:' + k + ':r' }); await this.st.delete([...old.keys()]);
        for (let i = 0; i < rules.length; i++) await this.st.put('job:' + k + ':r' + i, { k, at: nextAt(rules[i], tzOff), payload: msg(rules[i]), rule: i });
        await this.arm(); return json({ ok: true, n: rules.length });
      }
      return json({ ok: false, loi: 'Không có đường dẫn này' }, 404);
    } catch (e) { return json({ ok: false, loi: String(e && e.message || e) }, 500); }
  }
}
