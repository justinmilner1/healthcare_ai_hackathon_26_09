# T209 — four role-less divs that carried a name nothing announced

T207 fixed the fifth site of this bug and the mechanism behind it: `aria-label` on a `<div>` with no `role`
is prohibited by ARIA — the implicit role is `generic`, and a generic element cannot be named — so the label
is **dropped** rather than mispronounced, which is why a wrong one can survive two tickets unheard. These
are the four left.

| Where | What it was | What it is now | Which of the three fixes |
|---|---|---|---|
| `app/s/[token]/page.tsx` `.sweetie-typing` | `aria-label="Sweetie is typing"` on a role-less `<div>` holding three empty `<i>` | `role="status"`, named, with the words in its content, outside the `role="log"` | a role that may be named |
| `app/provider/signup/page.tsx` `.ss-stepper` | `aria-label="Setup progress"` on a role-less `<div>` | `<ol aria-label="Setup progress">`, from `components/Stepper.tsx` | a role that may be named |
| `app/provider/dashboard.tsx` `.ss-stepper` | `aria-label="Add patient progress"`, same markup a second time | the same component, one copy | a role that may be named |
| `app/page.tsx` `.home-visual` | `aria-label="Meet Sweetie and Sour"` | nothing | removed, not relocated |

## The one with a user-visible cost

`.sweetie-typing` is the only thing on the §2.5 screen that says a reply is coming, and the transcript it sat
in is a `role="log"` that announces a message when it lands and nothing in between. So a screen-reader user
sent their turn and met **silence** until the reply arrived, with no way to tell whether the send had gone
through — on a screen §2.5 expects to be driven by voice. §6.4 asks for "screen-reader text for state
changes" by name; this was the state change with no text.

Two things in the fix are easy to get wrong, and each would have passed a check while changing nothing a
patient hears:

- **The words are in the region's content, not only in its name.** A live region announces what *changed*,
  so a `role="status"` holding three empty `<i>` is still silence however well it is labelled. It carries
  both — `aria-label` because `status` is "Name From: author" and contents are not consulted for the name,
  and a clipped span because contents are all the announcement has. One `TYPING` constant, so they cannot
  drift.
- **It is outside the log.** ARIA computes an announcement against the nearest live-region ancestor and
  discourages nesting regions, so a `status` inserted *into* the log leaves "once or twice" to the screen
  reader. Out here the question does not arise. That is what moved the indicator from the last row of the
  transcript to a row under it, which is the only visual change in this ticket.

## Why neither gate had seen any of it

`e2e/a11y.ts`'s axe pass is §12.5's, and every call site of it is a patient page — correctly, that is where
the bar is set. Two consequences, and this ticket is both of them:

- **The provider and landing surfaces are outside it.** Three of the four sites were there. A full WCAG pass
  on each is a different ticket's work, so what reaches them is the narrow claim: `lib/ariaName.ts` says
  which roles ARIA prohibits a name on, `expectNoProhibitedAriaNames` (`e2e/a11y.ts`) collects every element
  on a page that claims one and expects none of them to be in that set. Unit tests in `lib/ariaName.test.ts`
  (§12.1); no wording moved into `lib/`, only the rule.
- **The typing indicator exists for the length of one model call.** Every axe pass in `e2e/a11y.spec.ts` ran
  against a page that did not contain it. The new test parks the `POST /api/sweetie` in a route handler —
  `e2e/durability.spec.ts`'s device — and reads the indicator while it is up.

Checked by putting the original markup back and re-running. axe reports it as a **serious violation** and not
an incomplete, because there is no text inside the element for axe to wonder about:

```
Error: axe found serious accessibility violations on Sweetie mid-reply:
  [serious] aria-prohibited-attr: Elements must only use permitted ARIA attributes
      .sweetie-typing
        Fix all of the following:
          aria-label attribute cannot be used on a div with no valid role attribute.
```

and, with a bare `<div aria-label="A name nobody hears" />` put back on the sign-up page, the narrow rule
fails there too: `the practice sign-up wizard: an accessible name on an element ARIA prohibits naming is not
announced at all`.

## The frames

| File | What to look at |
|---|---|
| `desktop-a11y-sweetie-typing.png` | The state no scan had ever contained: the turn held open, the indicator on screen. It is now a row under the transcript rather than the last row inside it — anchored above the composer, which on a desktop with two messages in the thread leaves the gap you can see here. |
| `mobile-a11y-sweetie-typing.png` | The same state at the 375px of §6.5, where the transcript is full enough that the dots sit directly under the patient's own message, as they did before. |
| `desktop-a11y-signup-stepper.png` | §2.1's strip as an `<ol>`: `1 You — 2 Practice`, pixel for pixel what the `<div>` drew. The list reset (`margin: 0; padding: 0; list-style: none`) is what keeps it that way. |
| `mobile-a11y-signup-stepper.png` | And at 375px, where §6.5 takes the step labels off the top bar. They are clipped now rather than `display: none`, so "You" and "Practice" are still read — a strip that announces "Setup progress" over two bare numbers would be a name over nothing. |
| `desktop-a11y-wizard-stepper.png` | §2.2's Add-patient strip, the second copy of the same markup, now the same component: `1 Contact — 2 Visit — 3 Invite`, the current step carrying `aria-current="step"`. |
| `mobile-a11y-wizard-stepper.png` | The wizard at 375px: three circles, no label, no overflow, "Step 1 of 3" still under the form. |
| `desktop-landing.png` | The fourth site, which is an absence. `.home-visual` carries no name; both characters are still announced twice over inside it, by each image's `alt` and by each `<figcaption>`. |
| `mobile-landing.png` | The same at 375px. |

## What this ticket did not change

The steppers' colours, spacing and glyphs: both frames are the same picture the `<div>` drew, which is the
point of an element swap. And nothing on `app/page.tsx` beyond the one attribute — the landing frames are
here as evidence that removing it left the page whole, not because anything in them moved.
