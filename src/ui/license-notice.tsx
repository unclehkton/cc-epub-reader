/**
 * In-app license / copyright notice for third-party packages we ship
 * (OpenCC, EPUB.js, JSZip, Preact, etc.).
 */

import type { UiLanguage } from "../domain/types";
import { t } from "./strings";

export interface LicenseNoticeProps {
  open: boolean;
  onClose: () => void;
  uiLanguage?: UiLanguage;
}

interface LicenseEntry {
  name: string;
  version: string;
  copyright: string;
  license: string;
  notice: string;
}

const LICENSES: LicenseEntry[] = [
  {
    name: "opencc-js",
    version: "1.4.1",
    copyright: "Copyright (c) 2020-2021 The nk2028 Project",
    license: "MIT AND Apache-2.0",
    notice:
      "Open Chinese Convert (OpenCC) JavaScript port. Converter code is MIT; dictionary data derived from opencc-data is Apache-2.0. The above copyright notice and permission notices are included as required by those licenses.",
  },
  {
    name: "opencc-data (via opencc-js)",
    version: "bundled",
    copyright: "OpenCC / nk2028 contributors",
    license: "Apache-2.0",
    notice:
      "Dictionary data redistributed with opencc-js is a derivative of opencc-data under the Apache License, Version 2.0. A copy of Apache-2.0 terms applies to that data.",
  },
  {
    name: "epubjs",
    version: "0.3.93",
    copyright: "Copyright (c) 2013, FuturePress",
    license: "BSD-2-Clause",
    notice:
      "Redistribution in binary form retains the FuturePress copyright notice and disclaimer as required by the FreeBSD-style license shipped with epubjs.",
  },
  {
    name: "jszip",
    version: "3.10.1",
    copyright:
      "Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso",
    license: "MIT (or GPL-3.0)",
    notice:
      "Used under the MIT license option. The MIT copyright notice and permission notice are included with this distribution.",
  },
  {
    name: "preact",
    version: "10.29.7",
    copyright: "Copyright (c) 2015-present Jason Miller",
    license: "MIT",
    notice:
      "Preact UI runtime. MIT license copyright and permission notice apply.",
  },
];

export function LicenseNotice({
  open,
  onClose,
  uiLanguage = "zh-Hant",
}: LicenseNoticeProps) {
  if (!open) return null;

  return (
    <div class="license-notice-root">
      <button
        type="button"
        class="settings-backdrop"
        aria-label={t(uiLanguage, "close")}
        onClick={onClose}
      />
      <div
        class="license-notice-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="license-notice-title"
      >
        <div class="settings-sheet-header">
          <h2 id="license-notice-title" class="settings-sheet-title">
            {t(uiLanguage, "licensesTitle")}
          </h2>
          <button
            type="button"
            class="settings-close touch-target"
            style={{ minWidth: "44px", minHeight: "44px" }}
            aria-label={t(uiLanguage, "close")}
            onClick={onClose}
          >
            {t(uiLanguage, "close")}
          </button>
        </div>
        <div class="license-notice-body">
          <p>{t(uiLanguage, "licensesIntro")}</p>
          {LICENSES.map((entry) => (
            <section key={entry.name} class="license-entry">
              <h3 class="license-entry-title">
                {entry.name}{" "}
                <span class="license-entry-version">{entry.version}</span>
              </h3>
              <p class="license-entry-meta">
                <strong>{entry.license}</strong>
                <br />
                {entry.copyright}
              </p>
              <p class="license-entry-notice">{entry.notice}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Exported for unit tests / static packaging checks. */
export function listShippedLicenses(): LicenseEntry[] {
  return LICENSES.slice();
}
