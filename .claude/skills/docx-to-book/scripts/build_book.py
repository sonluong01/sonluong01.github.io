#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bước 2: plan JSON -> fragment HTML cho books/.

    python3 build_book.py plans/ten-sach.json [--check]

Plan chỉ là bản đồ "block số mấy đóng vai gì", nên sửa cấu trúc sách là sửa
JSON rồi chạy lại — không phải sửa HTML 400 KB bằng tay. --check dựng ra rồi
so với file đang có, không ghi đè (dùng để kiểm tra plan còn tái tạo đúng).

Xem SKILL.md cho toàn bộ khoá của plan.
"""
import argparse
import html as H
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from docxbook import (SOFT_HYPHEN, data_uri, flatten, media_index, plain,
                      source_to_raw, tokenize_images)

TOKEN = re.compile(r'\x00IMG(\d+)\x00')


def build(plan, plan_dir, source=None):
    def rel(p):
        p = pathlib.Path(p)
        return p if p.is_absolute() else (plan_dir / p).resolve()

    docx = rel(source or plan['source'])
    work = rel(plan.get('work', docx.parent / (docx.stem + '-work')))
    work.mkdir(parents=True, exist_ok=True)

    # work/ là cache của lần chạy pandoc. Còn cache thì dựng lại được cả khi
    # file .docx gốc đã dọn đi — nó là nguyên liệu, không phải tài sản của repo.
    raw_path = work / (docx.stem + '-raw.html')
    media = work / (docx.stem + '-media')
    if raw_path.exists() and media.is_dir():
        raw = raw_path.read_text(encoding='utf-8')
    else:
        if not docx.exists():
            raise SystemExit('không thấy %s và cũng không có cache trong %s\n'
                             'chỉ đường tới file docx bằng --source' % (docx, work))
        raw, media, _ = source_to_raw(docx, raw_path, media)
    raw, img_order = tokenize_images(raw, media_index(media))
    blocks = flatten(raw)

    def key(d):                       # JSON chỉ có khoá chuỗi
        return {int(k): v for k, v in (d or {}).items()}

    chapters = key(plan.get('chapters'))
    sections = key(plan.get('sections'))
    rewrite = key(plan.get('rewrite'))
    drop = set(plan.get('drop', []))
    quote = set(plan.get('quote', []))
    captions = plan.get('captions', {})
    drop_img = {int(k[3:]) for k in plan.get('drop_images', [])}

    # 1. đánh máy lại các block hỏng nặng
    for i, txt in rewrite.items():
        blocks[i][2] = txt

    # 2. sửa ký tự vô hình + các thay thế lẻ tẻ
    patches = plan.get('replace', [])
    for b in blocks:
        s = b[2].replace(SOFT_HYPHEN, '-')
        for old, new in patches:
            s = s.replace(old, new)
        b[2] = s

    # 3. nối đoạn bị ngắt giữa chừng (làm từ cuối lên để chỉ số không xê dịch)
    for i in sorted(plan.get('merge', []), reverse=True):
        blocks[i - 1][2] = (blocks[i - 1][2] + ' ' + blocks[i][2]).strip()
        blocks[i][2] = None

    def figure(n, cap=None):
        cap = cap if cap is not None else captions.get('IMG%d' % n)
        src = data_uri(media / img_order[n])
        alt = H.escape(cap or 'Hình minh họa')
        tail = '\n  <figcaption>%s</figcaption>' % H.escape(cap) if cap else ''
        return '<figure>\n  <img src="%s" alt="%s">%s\n</figure>' % (src, alt, tail)

    out = []
    if plan.get('title'):
        out.append('<h2>%s</h2>' % H.escape(plan['title']))
    if plan.get('cover') is not None:
        out.append(figure(int(plan['cover']), plan.get('cover_caption')))
    if plan.get('byline'):
        out.append('<p style="text-align:center"><strong>%s</strong></p>'
                   % H.escape(plan['byline']))

    i, n = 0, len(blocks)
    while i < n:
        tag, parent, txt = blocks[i]
        if i in chapters:
            out.append('<h2>%s</h2>' % H.escape(chapters[i]))
        if i in sections:
            out.append('<h3>%s</h3>' % H.escape(sections[i]))
        if txt is None or i in drop or not txt.strip():
            i += 1
            continue

        # ảnh nằm lẫn trong đoạn -> tách ra thành figure riêng đứng trước
        imgs = [int(m.group(1)) for m in TOKEN.finditer(txt)]
        if imgs:
            txt = TOKEN.sub('', txt).strip()
            for k in imgs:
                if k not in drop_img and k != plan.get('cover'):
                    out.append(figure(k))
            if not plain(txt).strip():
                i += 1
                continue

        # Các block quote liền nhau là một đoạn trích liền mạch (nguyên văn
        # chữ Hán-Việt, một bài thơ), nên gộp vào chung một <blockquote> —
        # để rời thì mỗi dòng thành một khối có gạch lề riêng, đọc rất gãy.
        if i in quote:
            parts, j = [re.sub(r'</?p>', '', txt)], i + 1
            while j < n and j in quote and j not in drop \
                    and j not in chapters and j not in sections \
                    and blocks[j][2] and blocks[j][2].strip() \
                    and '\x00' not in blocks[j][2]:
                parts.append(re.sub(r'</?p>', '', blocks[j][2]))
                j += 1
            out.append('<blockquote>\n%s\n</blockquote>'
                       % '\n'.join('  <p>%s</p>' % p for p in parts))
            i = j
            continue

        if tag == 'li':
            lt, items = parent, []
            while i < n and blocks[i][0] == 'li' and blocks[i][1] == lt \
                    and i not in drop and i not in chapters and i not in sections:
                if blocks[i][2]:
                    items.append('  <li>%s</li>' % re.sub(r'</?p>', '', blocks[i][2]))
                i += 1
            if items:
                out.append('<%s>\n%s\n</%s>' % (lt, '\n'.join(items), lt))
            continue

        out.append('<p>%s</p>' % txt)
        i += 1

    if plan.get('note'):
        out.append('<p><em>%s</em></p>' % H.escape(plan['note']))

    doc = '\n'.join(out) + '\n'
    if '\x00' in doc:
        raise SystemExit('lỗi: còn token ảnh chưa xử lý')

    # Lỗi hay gặp nhất khi viết plan: chép nhầm một số vào "drop" và thế là mất
    # trắng một đoạn văn. Tiêu đề bị bỏ thường ngắn, nên đoạn dài bị bỏ là đáng ngờ.
    suspect = [(i, plain(blocks[i][2])) for i in sorted(drop)
               if blocks[i][2] and len(plain(blocks[i][2]).strip()) > 120]
    return doc, blocks, img_order, suspect


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan')
    ap.add_argument('--source', default=None,
                    help='đường dẫn .docx, ghi đè plan["source"]')
    ap.add_argument('--check', action='store_true',
                    help='chỉ so với file đang có, không ghi')
    a = ap.parse_args()

    plan_path = pathlib.Path(a.plan).resolve()
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    doc, blocks, img_order, suspect = build(plan, plan_path.parent, a.source)

    out_path = pathlib.Path(plan['output'])
    if not out_path.is_absolute():
        out_path = (plan_path.parent / out_path).resolve()

    titles = re.findall(r'<h2>(.*?)</h2>', doc)
    print('%d chương:' % len(titles))
    for k, t in enumerate(titles):
        print('  %2d  %s' % (k, t))

    text = plain(re.sub(r'<img[^>]*>', '', doc))
    left = [m.group(0) for m in re.finditer(r'.{0,45}\?.{0,12}', text)]
    print('\nsố chữ: %d   dấu "?" còn lại: %d' % (len(text.split()), len(left)))
    for s in left:
        print('   ', s.replace('\n', ' '))
    print('(mỗi dấu phải là câu hỏi thật — còn lại là chữ chưa phục hồi)')

    if len(titles) < 2:
        print('\nCẢNH BÁO: dưới 2 thẻ h2 — splitChapters() sẽ không tách được chương.')

    if suspect:
        print('\nCẢNH BÁO: %d block dài đang nằm trong "drop" — tiêu đề thì ngắn,'
              ' nên nhiều khả năng đây là đoạn văn bị bỏ nhầm:' % len(suspect))
        for i, t in suspect:
            print('   %4d  %s…' % (i, t[:70]))

    if a.check:
        old = out_path.read_text(encoding='utf-8') if out_path.exists() else None
        print('\n--check:', 'KHỚP' if old == doc else 'KHÁC file đang có', out_path)
        return
    out_path.write_text(doc, encoding='utf-8')
    print('\nđã ghi %s (%d byte)' % (out_path, out_path.stat().st_size))
    print('Nhớ thêm mục vào books/library.json (id, title, author, file, rev).')


if __name__ == '__main__':
    main()
