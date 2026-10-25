// The body of the clinician's "In the patient's words" block (design §2.6), on both of the surfaces that
// have one: the working brief and the printed one-pager (§7.4).
//
// Here rather than twice in those two files because T154 is a bug about what that block says, and a block
// that says it in two places can be fixed in one of them. What goes in it is decided in
// lib/patientWords.ts, which is pure and tested; this is the markup, and the heading above it stays with
// each surface, which words it in its own tag (`h3` on the screen, `h2` on paper).
//
// No hooks and no state, so it renders in the print page's server tree and in the brief's client tree alike.

import { moreMessagesLine, type PatientWords } from "@/lib/patientWords";

export default function PatientWordsBody({ words }: { words: PatientWords }) {
  return (
    <>
      {words.note && <p className="sour-words-note mt-1 text-sm text-[var(--viz-muted)]">{words.note}</p>}
      {words.quotes.map((quote, i) => (
        <blockquote
          key={i}
          className="sour-words-quote mt-2 whitespace-pre-wrap border-l-2 border-black/15 pl-3 text-sm italic text-[var(--viz-ink-2)]"
        >
          {quote}
        </blockquote>
      ))}
      {words.more > 0 && <p className="sour-words-more mt-2 text-xs text-[var(--viz-muted)]">{moreMessagesLine(words.more)}</p>}
      {/* The machine-written lines of `Visit.notes`, kept for the clinician but outside the quotation: the
          safety-flag line and the reason staff typed into the booking form are not the patient's words. */}
      {words.context.length > 0 && (
        <div className="sour-words-context mt-2 space-y-0.5 text-xs text-[var(--viz-muted)]">
          {words.context.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
    </>
  );
}
