// What goes between a tooltip's label and its value, for every chart in the product.
//
// Recharts' own default is " : " (node_modules/recharts/.../DefaultTooltipContent: `separator: ' : '`), and
// until T87 no chart overrode it, so both tooltips read "Glucose : 118 mg/dL" and "Asleep : 5.3 h" on all
// three surfaces the charts appear on: the patient's summary (design §2.7), the clinician's brief (§2.6) and
// the printed sheet (§7.4). Each formatter already chooses its own word and unit; the separator was the one
// part of the string nobody had chosen. It lives here rather than in each chart so a third chart cannot
// quietly inherit the default again.
export const TOOLTIP_SEPARATOR = ": ";
