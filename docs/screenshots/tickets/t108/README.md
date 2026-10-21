# T108 — the one thing §2.6 promises about the one-pager, finally photographed

> Safety flags are at the top in red. — design §2.6

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox (214 passed, whole
check 6m25s). All four frames come from the new `e2e/flags.spec.ts`, which drives one visit carrying both
halves of that sentence: `data/fixtures/clarity_sustained_high.csv` for the glucose flag §7 computes, and
§2.5's red-flag scan stopping the interview for the intake banner.

There was no "before" worth keeping. The flags were not broken — they were simply never rendered by any test
and never written to any file, so the before-state of this ticket is the *absence* of these four pictures:
of the 202 PNGs the previous run wrote, not one showed a brief or a sheet with a flag on it, because no
visit in the suite had anything to flag.

| File | What it shows |
|---|---|
| `desktop-provider-sour-flags.png` | The clinician's brief. The intake banner and the glucose block, both red, between the §6.3 note and the Summary card — above the stat tiles, the chart and the spike table, which is what "at the top" has to mean on a page a clinician reads top-down. The sentence under "Glucose safety flags" is `lib/sour.ts`'s own, word for word; the spec asserts it against the bundle rather than against a literal, because it carries a local time. |
| `desktop-provider-print-flags.png` | The same two blocks on the §7.4 sheet, in the same order, above the same numbers. The pair is the point: a flag that reached one surface and not the other is the drift this ticket was filed to make visible, and nothing but these two files would have shown it. |
| `mobile-provider-sour-flags.png` | The brief at 375px, framed on the flags. One screenful of this page from the top is the persona header, the title block, four stacked buttons, the job chip and the §6.3 note — the first run's frame ended at "Glucose safety flags (computed from the" with the flag itself behind the bottom edge, which is T107's bug on T108's subject. The shot is anchored on the intake banner and `wholeRows` now fails a frame that cuts the block below it. |
| `mobile-provider-print-flags.png` | The sheet at 375px, which needed no such help: the header is short enough that both banners and the first of the numbers are in one frame. Kept as the phone-width half of the §6.5 pair. |

What the pictures are evidence for, and what they are not: "in red" is asserted in the spec as the colour the
browser actually paints (the two blocks state their red in different places — `.ss-error` in
`app/globals.css` and Tailwind's `text-red-900` — so the assertion fills a canvas pixel with the computed
value rather than matching a class name), and "at the top" as geometry against the first card. These frames
are what makes both checkable by eye on a later run; they are not what makes them true.
