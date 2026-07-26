---
name: docx-to-book
description: >
  Chuyển một file .docx (hoặc .pdf, .doc, .odt, .rtf, .epub) thành sách HTML cho
  tủ sách offline này — tách chương bằng h2/h3, nhúng ảnh, phục hồi chữ tiếng
  Việt bị hỏng mã hoá, rồi ghi mục vào books/library.json. Dùng skill này bất cứ
  khi nào người dùng đưa một file văn bản và muốn "thêm sách", "convert sang
  HTML", "đọc được trên app", hay chỉ kéo một file .docx / .pdf vào và nói tên
  nó — kể cả khi họ không nhắc chữ "skill" hay "chuyển đổi". Cũng dùng khi cần
  sửa lại cấu trúc chương của một cuốn sách đã có trong books/.
---

# docx → sách cho tủ sách

Việc này gần như không bao giờ là "chạy pandoc rồi xong". Nguồn tới tay ta có hai
kiểu, hỏng theo hai cách khác hẳn nhau — soi ra được kiểu nào là biết trước sẽ
phải vật lộn với cái gì.

**Sách in cũ đánh máy hoặc quét lại** (mẫu: [bat-doan-cam](plans/bat-doan-cam.json)):

- **không có heading thật** — tên chương chỉ là đoạn văn in đậm, còn Heading 1/2
  của Word thì rỗng hoặc đặt bừa;
- **thụt lề tràn lan**, mà pandoc dịch thành `<blockquote>`, và CSS của app
  render blockquote thành chữ nghiêng màu mờ — nguyên cuốn sách hoá thành lời
  trích dẫn;
- **mất ký tự** — bản đánh máy đi qua một vòng mã hoá 8-bit rồi trở về Unicode,
  làm rụng sạch dải CP1252 (`à á â ã ê í ó ô ú ý`, dấu `…`, ngoặc kép cong) và
  thay bằng `?`;
- **đứt đoạn giữa chừng** ở chỗ sang trang của sách in.

**Bản chép từ web** (mẫu: [dao-duc-kinh-phan-duc](plans/dao-duc-kinh-phan-duc.json)):
chữ nghĩa thường sạch — không rụng ký tự, không ảnh, không heading bừa. Đổi lại
nó **xuống dòng theo từng dòng in**: mỗi dòng là một `<p>` riêng, để nguyên thì
cả cuốn đọc như thơ vụn. Kèm theo là rụng dấu câu cuối dòng, dính chữ
(`tứcvạn`), và front matter sai (dòng đề mục ghi "tới câu 61" trong khi sách
chạy tới 81).

**Sách in scan ra PDF** (mẫu: [thai-cuc-quyen](plans/thai-cuc-quyen.json)): chữ
lấy ra sạch bong (nếu là PDF text, không phải ảnh), nhưng PDF **không có khái
niệm đoạn văn** — chỉ có dòng đặt ở toạ độ. [pdfbook.py](scripts/pdfbook.py)
dựng lại đoạn từ thụt lề dòng đầu và dòng kết thúc sớm, gom nét vẽ vector thành
hình rồi render ra PNG. Xem mục "PDF" bên dưới cho những gì còn sót lại.

Nên quy trình là ba bước: **soi → viết plan → dựng**. Plan là một file JSON nói
"block số mấy đóng vai gì". Sửa sách về sau là sửa plan rồi chạy lại, chứ không
ai đi sửa tay file HTML 400 KB.

Cần `pandoc` (`brew install pandoc`) và Python 3; riêng nguồn PDF cần thêm
`pymupdf` (`pip install pymupdf`, nên cài trong venv). Không thêm phụ thuộc nào
vào app — script chỉ chạy lúc chuyển đổi, app vẫn là vanilla JS không build step.

## Bước 1 — soi file

```bash
python3 .claude/skills/docx-to-book/scripts/inspect_docx.py ~/Downloads/SÁCH.docx
```

