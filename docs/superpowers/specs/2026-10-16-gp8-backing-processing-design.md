# Backing pitch and six frequency filters

2026-10-16. Approved ongoing 258-item parity scope; implement in this chat with disjoint workers and independent review. This specification extends existing backing playback/settings/export/UI interfaces. No further approval gate is requested.

## Intent and acceptance boundary

P17 provides independent local semitone/cents adjustment while preserving duration. P18 provides the six documented frequency emphasis/attenuation modes. The musician can retune a backing recording or emphasize a frequency band while practicing the same score, then save/reopen, Undo/Redo and export the same audible processing.

The official [backing manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track) and its [filter menu](https://www.guitar-pro.com/img/gp-docs/gp8/en/backing_track_filters.webp) supply the feature names. Exact proprietary pitch bounds, curves and metadata are unverified. The numeric ranges and response below are explicit TabPlayer policy. Global relative tonality remains P12; no score/keys/MIDI transposition, vocal/center separation, AI stems or new DSP dependency.

Baseline accepted product source is447d2a9240dc5727ff0679b5b0f84dd7107db603, delivered byae6fcb8. P16 native timing/source/history/reference gates remain authoritative; its GP bracket and platform/shipping gaps remain open.

## Wire contract and neutral compatibility

Add to TS edit-types.ts and native settings.rs:
- BackingFilter wire values: 'none', 'bassEnhance', 'bassAttenuation', 'mediumEnhance', 'mediumAttenuation', 'highEnhance', 'highAttenuation'.
- BackingProcessing = {semitones:number; cents:number; filter:BackingFilter}. All three fields are required, exact keys only.
- BackingSettings.processing?:BackingProcessing|null. Missing/null means {semitones:0,cents:0,filter:'none'}. An explicitly present undefined value is invalid in direct TS validation.
- semitones is a finite integer in[-12,12]; cents is a finite integer in[-100,100]. Reject fractions, booleans, strings, nonfinite values, out-of-range and unknown keys/modes in TS and native. Rust stores numeric values as f64 with explicit integer validation so JSON decimal spellings of integer values agree with TS.
- No cents carry/clamp/normalization. Preserve the pair as entered. Audible ratio =2^((semitones+cents/100)/12); cancellation such as -1/+100 takes the exact zero-pitch PCM path. A changed pair remains a deliberate settings edit.
- Native Option<BackingProcessing> defaults missing/null and omits None on serialization. Existing payloads need no migration or forced neutral fields. Unknown fields remain rejected.

Export defaultBackingProcessing():BackingProcessing and backingProcessingKey(processing:BackingProcessing|null|undefined):string from a small src/audio/backing-processing.ts. The key serializes the defaulted individual pair/filter, not a rounded ratio. validateBackingSettings validates processing before edit admission. DocumentController.backingState includes that normalized key; missing/null/explicit0/0/none and identical pair/filter are no-ops preserving live redo. Invalid data still rejects before no-op detection. Existing P16 settings, source assets, score and original bytes stay intact.

One shared tests/backing-processing-protocol.json carries literal valid/invalid settings cases for TS/native acceptance. JSON nonfinite cannot be encoded; each language adds direct nonfinite tests. Do not change the historical reference-sync protocol/timing fixtures.

## Native pitch and filter execution

Reuse BackingVoice and its shared stereo grain offset. Within-grain stride becomes(sourceRate/outputRate)*ratio at correlation radius/coarse/refined/head/tail reads. Expected mapped source origin, hop cadence, transient score times, reference map, BPM, ticks, output duration and bounds do not change. Every read still uses the existing independently gated source_frame/sample path; excluded frames may never influence correlation or output.

Keep BackingVoice::new(audio,map,rate) as the neutral compatibility constructor; add new_with_processing(audio:Arc<DecodedAudio>,map:BackingMap,rate:u32,processing:BackingProcessing)->Result<Self,String>. Validate processing and precompute stride/filter off the callback. Neutral input retains the incumbent arithmetic/branch path and bypasses filtering, with exact PCM equality including zero-total cancellation.

Add pub(crate) BackingFilterDsp in audio/dsp.rs with new(mode:BackingFilter,rate:u32)->Result<Self,String>, process(frame:[f32;2])->[f32;2] and reset(). Reuse existing Biquad, with independent channel delay state and no channel matrix. None is direct bypass. The chosen curves are:
- Bass: existing low shelf at180Hz, +6dB Enhance / -6dB Attenuation.
- Medium: existing peak at1000Hz, +6/-6dB, existing alpha=sin(w)/1.4 (Q0.7).
- High: existing high shelf at4000Hz, +6/-6dB.
- Existing frequency clamp min(hz,0.45*rate) applies at supported8–192kHz output rates. No normalization, auto gain or limiter added here.

The voice owns the filter and processes the assembled frame AFTER isolated-transient reinsertion and BEFORE existing backing gain/pan. Reset filter on seek/loop/range restart, reconstruction and any excluded/nonfinite/EOF participation. Suppress all backing output outside reference entry-inclusive/exit-exclusive and during score release/export tails. Preserve the incumbent neutral grain cursor behavior around legacy offset/EOF. Do not allocate, scan PCM, prepare coefficients or destroy heap values in the callback.

Renderer retains install_backing(audio,map,mix) neutral compatibility and adds install_processed_backing(audio,map,mix,processing:BackingProcessing)->Result<(),String>. Both native device preparation and runtime/offline export use the latter with defaulted frozen processing. Shared renderer/stem scratch slots ensure identical audible transforms before master limiting.

## Live settings and export

AudioService.set_mix classifies defaulted processing changes alongside voice/map/presence changes and uses the EXISTING off-thread prepared renderer/preserved-install route. Processing-only changes reuse old decoded Arc and resources, keep generation/current tick/practice/range/loop, and do not decode again. The existing reference-timing-on-old-plan rejection stays exact. Gain/pan/mute/solo-only edits retain the cheap PreparedMix path and do not reset grains/filter.

A changed processing pair may reconstruct the voice even if total pitch cancels. No click-free morph or continuous score-DSP-state claim. Existing preserved install supplies deterministic current-tick restart. NativePlaybackController's existing complete audio-settings key detects processing, while referenceTimingKey ignores it; test settled processing edits reach setMix without new plan generation. Existing in-flight preparation behavior remains.

Frozen WAV/mix/backing stems contain processed backing; score stems/events and timeline are unchanged. Omitted backing still validates P16 source/timing before omission and emits no backing DSP tail. Device-rate rebuild and new source use frozen processing at the new rate. Save/clean-close/fresh-reopen and Undo/Redo preserve the raw processing pair and immutable asset identity.

Proprietary GP processing metadata remains unsupported. gpBackingSelectionIssue and projectGpDocument both reject includeBacking for an audibly nonneutral processing value (total pitch!=0 or filter!='none') with: 'Backing pitch and filters cannot be stored in this Guitar Pro export. Clear Include backing audio to export notation.' Existing associated checkbox/error/default-include/omit path remains. Explicit omit bypasses source processing/bytes and exports selected notation without active backing/sync. No source re-encoding, invented GPIF field or silent loss of an audible transform. Neutral cancellation may include unchanged raw audio.

## UI contract and GenAI authority

Root generated and inspected docs/design/reference-workstation/backing-pitch-filter-concept.png BEFORE code; exact prompt/provenance is backing-pitch-filter-generated-concept.json. The corrected concept retains the established LEFT Backing sidebar, score-first canvas, right note Inspector and waveform. Adopt its compact Pitch & filter disclosure below mix and above Sync timing, paired Semitones/Cents, full-width Filter, quiet Reset and 'Changes backing audio only.' Incidental notation/timing, blue generated focus and example values are not truth/defaults. Existing white keyboard focus remains. No context rerun, concept tournament or visual-world replacement.

Create BackingProcessingControls.tsx within src/audio, used by BackingPanel only for committed settings. Props: settings:BackingSettings; busy:boolean; visible:boolean; beginOperation:()=>()=>void; onEdit:(edit:EditCommand)=>void|Promise<void>. Add optional visible?:boolean(defaulttrue) to BackingPanel, passed the actual Backing-pane visibility by App. No App layout/dock changes. New controls are absent for score-only/original embedded/loading states; existing Edit embedded path remains.

Native select labels in wire order: No Filter, Bass Enhance, Bass Attenuation, Medium Enhance, Medium Attenuation, Hi Freq Enhance, Hi Freq Attenuation. Select commits one setBacking; Reset commits processing:null only when nonneutral fields exist. Each uses a single owned operation lease until onEdit settles, preserving settings captured before awaiting and reporting a local error on rejection.

Each number has a local string draft; first CHANGE acquires one lease and captures full backing settings. Enter commits once; unchanged Enter is no-op; Escape/blur cancels without edit. Arrows step1, Shift10, clamped to local bounds, and remain draft until Enter. Incomplete/out-of-range/noninteger draft is aria-invalid, cannot commit, and must not use a previous valid value. Labels/units and Enter/Escape guidance are associated. Stop keyboard propagation.

Own draft/pending lease keeps its active field usable despite workspace busy; siblings, select/Reset and other backing actions disable. Collapse/hide/settings/source change/window blur/unmount cancels a draft; a pending commit remains leased until settlement, and later errors from a hidden/stale/unmounted session cannot publish. A local state/ref implementation is sufficient; no general transaction framework. Shared endpoint hook continues to arbitrate endpoint actions through workspace busy. Gain/anchors/reference controls preserve processing by existing object spread.

## Independent acceptance oracles

1. Shared strict protocol, legacy missing/null, boundaries, individual pair retention, invalid no-op, neutral equivalent no-op with live redo, asset/score unchanged and native project persistence.
2. Low-amplitude440Hz independent rendered-frequency estimates at literal targets +12=880, -12=220, +1=466.1637615, +50c=452.8929841, -50c=427.4740541Hz, and declared endpoints +/-13semitones from combined fields. Tolerance max(1Hz,0.003*target) on a settled multi-second window. Test +1/-50 and0/+50 identical, -1/+100 exact neutral. Do not inspect internal ratio to prove pitch.
3. Voice/core stereo [s,s],[s,-s],[s,0],[0,s] retain relationships/silent channels. Same frames/ticks/duration at44.1/48kHz, cross-rate source/output and relative0.1/1.23/3; score-only event/stem equality.
4. All six filters at44.1/48k: target80/1000/10000Hz gain sign and magnitude4–7dB, with sign reversed for cuts; at each other listed band absolute response<1dB. NoFilter exact bypass. Use actual steady PCM amplitude/DFT after settling and ample headroom, independent of coefficients. Every stereo pattern and mode, deterministic reset.
5. Two decoded sources identical inside fractional reference brackets but radically different outside produce identical pitched/filtered output. Cover both interpolation neighbors, correlation radius, transient neighborhoods, exact exit impulse, seek near entry/exit, positive range/loop at both rates/speeds, no backing tails. Negative-control sensitivity for the distinguishing gate/pitch oracle.
6. Frozen shared renderer live/offline backing stem agreement, score stem equality, included/omitted PCM timing, settings during export/stale owner/revision/generation and existing P16 protections. Actual native setMix processing installs/reuses source, gain-only remains cheap.
7. Actual Windows edit/cancel/invalid/UndoRedo/save-clean-close-fresh-reopen, GP blocked include→explicit omit publication, native clock/generation/source invariants and a new original processed backing WAV/stem whose frequency/response is inspected. No physical audio window is assumed. Listening and original-GP8/platform/shipping claims remain separate if unexecuted.
8. One batched new-control visual review at960/1280/1600 and short height, actual numeric/select keyboard focus and invalid/pending/readOnly states against this GenAI; one identified correction set and at most one confirmation. P16 visual ceiling stays exhausted; do not reopen its accepted screens for freshness.

## Completion

Freeze spec/plan/interfaces and commit before implementation. Use separate native/TS contract producers, then independent DSP/UI/GP work with serialized Cargo ownership and no shared-path collisions. Root joins, verifies coherent checks, builds an owned diagnostic and bounded actual workflow, obtains final review, advances only supported P17/P18 current assessments preserving history, and pushes a checkpoint. Never claim full parity from this slice.
