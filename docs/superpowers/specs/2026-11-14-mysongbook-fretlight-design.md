# mySongBook and Fretlight: research and design (THE-77, tracker rows L02, L03, L04, U19)

Status: proposed 2026-11-14, for owner approval. No product code was written for this document. Ticket THE-77. Tracker rows are in `docs/validation/2026-10-15-gp8-parity-progress.md`; the original baseline text is in `docs/validation/2026-10-15-gp8-parity-baseline.md` (rows L02 to L04 at lines 322 to 324, U19 at line 315). Web pages were read on 2026-11-14 through a page-fetching tool that summarises pages; quotes below come from those summaries and were not compared against the raw pages. Check a quote before relying on it in anything public.

## Summary

- **mySongBook.** I found no public API, partner programme or third-party access route. The published terms say scores are readable only with an internet connection, cannot be stored, and cannot be modified, exported or saved on the customer's device. L02 to L04 as written ("use supported authorized service access", "open previously authorized cached score") therefore cannot be met by integration, and a cache is the thing the terms prohibit. Recommendation: mark L02 to L04 out of scope with that reason. Nothing in TabPlayer's Library can honestly stand in for them.
- **Fretlight.** There is no public SDK. The vendor offers one "by application" (a 2010s-era blog statement, not confirmed as current). The USB protocol of the wired guitars is documented in one community blog post, cross-checked by its author against two open-source projects. The current wireless guitars use Bluetooth LE with no public protocol I could find. Recommendation: build the device-independent half now (frame model, encoder, fake backend, frontend lit-position extraction), and add the USB transport only when someone with a wired Fretlight can test it. U19 cannot reach "implemented" without hardware proof; the honest best without hardware is "missing", and with a transport and a hardware test it would be "partial" at first.

## Part 1: mySongBook

### Facts, with sources

