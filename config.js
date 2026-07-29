/* Cấu hình đồng bộ đám mây (PostgreSQL qua Supabase).
   Để trống = app chạy hoàn toàn offline, tiến độ đọc chỉ nằm trên máy này.
   Hướng dẫn điền: SETUP-SUPABASE.md

   `anonKey` sinh ra để công khai — dữ liệu được bảo vệ bằng Row Level Security
   (mỗi tài khoản chỉ đụng được dòng của mình), không phải bằng cách giấu key.

   Dùng chung project với trading-journal: cùng kho tài khoản, nên đăng nhập bằng
   đúng email/mật khẩu bên đó. Bảng `reading_progress` nằm riêng, không đụng
   `trades`/`notes`/`app_state`. */
window.SUPABASE_CFG = {
  url: 'https://pmaowtzvqbmwnqlaiklb.supabase.co',
  anonKey: 'sb_publishable_Zs92xHfzJT-UlASykWzXhg_gLXlMqop',
  allowSignup: false, // tài khoản đã có sẵn bên trading-journal — chỉ cần đăng nhập
};
