# Đăng nhập & đồng bộ tiến độ đọc (Supabase)

Tủ sách vẫn chạy đủ offline bằng `localStorage`. Phần này là **tuỳ chọn**: thêm một
database PostgreSQL miễn phí để chương đã đọc ✓ và vị trí đang đọc theo bạn sang
máy khác, khoá bằng đăng nhập email + mật khẩu. Làm một lần, ~10 phút.

Không cài gì thêm: app gọi thẳng REST của Supabase bằng `fetch`, không thư viện,
không CDN (một thẻ `<script>` ngoài origin sẽ hỏng ngay khi mất mạng).

## 1. Tạo project Supabase

1. Vào https://supabase.com → **Start your project** → đăng ký.
2. **New project** → tên gì cũng được (`tu-sach`), đặt mật khẩu database mạnh
   (hằng ngày không dùng tới), region **Southeast Asia (Singapore)**.
3. Chờ ~1 phút cho project khởi tạo.

## 2. Tạo bảng

**SQL Editor → New query** → dán toàn bộ [`supabase/schema.sql`](supabase/schema.sql)
→ **Run**. Thấy "Success. No rows returned" là xong.

Bảng `reading_progress` một dòng cho mỗi (tài khoản, sách), bật sẵn Row Level
Security nên mỗi tài khoản chỉ đọc/ghi được dòng của chính mình.

## 3. Bật đăng nhập bằng email

1. **Authentication → Sign In / Up → Email** — đảm bảo Email đang bật.
2. Khuyên dùng: **tắt** "Confirm email" để tạo tài khoản xong đăng nhập được ngay.
   Thích bước xác nhận email thì cứ để bật — app sẽ nhắc "Mở email để xác nhận".

## 4. Nối vào app

**Project Settings → API**, copy **Project URL** và key **anon public**
(hoặc **publishable**), rồi điền vào [`config.js`](config.js):

```js
window.SUPABASE_CFG = {
  url: 'https://abcdefgh.supabase.co',
  anonKey: 'eyJhbGciOi…',
  allowSignup: true,
};
```

Tải lại trang → nút **☁** trên đầu tủ sách → **Tạo tài khoản** → đăng nhập. Tạo
xong thì đổi `allowSignup: false` để ẩn nút tạo tài khoản đi.

Key `anon` sinh ra để công khai, commit thoải mái — dữ liệu được bảo vệ bằng Row
Level Security chứ không phải bằng cách giấu key.

**Đổi `config.js` hay `sync.js` thì phải bump `CACHE` trong [`sw.js`](sw.js)**,
nếu không service worker vẫn trả bản cũ đã cache.

## 5. Dùng

- Nút **☁** ở đầu tủ sách là trạng thái đồng bộ: `☁` xám (chưa đăng nhập),
  `⟳` (đang đồng bộ), `☁` viền đậm (đã đồng bộ), `⚠` (lỗi — bấm vào xem lý do).
- Máy nào cũng đăng nhập cùng tài khoản đó là xong.
- Tiến độ tự đẩy lên ~4 giây sau mỗi lần lưu; kéo về lúc mở app, lúc đăng nhập,
  lúc quay lại tab sau hơn 1 phút, và khi bấm **Đồng bộ ngay**.
- Offline vẫn đọc và vẫn ghi tiến độ như thường; có mạng lại thì lần lưu sau tự đẩy.

## Luật trộn (khi hai máy cùng đọc)

- **Chương đã đọc ✓ lấy hợp của hai bên** — dấu ✓ không bao giờ mất vì đồng bộ.
- **Vị trí đang đọc** theo bên có `updatedAt` mới hơn. Cuốn đang mở trong trình
  đọc thì máy này luôn thắng, không bị nhảy chỗ giữa chừng.
- **Xoá khỏi lịch sử** ghi một "bia mộ" trong `reader-progress-del` (localStorage)
  rồi xoá dòng trên server ở lần đẩy kế tiếp. Thiếu bia mộ thì lần kéo về sau sách
  vừa xoá sẽ mọc lại. Bia mộ tự hết hạn sau 90 ngày. Nếu máy kia đọc tiếp cuốn đó
  *sau* lúc bạn xoá, nó được nhận lại — đọc mới thắng xoá cũ.
- **"Đọc lại từ đầu"** ghi `resetAt`, xoá luôn phần ✓ mà máy kia lưu *trước* lúc reset.

## Ghi chú

- Chỉ tiến độ đọc được đồng bộ. Theme, cỡ chữ và cache nội dung sách (IndexedDB)
  vẫn thuộc về từng máy.
- Đăng xuất **không** xoá lịch sử đọc trên máy.
- Sách vẫn do server sở hữu qua [`books/library.json`](books/library.json); tài
  khoản không thêm/sửa/xoá được sách.
- Không điền `config.js` thì app chạy y như trước, nút ☁ chỉ hiện hướng dẫn.
