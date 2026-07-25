---
name: docx-to-book
description: >
  Chuyển một file .docx (hoặc .doc, .odt, .rtf, .epub) thành sách HTML cho tủ
  sách offline này — tách chương bằng h2/h3, nhúng ảnh, phục hồi chữ tiếng Việt
  bị hỏng mã hoá, rồi ghi mục vào books/library.json. Dùng skill này bất cứ khi
  nào người dùng đưa một file văn bản và muốn "thêm sách", "convert sang HTML",
  "đọc được trên app", hay chỉ kéo một file .docx vào và nói tên nó — kể cả khi
  họ không nhắc chữ "skill" hay "chuyển đổi". Cũng dùng khi cần sửa lại cấu
  trúc chương của một cuốn sách đã có trong books/.
---

# docx → sách cho tủ sách

Việc này gần như không bao giờ là "chạy pandoc rồi xong". Sách trong tủ này hầu
hết là sách in cũ được đánh máy hoặc quét lại, nên file .docx tới tay ta thường:

- **không có heading thật** — tên chương chỉ là đoạn văn in đậm, còn Heading 1/2
  của Word thì rỗng hoặc đặt bừa;
- **thụt lề tràn lan**, mà pandoc dịch thành `<blockquote>`, và CSS của app
  render blockquote thành chữ nghiêng màu mờ — nguyên cuốn sách hoá thành lời
  trích dẫn;
- **mất ký tự** — bản đánh máy đi qua một vòng mã hoá 8-bit rồi trở về Unicode,
  làm rụng sạch dải CP1252 (`à á â ã ê í ó ô ú ý`, dấu `…`, ngoặc kép cong) và
  thay bằng `?`;
- **đứt đoạn giữa chừng** ở chỗ sang trang của sách in.

Nên quy trình là ba bước: **soi → viết plan → dựng**. Plan là một file JSON nói
"block số mấy đóng vai gì". Sửa sách về sau là sửa plan rồi chạy lại, chứ không
ai đi sửa tay file HTML 400 KB.

Cần `pandoc` (`brew install pandoc`) và Python 3. Không thêm phụ thuộc nào vào
app — script chỉ chạy lúc chuyển đổi, app vẫn là vanilla JS không build step.

## Bước 1 — soi file

```bash
python3 .claude/skills/docx-to-book/scripts/inspect_docx.py ~/Downloads/SÁCH.docx
```

Sinh ra `SÁCH-work/` chứa `*-raw.html` (bản pandoc), `*-media/` (ảnh tách rời)
và `*-blocks.txt` — danh sách mọi đoạn văn có đánh số. **Đọc hết blocks.txt**;
đó là toàn bộ cuốn sách ở dạng phẳng và mọi con số trong plan đều trỏ vào đây.
Báo cáo in ra màn hình sẽ chỉ luôn: heading của Word có dùng được không, ảnh nào
ở block nào, những `?` khả nghi, và các đoạn có vẻ bị ngắt.

Mở thư mục ảnh ra **xem tận mắt** — đó là cách duy nhất biết ảnh nào là bìa và
mỗi ảnh ứng với "Hình" số mấy để đặt figcaption.

## Bước 2 — viết plan

Đặt trong `.claude/skills/docx-to-book/plans/<id-sách>.json`. Xem
[plans/bat-doan-cam.json](plans/bat-doan-cam.json) làm mẫu đầy đủ.

| Khoá | Ý nghĩa |
| --- | --- |
| `source` | đường dẫn .docx (tương đối so với file plan). Ghi đè bằng `--source` |
| `output` | file HTML sẽ ghi, thường `../../../../books/<id>.html` |
| `work` | thư mục cache pandoc (mặc định cạnh file docx) |
| `title`, `byline`, `cover`, `cover_caption` | chương đầu làm trang bìa; `cover` là số IMG |
| `chapters` | `{"19": "Chương Thứ Nhất"}` — chèn `<h2>` **trước** block 19 |
| `sections` | như trên nhưng `<h3>` |
| `drop` | block bỏ hẳn: dòng tiêu đề đã hoá thành h2/h3, heading rỗng, ô bảng rỗng |
| `quote` | block render thành `<blockquote>` — câu khẩu quyết, thơ, đề từ |
| `merge` | block `i` dán vào cuối block `i-1` (nối đoạn bị ngắt trang) |
| `captions` | `{"IMG2": "Hình 10 – 11 – 12"}` |
| `drop_images` | `["IMG5"]` — ảnh chèn lót 1×1, ảnh rác |
| `replace` | `[["cũ","mới"]]` thay chuỗi trên mọi block, để vá `?` lẻ tẻ |
| `rewrite` | `{"212": "<strong>…"}` đánh máy lại nguyên block hỏng nặng |
| `note` | đoạn in nghiêng cuối sách, dùng khi bản nguồn thiếu/đứt |

