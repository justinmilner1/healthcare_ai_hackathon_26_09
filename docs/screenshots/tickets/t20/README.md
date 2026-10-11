# T20 screenshots

From `bash scripts/agent-check.sh` on branch `t20-llm-timeout-circuit`, re-taken after `main` (T02's visit model, T40's log fix) was merged in, so they match the branch head.

| File | What it shows |
|---|---|
| `desktop-sweetie-degraded.png` | The model gateway is configured but unreachable. The quiet §6.3 note sits under the conversation header, and the scripted second question has already arrived: the intake continues. |
| `mobile-sweetie-degraded.png` | The same at 375px. The note wraps to two lines and adds no horizontal scroll. |
| `desktop-sweetie-start.png` | No key at all: the "Demo mode" badge, and no note. An offline demo is not an outage. |
| `desktop-sweetie-done.png` | The scripted flow after both questions, unchanged by this ticket. |
| `desktop-provider-dashboard.png` | The provider page, which now imports its visit labels from `lib/visits.ts` instead of `lib/sweetie.ts`. Nothing this ticket changed shows here; the visit-centric rows and stage pills are T02's, arriving through the merge. |
