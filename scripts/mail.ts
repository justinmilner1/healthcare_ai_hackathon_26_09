// npm run mail — print the local mailbox (design §5.1: the console half of the console mailer).
//
// With no email provider configured, lib/mailer.ts writes each message to .mail/ instead of sending it, because
// a sign-in link is a credential and §10.3 keeps link tokens out of the application log. This prints the newest
// message, which is how you sign in locally. `npm run mail -- 3` prints the last three.

import { devMailDir, linkIn, readDevMail } from "../lib/devMailbox";

const count = Math.max(1, Number(process.argv[2] ?? 1) || 1);
const mail = readDevMail();

if (mail.length === 0) {
  console.log(`No messages in ${devMailDir()}/. Ask for a sign-in link at /provider/signin first.`);
} else {
  for (const message of mail.slice(-count)) {
    console.log(`\n--- ${message.file}`);
    console.log(`To:      ${message.to}`);
    console.log(`Subject: ${message.subject}`);
    console.log(message.text.trim());
    const link = linkIn(message.text);
    if (link) console.log(`\nOpen:    ${link}`);
  }
}
