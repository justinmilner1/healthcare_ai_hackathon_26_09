"use client";

// A time on paper, in the reader's own zone.
//
// The sheet beside this file is server-rendered, and the server runs in UTC: a 7pm appointment on the west
// coast would print with tomorrow's date. Formatting in the browser fixes that, but formatting in the browser
// on the first render would not match what the server sent and React would throw the markup away. So the
// server's UTC rendering is what ships, and the effect — which only ever runs in the browser — rewrites it in
// the local zone before the clinician can read either. The `dateTime` attribute carries the instant itself
// for anything machine-read.

import { useEffect, useState } from "react";

const format = (iso: string, options: Intl.DateTimeFormatOptions, timeZone?: string) => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, timeZone ? { ...options, timeZone } : options);
};

export default function LocalTime({ iso, options }: { iso: string; options: Intl.DateTimeFormatOptions }) {
  // JSON and not the object: a prop literal is a new object on every render, which would re-run the effect
  // for ever. The string is stable, and it is also how the effect gets the options back.
  const key = JSON.stringify(options);
  const [text, setText] = useState(() => format(iso, options, "UTC"));

  useEffect(() => {
    setText(format(iso, JSON.parse(key) as Intl.DateTimeFormatOptions));
  }, [iso, key]);

  return <time dateTime={iso}>{text}</time>;
}
