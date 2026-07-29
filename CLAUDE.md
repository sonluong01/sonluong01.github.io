# Tủ sách — offline HTML book reader (PWA)

Vanilla JS, **no build step, no dependencies, no package.json**. Files are served
as-is. Never introduce a bundler, framework, or npm dependency.

## Ranh giới: server sở hữu nội dung, app sở hữu tiến độ

Nội dung **và** cấu trúc thư mục do server định nghĩa trong
[books/library.json](books/library.json). App **không** tạo/sửa/xoá sách hay thư
mục — không có nút "thêm sách", không import file, không upload. Việc duy nhất
app ghi lại là **tiến độ đọc** (chương đang đọc, vị trí cuộn, chương đã đọc), lưu
trong `localStorage` của từng máy — và, nếu bật đồng bộ, đẩy lên Supabase.
Tài khoản chỉ để mang tiến độ đọc sang máy khác; nó không mở thêm quyền gì với nội dung.

Nếu có yêu cầu "thêm sách" → sửa `library.json` + đặt một thư mục chương vào
`books/` (xem cấu trúc bên dưới), chứ không thêm UI vào app.

## Run it

```bash
python3 -m http.server 8000     # rồi mở http://localhost:8000
```

Bắt buộc HTTP thật — `file://` làm hỏng `fetch()` catalog, service worker và manifest.

## books/: mỗi cuốn một thư mục, mỗi chương một file

```
books/
  library.json                    ← catalog
  noi-cong-tam-phap/
    toc.json                      ← { "chapters": [ { "title": "…", "file": "001.html" }, … ] }
    001.html … 009.html           ← fragment HTML của từng chương (không <html>/<head>)
```

Thứ tự trong `toc.json` chính là chỉ số chương — **chèn/xoá/đảo chương làm lệch
tiến độ và dấu ✓ đã lưu** (chúng lưu theo chỉ số), sửa nội dung một chương thì không.

```json
{
  "title": "Tủ sách",
  "items": [
    { "id": "noi-cong-tam-phap", "title": "Nội Công Tâm Pháp", "author": "Giang Thanh",
      "dir": "noi-cong-tam-phap", "rev": 3 },
    { "type": "folder", "id": "kiem-hiep", "title": "Kiếm hiệp",
      "items": [ { "id": "tlbb", "title": "Thiên Long Bát Bộ", "dir": "tlbb" } ] }
  ]
}
```

- `dir` — tên thư mục sách trong `books/`. Bắt buộc với sách.
- `id` — **khoá của tiến độ đọc và của URL**. Đổi `id` = mất tiến độ của người đọc.
  Thiếu thì tự suy từ `dir` (sách) hoặc tiêu đề (thư mục).
- `rev` — **bump khi sửa nội dung sách** (toc.json hay file chương), nếu không
  client vẫn dùng bản đã cache. Mặc định 1. Chỉ cần bump `rev`: app fetch nội dung
  với `?v=rev` nên rev mới tự vượt qua cache-first của service worker; `CACHE`
  trong [sw.js](sw.js) chỉ dành cho vỏ app.
- `desc` — giới thiệu sách, hiện ở tab **Giới thiệu** của trang sách. Không bắt buộc;
  xuống dòng bằng `\n`.
- Thư mục lồng nhau tuỳ ý (giới hạn 8 cấp), nhận diện qua `type:"folder"` hoặc có `items`.

## Files

| File | Role |
| --- | --- |
| [index.html](index.html) | Toàn bộ DOM: thư viện, trang sách, trình đọc, bottom sheet. Script inline trong `<head>` áp theme/cỡ chữ trước khi vẽ (chống nháy) — phải khớp với `applyTheme`/`applyFont`. |
| [app.js](app.js) | Catalog → thư viện → trang sách → trình đọc → tiến độ. Hash router. |
| [style.css](style.css) | ~300 KB nhưng **chỉ ~230 dòng cuối là CSS thật** — phía trên là font Nunito nhúng base64. Nhảy qua chúng; đừng bao giờ format lại file. |
| [sw.js](sw.js) | Cache vỏ app. `library.json` đi **network-first** (nếu không sách mới không bao giờ hiện); file chương cache lazily theo URL `?v=rev`. Bump `CACHE` mỗi lần đổi asset vỏ app. |
| [books/](books/) | `library.json` + mỗi cuốn một thư mục (`toc.json` + chương). |
| [config.js](config.js) | `url` + `anonKey` của Supabase. Để trống = app chạy y như cũ, không có đám mây. Commit thoải mái: anon key sinh ra để công khai, RLS mới là thứ bảo vệ dữ liệu. |
| [sync.js](sync.js) | Đăng nhập + đồng bộ tiến độ. Nạp **sau** app.js, dùng chung biến top-level của nó (`LS`, `progress`, `mergeProgress`, `syncRepaint`, `toast`). |
| [supabase/schema.sql](supabase/schema.sql) | Bảng `reading_progress` + RLS. Dán vào SQL Editor. Xem [SETUP-SUPABASE.md](SETUP-SUPABASE.md). |

## Lưu trữ