Nhận cả `.pdf`, nhưng lúc đó phải gọi bằng đúng python có `pymupdf` (venv), chứ
không phải `python3` trần. Sinh ra `SÁCH-work/` chứa `*-raw.html` (bản pandoc,
hoặc bản dựng từ PDF), `*-media/` (ảnh tách rời) và `*-blocks.txt` — danh sách
mọi đoạn văn có đánh số. **Đọc hết blocks.txt**; đó là toàn bộ cuốn sách ở dạng
phẳng và mọi con số trong plan đều trỏ vào đây. Báo cáo in ra màn hình sẽ chỉ
luôn: heading của Word có dùng được không, ảnh nào ở block nào, những `?` khả
nghi, các đoạn có vẻ bị ngắt, và (với PDF) chữ nào bị nuốt vào vùng hình.

Mở thư mục ảnh ra **xem tận mắt** — đó là cách duy nhất biết ảnh nào là bìa và
mỗi ảnh ứng với "Hình" số mấy để đặt figcaption.

## Bước 2 — viết plan

Đặt trong `.claude/skills/docx-to-book/plans/<id-sách>.json`.
[bat-doan-cam.json](plans/bat-doan-cam.json) là mẫu đầy đủ nhất (ảnh, `sections`,
`rewrite`); [dao-duc-kinh-phan-duc.json](plans/dao-duc-kinh-phan-duc.json) là mẫu
nối lại bản xuống dòng theo dòng in.

