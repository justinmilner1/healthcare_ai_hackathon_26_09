# T17 screenshots

From `bash scripts/agent-check.sh` on branch `t17-print-view`, written by `e2e/print.spec.ts`.

| File | What it shows |
|---|---|
| `desktop-provider-print.png` | `GET /provider/visit/<id>/print` as the clinician sees it before printing: a sheet of A4 on a desk, with the summary on it and nothing else. The only chrome is the toolbar above the sheet — back to the working summary, and Print — and it does not print. |
| `desktop-provider-print-media.png` | The same page with the browser switched to print media. The toolbar is gone and the sheet is the page, 186mm wide, which is the printable area of an A4 inside the 12mm `@page` margin. |
| `desktop-provider-print.pdf` | The acceptance criterion's PDF export, straight from `page.pdf()` in the spec — headless Chromium's own print pipeline. One page, charts and all; the spec asserts the page count. |
| `mobile-provider-print.png` | The sheet at 375px. Below 720px it stops pretending to be a page: one column, the practice block under the header, the tiles two by two, no horizontal scroll. |
| `desktop-provider-sour-ready.png` | The screen the Print button lives on (`/provider/<id>`). Print is now a link to the sheet, opening in its own tab, where it used to call `window.print()` on this page. |

The first export looked wrong and is what the print CSS in `app/globals.css` was written against: Recharts
measures its container in the browser and writes that number onto the svg, so with the sheet one width on
screen and another on paper both charts printed shrunk into the middle of their cards. The sheet is one
width everywhere now. The same export also showed a tooltip left open by the last pointer position printing
over the glucose line, and a chart's table twin printing as a disclosure triangle that does nothing on paper.