- **localStorage** — nguồn sự thật duy nhất do app sở hữu:
  - `reader-progress` = `{ [bookId]: { i, ratio, read: [chỉ số chương], resetAt, updatedAt } }`
  - `reader-progress-del` = `{ [bookId]: lúc xoá }` — bia mộ cho đồng bộ. Thiếu nó
    thì lần kéo về sau, cuốn vừa xoá khỏi lịch sử sẽ mọc lại. Tự hết hạn sau 90 ngày.
  - `reader-settings` = `{ theme, fontSize }` — **không** đồng bộ, thuộc về từng máy
  - `reader-cloud` = phiên Supabase `{ access_token, refresh_token, expires_at, user }`
- **IndexedDB chỉ là cache**, xoá lúc nào cũng được:
  - `books` = `{ id, rev, title, author, dir, nCh, toc: [{title, file}] }` — toc.json đã tải
  - `chapters` = `{ key: bookId+'::'+i, bookId, i, title, html }` — chương tải khi cần
    (`fetchChapter()`); mở sách trong trình đọc thì `prefetchBook()` tải nốt phần còn
    lại trong nền để đọc offline được trọn cuốn.
  - Vô hiệu khi `rev` trong catalog khác `rev` đã cache; `pruneCache()` dọn sách đã
    biến khỏi catalog. `DB_VER` = 1.

Chương được đánh dấu **đã đọc** khi cuộn tới ≥90%, khi bấm sang chương sau lúc đã
cuộn quá nửa, hoặc ngay lập tức nếu chương ngắn tới mức không cuộn được (`scrollable()`).

## Conventions that matter

- **Mọi truy cập IndexedDB đi qua `op()`.** Nó resolve khi transaction *complete*,
  và tạo transaction sau khi db promise đã settled. Đừng `await` giữa lúc mở
  transaction và dùng store — transaction sẽ inactive và ghi hỏng im lặng.
- **Điều hướng chỉ bằng hash:** `#/book/<id>` = trang sách (giới thiệu + mục lục),
  `#/read/<id>[/<chương>]` = trình đọc, `#/folder/<id>` = thư mục, `''` = gốc. Đổi
  view bằng cách gán `location.hash` rồi để `route()` lo. Đừng vừa gọi `openBook()`
  vừa set hash ở cùng chỗ — sách sẽ load hai lần.
- **Bấm một cuốn ở thư viện vào trang sách trước, không nhảy thẳng vào đọc.** Chỉ
  mục "▶ Đọc tiếp" trong menu ⋮ và các nút trên trang sách mới đi `#/read/`. Số
  chương trong hash chỉ là lệnh "mở tại đây": `route()` `replaceState` bỏ nó ngay
  sau khi mở, để lần reload sau vẫn theo tiến độ đã lưu.
- **UI toàn tiếng Việt.** Giữ đúng giọng văn hiện có.
- Mọi chuỗi của người dùng/catalog phải qua `esc()` trước khi vào `innerHTML`. HTML
  của chương được chèn thô có chủ đích (nó chính là nội dung sách).
- `cancelRestore()` phải chạy trước khi rời trình đọc — `restoreScroll` còn chuỗi
  timer 2 giây, không huỷ thì nó kéo cả trang thư viện.
- **Đụng tới tiến độ thì đi qua `saveProgress()`**, đừng `LS.set('reader-progress')`
  thẳng: nó là chỗ duy nhất hẹn lịch đẩy lên đám mây. Xoá một cuốn khỏi lịch sử thì
  phải ghi bia mộ `deleted[id]` cùng lúc, không thì đồng bộ hiểu là "chưa từng đọc".
- **Đồng bộ gọi thẳng REST của Supabase bằng `fetch`, cố ý không dùng supabase-js.**
  Thêm `<script>` từ CDN là app chết ngay khi mất mạng — mà đây là app đọc offline.
- Trộn tiến độ (`mergeProgress`): `read` lấy **hợp** hai bên (dấu ✓ không mất vì đồng
  bộ), vị trí đang đọc theo `updatedAt` mới hơn, và cuốn đang mở trong trình đọc luôn
  để máy này thắng — đang đọc dở mà bị nhảy chương là lỗi tệ nhất ở đây.

## Testing

Không có test suite. Kiểm tra tay trên trình duyệt: bấm một cuốn → trang sách (số
chương, mục lục, nút Đọc), vào đọc vài chương, bấm ‹ (phải quay về trang sách chứ
không ra thẳng thư viện), rồi reload
(phải nhảy lại đúng chương + vị trí, dấu ✓ còn nguyên), quay lại thư viện xem
"đã đọc x/y chương", đổi theme/cỡ chữ, rồi ngắt mạng reload để kiểm tra service worker.

Đồng bộ (khi `config.js` đã điền): đăng nhập ở hai trình duyệt khác nhau, đọc vài
chương ở bên A → bên B bấm **Đồng bộ ngay** phải thấy đúng ✓ và đúng vị trí; xoá một
cuốn khỏi lịch sử ở A rồi đồng bộ B (không được mọc lại); ngắt mạng đọc tiếp (nút ☁
chuyển ⚠), nối lại mạng đọc thêm một tí → phải tự đẩy lên trong ~4 giây.
