---
name: screenshots
description: Regenerate the app screenshots used by the README and the landing page (cloud/public) after a UI change. Use when asked to update, refresh or retake the screenshots/images of Hangar.
---

# Screenshots

```sh
npm run build:core
node scripts/screenshots.js
```

The script builds a fictitious world, starts `hangar-server` on it and captures with Playwright (Chrome), light and dark:

- `docs/images/pending.png`, `docs/images/pending-dark.png`: Pending with a session open in the panel.
- `docs/images/insights.png`, `docs/images/insights-dark.png`: Insights.

All four are also copied to `cloud/public/img/`.

Afterwards, open every PNG and check it: no empty states, errors or overflow, both themes right.
