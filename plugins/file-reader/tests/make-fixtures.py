#!/usr/bin/env python3
# 生成 file-reader 的离线测试样本（不需要联网，也不依赖 python-docx）
import os
import zipfile

OUT = '/tmp/fr-test'
os.makedirs(OUT, exist_ok=True)


def w(path, data, binary=False):
    mode = 'wb' if binary else 'w'
    kw = {} if binary else {'encoding': 'utf-8'}
    with open(os.path.join(OUT, path), mode, **kw) as f:
        f.write(data)


# 1) GBK 文本（QQ 群里最常见的编码坑）
w('gbk-note.txt', '这是一个 GBK 编码的测试文件。\n第二行：机器人应该能读到中文。\n'.encode('gbk'), binary=True)

# 2) UTF-8 文本 + BOM 的 csv
w('table.csv', '\ufeff姓名,分数,备注\n小明,95,优秀\n小红,88,良好\n')

# 3) docx（最小可用 OOXML）
DOC = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>项目周报：文件阅读插件</w:t></w:r></w:p>
<w:p><w:r><w:t>本周完成 txt / docx / pdf 三种格式的抽取。</w:t></w:r></w:p>
<w:p><w:r><w:t>下周计划：支持扫描件 OCR。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>负责人</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>YG</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>'''
with zipfile.ZipFile(os.path.join(OUT, 'report.docx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    z.writestr('word/document.xml', DOC)

# 4) xlsx（共享字符串 + 一张表）
SS = '''<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>姓名</t></si><si><t>城市</t></si><si><t>小明</t></si><si><t>杭州</t></si></sst>'''
SHEET = '''<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
<row r="3"><c r="A3"><v>42</v></c><c r="B3"><v>3.14</v></c></row>
</sheetData></worksheet>'''
with zipfile.ZipFile(os.path.join(OUT, 'sheet.xlsx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('xl/sharedStrings.xml', SS)
    z.writestr('xl/worksheets/sheet1.xml', SHEET)

# 5) pptx（两页）
S1 = '''<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第一页标题</a:t></a:r></a:p><a:p><a:r><a:t>要点一</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'''
S2 = '''<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二页标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'''
with zipfile.ZipFile(os.path.join(OUT, 'deck.pptx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('ppt/slides/slide1.xml', S1)
    z.writestr('ppt/slides/slide2.xml', S2)

# 6) 最小 PDF（ASCII 文本，用来验证 pdftotext 通路）
pdf = b'''%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 62>>stream
BT /F1 18 Tf 30 150 Td (Hello File Reader PDF) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
'''
w('simple.pdf', pdf, binary=True)

# 7) 伪装成 .doc 的 docx（扩展名不可信时的兜底）
with open(os.path.join(OUT, 'report.docx'), 'rb') as f:
    w('fake.doc', f.read(), binary=True)

print('fixtures ->', OUT)
for name in sorted(os.listdir(OUT)):
    print(' ', name, os.path.getsize(os.path.join(OUT, name)), 'bytes')