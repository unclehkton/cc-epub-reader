import JSZip from "jszip";

export interface MakeEpubOptions {
  title?: string;
  creator?: string;
  language?: string;
  identifier?: string;
  chapters?: Array<{ id: string; href: string; title: string; body: string }>;
  /** Extra zip paths (relative) → string/Uint8Array contents */
  extraFiles?: Record<string, string | Uint8Array>;
  /** Omit META-INF/container.xml */
  omitContainer?: boolean;
  /** Omit the OPF package document */
  omitPackage?: boolean;
  /** Include META-INF/encryption.xml (DRM signal) */
  encrypted?: boolean;
  /** Override mimetype file content */
  mimetype?: string;
  /** Rootfile full-path inside container */
  rootfilePath?: string;
}

const DEFAULT_CHAPTER = {
  id: "c1",
  href: "ch1.xhtml",
  title: "Chapter 1",
  body: "<p>你好世界</p>",
};

/**
 * Build an in-memory minimal EPUB as a Blob. No network.
 */
export async function makeEpub(options: MakeEpubOptions = {}): Promise<Blob> {
  const title = options.title ?? "Sample Title";
  const creator = options.creator;
  const language = options.language ?? "zh-CN";
  const identifier = options.identifier ?? "urn:uuid:test-epub-1";
  const chapters = options.chapters ?? [DEFAULT_CHAPTER];
  const rootfilePath = options.rootfilePath ?? "OEBPS/content.opf";

  const zip = new JSZip();
  zip.file("mimetype", options.mimetype ?? "application/epub+zip", {
    compression: "STORE",
  });

  if (!options.omitContainer) {
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${rootfilePath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    );
  }

  if (options.encrypted) {
    zip.file(
      "META-INF/encryption.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData>
  </EncryptedData>
</encryption>`,
    );
  }

  if (!options.omitPackage) {
    const manifestItems = chapters
      .map(
        (ch) =>
          `<item id="${ch.id}" href="${ch.href}" media-type="application/xhtml+xml"/>`,
      )
      .join("\n    ");
    const spineItems = chapters
      .map((ch) => `<itemref idref="${ch.id}"/>`)
      .join("\n    ");
    const creatorXml =
      creator !== undefined
        ? `<dc:creator>${escapeXml(creator)}</dc:creator>`
        : "";

    zip.file(
      rootfilePath,
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    ${creatorXml}
    <dc:language>${escapeXml(language)}</dc:language>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`,
    );

    const packageDir = rootfilePath.includes("/")
      ? rootfilePath.slice(0, rootfilePath.lastIndexOf("/") + 1)
      : "";

    for (const ch of chapters) {
      zip.file(
        `${packageDir}${ch.href}`,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${escapeXml(ch.title)}</title></head>
  <body>${ch.body}</body>
</html>`,
      );
    }
  }

  if (options.extraFiles) {
    for (const [path, content] of Object.entries(options.extraFiles)) {
      zip.file(path, content);
    }
  }

  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  return new Blob([buffer], { type: "application/epub+zip" });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
