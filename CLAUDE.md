# Tủ sách — offline HTML book reader (PWA)

Vanilla JS, **no build step, no dependencies, no package.json**. Files are served
as-is. Never introduce a bundler, framework, or npm dependency.

## Ranh giới: server sở hữu nội dung, app sở hữu tiến độ

Nội dung **và** cấu trúc thư mục do server định nghĩa trong
[books/library.json](books/library.json). App **không** tạo/sửa/xoá sách hay thư
mục — không có nút "thêm sách", không import file, không upload. Việc duy nhất
app ghi lại là **tiến độ đọc** (chương đang đọc, vị trí cuộn, chương đã đọc), lưu
trong `localStorage` của từng máy.

Nếu có yêu cầu "thêm sách" → sửa `library.json` + đặt file HTML vào `books/`, chứ
không thêm UI vào app.

## Run it

```bash
python3 -m http.server 8000     # rồi mở http://localhost:8000
```

Bắt buộc HTTP thật — `file://` làm hỏng `fetch()` catalog, service worker và manifest.

## books/library.json

```json
{
  "title": "Tủ sách",
  "items": [
    { "id": "noi-cong-tam-phap", "title": "Nội Công Tâm Pháp", "author": "Giang Thanh",
      "file": "noi-cong-tam-phap.html", "rev": 1 },
    { "type": "folder", "id": "kiem-hiep", "title": "Kiếm hiệp",
      "items": [ { "id": "tlbb", "title": "Thiên Long Bát Bộ", "file": "tlbb.html" } ] }
  ]
}
```

- `file` — đường dẫn tương đối trong `books/`. Bắt buộc với sách.
- `id` — **khoá của tiến độ đọc và của URL**. Đổi `id` = mất tiến độ của người đọc.
  Thiếu thì tự suy từ tên file (sách) hoặc tiêu đề (thư mục).
- `rev` — **bump khi sửa nội dung file sách**, nếu không client vẫn dùng bản chương
  đã tách trong cache. Mặc định 1. Sửa file sách thì phải bump **cả** `rev` **lẫn**
  `CACHE` trong [sw.js](sw.js): `rev` dọn cache chương trong IndexedDB, còn file
  `.html` thì service worker đi cache-first nên không bump `CACHE` là vẫn ăn bản cũ.
- `desc` — giới thiệu sách, hiện ở tab **Giới thiệu** của trang sách. Không bắt buộc;
  xuống dòng bằng `\n`.
- Thư mục lồng nhau tuỳ ý (giới hạn 8 cấp), nhận diện qua `type:"folder"` hoặc có `items`.

## Files

| File | Role |
| --- | --- |
| [index.html](index.html) | Toàn bộ DOM: thư viện, trang sách, trình đọc, bottom sheet. Script inline trong `<head>` áp theme/cỡ chữ trước khi vẽ (chống nháy) — phải khớp với `applyTheme`/`applyFont`. |
| [app.js](app.js) | Catalog → thư viện → trang sách → trình đọc → tiến độ. Hash router. |
| [style.css](style.css) | ~300 KB nhưng **chỉ ~230 dòng cuối là CSS thật** — phía trên là font Nunito nhúng base64. Nhảy qua chúng; đừng bao giờ format lại file. |
| [sw.js](sw.js) | Cache vỏ app. `library.json` đi **network-first** (nếu không sách mới không bao giờ hiện); file sách cache lazily. Bump `CACHE` mỗi lần đổi asset. |
| [books/](books/) | `library.json` + các file `.html` nội dung. |

## Lưu trữ

- **localStorage** — nguồn sự thật duy nhất do app sở hữu:
  - `reader-progress` = `{ [bookId]: { i, ratio, read: [chỉ số chương], updatedAt } }`
  - `reader-settings` = `{ theme, fontSize }`
- **IndexedDB chỉ là cache**, xoá lúc nào cũng được:
  - `books` = `{ id, rev, title, author, nCh, toc }` — kết quả tách chương
  - `chapters` = `{ key: bookId+'::'+i, bookId, i, title, html }`
  - Vô hiệu khi `rev` trong catalog khác `rev` đã cache; `pruneCache()` dọn sách đã
    biến khỏi catalog. `DB_VER` = 1.

Chương được đánh dấu **đã đọc** khi cuộn tới ≥90%, khi bấm sang chương sau lúc đã
cuộn quá nửa, hoặc ngay lập tức nếu chương ngắn tới mức không cuộn được (`scrollable()`).

## Conventions that matter

- **Mọi truy cập IndexedDB đi qua `op()` / `putChapters()`.** Chúng resolve khi
  transaction *complete*, và tạo transaction sau khi db promise đã settled. Đừng
  `await` giữa lúc mở transaction và dùng store — transaction sẽ inactive và ghi
  hỏng im lặng.
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

## Testing

Không có test suite. Kiểm tra tay trên trình duyệt: bấm một cuốn → trang sách (số
chương, mục lục, nút Đọc), vào đọc vài chương, bấm ‹ (phải quay về trang sách chứ
không ra thẳng thư viện), rồi reload
(phải nhảy lại đúng chương + vị trí, dấu ✓ còn nguyên), quay lại thư viện xem
"đã đọc x/y chương", đổi theme/cỡ chữ, rồi ngắt mạng reload để kiểm tra service worker.
