-- Tủ sách — bảng tiến độ đọc trên Supabase (PostgreSQL)
-- Dán toàn bộ file này vào Supabase → SQL Editor → Run.
-- Row Level Security bật sẵn: mỗi tài khoản chỉ đọc/ghi được dòng của mình,
-- nên `anonKey` công khai trong config.js không hề lộ dữ liệu của ai.

create table if not exists public.reading_progress (
  user_id       uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  book_id       text        not null,   -- = `id` trong books/library.json
  chapter       int         not null default 0,
  ratio         real        not null default 0,
  read_chapters jsonb       not null default '[]'::jsonb,
  reset_at      timestamptz,            -- lần bấm "Đọc lại từ đầu" gần nhất
  updated_at    timestamptz not null default now(),
  primary key (user_id, book_id)
);

alter table public.reading_progress enable row level security;

drop policy if exists "own reading progress" on public.reading_progress;
create policy "own reading progress" on public.reading_progress
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