| Khoá | Ý nghĩa |
| --- | --- |
| `source` | đường dẫn .docx (tương đối so với file plan). Ghi đè bằng `--source` |
| `output` | file HTML sẽ ghi, thường `../../../../books/<id>.html` |
| `work` | thư mục cache pandoc. Cứ để `"../work"` — xem [Bước 3](#bước-3--dựng-và-ghi-vào-tủ-sách) |
| `title`, `byline`, `cover`, `cover_caption` | chương đầu làm trang bìa; `cover` là số IMG |
| `chapters` | `{"19": "Chương Thứ Nhất"}` — chèn `<h2>` **trước** block 19 |
| `sections` | như trên nhưng `<h3>` |
| `drop` | block bỏ hẳn: dòng tiêu đề đã hoá thành h2/h3, heading rỗng, ô bảng rỗng |
| `quote` | block render thành `<blockquote>` — câu khẩu quyết, thơ, đề từ. Các block quote **liền nhau gộp chung một khối**, nên cứ liệt kê từng dòng của một bài thơ hay một đoạn nguyên văn |
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

Nhãn chương nhiều khi phải tự đặt: bản nguồn chỉ để số trần `1`, `2`, `3`. Đặt
thì đặt theo cách gọi quen của cuốn sách đó ("Chương 12" cho Đạo Đức Kinh), và
**báo lại là mình đã tự đặt** — nhất là khi bản nguồn dùng từ khác (nó gọi là
"câu", ta ghi "Chương").

### Cấu trúc đều thì sinh plan bằng script

Sách 44 chương mà ngồi chép 44 con số vào JSON thì chỉ cần lệch một số là mất
trắng một đoạn. Nhận ra tên chương bằng luật được — block chỉ có mỗi con số,
block in đậm, block mở đầu bằng "Chương" — thì viết mấy dòng Python đọc
`*-raw.html` qua `flatten()` của [scripts/docxbook.py](scripts/docxbook.py) rồi
`json.dump` thẳng ra plan. Cả hai cuốn Đạo Đức Kinh sinh kiểu đó, `chapters`,
`quote`, `merge` không gõ tay chữ nào.

Sinh xong vẫn phải in ra soát: đủ số chương chưa, dãy số có liên tục không
(`38..81`), có block nào rơi ra ngoài mọi vai trò không. Script sinh sai thì sai
đều và im lặng — chính vì vậy mới phải kiểm bằng mắt.

### Nối lại bản xuống dòng theo dòng in

Với bản chép web, `merge` không còn là vá vài chỗ sang trang mà là dựng lại toàn
bộ đoạn văn. Luật này chạy tốt cho tiếng Việt:

> nối block `i` vào `i-1` khi block `i` **bắt đầu bằng chữ thường**, hoặc block
> `i-1` **kết bằng `,` `;` `:`**. Còn lại là đoạn mới.

Xét hoa/thường ở ký tự chữ đầu tiên **sau khi bỏ `“ ( [` mở đầu**, nhờ vậy
`(vì nắm được chân lí)` nối đúng vào câu trước, mà `“Ta không dám làm chủ` sau
dấu `:` cũng nối đúng. Đừng lấy "dòng trước đã có dấu chấm chưa" làm luật chính —
bản chép web rụng dấu chấm cuối dòng như cơm bữa, tin vào nó là dính hai câu.

**Bắt buộc soát ranh giới.** In ra hai loại đáng ngờ rồi đọc từng dòng một:

- chỗ **nối** mà dòng trước không có dấu câu nào → phải đúng là câu chưa dứt;
- chỗ **tách** mà dòng trước thiếu dấu chấm → phải đúng là hết câu.

Phần Đức có 16 chỗ loại một, 4 chỗ loại hai; đọc hết mất vài phút và đó chính là
chỗ luật suýt sai. Không soát thì không có cách nào biết mình nối đúng hay sai.

### PDF: đoạn văn và hình vẽ

PDF chỉ có dòng đặt ở toạ độ, nên [pdfbook.py](scripts/pdfbook.py) phải đoán
đâu là hết đoạn: **thụt lề dòng đầu** và **dòng kết thúc sớm** so với lề phải
của mấy dòng lân cận. Nó cũng gom nét vẽ vector thành cụm rồi render mỗi cụm ra
một PNG xám 150 dpi (hình trong sách võ là nét vẽ, `get_images()` trả về rỗng dù
trang đầy hình), dán dấu đầu dòng lẻ loi vào dòng chữ kế nó, và ném rác của công
cụ tạo PDF (dòng "Generated by Foxit…", số trang) đi.

Chỗ nó *không* tự lo được, phải soát bằng mắt trong `blocks.txt`:

- **chữ chạy vòng quanh hình** — Word bọc chữ ôm sát viền hình nên một dòng in
  bị cắt thành mấy mảnh. Script biết vùng đó mà không cắt đoạn bừa, nhưng đôi
  khi nuốt luôn ranh giới đoạn thật; đọc lại mấy block quanh mỗi `[IMG]`;
- **đoạn bị hình chen ngang** — `…chưởng hướng xuống` / `[IMG11]` / `rồi khép
  dần…`. Cho **cả hai** số vào `merge` (cả block ảnh), token ảnh nằm lại trong
  câu và `build_book.py` sẽ tự kéo hình ra đứng trước đoạn;
- **bảng và danh sách hai cột** — thứ tự đọc của PDF là theo cột, ra `blocks.txt`
  thì so le hết. Không vá bằng `merge` được: mở trang đó ra xem rồi `rewrite`
  gọn cả bảng vào **một** block (dùng `<br>` xuống dòng), `drop` phần còn lại;
- **số hiệu hình** thường là nét vẽ chứ không phải chữ, nên nó nằm sẵn trong ảnh
  render — khỏi cần `captions`. Cái nào là chữ thì inspect gom vào
  `*-captions.json` để chép sang plan;
- **tiêu đề dính vào đoạn văn** — `…Hàng-Thanh.,. 3-. LÃM TƯỚC VĨ`. Đặt
  `chapters` ở block **sau** rồi `rewrite` block đó bỏ phần tiêu đề đi.

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

### Gõ telex hụt phím

Kiểu hỏng khác hẳn, và là của **người đánh máy bản in**, không phải của vòng
chuyển đổi: `noiwchor` = nơi chỏ, `cngx` = cũng, `vwnj` = vận, `thaaysddoois` =
thấy đối, `monggif` = mong gì. Phím dấu telex (`w j f s x r`, `aa dd oo`) rơi
lạc vào giữa chữ.

Bắt gần như trọn ổ bằng hai phép lọc, vì chính tả tiếng Việt **không có `w j f
z`** và **không có âm tiết quá 7 chữ cái**:

```python
[w for w in re.findall(r'\b\w+\b', text) if re.search(r'[wjfz]', w.lower())]
re.findall(r'\b[^\W\d_]{8,}\b', text)       # dính chữ: đồngthời, nwowngnhau
```

Thái Cực Quyền ra đúng 7 + 2 chỗ, không có báo động giả nào.

Vá bằng `replace`, nhưng **luôn kèm chữ hai bên** — `replace` chạy trên *mọi*
block, `["hal", "hạ"]` sẽ băm nát cả cuốn, còn `["chưởng hal trầm", "chưởng hạ
trầm"]` thì không. Chỉ vá chỗ nào chữ đó **không thể là tiếng Việt**; `úp va mũi
bàn tay` (va hay và ?) và `gối (tràn) mình` thì để nguyên rồi liệt kê cho người
dùng — xem [Những gì không được tự tiện làm](#những-gì-không-được-tự-tiện-làm).

Ghi lý do ngay trong plan: khoá nào `build_book.py` không biết thì nó bỏ qua,
nên cứ đặt `"_replace": "…"` cạnh `replace` để lần sau còn biết mình đã sửa gì
và vì sao.

### Mấy phép soi rẻ tiền

Chạy trên text đã qua `plain()`, mỗi phép vài dòng Python, lần nào cũng nên chạy —
`inspect_docx.py` không bắt mấy loại này:

| Tìm | Bắt được |
| --- | --- |
| `\w[.,;:]\w` | thiếu dấu cách sau dấu câu (`được.Nhồi`, `phác,tuy`) — lọc bỏ `v.v`, `h.4`, `G.S` |
| `[^\W\d_]{8,}` | dính chữ, sạch báo động giả (`đồngthời`). Hạ xuống `{6,}` thì bắt được `tứcvạn` nhưng phải trừ danh sách âm tiết dài hợp lệ (`thường`, `nghiêng`, `chuyển`…) |
| `[wjfz]` trong chữ tiếng Việt | gõ telex hụt phím (`cngx`, `monggif`) |
| `?` mà chữ ngay sau viết thường | `?` không phải dấu hỏi |

Phép cuối khác hẳn chuyện rụng CP1252 ở trên: `“lợi khí” quyền mưu? thì quốc gia`
không phải câu hỏi — dấu `?` đó nuốt mất dấu `)`. Còn `?` cuối câu thì
`build_book.py` in hết ra rồi, đọc lại từng cái xem có phải câu hỏi thật không.

### Những gì không được tự tiện làm

Giữ đúng chính tả và giọng văn của bản gốc, kể cả từ cũ và lỗi nhỏ của tác giả
(`chum lại`, `xử dụng`) — đây là sách in lại, không phải bài viết cần biên tập.
Nếu bản nguồn thiếu hình hay đứt ngang, **nói rõ trong `note`**, tuyệt đối không
viết bù phần thiếu.

Ranh giới là: **lỗi cơ học thì sửa, chữ nghĩa thì không.** Thiếu dấu cách, dính
chữ, `?` nuốt mất `)` — rác của vòng chép, sửa bằng `replace` rồi báo lại một
dòng. Còn `nhà cần quyền`, `thu thuế nặng nặng`, `ẩn náo` — có thể là lỗi đánh
máy mà cũng có thể là chữ của bản in; không có bản gốc trong tay thì **để nguyên
và liệt kê cho người dùng**, đừng tự quyết thay họ.

Front matter sai cũng xử theo lối đó. Phần Đức có dòng đề mục ghi "từ câu 38 tới
câu 61" trong khi chính văn chạy đủ tới 81: không sửa thầm, mà cũng không để
nguyên cho người đọc tưởng sách thiếu — bỏ khỏi thân sách, ghi khoảng đúng vào
`byline`, nói rõ đầu đuôi trong `note`.

## Bước 3 — dựng và ghi vào tủ sách

```bash
python3 .claude/skills/docx-to-book/scripts/build_book.py \
        .claude/skills/docx-to-book/plans/<id>.json --source ~/Downloads/SÁCH.docx
```

Script in ra danh sách chương, số chữ, số `?` còn lại, và cảnh báo khi có block
dài nằm trong `drop` — gần như chắc chắn là chép nhầm một con số và mất trắng
một đoạn văn. Soi kỹ mấy cảnh báo đó.

Nếu file .docx đã dọn đi mà `work/` còn thì vẫn dựng lại được từ cache — kể cả
nguồn PDF, lúc đó `python3` trần cũng chạy được vì không phải gọi tới `pymupdf`
nữa. `--check` dựng ra rồi so với file đang có, không ghi — dùng để xác nhận
plan còn tái tạo đúng cuốn sách sau khi sửa script. Sửa `docxbook.py` hay
`pdfbook.py` thì `--check` **cả mấy cuốn đã có**: khớp từng byte mới là không
làm hỏng sách cũ.

Muốn vậy thì `work` phải trỏ vào **`"../work"`** (tức `skills/docx-to-book/work/`,
đã có trong `.gitignore`). Mặc định cache nằm cạnh file .docx, mà .docx thì là
nguyên liệu tạm — dọn nó đi là mất luôn cache, plan hoá ra không dựng lại được
nữa. Lúc đó phải đi tìm lại bản .docx rồi chạy với `--source`. Còn để `../work`
thì cache sống chung với plan, xoá .docx bao nhiêu lần cũng không sao.

Rồi thêm mục vào [books/library.json](../../../books/library.json):

```json
{ "id": "<id>", "title": "…", "author": "…", "file": "<id>.html", "rev": 1,
  "desc": "Sách nói về cái gì, mở đầu ra sao, đi tới đâu.\nBản nguồn thiếu/đứt chỗ nào." }
```

`id` là khoá của tiến độ đọc **và** của URL — đổi `id` là xoá sạch tiến độ của
người đọc. Về sau mỗi lần sửa nội dung file sách phải **tăng `rev`**, không thì
client vẫn dùng bản chương đã tách trong IndexedDB và không thấy gì thay đổi.

`desc` là đoạn giới thiệu ở trang sách. Viết sau khi đã đọc `blocks.txt`, nên nó
phải nói được cuốn này dạy gì và dừng ở đâu — hai đoạn ngăn bằng `\n`: đoạn đầu
là nội dung, đoạn sau là cảnh báo về bản nguồn (đúng cái đã ghi trong `note`).
Đừng chép bìa sách hay tán tụng.

Bộ nhiều tập thì gom vào thư mục, tên sách rút ngắn cho khỏi lặp tên bộ:

```json
{ "type": "folder", "id": "dao-duc-kinh", "title": "Lão Tử — Đạo Đức Kinh",
  "items": [ { "id": "dao-duc-kinh-phan-dao", "title": "Phần Đạo (chương 1–37)", … },
             { "id": "dao-duc-kinh-phan-duc", "title": "Phần Đức (chương 38–81)", … } ] }
```

Gom vào thư mục **không** đụng `id` nên tiến độ đọc còn nguyên, và tìm kiếm cũng
không mất gì: `searchBooks()` gộp cả tên thư mục vào chuỗi tìm, nên rút tên sách
xuống còn "Phần Đạo" thì gõ "đạo đức kinh" vẫn ra. Đổi `title` mà không tăng
`rev` thì bản cache trong IndexedDB còn giữ tên cũ — chỉ lộ ra ở hộp thoại
"Đọc lại …" và màn hình lúc mất mạng, còn danh sách online luôn lấy từ catalog.

Không cần đụng `sw.js`: `library.json` đi network-first, file sách cache lazily.

## Kiểm lại

Chạy `python3 -m http.server 8000` rồi mở sách: mục lục đúng chương chưa, ảnh có
hiện không, chữ nghiêng có đúng chỗ không, cuộn hết chương rồi reload xem có
nhảy lại đúng vị trí. Xem thêm mục Testing trong [CLAUDE.md](../../../CLAUDE.md).