| # | Finding | Source |
|---|---|---|
| 1 | The mySongBook web address redirects to the Guitar Pro site, which presents it as "The official Guitar Pro tabs and scores library"; the footer names Arobas Music. | [guitar-pro.com/tabs](https://www.guitar-pro.com/tabs) |
| 2 | The operator named in the terms of sale is Arobas Music SARL. | [Terms of sale](https://www.guitar-pro.com/c/6-terms-and-conditions-of-sale) |
| 3 | Offer: a subscription (1, 12 or 24 months, no auto-renewal) unlocking the catalogue; single scores bought with credits (credits are no longer sold, existing ones stay valid); one free "Free Tab of the Day". | [Blog: what is mySongBook](https://www.guitar-pro.com/blog/p/56130-discover-mysongbook-and-play-thousands-of-high-quality-tabs-in-guitar-pro), [Terms of sale 6.2 to 6.5](https://www.guitar-pro.com/c/6-terms-and-conditions-of-sale) |
| 4 | Guitar Pro 8 access: sign in with a Guitar Pro account inside the app; a subscription or a credit-bought score opens directly. Quote: "mySongBook requires online authentication to access scores". | [GP8 manual: open from mySongBook](https://www.guitar-pro.com/docs/gp8/mysongbook/open-from-msb) |
| 5 | Scores may not be stored or saved. Quotes: "The scores will not be available without an Internet connection and it will not be possible to store them" (6.1); "it will not be possible to modify, export or save this score on the Customer's device" (6.3). | [Terms of sale](https://www.guitar-pro.com/c/6-terms-and-conditions-of-sale) |
| 6 | The FAQ answers "Can I edit or save the scores?" with: "Due to copyright reasons, you can't edit, export, or save the scores." Readers are Guitar Pro 8 and the Guitar Pro mobile apps. | [mySongBook FAQ page](https://www.guitar-pro.com/11-mysongbook) |
| 7 | Terms of sale 6.2 says export and printing are available to subscribers ("export and printing will only be available to Customers with a valid subscription"). It does not say what format export produces. This sits uneasily with 6.3 and the FAQ; I could not resolve it from public pages. | [Terms of sale](https://www.guitar-pro.com/c/6-terms-and-conditions-of-sale) |
| 8 | Use is personal only (6.6: "strictly personal purposes"), and a purchase transfers no ownership right. | [Terms of sale](https://www.guitar-pro.com/c/6-terms-and-conditions-of-sale) |
| 9 | The terms of use require "prior written authorization of Arobas Music SARL" for reproducing or using site content, and make linking to the sites subject to "the prior agreement of the Director of Publication". | [Terms of use](https://www.guitar-pro.com/c/3-terms-of-use) |
| 10 | I found no documented API, developer programme, partner programme or third-party access. The terms of use as retrieved say nothing about automated access, scraping, reverse engineering or third-party software, and the GP8 manual and FAQ do not mention third-party apps. Absence of a clause is not permission; the terms-of-sale restrictions in rows 5, 6 and 8 already rule out caching and redistribution. | [Terms of use](https://www.guitar-pro.com/c/3-terms-of-use), [GP8 mySongBook chapter](https://www.guitar-pro.com/docs/gp8/mysongbook) |
| 11 | No page I read names the file formats mySongBook delivers. The "encrypted .gp variants" in the task brief are not something I could confirm from public sources, and I did not investigate. | none |

Confidence: high that no public API exists on the pages I read (I searched and read the main pages, not every help article; the Guitar Pro help centre returned 403 to the fetch tool). High on the "no store, no export" terms (three consistent pages). Medium on the 6.2 export statement (ambiguous). The terms may have changed since; the terms-of-sale page gave no update date.

### Boundaries (TabPlayer will not do these)

1. Circumvent or inspect any protection or licence check, or open protected content by any route other than the official client.
2. Scrape the site or impersonate the official client or its account flow.
3. Ask for or store a mySongBook or Guitar Pro account name or password. No official third-party sign-in flow exists, so there is nothing legitimate to store credentials for.
4. Cache, mirror or redistribute catalogue data, scores or artwork. The terms forbid storing scores, so L04's "cached score" is not available to any third party even with permission unless Arobas Music grants one in writing.
5. Use the mySongBook or Guitar Pro marks in a way that implies affiliation. (PRODUCT.md already requires independence.)

### Which files a user can open

TabPlayer imports `.gp`, `.gpx`, `.gp3`, `.gp4`, `.gp5` and native `.tabplayer` (PRODUCT.md, Operating Context). Those are ordinary files when they come from the user's own authoring or from sellers that deliver plain files. Based on rows 5 and 6, a user cannot obtain a plain file of a mySongBook purchase from the service, so there is nothing mySongBook-specific for TabPlayer to open. I did not check what a file would be if one existed.

### The Library as it is

- Recents, pinning, personal templates, indexed folders (title, artist, album, track names, text search, title/artist/instrument filters, sorting) and bundled templates and examples exist (`src-tauri/src/file_library/types.rs`: `LibrarySection`, `LibraryQuery`, `LibraryMetadata`; validation record `docs/validation/2026-10-15-gp8-file-library.md`).
- Bundled content carries an `origin` (factory, personal, example) and a `license` per item; the bundled templates are CC0-1.0 (`assets/library/manifest.json`).
- There is no source tag, no favourites separate from "pinned" recents, no collections, no album/arrangement browse view and no genre or arrangement field in the index. `protected.rs` protects TabPlayer's own storage from being overwritten; it has nothing to do with vendor content protection.

### Options against the tracker

| Option | What it is | L02 | L03 | L04 |
|---|---|---|---|---|
| (a) Out of scope | Record the reason in the tracker and the validation note; no code. | stays missing, reason recorded | stays missing, reason recorded | stays missing, reason recorded |
| (b) Local library "source" tag, collections, browse by artist/album, favourites for files the user already holds | A general Library improvement with a free-text source label. No connection to the service, and in practice no mySongBook files to hold. | no change (acceptance requires service access; the baseline says not to substitute) | no change | no change (offline by nature is not "previously authorized cached score with access status") |
| (c) Link out | A "find scores" link to the official site. | no change | no change | no change. Terms of use row 9 make links subject to prior agreement, so ask first. |

The baseline states: "The app must not claim mySongBook/Fretlight/Line-In/MIDI input or external output merely because an internal simulation/placeholder exists." That rules out moving any of the three rows on the strength of (b) or (c).

### Free scores: does a TabPlayer free shelf stand in?

No. L03's acceptance is "Verify genuine authorized receipts/entitlements and free-score access if integration is available". It is conditional on the integration existing, so with no integration the clause that is checkable (receipts, entitlements) cannot be done, and the free-score clause is not triggered. The baseline says "Author independent assets", which supports shipping our own openly licensed examples as a feature in its own right (the bundled examples already exist), but it does not make them "free-score access" to mySongBook. Do not relabel them.

### Recommendation, mySongBook

- Choose (a) for L02, L03 and L04, with the reasons in findings 4 to 8. Add the finding to the tracker as a plain limit, not as a pending task. Status stays "missing".
- Treat (b) as a separate Library idea, judged on its own merit and not tied to mySongBook. It belongs in `docs/backlog.md`. It moves no tracker row.
- Do not add a link (c) unless Arobas Music agrees in writing (see questions).
- Optional, owner's call: write to Arobas Music asking whether any third-party access or partnership exists. A yes would change this whole section; I expect no, but I have no evidence either way.

### Slices, recommended option

- M1 (docs only, small): add the limit and reasons to the tracker rows and a validation note `docs/validation/2026-11-14-mysongbook-out-of-scope.md`; README line stating there is no mySongBook integration. No code, no dependencies.

## Part 2: Fretlight

### Facts, with sources

| # | Finding | Source |
|---|---|---|
| 1 | Fretlight is a brand of Optek Music Systems. The Fretlight site shows copyright 2026 and current products: FG-821 wireless (Bluetooth 5.4), Traveler, Beginner Electric, 200 Series, a Bluetooth classroom hub for up to 30 guitars, and "FG-400/500 wired guitar" videos. The fetch tool inferred the company is active from the page; that is an inference. | [fretlight.com](https://www.fretlight.com), [Optek brand statement on a Fretlight Ready app listing](https://apps.apple.com/app/id972426361) |
| 2 | Retail listings show FG-621 (wireless, BLE) and FG-5xx guitars, some out of stock or discontinued at specific shops. Whether wired FG-4xx/5xx guitars are still sold new is unconfirmed; used ones are on resale sites. | [Sweetwater FG-621](https://www.sweetwater.com/store/detail/FG621SB--fretlight-fg-621-wireless-electric-guitar-learning-system-sunburst), [Reverb FG-521](https://reverb.com/item/98423576-fretlight-500-series-fg-521-black-used) |
| 3 | Guitar Pro 8 supports Fretlight over USB or Bluetooth, with modes Tablature (cursor position), Chords, Scale, left-handed display and a fret-range limit. Wireless needs Bluetooth 4.0, macOS 10.10 or later, or Windows 10. | [GP8 manual: Fretlight](https://www.guitar-pro.com/docs/gp8/tools/fretlight) |
| 4 | Guitar Pro 6 was announced as "Fretlight Ready" in a joint Optek and Arobas Music announcement. | [MusicRadar](https://musicradar.com/news/guitars/learn-millions-of-guitar-songs-with-guitar-pro-6-fretlight-ready-473362) |
| 5 | "Fretlight Ready" is a designation for apps that send data to a guitar over Bluetooth; Optek disclaims responsibility for third-party apps that carry it. So third-party apps exist, but I found no published terms for becoming one. | [StringMaster Pro listing](https://apps.apple.com/app/id972426361) |
| 6 | A community author states "Optek Music Systems has a Fretlight SDK that's available by application." That is the only SDK mention I found; the post is undated in what I read and I could not confirm the programme is open today. | [Exploring Binary](https://www.exploringbinary.com/my-fretlight-guitar-as-a-binary-clock/) |
| 7 | The fretlight.com page lists no SDK, API or developer programme. | [fretlight.com](https://www.fretlight.com) |

### The documented wired protocol

Source: one blog post by Rick Regan on Exploring Binary ([post 1](https://www.exploringbinary.com/my-fretlight-guitar-as-a-binary-clock/), [post 2, Raspberry Pi](https://www.exploringbinary.com/my-fretlight-guitar-binary-clock-raspberry-pi-edition/)). The author says he captured USB traffic with USBlyzer while Guitar Pro 6 played all 132 notes, and that the capture matched the encoding in two open-source projects: [Fretlight Animator](https://github.com/RGKaizen/FretLight-Animator) (C#, no licence visible in what I read, README says it uses Libusb.net) and the [TuxGuitar Light Plugin](https://github.com/nbald/TuxGuitar-Light-Plugin) (GPL-3.0, so its code must not be copied into this MIT project; it has a `udev` folder, which fits the Linux permission note below). Neither repository's README documents the byte layout; I did not read their source.

What the post states:

- USB HID device, vendor ID 0x0925, product ID 0x2000. The author notes 0x0925 is assigned to Lakeview Research and does not know why Fretlight uses it. That ID pair may therefore be shared with unrelated devices (my inference).
- The host writes to the interrupt OUT endpoint. With HID libraries that is an 8-byte report: report ID 0, then a 7-byte packet. With raw USB the Raspberry Pi post writes the 7 bytes without the leading zero.
- Packet: bytes 0 to 5 are LED bits (1 on, 0 off), byte 6 is the packet ID. Packet 1 covers frets 0 to 7, packet 2 frets 8 to 15, packet 3 frets 16 to 21 (frets 0 to 21, 6 strings, 132 LEDs). Strings are numbered 1 to 6 with 1 the high E. In packet 3, byte 0 and the low four bits of byte 1 are unused.
- Bit layout, which I checked for internal consistency and which reduces to one formula (my inference from the post's tables): number the LEDs in a packet `k = (fret - first_fret_of_packet) * 6 + (string - 1)`; LED `k` is bit `7 - (k mod 8)` of byte `5 - floor(k / 8)`. I verified this against the first, last and boundary cells of all three tables as printed.
- Not stated: brightness, whether LEDs persist if no further packet arrives, whether sending only one packet leaves the other two groups unchanged, how to clear (presumably send zero data for all three packets), timing limits, whether all models use 22 frets, and anything about wireless models.

Confidence: medium. It is one author, one guitar of unknown model, a secondary-source description of USB traffic, though matched against two independent projects by his account. The formula consistency is a good sign for transcription accuracy but proves nothing about the device. Treat every unstated item above as unknown until tested on hardware.

Wireless models: no published GATT services or characteristics found. A search for community write-ups returned only generic BLE guides. I did not reverse engineer anything and recommend nobody on this project does.

### What TabPlayer would need

**Transport (dependency decision for the owner).** Crates.io data read 2026-11-14 through its API:

| Crate | Version, last release | Licence | Notes |
|---|---|---|---|
| `hidapi` | 2.6.7, 2026-08-27 | MIT | Wraps the C hidapi library (Windows, macOS, Linux). Fits the post's "report ID 0 plus 7 bytes" layout. The C library's own licence terms should be checked against `THIRD_PARTY_NOTICES.md` before adding. Linux needs a udev rule for non-root access. |
| `nusb` | 0.2.9, 2026-10-24 | Apache-2.0 OR MIT | Pure Rust USB, no libusb. Raw endpoint writes (no report-ID byte). Windows needs a WinUSB driver bound to the device, which a stock HID device does not have, so it is a poor fit on Windows. |
| `rusb` | 0.9.4, 2024-04-27 | MIT | libusb binding. Same Windows driver issue; last release is 2.5 years old. |
| `btleplug` | 0.13.5, 2026-10-10 | MIT, Apache-2.0 or BSD-3-Clause | Cross-platform BLE central. Only useful if a wireless protocol becomes known. Not recommended now. |

My recommendation: `hidapi` only, and only in slice F3 when a tester exists. `midir` is the only device crate already in `src-tauri/Cargo.toml`. Platform limits (macOS permission prompts for HID, Linux udev) are unverified for this device.

**Where the LED state comes from.**
- The instrument view's lit positions are computed in the frontend. `focusNotes` (`src/instruments/focus.ts`) turns the focus (`playing`, `beat`, `bar`, `next`) and the native playback plan into planned notes; `LiveInstrumentView` (`src/instruments/LiveInstrumentView.tsx`) feeds them, with `player.activeNotes` for "Playing notes" and `player.scheduledNotes` for the other three; `InstrumentView.tsx` maps each note to a string and fret using the staff's tuning and capo, and mirrors for left-handed.
- Scale overlays: the tracker (U15) records that previews exist only in the Scale browser, not on the main instrument view. So "scale mode" is a different source from the four focus modes.
- Proposed design: extract the note-to-(string, fret) step from `InstrumentView.tsx` into a pure function so both the SVG view and a device sink use it (a refactor that must leave `InstrumentView` tests unchanged). The frontend sends a complete frame (a set of at most 132 string/fret pairs plus a sequence number) to a native command; Rust coalesces frames, keeps only the newest, and a worker thread writes it. This follows `midi_in.rs`: a bounded channel, one worker thread, nothing on the audio callback, nothing in `src-tauri/src/audio/`. LEDs follow the same status the view already follows, so repeats and loops come for free from the playback plan's occurrences (to be proved with the fake backend).
- Consequence for latency: the lit state travels native playback state to webview, then to a native command, then to USB. Expect tens of milliseconds of jitter on top of the audio latency, not a measured figure. Fine for finger guidance; it is not a timing authority, and the product rule that native playback is the timing authority still holds.
- Handedness, capo, tunings: the device has a fixed physical layout. The post says frets are 0 to 21 and strings 1 to 6. A left-handed guitar flips the user's mental model, not the LED map; GP8 offers a "left-handed display" switch, so a switch here is needed and its exact meaning on hardware is unknown. Capo: the view shows frets relative to the capo (`detail_capo_relative`); the physical frets on the neck are absolute. The mapping needs a decision and a hardware check. Notes above fret 21, strings other than 6 (7/8-string, bass with 4 strings, drums) are not lit or are mapped to the lowest strings for bass; the bass behaviour is unknown, since the documented guitars have six strings.
- Consent: no HID device is listed with its path opened, and none is written to, until the user presses Connect in a new panel; never at launch, on opening a document or on reconnect (same rule as MIDI capture). Match the product name string as well as VID/PID before writing, because 0x0925 may be shared.
- Disconnect and reconnect: a failed write marks the device lost; the panel shows it; reconnect only on the user's action or after a bounded retry like `midi_out.rs` (retry at most every 2 s, open timeout 3 s). Clear LEDs on Stop, on document close and on app exit (`RunEvent::Exit`).

### What can and cannot be verified

Can be verified without hardware: the encoder against the post's printed tables and the formula (every one of the 132 positions round-trips; unused bits stay zero); frame coalescing; disconnect, reconnect and exit clearing with a fake backend; repeats and loops; handedness and fret-range mapping; consent (nothing opened before Connect); input bounds; i18n, focus and keyboard behaviour.

Cannot be verified: that a real guitar lights the right LED, packet persistence and clearing, timing, wired model coverage, macOS and Linux permission behaviour, and everything about wireless models. Nobody here owns one.

Tracker rules: the baseline says status "implemented" needs "implementation/UI and meaningful existing assertions" and that acceptance for hardware rows must use "actual authorized service/device access". Precedent: MIDI input is "built and awaits real hardware" and sits at partial (U16, U17). So U19 can reach "partial" only once a transport exists and the validation note says plainly it was not run on hardware. Before a transport exists, U19 stays "missing", and a fake backend does not change that.

### Options

| Option | Scope | U19 outcome | Risk |
|---|---|---|---|
| (a) Documented protocol, fake backend, ship "untested on hardware" | F1 to F4, USB only, experimental label, off by default | missing to partial (hardware-pending) | Public MIT release contains code that writes to a USB device from one blog's description, with no test. A wrong packet is unlikely to damage hardware (LED data only) but I cannot rule out odd firmware reactions. Covers only wired legacy guitars. |
| (b) Device-independent half now, transport later | F1 and F2 only; no new dependency | stays missing | Delivers no user-visible feature by itself. Low risk. Work is reusable if a tester appears. |
| (c) Out of scope | docs only | stays missing, reason recorded | Contradicts the owner's 2026-11-14 decision; justified only if no tester can be found and wireless remains closed. |

### Recommendation, Fretlight

(b) now, and F3 and F4 only if the owner can get a tester before 1.0 (for example by buying a used wired FG-5xx, or finding a volunteer). If no tester exists by then, ship 1.0 without a Fretlight panel and record U19 as "missing, blocked on hardware and on the wireless protocol". Also write to Optek Music Systems to ask about the SDK or Fretlight Ready programme and about using the community-documented USB layout; a written answer is worth more than the blog post.

### Slices (recommended option, with later slices marked)

| Slice | Content | Size | Needs |
|---|---|---|---|
| F1 | `src-tauri/src/fretlight.rs`: frame type (bounded set of string/fret), encoder to the three 7-byte packets, `LedBackend` trait, fake backend that records writes; tests that every position round-trips against the documented tables. No dependency. | S | none |
| F2 | Extract note-to-(string, fret) as a pure function used by `InstrumentView`; frontend builds a frame from the four focus modes; new Rust command receiving frames with validation and coalescing; handedness, fret range, capo mode as settings; fake-backend tests for repeats, loop and Stop clearing. | M | none |
| F3 (later) | `hidapi` backend: list, product-name match, open on Connect, writer thread, loss detection, bounded retry, clear on exit. | M | owner dependency decision, tester |
| F4 (later) | Panel UI (Connect, status, mode, handedness), i18n en/et/de, keyboard and focus rules (`useBusyGuard`), validation note stating "not run on hardware" or the real result. | M | F3 |
| F5 (later) | Scale mode from the Scale browser preview. | S | F2 |
| F6 | Wireless (BLE): not planned; no public protocol. | blocked | vendor documentation |

For comparison, the MIDI capture design used four to five slices of similar size. Estimates are my judgement, not measured.

## Decisions for the owner

1. **mySongBook:** accept (a), that is, L02 to L04 out of scope with the stated reason? Or request written access terms from Arobas Music first?
2. **Fretlight dependency:** approve `hidapi` (and its bundled C library licence) for F3, now or only once a tester exists?
3. **Fretlight transport timing:** build F3 and F4 without hardware proof ("untested" label), or wait for a tester?
4. **Wireless models:** accept that BLE is out until the vendor documents it?

## Questions for the owner

1. Do you want me to draft a short enquiry to Arobas Music (third-party access, linking) and one to Optek (SDK, community layout)? I would not send either without your say-so.
2. Can you obtain a wired Fretlight (FG-4xx or 5xx) or know someone who has one?
3. Is the "Experimental, untested on hardware" label acceptable in a public 1.0, or must hardware features be hidden until verified?
4. Should the Library "source tag and collections" idea go into `docs/backlog.md`, independent of mySongBook?
5. Capo behaviour on a physical guitar: light the fret relative to the capo (as the on-screen view does) or the absolute fret? This needs a tester either way.
