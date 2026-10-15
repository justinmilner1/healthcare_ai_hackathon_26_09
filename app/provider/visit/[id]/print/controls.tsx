"use client";

// The two controls that are not part of the sheet, and so are not on the paper (`print:hidden`): the way
// back to the working summary, and the print itself.
//
// `auto` is what the Print button on /provider/[id] sets (`?auto=1`): a clinician who pressed Print has
// already asked for the dialog, so the tab that opens puts it up rather than making them press again. The
// bare URL in design §7.4 carries no such thing — it renders the sheet and waits, which is what makes it
// safe to open, screenshot or export to PDF without a dialog in the way.

import Link from "next/link";
import { useEffect, useRef } from "react";

/** The charts hydrate and measure themselves after the document is done, so the dialog waits for that:
 *  printing into a half-drawn chart is the one thing this delay is here to avoid. */
const SETTLE_MS = 400;

export default function PrintControls({ backHref, auto }: { backHref: string; auto: boolean }) {
  const asked = useRef(false);

  useEffect(() => {
    if (!auto || asked.current) return;
    asked.current = true; // a re-render must not raise a second dialog
    let timer = 0;
    const open = () => {
      timer = window.setTimeout(() => window.print(), SETTLE_MS);
    };
    if (document.readyState === "complete") open();
    else window.addEventListener("load", open, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("load", open);
    };
  }, [auto]);

  return (
    <div className="sour-print-toolbar print:hidden">
      <Link href={backHref} className="sour-print-back">← Back to the summary</Link>
      <button type="button" onClick={() => window.print()} className="ss-button ss-button-primary">
        Print
      </button>
    </div>
  );
}
