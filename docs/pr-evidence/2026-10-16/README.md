# Missing local artwork regression

Synthetic API/audio fixture used for Aurral PR #1205. No personal library,
credentials or deployment data is shown.

- Before: `11df00572969a49250cf6ad44c0d32133376d440`, before fixing error fallbacks.
- After: `b196be5282c464e4cdd40ef4d898b2b090f4f73e`.
- The cover endpoint returns 404 in these browser cases.
- Library/header retain the initial-letter tile; player and queue retain the music icon.
- Browser assertions also verify normal decoded artwork and progressing generated WAV audio.

The player after capture has its queue open to show both music placeholders.
These captures demonstrate UI handling; separate backend tests verify actual
authentication, real file/image decoding and the short-lived missing-artwork cache.
