import { describe, expect, it } from "vitest";
import {
  ADOBE_FONT_OBFUSCATION,
  IDPF_FONT_OBFUSCATION,
  classifyEncryptionXml,
  shouldRejectEncryption,
} from "../../src/library/encryption-policy";

describe("classifyEncryptionXml", () => {
  it("allows IDPF font obfuscation only", () => {
    const xml = `<?xml version="1.0"?>
      <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <EncryptedData>
          <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
          <CipherData>
            <CipherReference URI="OEBPS/Fonts/Body.otf"/>
          </CipherData>
        </EncryptedData>
      </encryption>`;
    const c = classifyEncryptionXml(xml);
    expect(c.kind).toBe("font-obfuscation-only");
    expect(shouldRejectEncryption(xml)).toBe(false);
  });

  it("allows Adobe font obfuscation", () => {
    const xml = `
      <EncryptedData>
        <EncryptionMethod Algorithm="${ADOBE_FONT_OBFUSCATION}"/>
        <CipherData><CipherReference URI="fonts/x.ttf"/></CipherData>
      </EncryptedData>`;
    expect(classifyEncryptionXml(xml).kind).toBe("font-obfuscation-only");
  });

  it("rejects encrypted XHTML content", () => {
    const xml = `
      <EncryptedData>
        <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
        <CipherData><CipherReference URI="OEBPS/Text/ch1.xhtml"/></CipherData>
      </EncryptedData>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects unknown algorithms on non-font resources", () => {
    const xml = `
      <EncryptedData>
        <EncryptionMethod Algorithm="http://example.com/unknown"/>
        <CipherData><CipherReference URI="OEBPS/Images/cover.png"/></CipherData>
      </EncryptedData>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("treats empty as none", () => {
    expect(classifyEncryptionXml("").kind).toBe("none");
    expect(shouldRejectEncryption(null)).toBe(false);
  });

  it("rejects IDPF font algorithm paired with XHTML content URI", () => {
    // Regression: isFontAlgo alone must not allow content resources.
    const xml = `<?xml version="1.0"?>
      <encryption>
        <EncryptedData>
          <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
          <CipherData>
            <CipherReference URI="OEBPS/Text/chapter1.xhtml"/>
          </CipherData>
        </EncryptedData>
      </encryption>`;
    expect(classifyEncryptionXml(xml).kind).toBe("content-drm");
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects Adobe font algorithm on image content", () => {
    const xml = `
      <EncryptedData>
        <EncryptionMethod Algorithm="${ADOBE_FONT_OBFUSCATION}"/>
        <CipherData><CipherReference URI="OEBPS/Images/cover.png"/></CipherData>
      </EncryptedData>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("pairs algorithm and URI per EncryptedData block, not by list index", () => {
    // Font method first, content AES second — must not mis-pair font algo with xhtml.
    const xml = `
      <EncryptedData>
        <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
        <CipherData><CipherReference URI="OEBPS/Fonts/Body.otf"/></CipherData>
      </EncryptedData>
      <EncryptedData>
        <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
        <CipherData><CipherReference URI="OEBPS/Text/ch1.xhtml"/></CipherData>
      </EncryptedData>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects font-algorithm + URI that only contains substring 'font'", () => {
    // Classic bypass: looksLikeFont used /font/i and allowed content paths.
    const xml = `
      <EncryptedData>
        <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
        <CipherData><CipherReference URI="OEBPS/Text/font-notes.xhtml"/></CipherData>
      </EncryptedData>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects font-algorithm on fonts.css (stylesheet is not a font file)", () => {
    const xml = `
      <EncryptedData>
        <EncryptionMethod Algorithm="${ADOBE_FONT_OBFUSCATION}"/>
        <CipherData><CipherReference URI="OEBPS/Styles/fonts.css"/></CipherData>
      </EncryptedData>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects empty-URI font algorithm even when another font entry exists", () => {
    const xml = `<?xml version="1.0"?><encryption>
      <EncryptedData>
        <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
        <CipherData><CipherReference URI="OEBPS/Fonts/Body.otf"/></CipherData>
      </EncryptedData>
      <EncryptedData>
        <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
        <CipherData></CipherData>
      </EncryptedData>
    </encryption>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects XML comment decoy font pair when real AES+XHTML follows", () => {
    // Regex path would match IDPF+decoy.otf inside the comment first.
    const xml = `<?xml version="1.0"?>
      <encryption>
        <EncryptedData>
          <!--
            <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
            <CipherReference URI="Fonts/decoy.otf"/>
          -->
          <EncryptionMethod
            Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
          <CipherData>
            <CipherReference URI="Text/secret.xhtml"/>
          </CipherData>
        </EncryptedData>
      </encryption>`;
    expect(classifyEncryptionXml(xml).kind).toBe("content-drm");
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects duplicate EncryptionMethod in one EncryptedData block", () => {
    const xml = `<?xml version="1.0"?><encryption>
      <EncryptedData>
        <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
        <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
        <CipherData><CipherReference URI="OEBPS/Fonts/Body.otf"/></CipherData>
      </EncryptedData>
    </encryption>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects duplicate CipherReference in one EncryptedData block", () => {
    const xml = `<?xml version="1.0"?><encryption>
      <EncryptedData>
        <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
        <CipherData>
          <CipherReference URI="OEBPS/Fonts/Body.otf"/>
          <CipherReference URI="OEBPS/Text/ch1.xhtml"/>
        </CipherData>
      </EncryptedData>
    </encryption>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("supports namespace-prefixed EncryptedData for font-only packages", () => {
    const xml = `<?xml version="1.0"?>
      <enc:encryption xmlns:enc="urn:oasis:names:tc:opendocument:xmlns:container"
                      xmlns:enc2="http://www.w3.org/2001/04/xmlenc#">
        <enc:EncryptedData>
          <enc2:EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
          <enc2:CipherData>
            <enc2:CipherReference URI="OEBPS/Fonts/Body.otf"/>
          </enc2:CipherData>
        </enc:EncryptedData>
      </enc:encryption>`;
    expect(classifyEncryptionXml(xml).kind).toBe("font-obfuscation-only");
  });

  it("rejects malformed XML fail-closed", () => {
    const xml = `<encryption><EncryptedData><EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });

  it("rejects mix of valid font and malformed EncryptedData block", () => {
    const xml = `<?xml version="1.0"?><encryption>
      <EncryptedData>
        <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
        <CipherData><CipherReference URI="OEBPS/Fonts/Body.otf"/></CipherData>
      </EncryptedData>
      <EncryptedData>
        <EncryptionMethod Algorithm="${IDPF_FONT_OBFUSCATION}"/>
        <EncryptionMethod Algorithm="${ADOBE_FONT_OBFUSCATION}"/>
        <CipherData><CipherReference URI="OEBPS/Fonts/Other.ttf"/></CipherData>
      </EncryptedData>
    </encryption>`;
    expect(shouldRejectEncryption(xml)).toBe(true);
  });
});
