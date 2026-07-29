/* ===================================================================
   Đồng bộ tiến độ đọc lên Supabase (PostgreSQL) — đăng nhập email + mật khẩu.

   Không thư viện, không build: gọi thẳng REST của Supabase bằng `fetch`.
   (Cố tình *không* nạp supabase-js từ CDN — app này phải chạy được offline,
   một thẻ <script> ngoài origin sẽ hỏng ngay khi mất mạng.)

   Nạp *sau* app.js nên dùng chung được các biến top-level của nó:
   LS, progress, saveProgress, mergeProgress, syncRepaint, toast.
   localStorage vẫn là nguồn sự thật lúc offline; mỗi lần lưu tiến độ chỉ hẹn
   một lần đẩy, còn đăng nhập / mở app thì kéo về + trộn trước rồi mới đẩy.
   =================================================================== */
'use strict';

(() => {
  const cfg = window.SUPABASE_CFG || {};
  const API = (cfg.url || '').replace(/\/+$/, '');
  const configured = !!(API && cfg.anonKey);
  const PATH = '/rest/v1/reading_progress';
  const COLS = 'book_id,chapter,ratio,read_chapters,reset_at,updated_at';

  const $ = s => document.querySelector(s);

  /* ---------- phiên đăng nhập ---------- */
  /* sess = { access_token, refresh_token, expires_at, user:{id,email} } */
  let sess = LS.get('reader-cloud', null);
  const saveSess = () => sess ? LS.set('reader-cloud', sess) : localStorage.removeItem('reader-cloud');

  let state = !configured ? 'off' : (sess ? 'idle' : 'out');
  let note = '';                       // dòng chữ phụ dưới modal
  let pulled = false;                  // đã kéo về lần nào trong phiên chạy này chưa
  let lastSync = 0;

  const LABEL = {
    off:     'Chưa bật đồng bộ đám mây.',
    out:     'Chưa đăng nhập — tiến độ chỉ lưu trên máy này.',
    idle:    'Đã đăng nhập.',
    syncing: 'Đang đồng bộ…',
    ok:      'Đã đồng bộ ✓',
    error:   'Lỗi đồng bộ — sẽ thử lại ở lần lưu sau.',
  };

  function setState(s, msg){
    state = s; note = msg || '';
    const btn = $('#cloudBtn');
    btn.textContent = s === 'syncing' ? '⟳' : s === 'error' ? '⚠' : '☁';
    btn.classList.toggle('on', s === 'ok');
    btn.classList.toggle('err', s === 'error');
    btn.title = LABEL[s] + (note ? ' ' + note : '');
    $('#accStatus').textContent = LABEL[s] + (note ? ' ' + note : '');
  }

  /* ---------- modal ---------- */
  function paintModal(){
    $('#accOff').hidden = configured;
    $('#accOut').hidden = !configured || !!sess;
    $('#accIn').hidden  = !configured || !sess;
    $('#accSignUp').hidden = !cfg.allowSignup;
    if (sess) $('#accWho').textContent = 'Đang đăng nhập: ' + (sess.user?.email || '');
    setState(state, note);
  }
  function openAcc(){
    paintModal();
    $('#acc').hidden = false;
    requestAnimationFrame(() => document.body.classList.add('acc-open'));
  }
  let hideTimer;
  function closeAcc(){
    if (!document.body.classList.contains('acc-open')) return;
    document.body.classList.remove('acc-open');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { $('#acc').hidden = true; }, 220);
  }

  $('#cloudBtn').addEventListener('click', openAcc);
  $('#acc').addEventListener('click', e => {
    if (e.target.closest('.menu-bg') || e.target.closest('#accClose')) { closeAcc(); return; }
    const eye = e.target.closest('.acc-eye');
    if (eye) {
      const inp = $('#' + eye.dataset.eye);
      inp.type = inp.type === 'password' ? 'text' : 'password';
      eye.classList.toggle('on', inp.type === 'text');
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#acc').hidden) closeAcc();
  });

  if (!configured) { window.cloud = { schedule(){}, start(){}, configured: false }; setState('off'); return; }

  /* ---------- gọi API ---------- */
  const head = extra => Object.assign({ apikey: cfg.anonKey, 'Content-Type': 'application/json' }, extra);

  async function body(r){
    const j = await r.json().catch(() => null);
    if (r.ok) return j;
    const m = j && (j.error_description || j.msg || j.message || j.error_code || j.error);
    throw new Error(m || 'HTTP ' + r.status);
  }

  /* Đổi email+mật khẩu (hoặc refresh_token) lấy access token */
  async function grant(type, payload){
    const r = await fetch(API + '/auth/v1/token?grant_type=' + type,
      { method: 'POST', headers: head(), body: JSON.stringify(payload) });
    let j;
    try { j = await body(r); }
    catch (e) {
      // refresh token chết (đổi mật khẩu, quá hạn) → coi như đăng xuất, đừng thử lại mãi
      if (type === 'refresh_token') { sess = null; saveSess(); pulled = false; setState('out'); paintModal(); }
      throw e;
    }
    sess = { access_token: j.access_token, refresh_token: j.refresh_token,
             expires_at: Date.now() + (j.expires_in || 3600) * 1000,
             user: { id: j.user?.id, email: j.user?.email } };
    saveSess();
    return sess;
  }

  let refreshing = null;
  async function token(){
    if (!sess) throw new Error('Chưa đăng nhập.');
    if (sess.expires_at - Date.now() > 60e3) return sess.access_token;
    if (!refreshing) refreshing = grant('refresh_token', { refresh_token: sess.refresh_token })
      .finally(() => { refreshing = null; });
    await refreshing;
    return sess.access_token;
  }

  async function rest(path, opts = {}){
    const h = head(Object.assign({ Authorization: 'Bearer ' + await token() }, opts.headers));
    return body(await fetch(API + path, Object.assign({}, opts, { headers: h })));
  }

  /* ---------- kéo về + trộn ---------- */
  async function pull(){
    const rows = await rest(PATH + '?select=' + COLS) || [];
    const remote = {};
    for (const r of rows) remote[r.book_id] = {
      i: r.chapter | 0,
      ratio: +r.ratio || 0,
      read: Array.isArray(r.read_chapters) ? r.read_chapters : [],
      resetAt: Date.parse(r.reset_at) || 0,
      updatedAt: Date.parse(r.updated_at) || 0,
    };
    quiet = true;                       // mergeProgress gọi saveProgress → đừng hẹn đẩy chồng lên
    const changed = mergeProgress(remote);
    quiet = false;
    if (changed) syncRepaint();
    pulled = true;
  }

  /* ---------- đẩy lên ---------- */
  /* PostgREST: `in.("a","b")` — bọc nháy kép để id có dấu/khoảng trắng không vỡ */
  const q = v => encodeURIComponent('"' + String(v).replace(/(["\\])/g, '\\$1') + '"');

  async function push(){
    const rows = Object.keys(progress).map(id => {
      const p = progress[id];
      return { user_id: sess.user.id, book_id: id, chapter: p.i | 0, ratio: +(p.ratio || 0),
               read_chapters: p.read || [],
               reset_at: p.resetAt ? new Date(p.resetAt).toISOString() : null,
               updated_at: new Date(p.updatedAt || Date.now()).toISOString() };
    });
    if (rows.length) await rest(PATH, { method: 'POST', body: JSON.stringify(rows),
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });

    // Xoá trên server những cuốn đã bị xoá khỏi lịch sử ở máy này.
    // Chỉ làm sau khi đã kéo về ít nhất một lần, nếu không máy mới cài sẽ
    // quét sạch lịch sử của các máy kia.
    if (!pulled) return;
    const remote = await rest(PATH + '?select=book_id') || [];
    const live = new Set(Object.keys(progress));
    const gone = remote.map(r => r.book_id).filter(id => !live.has(id));
    if (gone.length) await rest(PATH + '?book_id=in.(' + gone.map(q).join(',') + ')',
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }

  /* ---------- điều phối ---------- */
  let timer = null, running = false, again = false, quiet = false;

  function schedule(){
    if (!sess || quiet) return;
    if (running) { again = true; return; }
    clearTimeout(timer);
    timer = setTimeout(() => sync(false), 4000);
  }

  async function sync(doPull){
    if (!sess) return;
    if (running) { again = true; return; }
    clearTimeout(timer);
    running = true; setState('syncing');
    try {
      if (doPull) await pull();
      await push();
      lastSync = Date.now();
      setState('ok');
    } catch (e) {
      if (sess) setState('error', String(e.message || e));
    }
    running = false;
    if (again) { again = false; schedule(); }
  }

  /* Mở lại tab sau một lúc → kéo về, để đọc dở ở điện thoại là thấy ngay */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !sess || running) return;
    if (Date.now() - lastSync < 60e3) return;
    sync(true);
  });

  /* ---------- đăng nhập / đăng ký / đăng xuất ---------- */
  const creds = () => ({ email: $('#accEmail').value.trim(), password: $('#accPass').value });

  async function signedIn(){
    pulled = false;
    $('#accPass').value = '';
    paintModal();
    toast('Đã đăng nhập ✓');
    closeAcc();
    await sync(true);
  }

  $('#accSignIn').addEventListener('click', async () => {
    const c = creds();
    if (!c.email || !c.password) { setState(state, 'Nhập email và mật khẩu đã.'); return; }
    setState('syncing', 'Đang đăng nhập…');
    try { await grant('password', c); } catch (e) { setState('out', String(e.message || e)); return; }
    await signedIn();
  });

  $('#accSignUp').addEventListener('click', async () => {
    const c = creds();
    if (!c.email || !c.password) { setState(state, 'Nhập email và mật khẩu đã.'); return; }
    setState('syncing', 'Đang tạo tài khoản…');
    let j;
    try {
      j = await body(await fetch(API + '/auth/v1/signup',
        { method: 'POST', headers: head(), body: JSON.stringify(c) }));
    } catch (e) { setState('out', String(e.message || e)); return; }
    if (!j.access_token) {                       // Supabase đang bắt xác nhận email
      setState('out', 'Mở email để xác nhận tài khoản, rồi quay lại đăng nhập.');
      return;
    }
    sess = { access_token: j.access_token, refresh_token: j.refresh_token,
             expires_at: Date.now() + (j.expires_in || 3600) * 1000,
             user: { id: j.user?.id, email: j.user?.email } };
    saveSess();
    await signedIn();
  });

  $('#accSignOut').addEventListener('click', async () => {
    const t = sess?.access_token;
    sess = null; saveSess();
    pulled = false; clearTimeout(timer);
    setState('out'); paintModal();
    toast('Đã đăng xuất. Lịch sử đọc trên máy này vẫn còn.');
    if (t) fetch(API + '/auth/v1/logout', { method: 'POST', headers: head({ Authorization: 'Bearer ' + t }) })
      .catch(() => {});
  });

  $('#accSyncNow').addEventListener('click', () => sync(true));

  window.cloud = {
    configured: true,
    schedule,
    start(){ if (sess) sync(true); else setState('out'); },
  };
  setState(state);
})();
