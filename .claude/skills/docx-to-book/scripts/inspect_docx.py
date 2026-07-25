#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bước 1: mổ xẻ .docx trước khi viết plan.

    python3 inspect_docx.py SÁCH.docx [--work THƯ_MỤC_TẠM]

Sinh ra trong thư mục tạm:
  <stem>-raw.html     pandoc fragment (ảnh đã nhúng base64)
  <stem>-media/       ảnh tách rời, mở ra xem để đặt chú thích hình
  <stem>-blocks.txt   danh sách block đánh số — plan trỏ theo số này

In ra màn hình bản báo cáo: heading, ảnh, hư hỏng mã hoá, đoạn bị ngắt.
Đọc kỹ blocks.txt rồi mới viết plan; đừng tin heading của Word.
"""
import argparse
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from docxbook import (SOFT_HYPHEN, extract_media, flatten, media_index, plain,
                      run_pandoc, tokenize_images)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('docx')
    ap.add_argument('--work', default=None, help='thư mục tạm (mặc định: cạnh file docx)')
    a = ap.parse_args()

    docx = pathlib.Path(a.docx).resolve()
    stem = docx.stem
    work = pathlib.Path(a.work) if a.work else docx.parent / (stem + '-work')
    work.mkdir(parents=True, exist_ok=True)

    raw_path = work / (stem + '-raw.html')
    raw = run_pandoc(docx, raw_path)
    media = extract_media(docx, work / (stem + '-media'))
    raw, img_order = tokenize_images(raw, media_index(media))
    blocks = flatten(raw)

    # ---- blocks.txt: bản đồ để viết plan ----
    lines = []
    for i, (tag, parent, inner) in enumerate(blocks):
        t = plain(inner)
        t = re.sub(r'\x00IMG(\d+)\x00', lambda m: '[IMG%s]' % m.group(1), t)
        lines.append('%4d %-3s %s' % (i, tag, t))
    (work / (stem + '-blocks.txt')).write_text('\n'.join(lines) + '\n', encoding='utf-8')

    print('=' * 70)
    print('%s — %d block' % (docx.name, len(blocks)))
    print('=' * 70)
    print('raw   :', raw_path)
    print('ảnh   :', media)
    print('blocks:', work / (stem + '-blocks.txt'), '  <-- đọc file này trước')

    # ---- heading Word có dùng được không? ----
    hs = collections.Counter(t for t, _, _ in blocks if t.startswith('h'))
    empty = sum(1 for t, _, inner in blocks if t.startswith('h') and not plain(inner).strip())
    print('\n--- heading của Word ---')
    print('  ', dict(hs) or 'không có heading nào')
    if empty:
        print('   %d heading rỗng -> cấu trúc Word không đáng tin, dựng lại bằng plan' % empty)

    # ---- ảnh ----
    print('\n--- ảnh (thứ tự xuất hiện) ---')
    for n, name in enumerate(img_order):
        p = media / name
        size = p.stat().st_size
        at = [i for i, b in enumerate(blocks) if '\x00IMG%d\x00' % n in b[2]]
        flag = '  <- 1x1? ảnh chèn lót, nên bỏ' if size < 200 else ''
        print('   IMG%-2d %-14s %7d B  block %s%s' % (n, name, size, at, flag))
    if img_order:
        print('   (mở thư mục ảnh ra xem để đặt figcaption "Hình 12 – 13")')

    # ---- hư hỏng mã hoá ----
    text = ''.join(plain(b[2]) for b in blocks)
    soft = text.count(SOFT_HYPHEN)
    if soft:
        print('\n--- ký tự vô hình ---')
        print('   %d soft hyphen (U+00AD) — hiện như gạch nối nhưng vô hình,' % soft)
        print('   build_book.py tự đổi thành "-"')

    qs = collections.Counter()
    for i, b in enumerate(blocks):
        for tok in re.findall(r'\S*\?\S*', plain(b[2])):
            qs[tok] += 1
    per_block = {i: plain(b[2]).count('?') for i, b in enumerate(blocks)}
    heavy = {i: n for i, n in per_block.items() if n >= 5}
    total = sum(per_block.values())
    if total:
        print('\n--- dấu "?" khả nghi: %d chỗ, %d dạng ---' % (total, len(qs)))
        print('   docx dựng lại từ sách in hay mất sạch ký tự dải CP1252')
        print('   (à á â ã ê í ó ô ú ý, dấu …, ngoặc kép cong) -> thành "?".')
        if heavy:
            print('   BLOCK HỎNG NẶNG (>=5): %s' % sorted(heavy))
            print('   -> đánh máy lại trong plan["rewrite"], giữ nguyên <em>/<strong>')
        print('   Các dạng hay gặp:')
        for tok, n in qs.most_common(25):
            print('      %3d  %s' % (n, tok))
        print('   Còn lại là "?" hỏi thật — đối chiếu bằng ngữ cảnh.')

    # ---- đoạn bị ngắt do sang trang ----
    cont = []
    for i in range(1, len(blocks)):
        prev, cur = plain(blocks[i - 1][2]).strip(), plain(blocks[i][2]).strip()
        if not cur or blocks[i][0] != 'p' or blocks[i - 1][0] != 'p':
            continue
        if cur[0].islower() and prev and prev[-1] not in '.!?…:':
            cont.append(i)
    if cont:
        print('\n--- đoạn có vẻ bị ngắt giữa chừng (sang trang trong sách in) ---')
        print('   ứng viên cho plan["merge"] (block i dán vào cuối block i-1):')
        print('   %s' % cont)
        print('   kiểm lại từng cái trong blocks.txt trước khi tin')

    print('\nBước tiếp: viết plan JSON (xem SKILL.md), rồi chạy build_book.py')


if __name__ == '__main__':
    main()
