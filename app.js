/* ===================================================================
   Tủ sách — trình đọc sách/truyện (vanilla JS, no build)

   Nội dung nằm trên server:
     books/library.json  — định nghĩa thư mục + danh sách sách
     books/<file>.html   — nội dung từng cuốn
   App chỉ lo: hiển thị, tách chương (có cache), và LƯU TIẾN ĐỘ ĐỌC.
   =================================================================== */

const CATALOG_URL = 'books/library.json';
const BOOKS_DIR   = 'books/';

/* ---------- IndexedDB: chỉ dùng làm cache chương đã tách ---------- */
const DB_NAME = 'reader', DB_VER = 1;
let dbPromise = null;
function openDB(){
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('books'))    db.createObjectStore('books',    { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chapters')) db.createObjectStore('chapters', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => { dbPromise = null; rej(r.error); };
  });
  return dbPromise;
}
/* Chạy fn(store) trong một transaction, resolve khi transaction commit.
   Transaction được tạo *sau* khi db promise settled nên không bao giờ inactive giữa chừng. */
async function op(name, mode, fn){
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(name, mode);
    const r = fn(t.objectStore(name));
    t.oncomplete = () => res(r ? r.result : undefined);
    t.onerror    = () => rej(t.error);
    t.onabort    = () => rej(t.error);
  });
}
const getCache  = id => op('books', 'readonly',  s => s.get(id));
const allCache  = ()  => op('books', 'readonly',  s => s.getAll());
const putCache  = m  => op('books', 'readwrite', s => s.put(m));
const getChapter = (bookId, i) => op('chapters', 'readonly', s => s.get(bookId + '::' + i));

async function putChapters(bookId, chapters){
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('chapters', 'readwrite');
    const st = t.objectStore('chapters');
    chapters.forEach((c, i) => st.put({ key: bookId + '::' + i, bookId, i, title: c.title, html: c.html }));
    t.oncomplete = () => res();
    t.onerror    = () => rej(t.error);
    t.onabort    = () => rej(t.error);
  });
}
async function dropCache(id){
  await op('books', 'readwrite', s => s.delete(id));
  await op('chapters', 'readwrite', st => {
    const cur = st.openCursor();
    cur.onsuccess = e => { const c = e.target.result;
      if (c){ if (c.value.bookId === id) c.delete(); c.continue(); } };
  });
}

