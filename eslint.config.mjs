// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// ESLint: its recommended rules. Run with ./lint.

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/", "web/vendor/",
      // Generated or third-party: the native projects, the copy of the
      // site the apps bundle, and the emulator test's output.
      "mobile/android/", "mobile/ios/", "mobile/www/", "mobile/smoke-out/",
    ],
  },
  js.configs.recommended,
  {
    // Empty catches are deliberate here: best-effort calls whose failure
    // changes nothing (closing what may already be closed, and the like).
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["web/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
  {
    // Node, plus the browser: functions passed to page.evaluate run there.
    files: ["test/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
];
