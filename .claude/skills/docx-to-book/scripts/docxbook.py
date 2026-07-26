# -*- coding: utf-8 -*-
"""Phần dùng chung của inspect_docx.py và build_book.py.

Điểm mấu chốt: hai script phải dẹt tài liệu ra **cùng một danh sách block với
cùng chỉ số**, vì cả bản kế hoạch (plan JSON) đều đánh địa chỉ theo chỉ số đó.
Mọi thay đổi cách dẹt sẽ làm sai lệch mọi plan đã viết — nếu buộc phải đổi, hãy
chạy lại inspect và soát lại plan.
"""
import base64
import pathlib
import re
import subprocess
import zipfile

MIME = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.bmp': 'image/bmp', '.emf': 'image/emf',
        '.wmf': 'image/wmf', '.tif': 'image/tiff', '.tiff': 'image/tiff',
        '.webp': 'image/webp'}

# Ký tự vô hình / rác thường gặp trong docx quét lại từ sách in.
SOFT_HYPHEN = '­'          # hiện ra như dấu gạch nhưng thật ra vô hình


def run_pandoc(docx, out_html):
    """docx -> fragment HTML (không --standalone, ảnh nhúng base64).

    Fragment, không phải trang đầy đủ: app tự bọc nội dung chương, còn
    splitChapters() chỉ đọc body.children.
    """
    subprocess.run(['pandoc', str(docx), '-t', 'html', '--embed-resources',
                    '-o', str(out_html)], check=True)
    return pathlib.Path(out_html).read_text(encoding='utf-8')


def source_to_raw(src, raw_path, media_dir):
    """Nguồn (docx/pdf/...) -> (raw_html, thư_mục_ảnh, [ghi chú]).

    Một cửa duy nhất cho cả hai nhánh, để inspect và build luôn nhìn thấy cùng
    một fragment. PDF đi qua pdfbook.py (nét vector phải render ra PNG), còn
    lại đi qua pandoc.
    """
    src = pathlib.Path(src)
    if src.suffix.lower() == '.pdf':
        from pdfbook import pdf_to_html
        raw, media, dropped = pdf_to_html(src, raw_path, media_dir)
        return raw, media, dropped
    raw = run_pandoc(src, raw_path)
    return raw, extract_media(src, media_dir), []


def extract_media(docx, media_dir):
    """Giải nén word/media/* để xem ảnh và tra ngược data-uri -> tên file."""
    media_dir = pathlib.Path(media_dir)
    media_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(docx) as z:
        for n in z.namelist():
            if n.startswith('word/media/'):
                (media_dir / pathlib.Path(n).name).write_bytes(z.read(n))
    return media_dir


def media_index(media_dir):
    """base64 của từng file -> tên file, để nhận diện ảnh trong HTML."""
    idx = {}
    for p in sorted(pathlib.Path(media_dir).iterdir()):
        idx[base64.b64encode(p.read_bytes()).decode()] = p.name
    return idx


def tokenize_images(raw, idx):
    """Thay mỗi <img> bằng token \\x00IMGn\\x00 để văn bản dễ đọc, dễ so khớp.

    Trả về (html_đã_thay, [tên_file_theo_thứ_tự_xuất_hiện]).
    """
    order = []

    def sub(m):
        order.append(idx.get(m.group(1), '?'))
        return '\x00IMG%d\x00' % (len(order) - 1)

    raw = re.sub(r'<img[^>]*src="data:image/[\w.+-]+;base64,([^"]+)"[^>]*/?>',
                 sub, raw)
    return raw, order


def flatten(raw):
    """Dẹt HTML thành [[tag, list_tag|None, inner_html], ...].

    Chỉ lấy các thẻ lá chứa chữ (h1-h6, p, li, td). Cố ý *không* giữ cây:
    pandoc bọc phần lớn thân bài trong <blockquote> chỉ vì Word thụt lề, nên
    giữ cây thì sách nào cũng ra một khối chữ nghiêng mờ. Cấu trúc thật được
    dựng lại từ plan.
    """
    out = []
    for m in re.finditer(r'<(h[1-6]|p|li|td)\b[^>]*>(.*?)</\1>', raw, re.S):
        tag = m.group(1)
        parent = None
        if tag == 'li':
            before = raw[:m.start()]
            parent = 'ol' if before.rfind('<ol') > before.rfind('<ul') else 'ul'
        out.append([tag, parent, ' '.join(m.group(2).split())])
    return out


def plain(inner):
    """Bỏ thẻ, dùng khi cần in ra cho người đọc."""
    import html as H
    return H.unescape(re.sub(r'<[^>]+>', '', inner))


def data_uri(path):
    path = pathlib.Path(path)
    mime = MIME.get(path.suffix.lower(), 'application/octet-stream')
    return 'data:%s;base64,%s' % (mime, base64.b64encode(path.read_bytes()).decode())
