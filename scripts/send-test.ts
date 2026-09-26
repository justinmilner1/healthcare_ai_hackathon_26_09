// Send yourself a test invite from the terminal, using whatever providers .env configures.
//   npm run send:test -- --email you@example.com --phone +14155551234
// Prints which provider was picked and the result for each channel.

import { config } from "dotenv";
config();

import { emailProvider } from "../lib/email";
import { sendIntakeInvite } from "../lib/notify";
import { smsProvider } from "../lib/sms";

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const email = get("--email");
  const phone = get("--phone");
  if (!email && !phone) {
    console.error("usage: npm run send:test -- --email you@example.com [--phone +1...]");
    process.exit(1);
  }
  console.log(`email provider: ${emailProvider() ?? "none"} · sms provider: ${smsProvider() ?? "none"} · region: ${process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "(unset)"}`);
  const r = await sendIntakeInvite({ name: "Test Patient", email, phone, token: "test-token", providerName: "Dr. Demo Endo", apptAt: new Date(Date.now() + 2 * 86400000) });
  console.log(JSON.stringify(r, null, 2));
}

main();
