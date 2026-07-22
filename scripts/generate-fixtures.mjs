/**
 * Build repository-owned DRM-free fixture EPUBs for E2E and stress tests.
 * Run: node scripts/generate-fixtures.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../tests/fixtures");

/** 1×1 PNG (green pixel) — valid archive-local image. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function writeEpub(fileName, build) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  await build(zip);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  const outPath = path.join(fixturesDir, fileName);
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(outPath, buffer);
  console.log(`wrote ${outPath} (${buffer.length} bytes)`);
}

async function buildReaderFixture(zip) {
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:reader-fixture-0001</dc:identifier>
    <dc:title>閱讀夾具</dc:title>
    <dc:creator>夾具作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-07-21T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/local.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`,
  );

  // Nested TOC via EPUB3 nav document.
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
  <head><title>目錄</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目錄</h1>
      <ol>
        <li>
          <a href="ch1.xhtml">第一章 開端</a>
          <ol>
            <li><a href="ch1.xhtml#sec-a">第一節 簡體原文</a></li>
          </ol>
        </li>
        <li>
          <a href="ch2.xhtml">第二章 圖片與遠端</a>
          <ol>
            <li><a href="ch2.xhtml#local-img">本地圖片</a></li>
            <li><a href="ch2.xhtml#remote-img">遠端圖片</a></li>
          </ol>
        </li>
        <li><a href="ch3.xhtml">第三章 敵意標記</a></li>
      </ol>
    </nav>
  </body>
</html>`,
  );

  // Nested NCX for EPUB2-style readers.
  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:reader-fixture-0001"/>
  </head>
  <docTitle><text>閱讀夾具</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>第一章 開端</text></navLabel>
      <content src="ch1.xhtml"/>
      <navPoint id="np1a" playOrder="2">
        <navLabel><text>第一節 簡體原文</text></navLabel>
        <content src="ch1.xhtml#sec-a"/>
      </navPoint>
    </navPoint>
    <navPoint id="np2" playOrder="3">
      <navLabel><text>第二章 圖片與遠端</text></navLabel>
      <content src="ch2.xhtml"/>
      <navPoint id="np2a" playOrder="4">
        <navLabel><text>本地圖片</text></navLabel>
        <content src="ch2.xhtml#local-img"/>
      </navPoint>
      <navPoint id="np2b" playOrder="5">
        <navLabel><text>遠端圖片</text></navLabel>
        <content src="ch2.xhtml#remote-img"/>
      </navPoint>
    </navPoint>
    <navPoint id="np3" playOrder="6">
      <navLabel><text>第三章 敵意標記</text></navLabel>
      <content src="ch3.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
  );

  zip.file(
    "OEBPS/ch1.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head><title>第一章 開端</title></head>
  <body>
    <h1 id="sec-a">第一章 開端</h1>
    <p data-testid="fixture-simplified">这是简体中文测试段落，用于验证香港繁体转换：软件、网络、里面、头发。</p>
    <p>第二段繼續閱讀進度，方便跨章節恢復位置。</p>
  </body>
</html>`,
  );

  zip.file(
    "OEBPS/ch2.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head><title>第二章 圖片與遠端</title></head>
  <body>
    <h1>第二章 圖片與遠端</h1>
    <p id="local-img">本地檔案圖片（應被門控）：</p>
    <img src="images/local.png" alt="本地夾具圖" width="32" height="32"/>
    <p id="remote-img">遠端圖片（絕不可載入）：</p>
    <img src="https://privacy-trap.example/remote-pixel.png" alt="遠端陷阱" width="1" height="1"/>
    <p>章節正文：繁體轉換應作用於「學習」「發現」等簡體字。</p>
  </body>
</html>`,
  );

  // Hostile markup for sanitizer coverage.
  zip.file(
    "OEBPS/ch3.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head>
    <title>第三章 敵意標記</title>
    <meta http-equiv="refresh" content="0;url=https://evil.example/"/>
    <link rel="stylesheet" href="https://evil.example/track.css"/>
  </head>
  <body>
    <h1>第三章 敵意標記</h1>
    <p>本章含有應被淨化的敵意內容。</p>
    <p>安全外部連結（應經父層 noopener 開啟，不可在 iframe 內導航）：</p>
    <a href="https://example.com/epub-external-test" id="fixture-external-link">外部連結示例</a>
    <a href="//example.com/protocol-relative-external" id="fixture-proto-external">協議相對外部連結</a>
    <script>window.__hostile = true;</script>
    <iframe src="https://evil.example/frame"></iframe>
    <object data="https://evil.example/obj"></object>
    <embed src="https://evil.example/embed"/>
    <form action="https://evil.example/submit"><input type="text" name="q"/></form>
    <base href="https://evil.example/"/>
    <a href="javascript:alert(1)">壞連結</a>
    <img src="x" onerror="window.__onerror=1" alt="onerror trap"/>
    <p onclick="window.__click=1">點擊陷阱段落，簡體字：電腦、滑鼠。</p>
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
      <animate attributeName="x" from="0" to="10" dur="1s"/>
      <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
    </svg>
  </body>
</html>`,
  );

  zip.file("OEBPS/images/local.png", TINY_PNG);
}

async function buildLargeChapter(zip) {
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  const paragraphs = [];
  for (let i = 1; i <= 200; i += 1) {
    paragraphs.push(
      `<p>第${i}段：這是用於轉換壓力測試的簡體中文長章節樣本句（內含簡體字供轉換）：软件网络里面头发学习发现电脑鼠标。</p>`,
    );
  }
  const body = paragraphs.join("\n    ");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:large-chapter-0001</dc:identifier>
    <dc:title>長章節壓力夾具</dc:title>
    <dc:creator>壓力測試</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>`,
  );

  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目錄</title></head>
  <body>
    <nav epub:type="toc"><ol><li><a href="ch1.xhtml">長章節</a></li></ol></nav>
  </body>
</html>`,
  );

  zip.file(
    "OEBPS/ch1.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head><title>長章節</title></head>
  <body>
    <h1>長章節壓力測試</h1>
    ${body}
  </body>
</html>`,
  );
}

// silence unused helper warning in strict tooling
void escapeXml;

await writeEpub("reader-fixture.epub", buildReaderFixture);
await writeEpub("large-chapter.epub", buildLargeChapter);
