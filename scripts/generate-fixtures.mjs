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
    <dc:title>阅读夹具</dc:title>
    <dc:creator>夹具作者</dc:creator>
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
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
        <li>
          <a href="ch1.xhtml">第一章 开端</a>
          <ol>
            <li><a href="ch1.xhtml#sec-a">第一节 简体原文</a></li>
          </ol>
        </li>
        <li>
          <a href="ch2.xhtml">第二章 图片与远端</a>
          <ol>
            <li><a href="ch2.xhtml#local-img">本地图片</a></li>
            <li><a href="ch2.xhtml#remote-img">远端图片</a></li>
          </ol>
        </li>
        <li><a href="ch3.xhtml">第三章 敌意标记</a></li>
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
  <docTitle><text>阅读夹具</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>第一章 开端</text></navLabel>
      <content src="ch1.xhtml"/>
      <navPoint id="np1a" playOrder="2">
        <navLabel><text>第一节 简体原文</text></navLabel>
        <content src="ch1.xhtml#sec-a"/>
      </navPoint>
    </navPoint>
    <navPoint id="np2" playOrder="3">
      <navLabel><text>第二章 图片与远端</text></navLabel>
      <content src="ch2.xhtml"/>
      <navPoint id="np2a" playOrder="4">
        <navLabel><text>本地图片</text></navLabel>
        <content src="ch2.xhtml#local-img"/>
      </navPoint>
      <navPoint id="np2b" playOrder="5">
        <navLabel><text>远端图片</text></navLabel>
        <content src="ch2.xhtml#remote-img"/>
      </navPoint>
    </navPoint>
    <navPoint id="np3" playOrder="6">
      <navLabel><text>第三章 敌意标记</text></navLabel>
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
  <head><title>第一章 开端</title></head>
  <body>
    <h1 id="sec-a">第一章 开端</h1>
    <p data-testid="fixture-simplified">这是简体中文测试段落，用于验证香港繁体转换：软件、网络、里面、头发。</p>
    <p>第二段继续阅读进度，方便跨章节恢复位置。</p>
  </body>
</html>`,
  );

  zip.file(
    "OEBPS/ch2.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head><title>第二章 图片与远端</title></head>
  <body>
    <h1>第二章 图片与远端</h1>
    <p id="local-img">本地档案图片（应被门控）：</p>
    <img src="images/local.png" alt="本地夹具图" width="32" height="32"/>
    <p id="remote-img">远端图片（绝不可加载）：</p>
    <img src="https://privacy-trap.example/remote-pixel.png" alt="远端陷阱" width="1" height="1"/>
    <p>章节正文：繁体转换应作用于「学习」「发现」等简体字。</p>
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
    <title>第三章 敌意标记</title>
    <meta http-equiv="refresh" content="0;url=https://evil.example/"/>
    <link rel="stylesheet" href="https://evil.example/track.css"/>
  </head>
  <body>
    <h1>第三章 敌意标记</h1>
    <p>本章含有应被净化的敌意内容。</p>
    <script>window.__hostile = true;</script>
    <iframe src="https://evil.example/frame"></iframe>
    <object data="https://evil.example/obj"></object>
    <embed src="https://evil.example/embed"/>
    <form action="https://evil.example/submit"><input type="text" name="q"/></form>
    <base href="https://evil.example/"/>
    <a href="javascript:alert(1)">坏连结</a>
    <img src="x" onerror="window.__onerror=1" alt="onerror trap"/>
    <p onclick="window.__click=1">点击陷阱段落，简体字：电脑、鼠标。</p>
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
      `<p>第${i}段：这是用于转换压力测试的简体中文长章节。软件网络里面头发学习发现电脑鼠标字体转换应当保持稳定。</p>`,
    );
  }
  const body = paragraphs.join("\n    ");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:large-chapter-0001</dc:identifier>
    <dc:title>长章节压力夹具</dc:title>
    <dc:creator>压力测试</dc:creator>
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
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc"><ol><li><a href="ch1.xhtml">长章节</a></li></ol></nav>
  </body>
</html>`,
  );

  zip.file(
    "OEBPS/ch1.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head><title>长章节</title></head>
  <body>
    <h1>长章节压力测试</h1>
    ${body}
  </body>
</html>`,
  );
}

// silence unused helper warning in strict tooling
void escapeXml;

await writeEpub("reader-fixture.epub", buildReaderFixture);
await writeEpub("large-chapter.epub", buildLargeChapter);
