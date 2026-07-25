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
const slug = s => (s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'd')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

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
const COVERS = [['#12332e','#2f6f63'], ['#3a2c1e','#7a5230'], ['#242a45','#45568a'],
                ['#3a2438','#7d3c98'], ['#402024','#a83a2e'], ['#20323a','#357d8a']];
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

async function renderLibrary(){
  if (cwd && !flat.some(x => x.id === cwd && x.folder)) cwd = null;
  const kids = childrenOf(cwd);
  const folders = kids.filter(x => x.folder);
  const books   = kids.filter(x => !x.folder);

  renderCrumb();
  const grid = $('#bookGrid'); grid.innerHTML = '';
  for (const f of folders) grid.appendChild(folderCard(f));
  for (const b of books)   grid.appendChild(bookCard(b));

  const empty = $('#libEmpty');
  empty.hidden = kids.length > 0;
  empty.innerHTML = catalogError
    ? 'Không đọc được <b>books/library.json</b>. Kiểm tra file trên server rồi tải lại trang.'
    : (cwd ? 'Thư mục trống.' : 'Chưa có sách nào trong <b>books/library.json</b>.');
}

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

function bookCard(b){
  const card = el('div', 'card');
  const pct = bookPctOf(b.id), n = nChCache[b.id], done = readCount(b.id);
  const status = !prog(b.id) ? 'Chưa đọc'
    : (n ? `Đã đọc ${done}/${n} chương` : 'Đang đọc');
  card.innerHTML =
    `<div class="cover" style="${coverStyle(b.title)}">${esc(initials(b.title))}` +
      `<span class="cbar"><i style="width:${pct}%"></i></span></div>` +
    `<h3>${esc(b.title)}</h3>` +
    (b.author ? `<div class="author">${esc(b.author)}</div>` : '') +
    `<div class="cprog">${status}</div>`;
  card.addEventListener('click', () => { location.hash = '#/book/' + encodeURIComponent(b.id); });
  return card;
}

function folderCard(f){
  const card = el('div', 'card folder');
  card.innerHTML =
    `<div class="cover">📁</div>` +
    `<h3>${esc(f.title)}</h3>` +
    `<div class="fcount">${countBooks(f.id)} sách</div>`;
  card.addEventListener('click', () => goFolder(f.id));
  return card;
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

async function loadChapter(i, ratio){
  if (cancelRestore) cancelRestore();
  const ch = await getChapter(R.id, i);
  R.i = i;
  prose().innerHTML = ch ? ch.html : '<p>Không tải được chương này.</p>';
  $('#sheetTitle').textContent = R.meta.toc[i]?.title || R.meta.title;
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

/* ---------- bottom sheet ---------- */
function openSheet(){ document.body.classList.add('sheet-open'); hideHint(); paintRead(); highlightChapter(); }
function closeSheet(){ document.body.classList.remove('sheet-open'); }
function toggleSheet(){ document.body.classList.contains('sheet-open') ? closeSheet() : openSheet(); }

let hintTimer;
function showHint(){ const h = $('#hint'); h.hidden = false; h.classList.remove('hide');
  clearTimeout(hintTimer); hintTimer = setTimeout(hideHint, 3500); }
function hideHint(){ $('#hint').classList.add('hide'); }

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
  });

  // chạm vào trang để mở bottom sheet (chỉ trong trình đọc)
  document.addEventListener('click', e => {
    if (currentView !== 'reader') return;
    if (e.target.closest('#sheet') || e.target.closest('a') || e.target.closest('.chapnav')) return;
    if (e.target.closest('#overlay')) { closeSheet(); return; }
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return;
    toggleSheet();
  });

  document.addEventListener('keydown', e => {
    if (e.target.matches && e.target.matches('input,textarea')) return;
    if (currentView === 'library') {
      if (e.key === 'Escape' && cwd) goFolder(byId(cwd)?.parent || null);
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
   #/book/<id> → trình đọc | #/folder/<id> → thư mục | '' → gốc  */
function lastReadBookId(){
  let best = null, t = -1;
  for (const id in progress){ const p = progress[id]; if (p && p.updatedAt > t){ t = p.updatedAt; best = id; } }
  return best;
}
let booted = false;
function route(){
  const b = location.hash.match(/^#\/book\/(.+)$/);
  if (b) { booted = true; openBook(decodeURIComponent(b[1])); return; }

  const f = location.hash.match(/^#\/folder\/(.+)$/);
  cwd = f ? decodeURIComponent(f[1]) : null;
  // "Đọc tiếp": lần mở app đầu tiên, nhảy thẳng vào cuốn đang đọc dở
  if (!booted) {
    booted = true;
    if (!f) {
      const last = lastReadBookId();
      if (last && byId(last)) { location.hash = '#/book/' + encodeURIComponent(last); return; }
    }
  }
  showView('library'); renderLibrary();
}

/* ---------- init ---------- */
(async function init(){
  applyTheme(); applyFont(); wire();
  const cached = await allCache().catch(() => []);
  for (const m of cached) nChCache[m.id] = m.nCh;       // để thẻ sách hiện "đã đọc x/y" ngay
  await loadCatalog();
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
