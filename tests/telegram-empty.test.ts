import { describe, expect, test } from "bun:test";
import { isHeaderOnlyRichMessage } from "../src/telegram.js";

describe("empty message guard", () => {
  test("detects a header-only rich message with debug ids", () => {
    const html = '<p><i>#L26</i></p>\n<p>🖥 <b>Alloy Lead</b> · <code>ses_df65</code> · <code>opencode/hy4-flash-free</code> (high)</p><p><i>#L26</i></p>';
    expect(isHeaderOnlyRichMessage(html)).toBe(true);
  });

  test("keeps real messages with content", () => {
    expect(isHeaderOnlyRichMessage('<p>🖥 <b>Alloy</b> · <code>ses_df65</code></p><blockquote>respuesta</blockquote>')).toBe(false);
    expect(isHeaderOnlyRichMessage('<p>🖥 <b>Alloy</b> · <code>ses_df65</code></p><p>✅ Listo</p>')).toBe(false);
    expect(isHeaderOnlyRichMessage('<p>hola mundo</p>')).toBe(false);
  });
});