### Chia chương thế nào

`splitChapters()` trong [app.js](../../../app.js) chọn **cấp heading nông nhất
xuất hiện từ 2 lần trở lên**. Cho nên: `h2` = chương, `h3` = mục trong chương.
Đừng dùng `h1`.

Chương là đơn vị lưu tiến độ và là một lần cuộn trên điện thoại, nên cắt theo
cái người ta thực sự đọc một hơi. Sách võ có tám thế thì tám thế là tám chương,
đừng gom cả tám vào một "Chương Thứ Nhì" chỉ vì sách in ghi thế — người đọc
muốn đánh dấu "đã xong Đệ Tam Đoạn Cẩm", không phải "đã đọc 37% chương 3".

### Chữ hỏng

Nếu inspect báo hàng trăm `?`, đối chiếu theo quy luật: chỉ những ký tự thuộc
CP1252 bị rụng, còn `ă đ ơ ư` và mọi chữ có dấu thanh chồng (`ầ ấ ệ ộ ữ`) thì
nguyên vẹn. Nhờ vậy suy ngược khá chắc tay: `ch?n` cạnh `co ch?n xuống` chỉ có
thể là `chân` (không thể là `chăn`, vì `ă` đã sống sót). Khi `?` nuốt luôn dấu
cách — `th?ch?n` = `thì chân` — thì phải đọc cả câu mới ra.

Block hỏng lác đác thì dùng `replace`; hỏng nặng (từ 5 dấu trở lên, inspect có
liệt kê) thì `rewrite` cả block, **giữ nguyên `<em>`/`<strong>` gốc** vì tác giả
dùng nghiêng để phân biệt phần mô tả động tác với phần luận giải.

Đừng đoán bừa cho xong. Chỗ nào không chắc, cứ chọn phương án hợp lý nhất rồi
**báo lại cho người dùng danh sách những chỗ đã suy đoán** để họ soát khi đọc.

### Những gì không được tự tiện làm

Giữ đúng chính tả và giọng văn của bản gốc, kể cả từ cũ và lỗi nhỏ của tác giả
(`chum lại`, `xử dụng`) — đây là sách in lại, không phải bài viết cần biên tập.
Nếu bản nguồn thiếu hình hay đứt ngang, **nói rõ trong `note`**, tuyệt đối không
viết bù phần thiếu.

## Bước 3 — dựng và ghi vào tủ sách

```bash
python3 .claude/skills/docx-to-book/scripts/build_book.py \
        .claude/skills/docx-to-book/plans/<id>.json --source ~/Downloads/SÁCH.docx
```

Script in ra danh sách chương, số chữ, số `?` còn lại, và cảnh báo khi có block
dài nằm trong `drop` — gần như chắc chắn là chép nhầm một con số và mất trắng
một đoạn văn. Soi kỹ mấy cảnh báo đó.

Nếu file .docx đã dọn đi mà `work/` còn thì vẫn dựng lại được từ cache.
`--check` dựng ra rồi so với file đang có, không ghi — dùng để xác nhận plan còn
tái tạo đúng cuốn sách sau khi sửa script.

Rồi thêm mục vào [books/library.json](../../../books/library.json):

```json
{ "id": "<id>", "title": "…", "author": "…", "file": "<id>.html", "rev": 1 }
```

`id` là khoá của tiến độ đọc **và** của URL — đổi `id` là xoá sạch tiến độ của
người đọc. Về sau mỗi lần sửa nội dung file sách phải **tăng `rev`**, không thì
client vẫn dùng bản chương đã tách trong IndexedDB và không thấy gì thay đổi.

Không cần đụng `sw.js`: `library.json` đi network-first, file sách cache lazily.

## Kiểm lại

Chạy `python3 -m http.server 8000` rồi mở sách: mục lục đúng chương chưa, ảnh có
hiện không, chữ nghiêng có đúng chỗ không, cuộn hết chương rồi reload xem có
nhảy lại đúng vị trí. Xem thêm mục Testing trong [CLAUDE.md](../../../CLAUDE.md).
