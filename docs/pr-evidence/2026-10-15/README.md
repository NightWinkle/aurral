# Aurral contribution screenshots

These images show generated audio/artwork and simulated API fixtures. They do not
contain a personal music library, credentials, or production configuration.

- Upstream baseline: `de540f731d1ce3729c211fa1654275f15d4a796b`.
- Local artwork candidate: `a7d38ee0099ce3de17a6e5c5cee60ccd7a96e891`.
- `local-artwork-before.png`: unmodified frontend cannot authenticate the local image URL.
- `local-artwork-after.png`: decoded synthetic cover in Library.
- `local-artwork-player.png`: decoded cover during synthetic WAV playback.
- Track-credit candidate: `66f24acb8d8b71ce0f03edfa37823e89da6de80c`.
- `track-credits-before.png`: upstream Library track rows replace the guest credits with Owner.
- `track-credits-after.png`: the candidate displays Guest & Owner, Owner and Alpha from the same fixture.

The track captures show the row credits. Separate browser assertions exercise
playback, information, sorting, search, playlists, sharing, owner-based acquisition
and restoring blocked/searching/moving acquisition activity on an album reopen.

The backend regressions separately exercise real indexed files, image decoding,
SQLite and authentication. Browser screenshots are UI evidence, not a claim of
live provider or production validation.