/* ---------- localStorage: settings + tiến độ đọc ---------- */
const LS = {
  get(k, d){ try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
let settings = LS.get('reader-settings', { theme: null, fontSize: 19 });
/* progress[bookId] = { i, ratio, read: [chương đã đọc], updatedAt } */
let progress = LS.get('reader-progress', {});
const saveSettings = () => LS.set('reader-settings', settings);
const saveProgress = () => LS.set('reader-progress', progress);

/* ---------- DOM helpers ---------- */
const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => (s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
/* b\u1ecf d\u1ea5u \u0111\u1ec3 so kh\u1edbp: "ki\u1ebfm hi\u1ec7p" ~ "kiem hiep" */
const norm = s => (s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'd');
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/* ===================================================================
   Catalog: books/library.json
   { "items": [ {id,title,author,file,rev},
                {type:"folder", id, title, items:[...]} ] }
   Làm phẳng thành danh sách có `parent` để render và định tuyến.
   =================================================================== */
let flat = [];            // [{id, title, folder, parent, file?, author?, rev?}]
let catalogError = null;

function flatten(node, parent, out, seen, depth){
  for (const raw of (node.items || [])) {
    const isFolder = raw.type === 'folder' || Array.isArray(raw.items);
    if (!isFolder && !raw.file) { console.warn('Bỏ qua mục thiếu "file":', raw); continue; }
    let id = raw.id || slug(isFolder ? raw.title : raw.file.replace(/\.[^.]+$/, ''));
    while (seen.has(id)) id += '-2';        // id phải duy nhất: nó là khoá của tiến độ + URL
    seen.add(id);
    const item = { id, title: raw.title || id, folder: isFolder, parent: parent || null };
    out.push(item);
    if (isFolder) { if (depth < 8) flatten(raw, id, out, seen, depth + 1); }
    else { item.file = raw.file; item.author = raw.author || ''; item.rev = raw.rev || 1; }
  }
}

async function loadCatalog(){
  try {
    const r = await fetch(CATALOG_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const json = await r.json();
    const out = []; flatten(json, null, out, new Set(), 0);
    flat = out; catalogError = null;
    if (json.title) { document.title = json.title; $('#libTitle').textContent = json.title; }
    pruneCache();
  } catch (e) {
    catalogError = e;
    // Offline / lỗi mạng: dựng tạm thư viện phẳng từ những sách đã mở trước đó
    if (!flat.length) {
      const cached = await allCache().catch(() => []);
      flat = cached.map(m => ({ id: m.id, title: m.title, author: m.author || '', folder: false, parent: null, rev: m.rev }));
    }
  }
}

/* Xoá cache của sách không còn trong catalog */
async function pruneCache(){
  const live = new Set(flat.filter(x => !x.folder).map(x => x.id));
  const cached = await allCache().catch(() => []);
  for (const m of cached) if (!live.has(m.id)) await dropCache(m.id).catch(() => {});
}

const byId       = id => flat.find(x => x.id === id);
const childrenOf = id => flat.filter(x => x.parent === (id || null));
function countBooks(id, depth = 0){
  if (depth > 8) return 0;
  let n = 0;
  for (const it of childrenOf(id)) n += it.folder ? countBooks(it.id, depth + 1) : 1;
  return n;
}
function pathOf(id){
  const path = []; let cur = id, guard = 0;
  while (cur && guard++ < 16){ const f = byId(cur); if (!f) break; path.unshift(f); cur = f.parent; }
  return path;
}

/* ---------- tách chương ---------- */
function splitChapters(html, fallbackTitle){
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  // chọn cấp heading nông nhất xuất hiện ít nhất 2 lần
  let level = null;
  for (const tag of ['h1','h2','h3']) { if (body.querySelectorAll(tag).length >= 2) { level = tag; break; } }
  if (!level) for (const tag of ['h1','h2','h3']) { if (body.querySelectorAll(tag).length === 1) { level = tag; break; } }

  const chapters = [];
  let cur = null;
  const push = t => { cur = { title: t, nodes: [] }; chapters.push(cur); };
  for (const node of Array.from(body.children)) {
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (level && tag === level) {
      push((node.textContent || '').trim() || ('Phần ' + (chapters.length + 1)));
      cur.nodes.push(node);
    } else {
      if (!cur) push('Mở đầu');
      cur.nodes.push(node);
    }
  }
  if (!chapters.length) { push(fallbackTitle || 'Nội dung'); cur.nodes = Array.from(body.children); }
  return chapters.map(c => ({ title: c.title, html: c.nodes.map(n => n.outerHTML).join('\n') }));
}

/* Trả về meta {id, rev, title, author, nCh, toc}; tải + tách + cache nếu cần.
   `rev` trong library.json đổi → cache cũ bị dựng lại. */
async function ensureBook(entry){
  const cached = await getCache(entry.id).catch(() => null);
  if (cached && cached.rev === entry.rev && cached.nCh) return cached;
  const r = await fetch(BOOKS_DIR + entry.file);
  if (!r.ok) throw new Error('Không tải được ' + entry.file + ' (HTTP ' + r.status + ')');
  const chapters = splitChapters(await r.text(), entry.title);
  const meta = { id: entry.id, rev: entry.rev, title: entry.title, author: entry.author,
                 nCh: chapters.length, toc: chapters.map(c => ({ title: c.title })) };
  await putChapters(entry.id, chapters);
  await putCache(meta);
  return meta;
}

/* ---------- theme + font ---------- */
function effTheme(){
  const t = document.documentElement.getAttribute('data-theme');
  return t || (window.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
}
function applyTheme(){
  if (settings.theme) document.documentElement.setAttribute('data-theme', settings.theme);
  else document.documentElement.removeAttribute('data-theme');
  const ic = $('#themeIc'); if (ic) ic.textContent = effTheme() === 'dark' ? '☀️' : '🌙';
  const m = $('#meta-theme'); if (m) m.setAttribute('content', getComputedStyle(document.body).backgroundColor);
}
function toggleTheme(){ settings.theme = effTheme() === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); }
function applyFont(){ document.documentElement.style.setProperty('--fs', settings.fontSize + 'px'); }
function setFont(delta){
  const before = chapterRatio();
  settings.fontSize = Math.max(15, Math.min(28, settings.fontSize + delta));
  saveSettings(); applyFont();
  requestAnimationFrame(() => { window.scrollTo(0, before * docMax()); updateProgress(); });
}

/* ---------- bìa ---------- */
/* tông đất/ấm cho hợp màu accent; chữ trên bìa luôn là màu giấy sáng */
const COVERS = [['#4a2c14','#8a5a2b'], ['#3b2230','#7a3f52'], ['#5a2318','#a8543a'],
                ['#2f3320','#636b34'], ['#402a12','#9c7226'], ['#252831','#4f5867']];
function coverStyle(title){ let h = 0; for (const c of title) h = (h*31 + c.charCodeAt(0)) >>> 0;
  const [a,b] = COVERS[h % COVERS.length]; return `background:linear-gradient(150deg,${a},${b})`; }
function initials(title){
  const words = title.replace(/[—–-].*$/, '').trim().split(/\s+/).filter(Boolean);
  if (words[0] && words[0].length <= 2) return words[0].toUpperCase();
  return words.slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

/* ---------- tiến độ ---------- */
const prog = id => progress[id] || null;
const readCount = id => (prog(id)?.read || []).length;
/* nCh chỉ biết sau lần mở đầu tiên (được cache lại) */
let nChCache = {};
function bookPctOf(id){
  const p = prog(id), n = nChCache[id];
  if (!p || !n) return 0;
  return Math.min(100, Math.round(((p.i + (p.ratio || 0)) / n) * 100));
}

/* ---------- thư viện ---------- */
let cwd = null;
let query = '';           // chuỗi tìm kiếm; '' = duyệt bình thường
let tab = 'history';      // 'history' = sách đang đọc | 'browse' = cây thư mục

/* Tìm trên *toàn bộ* catalog, không phụ thuộc thư mục đang đứng.
   Khớp khi mọi từ khoá đều xuất hiện trong tên sách / tác giả / đường dẫn thư mục. */
function searchBooks(q){
  const toks = norm(q).split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  return flat.filter(x => !x.folder).filter(x => {
    const hay = norm(x.title + ' ' + (x.author || '') + ' ' + folderPath(x).join(' '));
    return toks.every(t => hay.includes(t));
  });
}
const folderPath = b => pathOf(b.parent).map(f => f.title);

/* Sách từng mở, mới đọc nhất lên đầu (bỏ cuốn đã biến khỏi catalog) */
function historyBooks(){
  return Object.keys(progress)
    .map(id => ({ b: byId(id), t: progress[id]?.updatedAt || 0 }))
    .filter(x => x.b && !x.b.folder)
    .sort((a, b) => b.t - a.t)
    .map(x => x.b);
}

async function renderLibrary(){
  const list = $('#bookList'); list.innerHTML = '';
  const empty = $('#libEmpty');
  const q = query.trim();

  if (q) {                                   // tìm kiếm: phủ lên cả hai tab
    $('#tabs').hidden = true; $('#crumb').hidden = true;
    const hits = searchBooks(q);
    const note = $('#searchNote');
    note.hidden = !hits.length;
    note.textContent = hits.length + ' sách khớp “' + q + '”';
    for (const b of hits) list.appendChild(bookRow(b, true));
    empty.hidden = hits.length > 0;
    empty.innerHTML = 'Không tìm thấy sách nào khớp <b>' + esc(q) + '</b>.';
    return;
  }

  $('#searchNote').hidden = true;
  $('#tabs').hidden = false;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));

  if (tab === 'history') {
    $('#crumb').hidden = true;
    const books = historyBooks();
    for (const b of books) list.appendChild(bookRow(b, true));
    empty.hidden = books.length > 0;
    empty.innerHTML = 'Chưa đọc cuốn nào.<br>Mở tab <b>Tủ sách</b> để chọn một cuốn.';
    return;
  }

  if (cwd && !flat.some(x => x.id === cwd && x.folder)) cwd = null;
  const kids = childrenOf(cwd);
  renderCrumb();
  for (const f of kids.filter(x => x.folder))  list.appendChild(folderRow(f));
  for (const b of kids.filter(x => !x.folder)) list.appendChild(bookRow(b));

  empty.hidden = kids.length > 0;
  empty.innerHTML = catalogError
    ? 'Không đọc được <b>books/library.json</b>. Kiểm tra file trên server rồi tải lại trang.'
    : (cwd ? 'Thư mục trống.' : 'Chưa có sách nào trong <b>books/library.json</b>.');
}

function setTab(t){
  if (tab === t) return;
  tab = t;
  // đang đứng trong thư mục mà nhảy sang Lịch sử → trả hash về gốc, route() sẽ vẽ lại
  if (t === 'history' && location.hash) { location.hash = ''; return; }
  renderLibrary();
}

function openSearch(){
  $('#searchBar').hidden = false;
  $('#btnSearch').classList.add('on');
  const inp = $('#searchInput');
  inp.focus(); inp.select();
}
function closeSearch(){
  $('#searchBar').hidden = true;
  $('#btnSearch').classList.remove('on');
  $('#searchInput').value = '';
  const had = query; query = '';
  if (had) renderLibrary();          // đang xem kết quả → trả về thư mục cũ
}
function toggleSearch(){ $('#searchBar').hidden ? openSearch() : closeSearch(); }

function renderCrumb(){
  const crumb = $('#crumb');
  crumb.innerHTML = '';
  if (!cwd) { crumb.hidden = true; return; }
  crumb.hidden = false;
  const path = pathOf(cwd);
  const link = (label, id, here) => {
    const a = el('a', here ? 'here' : null, esc(label));
    if (!here) a.addEventListener('click', () => goFolder(id));
    return a;
  };
  crumb.appendChild(link('Tủ sách', null, false));
  path.forEach((f, i) => {
    crumb.appendChild(el('span', 'sep', '›'));
    crumb.appendChild(link(f.title, f.id, i === path.length - 1));
  });
}

/* Một hàng sách: bìa nhỏ • tên + tiến độ • nút ⋮ */
function bookRow(b, showPath){
  const row = el('div', 'row');
  const pct = bookPctOf(b.id), n = nChCache[b.id], done = readCount(b.id), p = prog(b.id);
  const started = !!p && (p.i > 0 || (p.ratio || 0) > 0.01 || (p.read || []).length > 0);
  const status = !started ? 'Chưa đọc' : (n ? `Đã đọc ${done}/${n}` : 'Đang đọc');
  const path = showPath ? folderPath(b) : [];
  row.innerHTML =
    `<div class="thumb" style="${coverStyle(b.title)}">${esc(initials(b.title))}` +
      `<span class="cbar"><i style="width:${pct}%"></i></span></div>` +
    `<div class="rmain">` +
      `<h3>${esc(b.title)}</h3>` +
      (b.author ? `<div class="rmuted">${esc(b.author)}</div>` : '') +
      (path.length ? `<div class="rmuted">📁 ${esc(path.join(' › '))}</div>` : '') +
      `<div class="rsub">${status}</div>` +
    `</div>` +
    `<button class="rmenu" aria-label="Tuỳ chọn">⋮</button>`;
  row.addEventListener('click', e => {
    if (e.target.closest('.rmenu')) bookMenu(b);
    else location.hash = '#/book/' + encodeURIComponent(b.id);
  });
  return row;
}

function folderRow(f){
  const row = el('div', 'row folder');
  row.innerHTML =
    `<div class="thumb">📁</div>` +
    `<div class="rmain"><h3>${esc(f.title)}</h3>` +
      `<div class="rsub">${countBooks(f.id)} sách</div></div>` +
    `<span class="rchev">›</span>`;
  row.addEventListener('click', () => goFolder(f.id));
  return row;
}

/* Menu ⋮ của một cuốn */
function bookMenu(b){
  const has = !!prog(b.id);
  showMenu(b.title, [
    { label: has ? '▶ Đọc tiếp' : '▶ Đọc từ đầu',
      run: () => { location.hash = '#/book/' + encodeURIComponent(b.id); } },
    has && { label: '🗑 Xoá khỏi lịch sử đọc', danger: true, run: () => {
      delete progress[b.id]; saveProgress(); renderLibrary();
      toast('Đã xoá lịch sử của “' + b.title + '”.');
    } }
  ].filter(Boolean));
}

/* Menu ⚙ của thư viện */
function settingsMenu(){
  const n = Object.keys(progress).length;
  showMenu('Cài đặt', [
    { label: effTheme() === 'dark' ? '☀️ Giao diện sáng' : '🌙 Giao diện tối', run: toggleTheme },
    { label: '↻ Tải lại danh sách', run: async () => {
      await loadCatalog(); renderLibrary();
      toast(catalogError ? 'Không tải được danh sách.' : 'Đã cập nhật danh sách sách.');
    } },
    { label: '🗑 Xoá toàn bộ lịch sử đọc' + (n ? ` (${n} cuốn)` : ''), danger: true, run: clearAllProgress }
  ]);
}

/* ---------- menu dạng bottom sheet dùng chung ---------- */
let menuItems = [];
function showMenu(title, items){
  menuItems = items;
  $('#menuTitle').textContent = title;
  const box = $('#menuList'); box.innerHTML = '';
  items.forEach((it, i) => {
    const btn = el('button', it.danger ? 'danger' : null, esc(it.label));
    btn.dataset.mi = i;
    box.appendChild(btn);
  });
  $('#menu').hidden = false;
  requestAnimationFrame(() => document.body.classList.add('menu-open'));
}
let menuHideTimer;
function closeMenu(){
  if (!document.body.classList.contains('menu-open')) return;
  document.body.classList.remove('menu-open');
  clearTimeout(menuHideTimer);
  menuHideTimer = setTimeout(() => { $('#menu').hidden = true; }, 220);
}

function goFolder(id){ location.hash = id ? '#/folder/' + encodeURIComponent(id) : ''; }

/* ---------- trình đọc ---------- */
const R = { id: null, meta: null, i: 0 };
let currentView = 'library';
const prose = () => $('#prose');
const docMax = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
const scrollable = () => document.documentElement.scrollHeight - window.innerHeight > 40;
const chapterRatio = () => Math.min(1, Math.max(0, window.scrollY / docMax()));
function bookPct(){ return Math.min(100, Math.round(((R.i + chapterRatio()) / (R.meta?.nCh || 1)) * 100)); }

function showView(v){
  currentView = v;
  $('#view-library').hidden = v !== 'library';
  $('#view-reader').hidden  = v !== 'reader';
  if (v !== 'reader') {
    if (cancelRestore) cancelRestore();   // nếu không, timer cuộn sẽ kéo cả trang thư viện
    R.id = null; R.meta = null;
    closeSheet();
    window.scrollTo(0, 0);
  }
}

let openToken = 0, shortChTimer;
async function openBook(id){
  const entry = byId(id);
  if (!entry || entry.folder) { location.hash = ''; return; }
  const token = ++openToken;              // đổi sách liên tục: chỉ lần mở cuối cùng được thắng
  if (cancelRestore) cancelRestore();     // dừng timer cuộn của cuốn trước
  R.id = null; R.meta = null;             // tránh scroll handler ghi tiến độ của cuốn cũ
  showView('reader');
  window.scrollTo(0, 0);
  $('#sheetTitle').textContent = entry.title;
  $('#chapterList').innerHTML = '';
  prose().innerHTML = '<p class="loading">Đang tải “' + esc(entry.title) + '”…</p>';
  let meta;
  try { meta = await ensureBook(entry); }
  catch (e) {
    if (token !== openToken) return;
    prose().innerHTML = '<p class="loading">Không tải được sách này.<br><small>' + esc(String(e.message || e)) + '</small></p>';
    return;
  }
  if (token !== openToken) return;
  R.id = id; R.meta = meta;
  nChCache[id] = meta.nCh;
  const p = prog(id) || {};
  buildChapterList();
  await loadChapter(Math.max(0, Math.min(p.i || 0, meta.nCh - 1)), p.ratio || 0);
  showHint();
}

/* "Chương 12: …" — thêm số chương nếu tiêu đề trong sách không có sẵn */
function chapterLabel(i){
  const t = (R.meta.toc[i]?.title || '').trim();
  if (/^(chuong|hoi|phan|quyen|tap|chapter|loi noi dau|mo dau)\b/.test(norm(t))) return t;
  return 'Chương ' + (i + 1) + (t ? ': ' + t : '');
}

async function loadChapter(i, ratio){
  if (cancelRestore) cancelRestore();
  const ch = await getChapter(R.id, i);
  R.i = i;
  resetEdge();
  prose().innerHTML = ch ? ch.html : '<p>Không tải được chương này.</p>';
  const label = chapterLabel(i);
  $('#sheetTitle').textContent = label;
  $('#rTitle').textContent = label;
  $('#prevCh').disabled = i <= 0;
  $('#nextCh').disabled = i >= R.meta.nCh - 1;
  highlightChapter();
  window.scrollTo(0, 0);
  saveNow(ratio > 0 ? ratio : 0);
  if (ratio > 0) restoreScroll(ratio);
  else updateProgress();
  // Chương ngắn tới mức không cuộn được thì coi như đã đọc.
  // Đợi 600ms cho ảnh dàn xong, nếu không chương toàn ảnh sẽ bị đánh dấu oan.
  clearTimeout(shortChTimer);
  shortChTimer = setTimeout(() => { if (R.i === i && !scrollable()) markRead(i); }, 600);
}

/* Đặt lại vị trí cuộn đã lưu cho tới khi trang (kể cả ảnh) ổn định.
   Nhả ngay khi người dùng cuộn để không giành quyền điều khiển. */
let cancelRestore = null;
function restoreScroll(ratio){
  if (cancelRestore) cancelRestore();
  let done = false;
  const timers = [];
  const apply = () => { if (!done) { window.scrollTo(0, ratio * docMax()); updateProgress(); } };
  const stop = () => { done = true;
    timers.forEach(clearTimeout);
    window.removeEventListener('wheel', stop); window.removeEventListener('touchmove', stop);
    window.removeEventListener('keydown', stop); cancelRestore = null; };
  cancelRestore = stop;
  window.addEventListener('wheel', stop, { passive: true, once: true });
  window.addEventListener('touchmove', stop, { passive: true, once: true });
  window.addEventListener('keydown', stop, { once: true });
  apply();
  prose().querySelectorAll('img').forEach(im => {
    if (!im.complete) { im.addEventListener('load', apply, { once: true });
                        im.addEventListener('error', apply, { once: true }); }
  });
  [80, 250, 600, 1200, 2000].forEach(ms =>
    timers.push(setTimeout(() => { apply(); if (ms === 2000) stop(); }, ms)));
}

/* ---------- kéo quá mép để đổi chương ----------
   Ở cuối chương kéo tiếp → chương sau; ở đầu chương kéo xuống → chương trước. */
const OVER = 110;                 // px kéo thêm ở mép mới đổi chương
let ovr = 0, ovrDir = 0, touchY = null, wheelTimer, flipAt = 0;
const atTop    = () => window.scrollY <= 2;
const atBottom = () => docMax() - window.scrollY <= 2;
const canGo = dir => !!R.meta && (dir > 0 ? R.i < R.meta.nCh - 1 : R.i > 0);

function paintEdge(){
  const e = $('#edge');
  if (!ovrDir || ovr < 10) { e.hidden = true; return; }
  const ready = ovr >= OVER;
  e.hidden = false;
  e.className = 'edge ' + (ovrDir > 0 ? 'bottom' : 'top') + (ready ? ' ready' : '');
  e.style.opacity = Math.min(1, 0.4 + (ovr / OVER) * 0.6);
  e.textContent = (ready ? 'Thả ra để sang chương ' : 'Kéo tiếp để sang chương ')
                + (ovrDir > 0 ? 'sau' : 'trước');
}
function resetEdge(){ ovr = 0; ovrDir = 0; paintEdge(); }

/* dy > 0: nội dung chạy lên (đọc tiếp) */
function edgeDrag(dy){
  if (!dy || document.body.classList.contains('sheet-open')) return;
  if (Date.now() - flipAt < 700) return;                 // vừa đổi chương xong, bỏ qua đà
  const dir = dy > 0 ? 1 : -1;
  if (!(dir > 0 ? atBottom() : atTop()) || !canGo(dir)) { if (ovrDir) resetEdge(); return; }
  if (ovrDir !== dir) { ovr = 0; ovrDir = dir; }
  ovr += Math.abs(dy);
  paintEdge();
}
function edgeRelease(){
  const dir = ovrDir, hit = ovr >= OVER;
  resetEdge();
  if (dir && hit) { flipAt = Date.now(); gotoChapter(R.i + dir); }
}

function gotoChapter(i){
  if (!R.meta || i < 0 || i >= R.meta.nCh) return;
  if (i > R.i && chapterRatio() > 0.5) markRead(R.i);   // đi tiếp = coi như đã đọc xong
  loadChapter(i, 0);
}

function buildChapterList(){
  const ul = $('#chapterList'); ul.innerHTML = '';
  R.meta.toc.forEach((c, i) => {
    const li = el('li');
    const a = el('a', null, esc(c.title || ('Chương ' + (i + 1))));
    a.dataset.i = i;
    a.addEventListener('click', () => { gotoChapter(i); closeSheet(); });
    li.appendChild(a); ul.appendChild(li);
  });
  paintRead();
}
function paintRead(){
  const read = new Set(prog(R.id)?.read || []);
  document.querySelectorAll('#chapterList a').forEach(a =>
    a.classList.toggle('read', read.has(+a.dataset.i)));
}
function highlightChapter(){
  document.querySelectorAll('#chapterList a').forEach(a =>
    a.classList.toggle('active', +a.dataset.i === R.i));
  const act = document.querySelector('#chapterList a.active');
  if (act && document.body.classList.contains('sheet-open')) act.scrollIntoView({ block: 'nearest' });
}
function updateProgress(){
  const pct = bookPct();
  $('#sheetPct').textContent = pct + '%';
  $('#rPct').textContent = pct + '%';
  $('#sheetBar').firstElementChild.style.width = pct + '%';
  $('#topbar-progress').firstElementChild.style.width = pct + '%';
  if (chapterRatio() >= 0.9) markRead(R.i);             // cuộn gần hết chương = đã đọc
}

/* ---------- lưu tiến độ ---------- */
let saveTimer;
function saveNow(ratioOverride){
  if (!R.id) return;
  const ratio = (typeof ratioOverride === 'number') ? ratioOverride : chapterRatio();
  const p = progress[R.id] || {};
  progress[R.id] = { i: R.i, ratio, read: p.read || [], updatedAt: Date.now() };
  saveProgress();
}
function scheduleSave(){ clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }

function markRead(i){
  if (!R.id || typeof i !== 'number') return;
  const p = progress[R.id] || (progress[R.id] = { i: R.i, ratio: 0, read: [], updatedAt: Date.now() });
  if (!p.read) p.read = [];
  if (p.read.includes(i)) return;
  p.read.push(i); p.read.sort((a, b) => a - b);
  p.updatedAt = Date.now();
  saveProgress();
  paintRead();
}

/* ---------- xoá lịch sử đọc ----------
   Chỉ đụng tới `reader-progress`. Nội dung sách đã tải (IndexedDB) giữ nguyên
   để vẫn đọc được offline. */
function clearAllProgress(){
  const n = Object.keys(progress).length;
  if (!n) { toast('Chưa có lịch sử đọc nào.'); return; }
  if (!confirm(`Xoá lịch sử đọc của ${n} cuốn?\n\n`
    + 'Vị trí đang đọc và các chương đã đánh dấu ✓ sẽ mất. '
    + 'Sách đã tải về vẫn còn, chỉ là đọc lại từ đầu.')) return;
  progress = {}; saveProgress();
  renderLibrary();
  toast('Đã xoá lịch sử đọc.');
}

/* Xoá tiến độ của riêng cuốn đang mở rồi nhảy về chương đầu */
function resetCurrentBook(){
  if (!R.id || !R.meta) return;
  if (!confirm('Đọc lại “' + R.meta.title + '” từ đầu?\n\n'
    + 'Vị trí đang đọc và các chương đã đánh dấu ✓ của cuốn này sẽ bị xoá.')) return;
  delete progress[R.id]; saveProgress();
  paintRead(); closeSheet();
  loadChapter(0, 0);
  toast('Đã xoá lịch sử đọc của cuốn này.');
}

/* ---------- bottom sheet ---------- */
function openSheet(){ document.body.classList.add('sheet-open'); hideHint(); paintRead(); highlightChapter(); }
function closeSheet(){ document.body.classList.remove('sheet-open'); }
function toggleSheet(){ document.body.classList.contains('sheet-open') ? closeSheet() : openSheet(); }

/* Pill nổi ở đáy màn hình: gợi ý mục lục lúc mở sách, và thông báo ngắn ở thư viện */
let hintTimer;
function showHint(msg, ms){
  const h = $('#hint');
  h.textContent = msg || 'Chạm để mở mục lục · kéo quá cuối trang để sang chương';
  h.hidden = false; h.classList.remove('hide');
  clearTimeout(hintTimer); hintTimer = setTimeout(hideHint, ms || 3500);
}
function hideHint(){ $('#hint').classList.add('hide'); }
const toast = m => showHint(m, 2600);

/* ---------- events ---------- */
function wire(){
  $('#prevCh').addEventListener('click', () => gotoChapter(R.i - 1));
  $('#nextCh').addEventListener('click', () => gotoChapter(R.i + 1));

  $('.actions').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'library') { closeSheet(); location.hash = ''; }
    else if (act === 'theme') toggleTheme();
    else if (act === 'fsup') setFont(1);
    else if (act === 'fsdown') setFont(-1);
    else if (act === 'reset') resetCurrentBook();
  });

  /* thư viện: tab, tìm kiếm, cài đặt, menu ⋮ */
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (b) setTab(b.dataset.tab);
  });
  $('#btnSearch').addEventListener('click', toggleSearch);
  $('#searchClose').addEventListener('click', closeSearch);
  $('#btnSettings').addEventListener('click', settingsMenu);
  $('#menu').addEventListener('click', e => {
    const b = e.target.closest('#menuList button');
    if (b) { const it = menuItems[+b.dataset.mi]; closeMenu(); if (it) it.run(); return; }
    if (e.target.closest('.menu-bg') || e.target.closest('#menuCancel')) closeMenu();
  });
  $('#searchInput').addEventListener('input', e => { query = e.target.value; renderLibrary(); });
  $('#searchInput').addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSearch(); $('#btnSearch').focus(); }
  });

  $('#rBack').addEventListener('click', () => { closeSheet(); location.hash = ''; });
  $('#rMenu').addEventListener('click', openSheet);

  /* kéo quá mép để đổi chương */
  window.addEventListener('touchstart', e => {
    touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (currentView !== 'reader' || touchY == null) return;
    const y = e.touches[0].clientY;
    edgeDrag(touchY - y);                       // vuốt ngón lên = đọc tiếp
    touchY = y;
  }, { passive: true });
  window.addEventListener('touchend', () => { touchY = null; if (currentView === 'reader') edgeRelease(); });
  window.addEventListener('touchcancel', () => { touchY = null; resetEdge(); });
  window.addEventListener('wheel', e => {
    if (currentView !== 'reader') return;
    edgeDrag(e.deltaY * 0.6);                   // chuột/trackpad: nhân nhỏ lại cho khỏi nhạy quá
    if (ovr >= OVER) { edgeRelease(); return; } // lăn chuột không có lúc "thả", đủ ngưỡng là đi
    clearTimeout(wheelTimer); wheelTimer = setTimeout(resetEdge, 600);
  }, { passive: true });

  // chạm vào trang để mở bottom sheet (chỉ trong trình đọc)
  document.addEventListener('click', e => {
    if (currentView !== 'reader') return;
    if (e.target.closest('#sheet') || e.target.closest('#rtop') ||
        e.target.closest('a') || e.target.closest('.chapnav')) return;
    if (e.target.closest('#overlay')) { closeSheet(); return; }
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return;
    toggleSheet();
  });

  document.addEventListener('keydown', e => {
    if (e.target.matches && e.target.matches('input,textarea')) return;
    if (!$('#menu').hidden) { if (e.key === 'Escape') closeMenu(); return; }
    if (currentView === 'library') {
      if (e.key === 'Escape') {
        if (!$('#searchBar').hidden) closeSearch();
        else if (cwd) goFolder(byId(cwd)?.parent || null);
      }
      else if (e.key === '/' && $('#searchBar').hidden) { e.preventDefault(); openSearch(); }
      return;
    }
    if (e.key === 'Escape') closeSheet();
    else if (e.key === 'ArrowRight') gotoChapter(R.i + 1);
    else if (e.key === 'ArrowLeft') gotoChapter(R.i - 1);
  });

  let raf = false;
  window.addEventListener('scroll', () => {
    if (currentView !== 'reader') return;
    if (!raf) { raf = true; requestAnimationFrame(() => { raf = false; updateProgress(); scheduleSave(); }); }
  }, { passive: true });

  window.addEventListener('pagehide', () => saveNow());
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change', applyTheme);
  window.addEventListener('hashchange', route);
}

/* ---------- routing ----------
   #/book/<id> → trình đọc | #/folder/<id> → thư mục | '' → gốc
   Mở app luôn vào thư viện; muốn đọc tiếp thì bấm vào sách ở tab Lịch sử. */
function route(){
  const b = location.hash.match(/^#\/book\/(.+)$/);
  if (b) { openBook(decodeURIComponent(b[1])); return; }

  const f = location.hash.match(/^#\/folder\/(.+)$/);
  cwd = f ? decodeURIComponent(f[1]) : null;
  if (f) tab = 'browse';                  // vào thư mục thì phải đang ở tab Tủ sách
  showView('library'); renderLibrary();
}

/* ---------- init ---------- */
(async function init(){
  applyTheme(); applyFont(); wire();
  tab = Object.keys(progress).length ? 'history' : 'browse';
  const cached = await allCache().catch(() => []);
  for (const m of cached) nChCache[m.id] = m.nCh;       // để thẻ sách hiện "đã đọc x/y" ngay
  await loadCatalog();
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
